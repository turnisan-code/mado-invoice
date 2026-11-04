// Issuing drafts: what issuing them would do (the numbers they would get, their dates, what to
// watch out for) and the run that issues them in date order, as the lists' bulk actions do. Every
// number still comes from issue_document (src/lib/pdf/issue.ts); nothing here reads cookies.
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkIssuable } from '@/lib/pdf/issue'
import { issueBulkDraft, lostEntries, startBulkIssue, todayIsPeriodDate, type BulkDraft, type BulkIssue } from '@/lib/pdf/bulk'
import { beforeLatest, issueOrder, movesToToday, type IssuedNote, type LatestIssued } from '@/lib/utils/bulk-issue'
import { clientDisplayName } from '@/lib/utils/clients'
import { addDays, calcTotals } from '@/lib/utils/document'
import { formatDocumentNumber, hasYearToken, nextCounter } from '@/lib/utils/numbering'
import { termDays } from '@/components/forms/builder/model'
import type { DocumentType, IssueProblem, Settings } from '@/types'

type DbError = { message: string; code?: string; details?: string | null }

// ─── Issuing ─────────────────────────────────────────────────────────────────

export type IssueDraft = BulkDraft & { type: DocumentType; created_at?: string | null }

export interface IssueRun<D extends IssueDraft> {
  notes: IssuedNote[]
  // The draft that could not be issued and why (IssueCheckError, a lifecycle refusal, …); the
  // drafts after it were not tried.
  failed: { draft: D; error: unknown } | null
  // Not tried because the deadline came too close.
  stopped: D[]
}

// Below this much time before the deadline no further draft is started: issuing one renders and
// stores its PDF and may archive it to Drive.
const MIN_ISSUE_MS = 15_000

// The newest issued document and the payment defaults of every type among the drafts, read
// before anything is issued, so a failed read stops the run before the first number.
export async function startIssueBatches(
  supabase: SupabaseClient,
  types: readonly DocumentType[],
  redate: boolean,
  today: string,
): Promise<{ batches: Partial<Record<DocumentType, BulkIssue>> } | { error: DbError }> {
  const batches: Partial<Record<DocumentType, BulkIssue>> = {}
  for (const type of new Set(types)) {
    const started = await startBulkIssue(supabase, type, redate, today)
    if ('error' in started) return { error: started.error }
    batches[type] = started.batch
  }
  return { batches }
}

// Issues the drafts oldest first (issueOrder), each through issueBulkDraft: moved to today when
// `redate` says so, numbered, frozen and archived. The first failure stops the run; what was
// issued before it stays issued.
export async function issueMany<D extends IssueDraft>(
  supabase: SupabaseClient,
  batches: Partial<Record<DocumentType, BulkIssue>>,
  drafts: readonly D[],
  opts: { deadline?: number | null } = {},
): Promise<IssueRun<D>> {
  const run: IssueRun<D> = { notes: [], failed: null, stopped: [] }
  const ordered = issueOrder(drafts)
  for (const [i, d] of ordered.entries()) {
    if (opts.deadline && opts.deadline - Date.now() < MIN_ISSUE_MS) {
      run.stopped = ordered.slice(i)
      break
    }
    try {
      run.notes.push(await issueBulkDraft(supabase, batches[d.type]!, d))
    } catch (error) {
      run.failed = { draft: d, error }
      break
    }
  }
  return run
}

// ─── What issuing would do ───────────────────────────────────────────────────

export const ISSUE_DRAFT_COLUMNS = [
  'id', 'type', 'number', 'status', 'date', 'due_date', 'created_at', 'client_id', 'language', 'currency', 'tax_treatment',
  'service_date', 'service_date_end', 'notes', 'discount_type', 'discount_value', 'skonto_percent', 'skonto_days',
  'invoice_kind', 'buyer_reference', 'converted_from_id', 'cancels_document_id', 'recurring_schedule_id',
  'clients(id, name, company, payment_days, uid_number, country)',
  'document_items(id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate, discount_type, discount_value, service_date, service_date_end, catalogue_item_id)',
  'payments(id, date, amount, kind)',
].join(', ')

export type IssueDraftRow = {
  id: string
  type: DocumentType
  number: string | null
  status: string
  date: string
  due_date: string | null
  created_at: string | null
  client_id: string | null
  language: string | null
  currency: string | null
  tax_treatment: string | null
  service_date: string | null
  service_date_end: string | null
  notes: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  skonto_percent: number | null
  skonto_days: number | null
  invoice_kind: string | null
  buyer_reference: string | null
  converted_from_id: string | null
  cancels_document_id: string | null
  recurring_schedule_id: string | null
  clients: { id: string; name: string; company: string | null; payment_days: number | null; uid_number: string | null; country: string | null } | null
  document_items: IssueDraftItem[] | null
  payments: { id: string; date: string; amount: number; kind: string | null }[] | null
}

