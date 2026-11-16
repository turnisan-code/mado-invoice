// Statement lines on the server (PR 9a): a stored line read back as the engine's transaction and
// row, the bookings Bookamat has around the lines, and the one duplicate check the page shows and
// the booking applies — the same assignment of bookings to lines (each booking to one line), over
// every open line of the store, never a booking Mado recorded on another line.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankBookingKind, BankLine, BookingRule } from '@/types'
import { BookamatError, bookamatFetch, type BookamatCredentials } from '@/lib/bookamat'
import { vendorsOf } from './rules'
import { analyseCredit, analyseExpense, annotateDuplicates, duplicateWindow, type AnalysedLine } from './analyse'
import { transactionOfCells } from './csv-parser'
import { toBookingLite, yearsOf, type BookingLike, type BookingLite } from './duplicates'
import type { BookamatAccounts, EasybankTransaction, MatchedIncomeTransaction, MatchedTransaction, Vendor } from './types'

export const LINE_COLUMNS = 'id, line_key, cells, booked_on, amount, currency, statement_iban, status, review, receipt_path, receipt_name, bookamat_claim, bookamat_pending'

export type StoredLine = Pick<BankLine, 'id' | 'line_key' | 'cells' | 'booked_on' | 'amount' | 'currency' | 'statement_iban' | 'status' | 'review' | 'receipt_path' | 'receipt_name' | 'bookamat_claim' | 'bookamat_pending'>

export const lineKind = (line: Pick<BankLine, 'amount'>): BankBookingKind => (Number(line.amount) < 0 ? 'expense' : 'bank_income')
export const engineKind = (kind: BankBookingKind): 'expense' | 'income' => (kind === 'expense' ? 'expense' : 'income')

export function lineTransaction(line: Pick<BankLine, 'cells'>): EasybankTransaction {
  const tx = transactionOfCells(line.cells)
  if (!tx) throw new BookamatError('bookamat', 'This statement line cannot be read', 400)
  return tx
}

export type LineRow = { kind: 'expense'; row: MatchedTransaction } | { kind: 'bank_income'; row: MatchedIncomeTransaction }

// A line as the engine books it: the Analyse (lib/expenses/analyse.ts) with what the owner set
// on it — the rule picked, the fields, the split lines, the bookings said not to be it.
export function lineRow(line: Pick<BankLine, 'cells' | 'amount' | 'review' | 'receipt_path'>, vendors: readonly Vendor[], lists: BookamatAccounts | null): LineRow {
  const tx = lineTransaction(line)
  const review = line.review ?? {}
  const override = review.override ?? {}
  const ack = review.ack_duplicate_ids ?? []
  if (lineKind(line) === 'expense') {
    const row = analyseExpense(tx, vendors, lists, { ruleId: review.rule_id, receipt: !!line.receipt_path })
    return { kind: 'expense', row: { ...row, override, ...(review.lines?.length ? { booking_lines: review.lines } : {}), ack_duplicate_ids: ack } }
  }
  return { kind: 'bank_income', row: { ...analyseCredit(tx, vendors, lists), override, ack_duplicate_ids: ack } }
}

type ListPage = { results?: unknown; next?: unknown } | unknown[] | string | null

// Every booking dated in the window, year by year (Bookmatic lib/bookamat.ts
// getBookingsInWindow); a year Bookamat does not have has none. Deleted ones are left out. An
// answer that is no list of bookings with their lines fails the check: a duplicate check that
// cannot read Bookamat books nothing.
export async function readBookingsInWindow(creds: BookamatCredentials, w: { from: string; until: string }, deadline?: number): Promise<BookingLite[]> {
  const out: BookingLite[] = []
  for (const y of yearsOf(w)) {
    const from = w.from > `${y}-01-01` ? w.from : `${y}-01-01`
    const until = w.until < `${y}-12-31` ? w.until : `${y}-12-31`
    for (let page = 1; ; page++) {
      if (page > 20) throw new BookamatError('bookamat', `Too many bookings between ${from} and ${until}`)
      let res: ListPage
      try {
        res = await bookamatFetch<ListPage>(creds, y, `bookings/?date_from=${from}&date_until=${until}&limit=500${page > 1 ? `&page=${page}` : ''}&format=json`, { deadline })
      } catch (err) {
        if (page === 1 && err instanceof BookamatError && err.code === 'year_missing') break
        throw err
      }
      const list = Array.isArray(res) ? res : res && typeof res === 'object' && Array.isArray(res.results) ? res.results : null
      if (!list) throw new BookamatError('bookamat', `Bookamat ${y} did not answer with a list of bookings`)
      for (const raw of list as (BookingLike & { status?: unknown })[]) {
        if (!raw || typeof raw !== 'object' || !Number.isInteger(Number(raw.id)) || typeof raw.title !== 'string' || typeof raw.date !== 'string') {
          throw new BookamatError('bookamat', `Bookamat ${y} answered with a booking that cannot be read`)
        }
        if (String(raw.status ?? '1') === '3') continue
        if (!Array.isArray(raw.amounts)) throw new BookamatError('bookamat', `Bookamat ${y} answered booking #${raw.id} without its lines`)
        out.push(toBookingLite({ ...raw, id: Number(raw.id) }))
      }
      const next = Array.isArray(res) ? null : (res as { next?: unknown }).next
      if (!next || !list.length) break
    }
  }
  return out
}

