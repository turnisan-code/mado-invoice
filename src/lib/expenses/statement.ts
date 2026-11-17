// A statement's lines on the server (PR 9a): stored once each (bank_lines, keyed by the
// parser's line id), and analysed for the „Kontoauszug“ page — the Analyse of every line with
// what the owner set on it, the year's accounts, the bookings Bookamat already has (the one
// check the booking applies too, lib/expenses/lines.ts), and what keeps a line from being
// booked here. Everything the engine reads is rebuilt from the line's cells: an amount, a date
// or a name the page sends is never taken.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankLine, BookingRule } from '@/types'
import { BookamatError, credentialsOf } from '@/lib/bookamat'
import { readExpenseAccounts } from './accounts'
import { vendorsOf } from './rules'
import { checkDuplicates, engineKind, lineKind, lineRow, lineTransaction, receiptKept, type LineRow, type StoredLine } from './lines'
import { LINE_TEXT, type LineSettings } from './book'
import { transactionOfCells } from './csv-parser'
import { bookingDateOf } from './booking-dates'
import { normIban } from './own-transfer'
import { expenseOwnerOf, setExpenseOwner } from './owner'
import { madoDocumentText, namedDocument, readMadoNumbers } from './mado-numbers'
import { receiptSearchForPage } from './receipt-state'
import type { BookamatAccounts, EasybankTransaction, MatchedIncomeTransaction, MatchedTransaction } from './types'

export { MAX_LINES } from './limits'
const CHUNK = 200

export type LineInput = { key: string; cells: string[] }

const dayOf = (raw: string | undefined): string | null => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((raw ?? '').trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

// The stored row of a line, from its cells; null when they are no transaction
export function lineRecord(input: LineInput): Omit<BankLine, 'id' | 'review' | 'receipt_path' | 'receipt_name' | 'receipt_search' | 'receipt_gmail' | 'bookamat_claim' | 'bookamat_pending' | 'status' | 'created_at' | 'updated_at'> | null {
  const tx = transactionOfCells(input.cells)
  if (!tx) return null
  return {
    line_key: input.key,
    cells: input.cells,
    statement_iban: (input.cells[0] ?? '').replace(/\s+/g, '').toUpperCase(),
    booked_on: tx.date,
    value_on: dayOf(input.cells[3]),
    amount: tx.type === 'expense' ? -tx.amount : tx.amount,
    currency: tx.currency || 'EUR',
    counterparty: tx.counterparty.slice(0, 200),
    bank_text: (input.cells[1] ?? '').slice(0, 2000),
    fee: tx.fee ?? null,
  }
}

export const LINE_SELECT = 'id, line_key, cells, statement_iban, booked_on, value_on, amount, currency, counterparty, bank_text, fee, status, review, receipt_path, receipt_name, receipt_search, receipt_gmail, bookamat_claim, bookamat_pending, created_at, updated_at'

// Stores the lines it has not seen (a line's review and status stay as they are) and returns
// every line of these keys, in the order given. Lines whose cells are no transaction are left
// out and counted.
export async function storeLines(supabase: SupabaseClient, inputs: readonly LineInput[]): Promise<{ lines: BankLine[]; unreadable: number }> {
  const records = inputs.map(lineRecord)
  const rows = records.filter((r): r is NonNullable<typeof r> => !!r)
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from('bank_lines').upsert(rows.slice(i, i + CHUNK), { onConflict: 'line_key', ignoreDuplicates: true })
    if (error) throw new BookamatError('database', error.message)
  }
  const keys = rows.map(r => r.line_key)
  const found = new Map<string, BankLine>()
  for (let i = 0; i < keys.length; i += CHUNK) {
    const { data, error } = await supabase.from('bank_lines').select(LINE_SELECT).in('line_key', keys.slice(i, i + CHUNK))
    if (error) throw new BookamatError('database', error.message)
    for (const l of (data ?? []) as BankLine[]) found.set(l.line_key, l)
  }
  return { lines: keys.map(k => found.get(k)).filter((l): l is BankLine => !!l), unreadable: records.length - rows.length }
}

