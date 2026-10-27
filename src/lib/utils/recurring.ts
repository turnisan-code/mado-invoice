import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecurringInterval, RecurringSchedule } from '@/types'

// Date math is self-contained (type-only imports) so plain node can run this module for checks.
const MONTHS_PER_INTERVAL: Record<Exclude<RecurringInterval, 'weekly'>, number> = {
  monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
}

const MAX_PERIODS_PER_RUN = 12

function parse(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y, m, d]
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

export function dayOfMonth(date: string): number {
  return parse(date)[2]
}

function shiftDays(date: string, days: number): string {
  const [y, m, d] = parse(date)
  const r = new Date(y, m - 1, d + days)
  return fmt(r.getFullYear(), r.getMonth() + 1, r.getDate())
}

// Whole months forward or back, landing on anchorDay clamped to the target month's length,
// so a schedule anchored on the 31st goes 31 Jan → 28 Feb → 31 Mar instead of drifting.
function shiftMonths(date: string, months: number, anchorDay: number): string {
  const [y, m] = parse(date)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = ((total % 12) + 12) % 12 + 1
  return fmt(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)))
}

export function advanceDate(date: string, interval: RecurringInterval, anchorDay: number): string {
  if (interval === 'weekly') return shiftDays(date, 7)
  return shiftMonths(date, MONTHS_PER_INTERVAL[interval], anchorDay)
}

// In arrears: the interval that ends the day before `date`. In advance: the interval that
// starts on `date`. Monthly in arrears on the 1st is therefore the whole previous calendar month.
export function servicePeriod(
  date: string,
  interval: RecurringInterval,
  inAdvance: boolean,
  anchorDay: number = dayOfMonth(date),
): { start: string; end: string } {
  if (inAdvance) return { start: date, end: shiftDays(advanceDate(date, interval, anchorDay), -1) }
  const start = interval === 'weekly' ? shiftDays(date, -7) : shiftMonths(date, -MONTHS_PER_INTERVAL[interval], anchorDay)
  return { start, end: shiftDays(date, -1) }
}

// First of next month.
export function defaultNextDate(today: string): string {
  const [y, m] = parse(today)
  return m === 12 ? fmt(y + 1, 1, 1) : fmt(y, m + 1, 1)
}

export interface GenerateResult {
  generated: { scheduleId: string; documentId: string; date: string }[]
  errors: { scheduleId: string; message: string }[]
}

type SourceDocument = Record<string, unknown> & {
  id: string
  client_id: string
  document_items: Record<string, unknown>[] | null
  clients: { payment_days: number | null } | null
}

// Copies the template invoice into a new draft dated `date`. Returns null when that period
// already exists (unique index documents_recurring_period_key), which a retry after a crash hits.
async function createPeriodInvoice(supabase: SupabaseClient, schedule: RecurringSchedule, source: SourceDocument, date: string): Promise<string | null> {
  const period = servicePeriod(date, schedule.interval, schedule.in_advance, schedule.anchor_day)
  const paymentDays = source.clients?.payment_days ?? 14

  const { data: doc, error } = await supabase.from('documents').insert({
    type: 'invoice',
    status: 'draft',
    number: null,
    client_id: source.client_id,
    date,
    due_date: shiftDays(date, paymentDays),
    service_date: period.start,
    service_date_end: period.end,
    recurring_schedule_id: schedule.id,
    converted_from_id: source.id,
    language: source.language,
    currency: source.currency,
    tax_treatment: source.tax_treatment,
    notes: source.notes ?? null,
    notes_internal: null,
    discount_type: source.discount_type ?? null,
    discount_value: source.discount_value ?? null,
    skonto_percent: source.skonto_percent ?? null,
    skonto_days: source.skonto_days ?? null,
  }).select('id').single()

  if (error) {
    if (error.code === '23505') return null
    throw new Error(error.message)
  }

  const items = (source.document_items ?? []).map(item => {
    const copy: Record<string, unknown> = { ...item, document_id: doc.id }
    delete copy.id
    delete copy.created_at
    return copy
  })
  if (items.length > 0) {
    const { error: itemsErr } = await supabase.from('document_items').insert(items)
    if (itemsErr) throw new Error(itemsErr.message)
  }
  return doc.id as string
}

async function runSchedule(supabase: SupabaseClient, schedule: RecurringSchedule, asOf: string, force: boolean, result: GenerateResult) {
  const { data: source, error } = await supabase
    .from('documents')
    .select('*, document_items(*), clients(payment_days)')
    .eq('id', schedule.source_document_id)
    .single()
  if (error || !source) throw new Error(error?.message ?? 'Template invoice not found')

  let next = schedule.next_date
  let lastDocumentId = schedule.last_document_id
  for (let i = 0; i < MAX_PERIODS_PER_RUN; i++) {
    // The manual button generates the upcoming period regardless of date; after that only catch-up.
    if (!(force && i === 0) && next > asOf) break
    if (schedule.end_date && next > schedule.end_date) {
      const { error: endErr } = await supabase.from('recurring_schedules').update({ active: false }).eq('id', schedule.id)
      if (endErr) throw new Error(endErr.message)
      break
    }

    const documentId = await createPeriodInvoice(supabase, schedule, source as SourceDocument, next)
    if (documentId) {
      lastDocumentId = documentId
      result.generated.push({ scheduleId: schedule.id, documentId, date: next })
      if (schedule.mode === 'issue') {
        const { error: issueErr } = await supabase.rpc('issue_document', { p_document_id: documentId })
        if (issueErr) result.errors.push({ scheduleId: schedule.id, message: `${next}: created as draft, issuing failed (${issueErr.message})` })
      }
    }

    const advanced = advanceDate(next, schedule.interval, schedule.anchor_day)
    const ended = !!schedule.end_date && advanced > schedule.end_date
    const { error: updErr } = await supabase
      .from('recurring_schedules')
      .update({ next_date: advanced, last_generated_at: new Date().toISOString(), last_document_id: lastDocumentId, active: !ended })
      .eq('id', schedule.id)
    if (updErr) throw new Error(updErr.message)

    next = advanced
    if (ended) break
  }
}

// Generates every invoice that is due as of `asOf` for the active schedules (one schedule with
// opts.scheduleId; opts.force also generates its upcoming period before it is due). Works with
// the service client (cron) and the user client (manual button) alike.
export async function generateDueSchedules(
  supabase: SupabaseClient,
  asOf: string,
  opts: { scheduleId?: string; force?: boolean } = {},
): Promise<GenerateResult> {
  const result: GenerateResult = { generated: [], errors: [] }

  let query = supabase.from('recurring_schedules').select('*').eq('active', true)
  if (opts.scheduleId) query = query.eq('id', opts.scheduleId)
  if (!opts.force) query = query.lte('next_date', asOf)
  const { data: schedules, error } = await query.order('next_date')
  if (error) {
    result.errors.push({ scheduleId: opts.scheduleId ?? '*', message: error.message })
    return result
  }

  for (const schedule of (schedules ?? []) as RecurringSchedule[]) {
    try {
      await runSchedule(supabase, schedule, asOf, !!opts.force, result)
    } catch (err) {
      result.errors.push({ scheduleId: schedule.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
