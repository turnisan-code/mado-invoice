import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { RecurringInterval, RecurringSchedule } from '@/types'
import type { TFn } from '@/lib/i18n'

// Date math is self-contained (type-only imports) so plain node can run this module for checks.
const MONTHS_PER_INTERVAL: Record<Exclude<RecurringInterval, 'weekly'>, number> = {
  monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12,
}

// How many invoices one run (the cron or "Generate now") creates for a schedule at most; the rest
// follow on the next runs.
export const MAX_PERIODS_PER_RUN = 12

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

export type ScheduleDates = Pick<RecurringSchedule, 'next_date' | 'interval' | 'anchor_day' | 'end_date'>

// Whether `date` is the date of a period the schedule has still to generate (from next_date up to
// end_date). The unique index documents_recurring_period_key allows one invoice per schedule and
// date, so no other invoice of the schedule may be moved onto such a day.
export function isUpcomingPeriodDate(schedule: ScheduleDates, date: string): boolean {
  if (schedule.end_date && date > schedule.end_date) return false
  let next = schedule.next_date
  while (next < date) next = advanceDate(next, schedule.interval, schedule.anchor_day)
  return next === date
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

// ─── Periods already covered ─────────────────────────────────────────────────
// What the schedule has billed is pinned down by its invoices, not by its dates: each one it
// generated (drafts and cancelled ones included) covers its service period, service_date to
// service_date_end. An edit of the interval, the next date (and with it the anchor day) or billing
// in advance or in arrears changes the periods the schedule generates from then on, but not those
// invoices. So the generator never creates a period that shares a day with one of them (those days
// would be billed twice: createPeriodInvoice skips it), and the schedule editor shows the invoice
// the schedule creates next, the periods it skips and the days no invoice covers (planNextPeriod).
export type CoveredPeriod = { start: string; end: string }

export type PeriodDefinition = Pick<RecurringSchedule, 'next_date' | 'interval' | 'anchor_day' | 'in_advance' | 'end_date'>

// The service period of the schedule's invoice dated `date`.
export function periodOn(def: Omit<PeriodDefinition, 'next_date' | 'end_date'>, date: string): CoveredPeriod {
  return servicePeriod(date, def.interval, def.in_advance, def.anchor_day)
}

function overlapping(covered: readonly CoveredPeriod[], period: CoveredPeriod): CoveredPeriod[] {
  return covered.filter(c => c.start <= period.end && c.end >= period.start)
}

// The days of `period` that none of `covered` covers, as ranges in date order: what stays unbilled
// when a period overlapping covered ones is skipped.
export function uncoveredIn(period: CoveredPeriod, covered: readonly CoveredPeriod[]): CoveredPeriod[] {
  const out: CoveredPeriod[] = []
  let from = period.start
  for (const c of [...overlapping(covered, period)].sort((a, b) => a.start.localeCompare(b.start))) {
    if (c.start > from) out.push({ start: from, end: shiftDays(c.start, -1) })
    if (c.end >= from) from = shiftDays(c.end, 1)
  }
  if (from <= period.end) out.push({ start: from, end: period.end })
  return out
}

// Ranges in date order, adjacent and overlapping ones joined.
function joinRanges(ranges: readonly CoveredPeriod[]): CoveredPeriod[] {
  const out: CoveredPeriod[] = []
  for (const r of [...ranges].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = out[out.length - 1]
    if (last && r.start <= shiftDays(last.end, 1)) { if (r.end > last.end) last.end = r.end } else out.push({ ...r })
  }
  return out
}

// PostgREST returns at most 1000 rows per request (max_rows) and .in() lists travel in the URL, so
// coveredPeriods reads a page at a time, for 100 schedules at a time.
const COVERED_PAGE = 1000
const COVERED_IDS = 100

// The service periods the invoices of these schedules cover, by schedule (every invoice generated
// for a schedule counts, drafts and cancelled ones included). The generator, the schedule list,
// the template banner and Claude's list_recurring all read them here.
export async function coveredPeriods(supabase: SupabaseClient, scheduleIds: readonly string[]): Promise<Map<string, CoveredPeriod[]>> {
  const out = new Map<string, CoveredPeriod[]>(scheduleIds.map(id => [id, []]))
  for (let i = 0; i < scheduleIds.length; i += COVERED_IDS) {
    const ids = scheduleIds.slice(i, i + COVERED_IDS)
    for (let from = 0; ; from += COVERED_PAGE) {
      const { data, error } = await supabase.from('documents').select('recurring_schedule_id, service_date, service_date_end')
        .in('recurring_schedule_id', ids).not('service_date', 'is', null).not('service_date_end', 'is', null)
        .order('service_date_end').order('id').range(from, from + COVERED_PAGE - 1)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as { recurring_schedule_id: string; service_date: string; service_date_end: string }[]
      for (const d of rows) out.get(d.recurring_schedule_id)?.push({ start: d.service_date, end: d.service_date_end })
      if (rows.length < COVERED_PAGE) break
    }
  }
  return out
}

export interface PeriodPlan {
  // The invoice the schedule creates next: its date and service period. From next_date on, every
  // period that overlaps a covered one is skipped; `date` is the first that does not.
  date: string
  period: CoveredPeriod
  // The skipped periods, first to last; empty when next_date's own period is free.
  skipped: (CoveredPeriod & { date: string })[]
  // The days between the last covered period before `period` and `period` that no invoice of the
  // schedule covers; null when `period` follows on directly or nothing came before it.
  gap: CoveredPeriod | null
  // `date` is after the end date: the schedule creates no further invoice.
  ended: boolean
  // With `asOf`: how many invoices are already due (from `date` up to asOf and the end date), which
  // the next run creates at once.
  due: number
  // Further on (a next date moved back before invoices the schedule already created): the span of
  // the later periods skipped because invoices cover part of them, and the days they leave
  // unbilled; null when none is. Periods covered exactly (already generated) are not counted.
  later: (CoveredPeriod & { uncovered: CoveredPeriod[] }) | null
}

// Bounds the walk over periods (1000 weeks is about 19 years).
const MAX_PLAN_STEPS = 1000

export function planNextPeriod(def: PeriodDefinition, covered: readonly CoveredPeriod[], asOf?: string): PeriodPlan {
  const skipped: PeriodPlan['skipped'] = []
  let date = def.next_date
  let period = periodOn(def, date)
  for (let i = 0; i < MAX_PLAN_STEPS && overlapping(covered, period).length; i++) {
    skipped.push({ date, ...period })
    date = advanceDate(date, def.interval, def.anchor_day)
    period = periodOn(def, date)
  }
  let before: string | null = null
  for (const c of covered) if (c.end < period.start && (!before || c.end > before)) before = c.end
  const gapStart = before ? shiftDays(before, 1) : null
  const gap = gapStart && gapStart < period.start ? { start: gapStart, end: shiftDays(period.start, -1) } : null
  const ended = !!def.end_date && date > def.end_date
  let due = 0
  for (let d = date, i = 0; asOf && d <= asOf && (!def.end_date || d <= def.end_date) && i < MAX_PLAN_STEPS; d = advanceDate(d, def.interval, def.anchor_day), i++) {
    if (!overlapping(covered, periodOn(def, d)).length) due++
  }
  let lastEnd: string | null = null
  for (const c of covered) if (!lastEnd || c.end > lastEnd) lastEnd = c.end
  const partly: CoveredPeriod[] = []
  for (let d = advanceDate(date, def.interval, def.anchor_day), i = 0; lastEnd && (!def.end_date || d <= def.end_date) && i < MAX_PLAN_STEPS; d = advanceDate(d, def.interval, def.anchor_day), i++) {
    const p = periodOn(def, d)
    if (p.start > lastEnd) break
    if (overlapping(covered, p).length && !covered.some(c => c.start === p.start && c.end === p.end)) partly.push(p)
  }
  const later = partly.length
    ? { start: partly[0].start, end: partly[partly.length - 1].end, uncovered: joinRanges(partly.flatMap(p => uncoveredIn(p, covered))) }
    : null
  return { date, period, skipped, gap, ended, due, later }
}

// The next date and anchor day that make the schedule's next period start on `start` (the editor's
// "bill from" for a gap): that date itself in advance, one interval later in arrears.
export function definitionStartingOn(def: Pick<PeriodDefinition, 'interval' | 'in_advance'>, start: string): Pick<PeriodDefinition, 'next_date' | 'anchor_day'> {
  const anchor = dayOfMonth(start)
  return { next_date: def.in_advance ? start : advanceDate(start, def.interval, anchor), anchor_day: anchor }
}

// The anchor day an edited next date gets: the one the editor set (definitionStartingOn), the
// schedule's own while the date is unchanged, else the day of the new date.
export function anchorDayFor(stored: Pick<PeriodDefinition, 'next_date' | 'anchor_day'> | null, nextDate: string, explicit?: number | null): number {
  if (explicit) return explicit
  if (stored && stored.next_date === nextDate) return stored.anchor_day
  return dayOfMonth(nextDate)
}

// ─── Days a run left unbilled ────────────────────────────────────────────────
// A run that skips a period because invoices of the schedule already cover part of it records the
// days they leave uncovered on the schedule (recurring_schedules.unbilled, 20261107_recurring.sql).
// Such a skip happens unattended: a generated invoice whose service period was moved into the next
// period (in the invoice editor or by Claude's update_document) or a schedule changed outside the
// editor. The plan's gap names those days only until the schedule's next invoice is created; the
// record keeps them on the schedule list and in Claude's list_recurring until an invoice of the
// schedule covers them or the owner dismisses them there (dismissUnbilled). A gap the editor showed
// before a save is not recorded: the owner saw it and saved.
export type NotBilled = { ranges: CoveredPeriod[]; dismissable: boolean }

// What the schedule list and list_recurring show as not billed: the recorded days that no invoice of
// the schedule covers, and `gap` (the plan's gap just before the next invoice; null once the
// schedule ended), joined. `dismissable`: recorded days lie outside the gap (the gap itself is
// billed with "Bill from" in the editor).
export function notBilled(recorded: readonly CoveredPeriod[] | null | undefined, covered: readonly CoveredPeriod[], gap: CoveredPeriod | null): NotBilled {
  const open = joinRanges((Array.isArray(recorded) ? recorded : []).flatMap(r => uncoveredIn(r, covered)))
  const outside = gap ? open.flatMap(r => uncoveredIn(r, [gap])) : open
  return { ranges: joinRanges(gap ? [...open, gap] : open), dismissable: outside.length > 0 }
}

// The list's "Dismiss": forgets the recorded days. Only while the next date is still the one the list
// showed: a run records days only together with moving the schedule on, so days recorded after the
// list was loaded are never dismissed unseen ({ changed: true }).
export async function dismissUnbilled(
  supabase: SupabaseClient,
  schedule: Pick<RecurringSchedule, 'id' | 'next_date'>,
): Promise<{ ok: true } | { ok: false; changed: true } | { ok: false; changed?: false; error: PostgrestError }> {
  const { data, error } = await supabase.from('recurring_schedules').update({ unbilled: [] })
    .eq('id', schedule.id).eq('next_date', schedule.next_date).select('id')
  if (error) return { ok: false, error }
  if (!data?.length) return { ok: false, changed: true }
  return { ok: true }
}

// The days to record after a run skipped periods leaving `uncovered` unbilled: those recorded so far
// (read afresh, so a dismissal made while the run went on is kept) that `covered` does not cover yet,
// and the new ones. null when the schedule has no record (20261107_recurring.sql not applied).
async function unbilledAfterSkip(supabase: SupabaseClient, schedule: RecurringSchedule, covered: readonly CoveredPeriod[], uncovered: readonly CoveredPeriod[]): Promise<CoveredPeriod[] | null> {
  if (!('unbilled' in schedule)) return null
  const { data, error } = await supabase.from('recurring_schedules').select('unbilled').eq('id', schedule.id).maybeSingle()
  if (error) throw new Error(error.message)
  const recorded = (data as { unbilled?: unknown } | null)?.unbilled
  const kept = (Array.isArray(recorded) ? recorded as CoveredPeriod[] : []).flatMap(r => uncoveredIn(r, covered))
  return joinRanges([...kept, ...uncovered])
}

export type StoredSchedule = PeriodDefinition & Pick<RecurringSchedule, 'id' | 'active'>
export type ScheduleEdit = PeriodDefinition & Pick<RecurringSchedule, 'name' | 'mode'>

// Saves the schedule editor's form. The next date saved is the plan's, past the periods the
// schedule's invoices already cover, so the list shows the date of the invoice that really comes
// next. A schedule whose next period starts after its end date is saved as ended; an ended one
// whose end moved out resumes. The update lands only while the schedule is as the editor read it
// (its dates, interval and active flag): { changed: true } when a run or another tab changed it
// meanwhile, so a stale form never moves the schedule back onto a period generated since.
export async function saveScheduleEdit(
  supabase: SupabaseClient,
  stored: StoredSchedule,
  edit: ScheduleEdit,
  covered: readonly CoveredPeriod[],
  asOf?: string,
): Promise<{ ok: true; plan: PeriodPlan } | { ok: false; changed: true } | { ok: false; changed?: false; error: PostgrestError }> {
  const plan = planNextPeriod(edit, covered, asOf)
  const wasEnded = !stored.active && !!stored.end_date && stored.next_date > stored.end_date
  let query = supabase.from('recurring_schedules').update({
    name: edit.name,
    mode: edit.mode,
    interval: edit.interval,
    in_advance: edit.in_advance,
    end_date: edit.end_date,
    next_date: plan.date,
    anchor_day: edit.anchor_day,
    active: plan.ended ? false : wasEnded ? true : stored.active,
  }).eq('id', stored.id).eq('next_date', stored.next_date).eq('interval', stored.interval)
    .eq('anchor_day', stored.anchor_day).eq('in_advance', stored.in_advance).eq('active', stored.active)
  query = stored.end_date ? query.eq('end_date', stored.end_date) : query.is('end_date', null)
  const { data, error } = await query.select('id')
  if (error) return { ok: false, error }
  if (!data?.length) return { ok: false, changed: true }
  return { ok: true, plan }
}

export interface GenerateResult {
  generated: { scheduleId: string; documentId: string; date: string }[]
  // Periods that already existed (retry after a crash, overlapping runs), so the cron log shows them,
  // and periods that overlap one an invoice of the schedule already covers ('overlaps': a schedule
  // whose interval, next date or billing in advance changed). Those are not generated, so no day is
  // billed twice; `message` says so (worded as `errors`).
  // `uncovered`: the days of a skipped period that no invoice covers, which stay unbilled; they are
  // recorded on the schedule (notBilled).
  skipped: { scheduleId: string; date: string; skipped: 'already_generated' | 'overlaps'; message?: string; covered?: CoveredPeriod[]; uncovered?: CoveredPeriod[] }[]
  // `message` is worded (in the UI language when the caller passes t); `detail` is the raw cause,
  // for the log only.
  errors: { scheduleId: string; message: string; code?: 'template_cancelled'; detail?: string }[]
}

// Issuing (number, archive copy, Drive) lives in the server-only src/lib/pdf/issue.ts. This module
// is also imported by client components for its date math, so the route handlers pass it in. It is
// called with `unattended`: a client a Claude session changed is refused there with code
// 'client_changed' just before the number is taken, and gets no archive copy (snapshotCode
// 'client_changed') should it change after that.
export type IssueDocumentFn = (supabase: SupabaseClient, documentId: string, opts: { unattended: true }) => Promise<{
  snapshotError: string | null
  snapshotCode?: string | null
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

// Whether a Claude session changed the client since the owner last saved it in Mado
// (clients.mcp_written_at, 20261105_mcp_drafts.sql). Issuing numbers what the client record says
// (the recipient block of the stored PDF, the e-invoice data) and the due date comes from its
// terms, so a schedule that issues automatically leaves such a client's invoice a draft until the
// owner has saved the client: no invoice is numbered with data Claude wrote without anyone
// approving it. Read afresh before each period is issued; a client read without the column (that
// migration not applied) has not been changed by Claude. A Claude write landing after this read is
// caught where it would be used: issueDocument checks the mark again just before the number is
// taken and in the read the archive copy is rendered from (`unattended`).
async function clientChangedByClaude(supabase: SupabaseClient, clientId: string): Promise<boolean> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle()
  if (error) throw new Error(error.message)
  return !!(data as { mcp_written_at?: string | null } | null)?.mcp_written_at
}

// How many days before its own date a period's invoice may move when that date is taken.
const MAX_DAYS_BACK = 6

type PeriodInvoice = { id: string; date: string; dueDate: string }

type PeriodOutcome =
  | { created: PeriodInvoice }
  // The period exists already (a retry after a crash, overlapping runs).
  | { exists: true }
  // Invoices of the schedule already cover some of its days (an edited schedule).
  | { overlaps: CoveredPeriod[] }

// Copies the template invoice into a new draft for the period dated `date`, unless an invoice of
// the schedule already covers a day of that period (found by service period: an issued catch-up
// period is dated today, see runSchedule): the very same period exists already, or the schedule was
// edited and the period overlaps one billed before; either way nothing is created, so no day is
// billed twice. When another invoice of the schedule already holds `date`
// (documents_recurring_period_key: one invoice per schedule and date, e.g. one moved to today by
// hand), the draft takes the nearest free day before it, so no period is skipped.
async function createPeriodInvoice(supabase: SupabaseClient, schedule: RecurringSchedule, source: SourceDocument, date: string, defaultPaymentDays: number | null): Promise<PeriodOutcome> {
  const period = periodOn(schedule, date)
  const paymentDays = paymentDaysOf(source, defaultPaymentDays)

  const { data: holders, error: lookupErr } = await supabase.from('documents').select('service_date, service_date_end')
    .eq('recurring_schedule_id', schedule.id).lte('service_date', period.end).gte('service_date_end', period.start)
  if (lookupErr) throw new Error(lookupErr.message)
  const covered = ((holders ?? []) as { service_date: string; service_date_end: string }[]).map(h => ({ start: h.service_date, end: h.service_date_end }))
  if (covered.some(c => c.start === period.start && c.end === period.end)) return { exists: true }
  if (covered.length) return { overlaps: covered }

  for (let back = 0; back <= MAX_DAYS_BACK; back++) {
    const day = shiftDays(date, -back)
    const created = await insertPeriodInvoice(supabase, schedule, source, day, shiftDays(day, paymentDays), period)
    if (created !== 'taken') return { created }
    const { data: holder, error: holderErr } = await supabase.from('documents').select('service_date, service_date_end')
      .eq('recurring_schedule_id', schedule.id).eq('date', day).limit(1).maybeSingle()
    if (holderErr) throw new Error(holderErr.message)
    if (!holder) throw new Error(`the invoice dated ${day} could not be read`)
    // An overlapping run has just created this very period.
    if (holder.service_date === period.start && holder.service_date_end === period.end) return { exists: true }
  }
  throw new Error(`no free date for the invoice of ${period.start} to ${period.end}`)
}

// 'taken' when another invoice of the schedule already has `date`. What is copied from the template
// here is what a Claude session may not change on the template of any recurring schedule
// (documents_mcp_template_guard in 20261105_mcp_drafts.sql): keep both lists alike. What comes
// from the client record instead (the due date from its terms, the recipient block at issue) is
// held back by clientChangedByClaude.
async function insertPeriodInvoice(supabase: SupabaseClient, schedule: RecurringSchedule, source: SourceDocument, date: string, dueDate: string, period: { start: string; end: string }): Promise<PeriodInvoice | 'taken'> {
  const { data: doc, error } = await supabase.from('documents').insert({
    type: 'invoice',
    status: 'draft',
    number: null,
    client_id: source.client_id,
    date,
    due_date: dueDate,
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
    if (error.code === '23505') return 'taken'
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
  return { id: doc.id as string, date, dueDate }
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
    dateTaken: (date: string) => t ? t('views.recurring.dateTaken', { date: day(date) }) : `${date}: created as draft, today's date is reserved for another invoice of this schedule`,
    dateHeld: (date: string, draftDate: string) => t
      ? t('views.recurring.dateHeld', { date: day(date), draftDate: day(draftDate) })
      : `${date}: created as draft dated ${draftDate}, another invoice of this schedule already has ${date}`,
    clientChanged: (date: string) => t
      ? t('views.recurring.clientChanged', { date: day(date) })
      : `${date}: created as draft, not issued: the client was changed from a Claude connection; check it and save it in Mado, then issue the draft`,
    overlaps: (date: string, period: CoveredPeriod, uncovered: CoveredPeriod[]) => {
      const range = (p: CoveredPeriod) => `${day(p.start)} – ${day(p.end)}`
      if (!t) return `${date}: not created, ${period.start} to ${period.end} overlaps an invoice this schedule already created${uncovered.length ? `; not billed: ${uncovered.map(p => `${p.start} to ${p.end}`).join(', ')}` : ''}`
      const vars = { date: day(date), start: day(period.start), end: day(period.end) }
      return uncovered.length
        ? t('views.recurring.overlapSkippedGap', { ...vars, gap: uncovered.map(range).join(', ') })
        : t('views.recurring.overlapSkipped', vars)
    },
    clientChangedIssued: (date: string) => t
      ? t('views.recurring.clientChangedIssued', { date: day(date) })
      : `${date}: issued, but no archive copy was made: the client was changed from a Claude connection while it was issued; check it and save it in Mado, then create the archive copy on the invoice's page`,
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
  // The manual button generates the upcoming period regardless of date: the first one no invoice of
  // the schedule covers yet, as planNextPeriod shows it. After that only catch-up. A period that
  // exists already ends it too (another run, the cron or a second tab, has just created it, or a
  // retry): the button then says so instead of creating the period after it ahead of its date.
  // Periods skipped as 'overlaps' (an edited schedule) do not: the first free one is created.
  let forced = force
  // A run creates up to MAX_PERIODS_PER_RUN invoices; skipping covered periods (one step for all
  // of them in a row, landing on a free one) does not count, so it never takes more than twice as
  // many steps.
  let periods = 0
  for (let i = 0; i < 2 * MAX_PERIODS_PER_RUN && periods < MAX_PERIODS_PER_RUN; i++) {
    if (!forced && next > asOf) break
    if (schedule.end_date && next > schedule.end_date) {
      const { error: endErr } = await supabase.from('recurring_schedules').update({ active: false }).eq('id', schedule.id)
      if (endErr) throw new Error(endErr.message)
      break
    }

    const outcome = await createPeriodInvoice(supabase, schedule, source as SourceDocument, next, defaultPaymentDays)
    const created = 'created' in outcome ? outcome.created : null
    const documentId = created?.id ?? null
    let advanced = advanceDate(next, schedule.interval, schedule.anchor_day)
    let unbilled: CoveredPeriod[] | null = null
    if (!created) {
      // Invoices of the schedule already cover the period at `next`: the very same period
      // ('already_generated', quietly) or part of it (the schedule was edited: 'overlaps', worded,
      // with the days left unbilled). This one and every following covered period are skipped in
      // one step, up to the one planNextPeriod names: the date the editor, the list and
      // list_recurring show.
      if ('exists' in outcome) forced = false
      const covered = (await coveredPeriods(supabase, [schedule.id])).get(schedule.id) ?? []
      if ('overlaps' in outcome) covered.push(...outcome.overlaps)
      const plan = planNextPeriod({ ...schedule, next_date: next, end_date: null }, covered)
      const skipped = plan.skipped.filter((p, k) => k === 0 || !schedule.end_date || p.date <= schedule.end_date)
      const partly = skipped.some(p => !covered.some(c => c.start === p.start && c.end === p.end))
      if (partly || ('overlaps' in outcome && !skipped.length)) {
        const own = periodOn(schedule, next)
        const span = { start: skipped[0]?.start ?? own.start, end: skipped[skipped.length - 1]?.end ?? own.end }
        const uncovered = joinRanges(skipped.flatMap(p => uncoveredIn(p, covered)))
        result.skipped.push({ scheduleId: schedule.id, date: next, skipped: 'overlaps', message: messages.overlaps(next, span, uncovered), covered: overlapping(covered, span), uncovered })
        // Kept on the schedule until an invoice covers them or the owner dismisses them (notBilled).
        if (uncovered.length) unbilled = await unbilledAfterSkip(supabase, schedule, covered, uncovered)
      } else {
        for (const p of skipped.length ? skipped : [{ date: next }]) result.skipped.push({ scheduleId: schedule.id, date: p.date, skipped: 'already_generated' })
      }
      if (plan.date > next) advanced = plan.date
    } else {
      periods++
      forced = false
      result.generated.push({ scheduleId: schedule.id, documentId: created.id, date: next })
      // Why the invoice stays a draft in 'issue' mode; the log says it in either mode.
      let held = created.date === next ? null : messages.dateHeld(next, created.date)
      let date = created.date
      // A client Claude changed: the draft keeps its period's dates (see clientChangedByClaude).
      // Otherwise an invoice is dated the day it is issued: a period caught up late is issued with
      // today's date and the due date from today, and keeps the period as its service period, so
      // it never gets a number after invoices dated later than it. The period key allows one
      // invoice per schedule and date, so only one catch-up can take today, and none when today is
      // a period date of the schedule itself. The others stay drafts at their period's date and
      // are reported: issued with that date, they would be dated before the day they were issued.
      if (schedule.mode === 'issue' && await clientChangedByClaude(supabase, (source as SourceDocument).client_id)) {
        held = messages.clientChanged(next)
      } else if (schedule.mode === 'issue' && next < asOf) {
        const later = advanceDate(next, schedule.interval, schedule.anchor_day)
        if (isUpcomingPeriodDate({ ...schedule, next_date: later }, asOf)) {
          held = messages.dateTaken(next)
        } else {
          const { error: dateErr } = await supabase.from('documents')
            .update({ date: asOf, due_date: shiftDays(asOf, paymentDaysOf(source as SourceDocument, defaultPaymentDays)) })
            .eq('id', created.id).is('number', null)
          if (dateErr?.code === '23505') held = messages.dateTaken(next)
          else if (dateErr) throw new Error(dateErr.message)
          else {
            date = asOf
            held = null
          }
        }
      }
      if (held) {
        result.errors.push({ scheduleId: schedule.id, message: held })
      } else if (schedule.mode === 'issue') {
        try {
          const { snapshotError, snapshotCode, driveError } = await issue(supabase, created.id, { unattended: true })
          if (snapshotError) {
            result.errors.push({ scheduleId: schedule.id, message: snapshotCode === 'client_changed' ? messages.clientChangedIssued(next) : messages.snapshot(next), detail: snapshotError })
          }
          if (driveError) result.errors.push({ scheduleId: schedule.id, message: messages.drive(next, driveError), detail: driveError.error })
        } catch (err) {
          // A client Claude changed after the check above: the invoice stays a draft, as held.
          const changed = !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'client_changed'
          result.errors.push({ scheduleId: schedule.id, message: changed ? messages.clientChanged(next) : messages.issue(next, err) })
          // The draft gets its period's dates back, as a failed bulk issue does.
          if (date !== created.date) {
            const { error: restoreErr } = await supabase.from('documents')
              .update({ date: created.date, due_date: created.dueDate })
              .eq('id', created.id).is('number', null)
            if (restoreErr) console.error(`[recurring] dates of ${created.id} not restored:`, restoreErr.message)
          }
        }
      }
    }

    // Only what this iteration changed goes into the update: last_* only when a document was
    // created here (an overlapping run must not overwrite them with a stale id), active only
    // when the schedule ended, so a Pause clicked mid-run is not undone, and unbilled only when
    // this iteration left days unbilled, always together with the move (dismissUnbilled relies
    // on that). And only while the schedule's periods are still the ones this run read: when the
    // owner edited its next date, interval or billing in advance meanwhile, or an overlapping run
    // moved it on, it stays as it is now and this run stops (the next run goes on from there).
    const ended = !!schedule.end_date && advanced > schedule.end_date
    const patch: Partial<RecurringSchedule> = { next_date: advanced }
    if (documentId) {
      patch.last_document_id = documentId
      patch.last_generated_at = new Date().toISOString()
    }
    if (ended) patch.active = false
    if (unbilled) patch.unbilled = unbilled
    const { data: moved, error: updErr } = await supabase.from('recurring_schedules').update(patch)
      .eq('id', schedule.id).eq('next_date', next).eq('interval', schedule.interval)
      .eq('anchor_day', schedule.anchor_day).eq('in_advance', schedule.in_advance)
      .select('id')
    if (updErr) throw new Error(updErr.message)
    if (!moved?.length) break

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
