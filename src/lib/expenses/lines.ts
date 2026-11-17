// Statement lines on the server (PR 9a): a stored line read back as the engine's transaction and
// row, the bookings Bookamat has around the lines, and the one duplicate check the page shows and
// the booking applies — the same assignment of bookings to lines (each booking to one line), over
// every open line of the store, never a booking Mado recorded on another line.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankBookingKind, BankLine, BankLineReceiptSearch, BookingRule } from '@/types'
import { BookamatError, bookamatFetch, type BookamatCredentials } from '@/lib/bookamat'
import { vendorsOf } from './rules'
import { analyseCredit, analyseExpense, annotateDuplicates, duplicateWindow, type AnalysedLine, type StoredGmailFind } from './analyse'
import { withGmailCandidate } from './gmail-attach'
import { transactionOfCells } from './csv-parser'
import { toBookingLite, yearsOf, type BookingLike, type BookingLite } from './duplicates'
import type { BookamatAccounts, DuplicateInfo, EasybankTransaction, MatchedIncomeTransaction, MatchedTransaction, Vendor } from './types'

export const LINE_COLUMNS = 'id, line_key, cells, booked_on, amount, currency, statement_iban, status, review, receipt_path, receipt_name, receipt_search, receipt_gmail, bookamat_claim, bookamat_pending'

export type StoredLine = Pick<BankLine, 'id' | 'line_key' | 'cells' | 'booked_on' | 'amount' | 'currency' | 'statement_iban' | 'status' | 'review' | 'receipt_path' | 'receipt_name' | 'receipt_search' | 'receipt_gmail' | 'bookamat_claim' | 'bookamat_pending'>

export const lineKind = (line: Pick<BankLine, 'amount'>): BankBookingKind => (Number(line.amount) < 0 ? 'expense' : 'bank_income')
export const engineKind = (kind: BankBookingKind): 'expense' | 'income' => (kind === 'expense' ? 'expense' : 'income')

export function lineTransaction(line: Pick<BankLine, 'cells'>): EasybankTransaction {
  const tx = transactionOfCells(line.cells)
  if (!tx) throw new BookamatError('bookamat', 'Diese Kontozeile ist nicht lesbar', 400)
  return tx
}

export type LineRow = { kind: 'expense'; row: MatchedTransaction } | { kind: 'bank_income'; row: MatchedIncomeTransaction }

// A line as the engine books it: the Analyse (lib/expenses/analyse.ts) with what the owner set
// on it — the rule picked, the fields, the split lines, the bookings said not to be it.
export function lineRow(
  line: Pick<BankLine, 'cells' | 'amount' | 'review' | 'receipt_path'> & Partial<Pick<BankLine, 'receipt_search' | 'receipt_gmail'>>,
  vendors: readonly Vendor[], lists: BookamatAccounts | null,
): LineRow {
  const tx = lineTransaction(line)
  const review = line.review ?? {}
  const override = review.override ?? {}
  const ack = review.ack_duplicate_ids ?? []
  if (lineKind(line) === 'expense') {
    // The receipt the line's Gmail search attached, with what it found (PR 9b); a PDF of its list
    // the owner attached („Anhängen“) as Bookmatic's page made it the row's (lib/expenses/gmail-attach.ts)
    const found = storedFind(line.receipt_search ?? null)
    const fromList = line.receipt_gmail ?? null
    let row = analyseExpense(tx, vendors, lists, { ruleId: review.rule_id, receipt: !!line.receipt_path && !fromList && !found?.chosen, found })
    if (fromList) row = withGmailCandidate(row, fromList.candidate, { name: fromList.name, extracted: fromList.extracted, unreadable: fromList.unreadable })
    return { kind: 'expense', row: { ...row, override, ...(review.lines?.length ? { booking_lines: review.lines } : {}), ack_duplicate_ids: ack } }
  }
  return { kind: 'bank_income', row: { ...analyseCredit(tx, vendors, lists), override, ack_duplicate_ids: ack } }
}

// A line's stored search as the row reads it (lib/expenses/analyse.ts StoredGmailFind)
export function storedFind(search: BankLineReceiptSearch | null): StoredGmailFind | null {
  if (!search) return null
  const c = search.chosen
  return {
    chosen: c ? { messageId: c.message_id, partId: c.part_id, fileName: c.file_name, subject: c.subject, date: c.date, via: c.via, bodyText: c.body_text ?? '' } : null,
    check: c ? search.check : null,
    read: c ? search.read : null,
    text: c ? search.text : null,
    note: search.note,
    plainNote: search.plain_note,
    candidates: search.candidates ?? [],
    failed: search.failed ?? [],
  }
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
      if (page > 20) throw new BookamatError('bookamat', `Zu viele Buchungen zwischen ${from} und ${until}`)
      let res: ListPage
      try {
        res = await bookamatFetch<ListPage>(creds, y, `bookings/?date_from=${from}&date_until=${until}&limit=500${page > 1 ? `&page=${page}` : ''}&format=json`, { deadline })
      } catch (err) {
        if (page === 1 && err instanceof BookamatError && err.code === 'year_missing') break
        throw err
      }
      const list = Array.isArray(res) ? res : res && typeof res === 'object' && Array.isArray(res.results) ? res.results : null
      if (!list) throw new BookamatError('bookamat', `Bookamat ${y} hat keine Liste von Buchungen geliefert`)
      for (const raw of list as (BookingLike & { status?: unknown })[]) {
        if (!raw || typeof raw !== 'object' || !Number.isInteger(Number(raw.id)) || typeof raw.title !== 'string' || typeof raw.date !== 'string') {
          throw new BookamatError('bookamat', `Bookamat ${y} hat eine Buchung geliefert, die nicht lesbar ist`)
        }
        if (String(raw.status ?? '1') === '3') continue
        if (!Array.isArray(raw.amounts)) throw new BookamatError('bookamat', `Bookamat ${y} hat Buchung #${raw.id} ohne ihre Zeilen geliefert`)
        out.push(toBookingLite({ ...raw, id: Number(raw.id) }))
      }
      const next = Array.isArray(res) ? null : (res as { next?: unknown }).next
      if (!next || !list.length) break
    }
  }
  return out
}