// The bookings Mado recorded in these years: on documents (an invoice's payment, a credit note's
// refund) and on statement lines (by line)
export async function readRecorded(supabase: SupabaseClient, years: readonly number[]): Promise<{ onDocuments: Set<number>; onLines: Map<number, string> }> {
  const onDocuments = new Set<number>()
  const onLines = new Map<number, string>()
  if (!years.length) return { onDocuments, onLines }
  const { data, error } = await supabase.from('bookamat_bookings').select('year, booking_id, bank_line_id, document_id').in('year', [...years])
  if (error) throw new BookamatError('database', error.message)
  for (const r of (data ?? []) as { booking_id: string; bank_line_id: string | null; document_id: string | null }[]) {
    const id = Number(r.booking_id)
    if (!Number.isFinite(id)) continue
    if (r.bank_line_id) onLines.set(id, r.bank_line_id)
    else if (r.document_id) onDocuments.add(id)
  }
  return { onDocuments, onLines }
}

export type DuplicateCheck = {
  // Each given line's row with the booking it most likely repeats (lib/expenses/analyse.ts)
  rows: Map<string, MatchedTransaction | MatchedIncomeTransaction>
  // Bookings Mado recorded on a document: a line repeating one is that document's money
  onDocuments: Set<number>
  // Those bookings among the ones read (to check a line against them whatever the owner said)
  documentIndex: BookingLite[]
  failed: string | null
}

const dayBefore = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
const dayAfter = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// The duplicate check of `lines` (open, with their rows built): over these and every other open
// line of the store whose window meets theirs, in one fixed order, so the page and the booking
// give each booking to the same line. Bookings recorded on other lines are none of theirs.
export async function checkDuplicates(
  supabase: SupabaseClient,
  creds: BookamatCredentials,
  lines: readonly (StoredLine & { built: LineRow })[],
  rules: readonly BookingRule[],
  accounts: (year: number) => BookamatAccounts | null,
  deadline?: number,
): Promise<DuplicateCheck> {
  const rows = new Map<string, MatchedTransaction | MatchedIncomeTransaction>()
  const toAnalysed = (l: StoredLine, b: LineRow): AnalysedLine => (b.kind === 'expense'
    ? { kind: 'expense', row: b.row, override: l.review?.override, ack: l.review?.ack_duplicate_ids }
    : { kind: 'income', row: b.row, override: l.review?.override, ack: l.review?.ack_duplicate_ids })
  const given = lines.map(l => ({ line: l as StoredLine, built: l.built }))
  const w0 = duplicateWindow(given.map(g => toAnalysed(g.line, g.built)))
  if (!w0) {
    for (const g of given) rows.set(g.line.id, g.built.row)
    return { rows, onDocuments: new Set(), documentIndex: [], failed: null }
  }
  try {
    // The other open lines whose own window meets this one (5 days of card lag, the month back
    // of a day of payment)
    const { data, error } = await supabase.from('bank_lines').select(LINE_COLUMNS).eq('status', 'open')
      .gte('booked_on', dayBefore(w0.from, 40)).lte('booked_on', dayAfter(w0.until, 40)).order('booked_on').order('id').limit(3000)
    if (error) throw new BookamatError('database', error.message)
    const ids = new Set(given.map(g => g.line.id))
    const others = ((data ?? []) as StoredLine[]).filter(l => !ids.has(l.id)).flatMap(l => {
      try {
        // Their titles need no accounts: a rule's comes from its template
        const lists = accounts(Number(String(l.booked_on).slice(0, 4)))
        return [{ line: l, built: lineRow(l, vendorsOf(rules, lists), lists) }]
      } catch { return [] }
    })
    const all = [...given, ...others].sort((a, b) => String(a.line.booked_on).localeCompare(String(b.line.booked_on)) || a.line.id.localeCompare(b.line.id))
    const analysed = all.map(a => toAnalysed(a.line, a.built))
    const w = duplicateWindow(analysed)!
    const [bookings, recorded] = await Promise.all([readBookingsInWindow(creds, w, deadline), readRecorded(supabase, yearsOf(w))])
    const index = bookings.filter(b => !recorded.onLines.has(b.id))
    const checked = annotateDuplicates(analysed, index)
    all.forEach((a, k) => { if (ids.has(a.line.id)) rows.set(a.line.id, checked[k]) })
    return { rows, onDocuments: recorded.onDocuments, documentIndex: bookings.filter(b => recorded.onDocuments.has(b.id)), failed: null }
  } catch (err) {
    const failed = err instanceof Error ? err.message : String(err)
    for (const g of given) rows.set(g.line.id, { ...g.built.row, duplicate_check_failed: failed })
    return { rows, onDocuments: new Set(), documentIndex: [], failed }
  }
}
