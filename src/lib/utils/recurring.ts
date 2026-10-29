import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecurringInterval, RecurringSchedule } from '@/types'
import type { TFn } from '@/lib/i18n'

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
  // Periods that already existed (retry after a crash, overlapping runs), so the cron log shows them.
  skipped: { scheduleId: string; date: string; skipped: 'already_generated' }[]
  // `message` is worded (in the UI language when the caller passes t); `detail` is the raw cause,
  // for the log only.
  errors: { scheduleId: string; message: string; code?: 'template_cancelled'; detail?: string }[]
}

// Issuing (number, archive copy, Drive) lives in the server-only src/lib/pdf/issue.ts. This module
// is also imported by client components for its date math, so the route handlers pass it in.
export type IssueDocumentFn = (supabase: SupabaseClient, documentId: string) => Promise<{
  snapshotError: string | null
  driveError: { error: string; code?: string } | null
}>

type SourceDocument = Record<string, unknown> & {
  id: string
  client_id: string
  status: string
  document_items: Record<string, unknown>[] | null
  clients: { payment_days: number | null } | null
}

// Copies the template invoice into a new draft dated `date`. Returns null when that period
// already exists (unique index documents_recurring_period_key), which a retry after a crash hits.
async function createPeriodInvoice(supabase: SupabaseClient, schedule: RecurringSchedule, source: SourceDocument, date: string, defaultPaymentDays: number | null): Promise<string | null> {
  const period = servicePeriod(date, schedule.interval, schedule.in_advance, schedule.anchor_day)
  // Same fallback chain as DocumentBuilder: the client's terms, then the settings default.
  const paymentDays = source.clients?.payment_days ?? defaultPaymentDays ?? 14

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

// Issue failures as the manual button shows them: in the UI language when the route passes t
// (describeError words database errors, formatDate the period's date), in English for the cron
// log. The archive and Drive failures are worded by kind; their raw text only goes to the log.
function issueMessages({ t, describeError, formatDate }: Wording) {
  const reason = (err: unknown) => describeError ? describeError(err) : err instanceof Error ? err.message : String(err)
  const day = (date: string) => formatDate ? formatDate(date) : date
  return {
    snapshot: (date: string) => t ? t('lifecycle.recurring.snapshotFailed', { date: day(date) }) : `${date}: issued, but the archive copy failed`,
    drive: (date: string, code: string | undefined) => t
      ? t('lifecycle.recurring.driveFailed', { date: day(date), error: t(code === 'google_reauth' ? 'messages.api.google_reauth' : 'messages.api.google_failed') })
      : `${date}: issued, but the Drive archive failed`,
    issue: (date: string, err: unknown) => t ? t('lifecycle.recurring.issueFailed', { date: day(date), error: reason(err) }) : `${date}: created as draft, issuing failed (${reason(err)})`,
  }
}

type Wording = { t?: TFn; describeError?: (err: unknown) => string; formatDate?: (date: string) => string }

async function runSchedule(supabase: SupabaseClient, schedule: RecurringSchedule, asOf: string, force: boolean, defaultPaymentDays: number | null, issue: IssueDocumentFn, result: GenerateResult, wording: Wording) {
  const messages = issueMessages(wording)
  const { data: source, error } = await supabase
    .from('documents')
    .select('*, document_items(*), clients(payment_days)')
    .eq('id', schedule.source_document_id)
    .single()
  if (error || !source) throw new Error(error?.message ?? 'Template invoice not found')

  // A template cancelled (Storno) after the schedule was created must not be copied any
  // further: pause the schedule and report it instead of generating.
  if ((source as SourceDocument).status === 'cancelled') {
    const { error: pauseErr } = await supabase.from('recurring_schedules').update({ active: false }).eq('id', schedule.id)
    if (pauseErr) throw new Error(pauseErr.message)
    result.errors.push({ scheduleId: schedule.id, message: 'template cancelled', code: 'template_cancelled' })
    return
  }

  let next = schedule.next_date
  for (let i = 0; i < MAX_PERIODS_PER_RUN; i++) {
    // The manual button generates the upcoming period regardless of date; after that only catch-up.
    if (!(force && i === 0) && next > asOf) break
    if (schedule.end_date && next > schedule.end_date) {
      const { error: endErr } = await supabase.from('recurring_schedules').update({ active: false }).eq('id', schedule.id)
      if (endErr) throw new Error(endErr.message)
      break
    }

    const documentId = await createPeriodInvoice(supabase, schedule, source as SourceDocument, next, defaultPaymentDays)
    if (documentId) {
      result.generated.push({ scheduleId: schedule.id, documentId, date: next })
      if (schedule.mode === 'issue') {
        try {
          const { snapshotError, driveError } = await issue(supabase, documentId)
          if (snapshotError) result.errors.push({ scheduleId: schedule.id, message: messages.snapshot(next), detail: snapshotError })
          if (driveError) result.errors.push({ scheduleId: schedule.id, message: messages.drive(next, driveError.code), detail: driveError.error })
        } catch (err) {
          result.errors.push({ scheduleId: schedule.id, message: messages.issue(next, err) })
        }
      }
    } else {
      result.skipped.push({ scheduleId: schedule.id, date: next, skipped: 'already_generated' })
    }

    // Only what this iteration changed goes into the update: last_* only when a document was
    // created here (an overlapping run must not overwrite them with a stale id) and active only
    // when the schedule ended, so a Pause clicked mid-run is not undone.
    const advanced = advanceDate(next, schedule.interval, schedule.anchor_day)
    const ended = !!schedule.end_date && advanced > schedule.end_date
    const patch: Partial<RecurringSchedule> = { next_date: advanced }
    if (documentId) {
      patch.last_document_id = documentId
      patch.last_generated_at = new Date().toISOString()
    }
    if (ended) patch.active = false
    const { error: updErr } = await supabase.from('recurring_schedules').update(patch).eq('id', schedule.id)
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
  opts: { scheduleId?: string; force?: boolean; issue: IssueDocumentFn } & Wording,
): Promise<GenerateResult> {
  const result: GenerateResult = { generated: [], skipped: [], errors: [] }

  // Due-date fallback for clients without payment terms, loaded once for the whole run.
  const { data: settings } = await supabase.from('settings').select('default_payment_days').maybeSingle()
  const defaultPaymentDays: number | null = settings?.default_payment_days ?? null

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
      await runSchedule(supabase, schedule, asOf, !!opts.force, defaultPaymentDays, opts.issue, result, opts)
    } catch (err) {
      result.errors.push({ scheduleId: schedule.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