// A line as the page shows it: the stored line (without its cells and its text a second time),
// its kind, the year it is booked in, the Analyse with the bookings Bookamat has, its booking,
// and what keeps it from being booked here
export type LineView = {
  line: Omit<BankLine, 'cells' | 'bank_text'>
  kind: 'expense' | 'bank_income'
  year: number
  // A credit recorded on an invoice in the „Einnahmen“ tab
  invoicePayment: boolean
  // A Mado document the line is the money of: its text names one (lib/expenses/mado-numbers.ts),
  // or Bookamat's booking of it is recorded on one. Never booked here.
  madoDocument: string | null
  // Why the booking refuses the line whatever the owner sets (the switch-over date, an account
  // that is no business account, another currency), else null
  gate: string | null
  // The account and currency part of it alone (the switch-over aside): a line Mado never books,
  // whose receipt is never searched in Gmail (PR 9b)
  accountGate: string | null
  // A receipt from Gmail the row dropped (the rule picked did not send it): never attached (PR 9b)
  receiptDropped: boolean
  row: MatchedTransaction | MatchedIncomeTransaction
  booking: { year: number; booking_id: string; pdf_attached_at: string | null } | null
}

export type StatementView = {
  lines: LineView[]
  accounts: Record<number, BookamatAccounts>
  // A year whose accounts Bookamat did not give: its lines are analysed without them
  accountsErrors: Record<number, string>
  unreadable: number
  // From when Mado books statement lines (Einstellungen → Buchungsregeln); null: not yet
  switchFrom: string | null
}