const PAGE = 1000

export type Recorded = {
  // Bookings Mado recorded on a document (an invoice's payment, a credit note's refund)
  onDocuments: Set<number>
  // Bookings Mado recorded on a statement line, by line
  onLines: Map<number, string>
  // Those document bookings whose payment the statement import recorded (payments.import_ref):
  // the money of that statement line, accounted for there, and no other line's
  ofImportedPayment: Set<number>
}

// The bookings Mado recorded in these years, read page by page
export async function readRecorded(supabase: SupabaseClient, years: readonly number[]): Promise<Recorded> {
  const onDocuments = new Set<number>()
  const onLines = new Map<number, string>()
  const ofImportedPayment = new Set<number>()
  if (!years.length) return { onDocuments, onLines, ofImportedPayment }
  const byPayment = new Map<string, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('bookamat_bookings').select('id, year, booking_id, bank_line_id, document_id, payment_id')
      .in('year', [...years]).order('id').range(from, from + PAGE - 1)
    if (error) throw new BookamatError('database', error.message)
    const rows = (data ?? []) as { booking_id: string; bank_line_id: string | null; document_id: string | null; payment_id: string | null }[]
    for (const r of rows) {
      const id = Number(r.booking_id)
      if (!Number.isFinite(id)) continue
      if (r.bank_line_id) onLines.set(id, r.bank_line_id)
      else if (r.document_id) {
        onDocuments.add(id)
        if (r.payment_id) byPayment.set(r.payment_id, id)
      }
    }
    if (rows.length < PAGE) break
  }
  const paymentIds = [...byPayment.keys()]
  for (let i = 0; i < paymentIds.length; i += 200) {
    const { data, error } = await supabase.from('payments').select('id, import_ref').in('id', paymentIds.slice(i, i + 200))
    if (error) throw new BookamatError('database', error.message)
    for (const p of (data ?? []) as { id: string; import_ref: string | null }[]) {
      if (p.import_ref) ofImportedPayment.add(byPayment.get(p.id)!)
    }
  }
  return { onDocuments, onLines, ofImportedPayment }
}

export type DuplicateCheck = {
  // Each given line's row with the booking it most likely repeats (lib/expenses/analyse.ts)
  rows: Map<string, MatchedTransaction | MatchedIncomeTransaction>
  // The lines whose booking — as if the owner had said nothing about it — is one Mado recorded on
  // a document: that document's money, never booked from the line
  documentMatches: Map<string, DuplicateInfo>
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
    return { rows, documentMatches: new Map(), failed: null }
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
    // Bookings recorded on a line, or of a payment the statement import recorded, are those lines'
    const index = bookings.filter(b => !recorded.onLines.has(b.id) && !recorded.ofImportedPayment.has(b.id))
    const checked = annotateDuplicates(analysed, index)
    // The same assignment without what the owner said: a document's booking stays its own
    const bare = annotateDuplicates(analysed.map(a => ({ ...a, ack: [] })), index)
    const documentMatches = new Map<string, DuplicateInfo>()
    all.forEach((a, k) => {
      if (!ids.has(a.line.id)) return
      rows.set(a.line.id, checked[k])
      const m = bare[k].duplicate_of
      if (m && recorded.onDocuments.has(m.id)) documentMatches.set(a.line.id, m)
    })
    return { rows, documentMatches, failed: null }
  } catch (err) {
    const failed = err instanceof Error ? err.message : String(err)
    for (const g of given) rows.set(g.line.id, { ...g.built.row, duplicate_check_failed: failed })
    return { rows, documentMatches: new Map(), failed }
  }
}

// Whether the booking attaches the line's Beleg: one uploaded by hand always; one from Gmail only
// while the row keeps it (a pick of another rule drops a receipt its sender did not send,
// lib/expenses/rule-match.ts pickRule)
export function receiptKept(
  line: Pick<BankLine, 'receipt_path'> & Partial<Pick<BankLine, 'receipt_search' | 'receipt_gmail'>>,
  row: { gmail_message_id?: string | null } | null | undefined,
): boolean {
  if (!line.receipt_path) return false
  if (!line.receipt_search?.chosen && !line.receipt_gmail) return true
  return !!row?.gmail_message_id
}