export type IssueDraftItem = {
  id: string
  sort_order: number
  line_type: string | null
  description: string | null
  quantity: number | null
  unit: string | null
  unit_price: number | null
  vat_rate: number | null
  discount_type: string | null
  discount_value: number | null
  service_date: string | null
  service_date_end: string | null
  catalogue_item_id: string | null
}

// The documents as stored, in the order the ids were given; a missing one is absent.
export async function loadIssueDrafts(supabase: SupabaseClient, ids: readonly string[]): Promise<IssueDraftRow[]> {
  const { data, error } = await supabase.from('documents').select(ISSUE_DRAFT_COLUMNS).in('id', [...ids])
  if (error) throw error
  const rows = (data ?? []) as unknown as IssueDraftRow[]
  return ids.map(id => rows.find(r => r.id === id)).filter((r): r is IssueDraftRow => !!r)
}

export function draftTotal(d: Pick<IssueDraftRow, 'document_items' | 'discount_type' | 'discount_value' | 'tax_treatment'>): number {
  const discount = d.discount_type && d.discount_value ? { type: d.discount_type, value: d.discount_value } : null
  return calcTotals(d.document_items ?? [], [], discount, d.tax_treatment).total
}

type NumberingSettings = Pick<Settings,
  | 'invoice_number_format' | 'invoice_prefix' | 'next_invoice_number' | 'invoice_counter_year' | 'invoice_number_reset_yearly'
  | 'quote_number_format' | 'quote_prefix' | 'next_quote_number' | 'quote_counter_year' | 'quote_number_reset_yearly'
  | 'credit_note_number_format' | 'credit_note_prefix' | 'next_credit_note_number' | 'credit_note_counter_year' | 'credit_note_number_reset_yearly'
>
export type IssueSettings = NumberingSettings & Pick<Settings, 'default_payment_days' | 'default_quote_validity_days' | 'drive_folder_id' | 'gmail_refresh_token'>

// The numbering columns of one type, as next_document_number reads them.
export function numberingOf(settings: Partial<NumberingSettings>, type: DocumentType) {
  return {
    format: settings[`${type}_number_format`] ?? '',
    prefix: settings[`${type}_prefix`] ?? '',
    next: settings[`next_${type}_number`] ?? 1,
    counterYear: settings[`${type}_counter_year`] ?? null,
    resetYearly: !!settings[`${type}_number_reset_yearly`],
  }
}

const COUNTER_TOKEN = /\{N{1,4}\}/
const MAX_SKIPPED = 50

// A refusal as issue_document would raise it, so it is worded like one (MI002, MI003).
const numberingRefusal = (code: string, message: string, details = '') => Object.assign(new Error(message), { code, details })

// The numbers next_document_number would hand out, in this order, for documents of one type dated
// as given: the yearly restart, and numbers already taken skipped (MI002 for a closed year, MI003
// for a format without a counter, as the database refuses them).
export async function expectedNumbers(
  supabase: SupabaseClient,
  settings: Partial<NumberingSettings>,
  type: DocumentType,
  dates: readonly string[],
): Promise<string[]> {
  const n = numberingOf(settings, type)
  if (!COUNTER_TOKEN.test(n.format)) throw numberingRefusal('MI003', `The ${type} number format has no counter token`)
  let next = n.next
  let counterYear = n.counterYear
  const out: string[] = []
  for (const date of dates) {
    const year = Number(date.slice(0, 4))
    if (n.resetYearly && hasYearToken(n.format) && counterYear !== null && year < counterYear) {
      throw numberingRefusal('MI002', `Numbering for ${counterYear} has already started`, String(counterYear))
    }
    let num = nextCounter(next, counterYear, n.resetYearly, n.format, year)
    let candidate = formatDocumentNumber(n.format, n.prefix, num, date)
    for (let skipped = 0; skipped < MAX_SKIPPED && (out.includes(candidate) || await numberTaken(supabase, candidate)); skipped++) {
      num++
      candidate = formatDocumentNumber(n.format, n.prefix, num, date)
    }
    out.push(candidate)
    next = num + 1
    counterYear = Math.max(counterYear ?? year, year)
  }
  return out
}

async function numberTaken(supabase: SupabaseClient, number: string): Promise<boolean> {
  const { data, error } = await supabase.from('documents').select('id').eq('number', number).limit(1)
  if (error) throw error
  return !!data?.length
}

