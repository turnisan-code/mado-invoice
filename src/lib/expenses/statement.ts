// A statement's lines on the server (PR 9a): stored once each (bank_lines, keyed by the
// parser's line id), and analysed for the „Kontoauszug“ page — the Analyse of every line with
// what the owner set on it, the year's accounts, and the bookings Bookamat already has.
// Everything the engine reads is rebuilt from the line's cells: an amount, a date or a name the
// page sends is never taken.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankLine, BookingRule } from '@/types'
import { BookamatError, credentialsOf } from '@/lib/bookamat'
import { readExpenseAccounts } from './accounts'
import { vendorsOf } from './rules'
import { annotateDuplicates, duplicateWindow, type AnalysedLine } from './analyse'
import { lineKind, lineRow, lineTransaction, readBookingsInWindow, type LineSettings } from './book'
import { transactionOfCells } from './csv-parser'
import { bookingDateOf } from './booking-dates'
import { expenseOwnerOf, setExpenseOwner } from './owner'
import type { BookamatAccounts, MatchedIncomeTransaction, MatchedTransaction } from './types'

export const MAX_LINES = 3000
const CHUNK = 200

export type LineInput = { key: string; cells: string[] }

const dayOf = (raw: string | undefined): string | null => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((raw ?? '').trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

// The stored row of a line, from its cells; null when they are no transaction
export function lineRecord(input: LineInput): Omit<BankLine, 'id' | 'review' | 'receipt_path' | 'receipt_name' | 'bookamat_claim' | 'bookamat_pending' | 'status' | 'created_at' | 'updated_at'> | null {
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

export const LINE_SELECT = 'id, line_key, cells, statement_iban, booked_on, value_on, amount, currency, counterparty, bank_text, fee, status, review, receipt_path, receipt_name, bookamat_claim, bookamat_pending, created_at, updated_at'

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

// A line as the page shows it: the stored line (without its cells' raw text twice), its kind,
// the year it is booked in, the Analyse (with the bookings Bookamat has), and its booking
export type LineView = {
  line: Omit<BankLine, 'cells'>
  kind: 'expense' | 'bank_income'
  year: number
  // A credit recorded on an invoice in the „Einnahmen“ tab
  invoicePayment: boolean
  row: MatchedTransaction | MatchedIncomeTransaction
  booking: { year: number; booking_id: string; pdf_attached_at: string | null } | null
}

export type StatementView = {
  lines: LineView[]
  accounts: Record<number, BookamatAccounts>
  // A year whose accounts Bookamat did not give: its lines are analysed without them
  accountsErrors: Record<number, string>
  unreadable: number
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

  const planned = lines.map(line => {
    const tx = lineTransaction(line)
    const kind = lineKind(line)
    return { line, kind, year: Number(bookingDateOf(tx, line.review?.override, kind === 'expense' ? 'expense' : 'income').slice(0, 4)) }
  })
  const accounts: Record<number, BookamatAccounts> = {}
  const accountsErrors: Record<number, string> = {}
  for (const year of [...new Set(planned.map(p => p.year))]) {
    try { accounts[year] = await readExpenseAccounts(creds, year, opts.deadline) } catch (err) { accountsErrors[year] = err instanceof Error ? err.message : String(err) }
  }

  const built = planned.map(p => {
    const lists = accounts[p.year] ?? null
    return { ...p, built: lineRow(p.line, vendorsOf(rules, lists), lists) }
  })
  // Bookamat's bookings of the lines still to book: read once
  const open = built.filter(b => b.line.status === 'open' && !(b.kind === 'bank_income' && paid.has(b.line.line_key)))
  const analysed: AnalysedLine[] = open.map(b => (b.built.kind === 'expense'
    ? { kind: 'expense', row: b.built.row, override: b.line.review?.override, ack: b.line.review?.ack_duplicate_ids }
    : { kind: 'income', row: b.built.row, override: b.line.review?.override, ack: b.line.review?.ack_duplicate_ids }))
  const w = duplicateWindow(analysed)
  let checked: (MatchedTransaction | MatchedIncomeTransaction)[] = analysed.map(a => a.row)
  if (w) {
    try {
      checked = annotateDuplicates(analysed, await readBookingsInWindow(creds, w, opts.deadline))
    } catch (err) {
      checked = annotateDuplicates(analysed, null, err instanceof Error ? err.message : String(err))
    }
  }
  const rowOf = new Map(open.map((b, k) => [b.line.id, checked[k]]))

  return {
    lines: built.map(b => {
      const { cells: _cells, ...line } = b.line
      void _cells
      return {
        line, kind: b.kind, year: b.year, invoicePayment: paid.has(b.line.line_key),
        row: rowOf.get(b.line.id) ?? b.built.row, booking: bookingOf.get(b.line.id) ?? null,
      }
    }),
    accounts,
    accountsErrors,
    unreadable: opts.unreadable ?? 0,
  }
}

// The lines still open, oldest first (the page without a file: what is left to do)
export async function openLines(supabase: SupabaseClient, limit = 500): Promise<BankLine[]> {
  const { data, error } = await supabase.from('bank_lines').select(LINE_SELECT).eq('status', 'open').order('booked_on').order('id').limit(limit)
  if (error) throw new BookamatError('database', error.message)
  return (data ?? []) as BankLine[]
}