export async function analyseStored(
  supabase: SupabaseClient, settings: LineSettings, lines: readonly BankLine[], opts: { deadline?: number; unreadable?: number } = {},
): Promise<StatementView> {
  setExpenseOwner(expenseOwnerOf(settings))
  const creds = credentialsOf(settings)
  const { data: ruleData, error: ruleErr } = await supabase.from('booking_rules').select('*').order('name').order('id')
  if (ruleErr) throw new BookamatError('database', ruleErr.message)
  const rules = (ruleData ?? []) as BookingRule[]

  const ids = lines.map(l => l.id)
  const keys = lines.map(l => l.line_key)
  const bookingOf = new Map<string, LineView['booking']>()
  const paid = new Set<string>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const [b, p] = await Promise.all([
      supabase.from('bookamat_bookings').select('bank_line_id, year, booking_id, pdf_attached_at').in('bank_line_id', ids.slice(i, i + CHUNK)),
      supabase.from('payments').select('import_ref').in('import_ref', keys.slice(i, i + CHUNK)),
    ])
    if (b.error) throw new BookamatError('database', b.error.message)
    if (p.error) throw new BookamatError('database', p.error.message)
    for (const r of (b.data ?? []) as { bank_line_id: string; year: number; booking_id: string; pdf_attached_at: string | null }[]) {
      bookingOf.set(r.bank_line_id, { year: r.year, booking_id: String(r.booking_id), pdf_attached_at: r.pdf_attached_at })
    }
    for (const r of (p.data ?? []) as { import_ref: string }[]) paid.add(r.import_ref)
  }

  const numbers = await readMadoNumbers(supabase)
  const planned = lines.flatMap(line => {
    try {
      const tx = lineTransaction(line)
      const kind = lineKind(line)
      const named = namedDocument(tx, numbers)
      return [{ line, tx, kind, year: Number(bookingDateOf(tx, line.review?.override, engineKind(kind)).slice(0, 4)), madoDocument: named ? madoDocumentText(named, kind === 'bank_income') : null }]
    } catch { return [] }
  })
  const accounts: Record<number, BookamatAccounts> = {}
  const accountsErrors: Record<number, string> = {}
  for (const year of [...new Set(planned.map(p => p.year))]) {
    try { accounts[year] = await readExpenseAccounts(creds, year, opts.deadline) } catch (err) { accountsErrors[year] = err instanceof Error ? err.message : String(err) }
  }
  const listsOf = (year: number) => accounts[year] ?? null

  const built = planned.map(p => ({ ...p, built: lineRow(p.line, vendorsOf(rules, listsOf(p.year)), listsOf(p.year)) as LineRow }))
  // Bookamat's bookings of the lines still to book: the booking's own check
  const open = built.filter(b => b.line.status === 'open' && !b.madoDocument && !(b.kind === 'bank_income' && paid.has(b.line.line_key)))
  const dup = await checkDuplicates(supabase, creds, open.map(b => ({ ...(b.line as StoredLine), built: b.built })), rules, listsOf, opts.deadline)

  const gateOf = (b: (typeof built)[number]): string | null => {
    if (!settings.expenses_from) return LINE_TEXT.notSwitched
    if (String(b.line.booked_on) < settings.expenses_from) return LINE_TEXT.beforeSwitch(settings.expenses_from)
    return accountGate(settings, b.tx, listsOf(b.year))
  }

  return {
    lines: built.map(b => {
      const { cells: _cells, bank_text: _text, ...stored } = b.line
      void _cells; void _text
      // The receipt's text and its e-mail's stay on the server (the row has what the page shows)
      const line = {
        ...stored,
        receipt_search: receiptSearchForPage(stored.receipt_search),
        receipt_gmail: stored.receipt_gmail ? { ...stored.receipt_gmail, text: null } : null,
      }
      const row = dup.rows.get(b.line.id) ?? b.built.row
      // A booking of this payment that Mado recorded on a document: that document's money,
      // whatever the owner said about it
      const docBooking = b.line.status === 'open' ? dup.documentMatches.get(b.line.id) : undefined
      const madoDocument = b.madoDocument ?? (docBooking ? LINE_TEXT.madoBooking(docBooking.title, docBooking.id) : null)
      return {
        line, kind: b.kind, year: b.year, invoicePayment: paid.has(b.line.line_key), madoDocument,
        gate: b.line.status === 'open' ? gateOf(b) : null, accountGate: accountGate(settings, b.tx, listsOf(b.year)),
        receiptDropped: b.kind === 'expense' && !!b.line.receipt_path && !receiptKept(b.line, b.built.row as MatchedTransaction),
        row, booking: bookingOf.get(b.line.id) ?? null,
      }
    }),
    accounts,
    accountsErrors,
    unreadable: opts.unreadable ?? 0,
    switchFrom: settings.expenses_from ?? null,
  }
}

// Whether the line's account and currency let Mado book it at all, the switch-over aside: a
// business account (the IBAN on the invoices, one under „Eigene Konten“, or one Bookamat keeps on
// a Zahlungsmittelkonto) and euro; else why not
export function accountGate(settings: Pick<LineSettings, 'iban' | 'own_ibans'>, tx: EasybankTransaction, lists: Pick<BookamatAccounts, 'bank_accounts'> | null): string | null {
  const own = [settings.iban ?? '', ...(settings.own_ibans ?? [])].map(normIban)
  const iban = normIban(tx.raw?.col0)
  const business = !!iban && (own.includes(iban) || (lists?.bank_accounts ?? []).some(a => normIban(a.iban) === iban))
  if (!business) return LINE_TEXT.notBusiness(iban)
  const currency = (tx.currency || 'EUR').trim().toUpperCase()
  if (currency !== 'EUR') return LINE_TEXT.currency(currency)
  return null
}

// The debits still open, the newest first (the page without a file: what is left to do). A
// credit needs the statement to tell an invoice's payment from other money.
export async function openLines(supabase: SupabaseClient, limit = 500): Promise<BankLine[]> {
  const { data, error } = await supabase.from('bank_lines').select(LINE_SELECT).eq('status', 'open').lt('amount', 0)
    .order('booked_on', { ascending: false }).order('id').limit(limit)
  if (error) throw new BookamatError('database', error.message)
  return ((data ?? []) as BankLine[]).reverse()
}