// The newest issued document of a type, as startBulkIssue reads it.
export async function latestIssuedOf(supabase: SupabaseClient, type: DocumentType): Promise<LatestIssued | null> {
  const { data, error } = await supabase.from('documents').select('number, date').eq('type', type).not('number', 'is', null)
    .order('date', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  return data?.number ? { number: data.number, date: data.date } : null
}

export interface IssuePreviewDoc {
  id: string
  type: DocumentType
  client: { id: string; name: string } | null
  currency: string
  // The draft's date, and the one it is issued with (today when it is moved).
  date: string
  issue_date: string
  due_date: string | null
  expected_number: string
  gross: number
  // Issued before this one is: the numbers no longer follow the dates.
  before_latest: LatestIssued | null
  // Stays on its date although it is older than today: its recurring schedule still has to
  // generate today's period.
  date_kept: boolean
  // Billed time entries and expenses no longer on one of its lines.
  unlinked: { time: number; expenses: number } | null
  zero_total: boolean
  // A credit note takes its amount off this invoice's open balance when issued.
  credits: { id: string; number: string | null } | null
}

export interface IssuePreview {
  documents: IssuePreviewDoc[]
  redate: boolean
  total_gross: number
  // Issuing archives each PDF to the Drive folder.
  drive: boolean
}

export class IssueRefusal extends Error {
  constructor(readonly reason: 'already_issued' | 'cancelled' | 'not_found', readonly documentId: string, readonly number: string | null = null) {
    super(reason)
  }
}

// What issuing the drafts would do, read only: nothing is moved, numbered or archived. Refuses
// what issuing would refuse (IssueRefusal; an incomplete draft as { code: 'incomplete', problems,
// details }; a date too far ahead MI001; a closed numbering year MI002).
export async function issuePreview(
  supabase: SupabaseClient,
  settings: IssueSettings,
  drafts: readonly IssueDraftRow[],
  { redate, today, latestIssued }: { redate: boolean; today: string; latestIssued?: ReadonlyMap<DocumentType, LatestIssued | null> },
): Promise<IssuePreview> {
  for (const d of drafts) {
    if (d.number) throw new IssueRefusal('already_issued', d.id, d.number)
    if (d.status === 'cancelled') throw new IssueRefusal('cancelled', d.id)
  }
  for (const d of drafts) {
    const problems: IssueProblem[] = await checkIssuable(supabase, d.id)
    if (problems.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', problems, details: { document_id: d.id } })
    if (d.date > addDays(today, 1)) {
      throw numberingRefusal('MI001', `The document date ${d.date} is in the future`)
    }
  }

  const terms = { default_payment_days: settings.default_payment_days ?? 14, default_quote_validity_days: settings.default_quote_validity_days ?? 14 }
  const ordered = issueOrder(drafts)
  const plans = new Map<string, { date: string; due: string | null; dateKept: boolean }>()
  for (const d of ordered) {
    let date = d.date
    let due = d.due_date
    let dateKept = false
    if (redate && movesToToday(d.date, today)) {
      if (d.recurring_schedule_id && await todayIsPeriodDate(supabase, d.recurring_schedule_id, today)) dateKept = true
      else {
        date = today
        if (d.type !== 'credit_note') due = addDays(today, termDays(d.type, terms, d.clients))
      }
    }
    // issue_document gives an invoice or quote without a due date one from the terms.
    if (!due && d.type !== 'credit_note') due = addDays(date, termDays(d.type, terms, d.clients))
    plans.set(d.id, { date, due, dateKept })
  }

  const numbers = new Map<string, string>()
  const latest = new Map<DocumentType, LatestIssued | null>()
  for (const type of new Set(ordered.map(d => d.type))) {
    const ofType = ordered.filter(d => d.type === type)
    const expected = await expectedNumbers(supabase, settings, type, ofType.map(d => plans.get(d.id)!.date))
    ofType.forEach((d, i) => numbers.set(d.id, expected[i]))
    latest.set(type, latestIssued?.has(type) ? latestIssued.get(type) ?? null : await latestIssuedOf(supabase, type))
  }

  const docs: IssuePreviewDoc[] = []
  for (const d of ordered) {
    const plan = plans.get(d.id)!
    const number = numbers.get(d.id)!
    const newest = latest.get(d.type) ?? null
    const earlier = beforeLatest(plan.date, newest) ? newest : null
    if (!newest || plan.date >= newest.date) latest.set(d.type, { number, date: plan.date })
    const gross = draftTotal(d)
    let credits: IssuePreviewDoc['credits'] = null
    if (d.type === 'credit_note' && d.converted_from_id) {
      const { data, error } = await supabase.from('documents').select('id, number').eq('id', d.converted_from_id).maybeSingle()
      if (error) throw error
      if (data) credits = { id: data.id, number: data.number }
    }
    docs.push({
      id: d.id,
      type: d.type,
      client: d.clients ? { id: d.clients.id, name: clientDisplayName(d.clients) } : null,
      currency: d.currency ?? 'EUR',
      date: d.date,
      issue_date: plan.date,
      due_date: plan.due,
      expected_number: number,
      gross,
      before_latest: earlier,
      date_kept: plan.dateKept,
      unlinked: d.type === 'invoice' ? await lostEntries(supabase, d.id) : null,
      zero_total: gross === 0,
      credits,
    })
  }
  return {
    documents: docs,
    redate,
    total_gross: Math.round(docs.reduce((s, d) => s + d.gross, 0) * 100) / 100,
    drive: !!settings.drive_folder_id && !!settings.gmail_refresh_token,
  }
}
