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
  driveError: DriveError | null
}>

type SourceDocument = Record<string, unknown> & {
  id: string
  client_id: string
  status: string
  document_items: Record<string, unknown>[] | null
  clients: { payment_days: number | null } | null
}

// Same fallback chain as DocumentBuilder: the client's terms, then the settings default.
function paymentDaysOf(source: SourceDocument, defaultPaymentDays: number | null): number {
  return source.clients?.payment_days ?? defaultPaymentDays ?? 14
}

// Copies the template invoice into a new draft dated `date`. Returns null when that period
// already exists, which a retry after a crash hits: by its service period (an issued catch-up
// period is dated today, see runSchedule), else by the unique index documents_recurring_period_key.
async function createPeriodInvoice(supabase: SupabaseClient, schedule: RecurringSchedule, source: SourceDocument, date: string, defaultPaymentDays: number | null): Promise<string | null> {
  const period = servicePeriod(date, schedule.interval, schedule.in_advance, schedule.anchor_day)
  const paymentDays = paymentDaysOf(source, defaultPaymentDays)

  const { data: existing, error: lookupErr } = await supabase.from('documents').select('id')
    .eq('recurring_schedule_id', schedule.id).eq('service_date', period.start).eq('service_date_end', period.end)
    .limit(1).maybeSingle()
  if (lookupErr) throw new Error(lookupErr.message)
  if (existing) return null

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
    // A period bills the service anew, in EUR: a template that was a final invoice deducts
    // nothing here, and an advance or partial one is not repeated as such.
    invoice_kind: 'standard',
    language: source.language,
    currency: 'EUR',
    exchange_rate: 1,
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

  const items = (source.document_items ?? []).filter(item => item.line_type !== 'deduction').map(item => {
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
// (describeError words database errors, describeDriveError Google's, formatDate the period's
// date), in English for the cron log. The raw text of an archive or Drive failure only goes to the log.
function issueMessages({ t, describeError, describeDriveError, formatDate }: Wording) {
  const reason = (err: unknown) => describeError ? describeError(err) : err instanceof Error ? err.message : String(err)
  const day = (date: string) => formatDate ? formatDate(date) : date
  return {
    snapshot: (date: string) => t ? t('lifecycle.recurring.snapshotFailed', { date: day(date) }) : `${date}: issued, but the archive copy failed`,
    drive: (date: string, driveError: DriveError) => t
      ? t('lifecycle.recurring.driveFailed', {
        date: day(date),
        error: describeDriveError ? describeDriveError(driveError) : t(driveError.code === 'google_reauth' ? 'messages.api.google_reauth' : 'messages.api.google_failed'),
      })
      : `${date}: issued, but the Drive archive failed`,
    issue: (date: string, err: unknown) => t ? t('lifecycle.recurring.issueFailed', { date: day(date), error: reason(err) }) : `${date}: created as draft, issuing failed (${reason(err)})`,
    dateTaken: (date: string) => t ? t('views.recurring.dateTaken', { date: day(date) }) : `${date}: created as draft, another invoice of this schedule is already dated today`,
  }
}

type DriveError = { error: string; code?: string }

type Wording = {
  t?: TFn
  describeError?: (err: unknown) => string
  describeDriveError?: (driveError: DriveError) => string
  formatDate?: (date: string) => string
}

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
    result.errors.push({ scheduleId: schedule.id, message: wording.t ? wording.t('messages.api.template_cancelled') : 'template cancelled', code: 'template_cancelled' })
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
      // An invoice is dated the day it is issued: a period caught up late is issued with today's
      // date and the due date from today, and keeps the period as its service period, so it never
      // gets a number after invoices dated later than it. A draft keeps the period's date; issuing
      // it by hand offers today's. The period key allows one invoice per schedule and date, so a
      // second period caught up in the same run stays a draft.
      let issuable = schedule.mode === 'issue'
      if (issuable && next < asOf) {
        const { error: dateErr } = await supabase.from('documents')
          .update({ date: asOf, due_date: shiftDays(asOf, paymentDaysOf(source as SourceDocument, defaultPaymentDays)) })
          .eq('id', documentId)
        if (dateErr?.code === '23505') {
          result.errors.push({ scheduleId: schedule.id, message: messages.dateTaken(next) })
          issuable = false
        } else if (dateErr) {
          throw new Error(dateErr.message)
        }
      }
      if (issuable) {
        try {
          const { snapshotError, driveError } = await issue(supabase, documentId)
          if (snapshotError) result.errors.push({ scheduleId: schedule.id, message: messages.snapshot(next), detail: snapshotError })
          if (driveError) result.errors.push({ scheduleId: schedule.id, message: messages.drive(next, driveError), detail: driveError.error })
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
    result.errors.push({ scheduleId: opts.scheduleId ?? '*', message: opts.t ? opts.t('messages.api.generate_failed') : error.message, detail: error.message })
    return result
  }

  for (const schedule of (schedules ?? []) as RecurringSchedule[]) {
    try {
      await runSchedule(supabase, schedule, asOf, !!opts.force, defaultPaymentDays, opts.issue, result, opts)
    } catch (err) {
      // A lookup or write that failed partway; the periods generated before it stay.
      const detail = err instanceof Error ? err.message : String(err)
      result.errors.push({ scheduleId: schedule.id, message: opts.t ? opts.t('messages.recurringStopped') : detail, detail })
    }
  }
  return result
}
