// Booking statement lines in Bookamat (PR 9a): Bookmatic's booking route (app/api/bookings/
// route.ts) per line — the refusals, the payload and its checks, the duplicate check that
// books nothing while it cannot run, the self-heal of a refused booking, the Beleg — with the
// guards Mado's own sync has (8a/8b) around the post: a claim per line, a journal written
// before the post, the lost answer looked up before anything is posted again, and the
// booking recorded once (bookamat_bookings, bank_lines_booking_guard).
//
// Only the owner books, from the „Kontoauszug“ page: no daily job, and Claude cannot (D9).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankBookingKind, BankLine, BankLinePending, BookingRule } from '@/types'
import {
  BookamatError, bookamatFetch, conflictBookingId, credentialsOf, findBooking, validId,
  type BookamatCredentials, type BookamatSettings,
} from '@/lib/bookamat'
import { readExpenseAccounts } from './accounts'
import { vendorsOf } from './rules'
import { analyseCredit, analyseExpense, lineBankAccountId } from './analyse'
import { transactionOfCells } from './csv-parser'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, payloadContext } from './booking-payload'
import { blockingProblems, problemText, validatePayload, type BookingProblem } from './booking-validation'
import { assignDuplicates, bankRows, nearBankDate, toBookingLite, yearsOf, windowFor, type BookingLike, type BookingLite, type DuplicateMatch } from './duplicates'
import { bookingDateOf, payDay } from './booking-dates'
import { adaptBookingPayload, safeAttachmentName } from './adapt-payload'
import { attachmentName } from './attachment'
import { ruleChoiceReason } from './rule-match'
import { resolveIncomeDefaults } from './row-defaults'
import { refundNote } from './refunds'
import { expenseOwnerOf, setExpenseOwner, type OwnerSettings } from './owner'
import type { BookamatAccounts, BookingPayload, EasybankTransaction, MatchedIncomeTransaction, MatchedTransaction, Vendor } from './types'

export const CLAIM_TTL_MS = 3 * 60_000
const MAX_TRIES = 4

export type LineSettings = BookamatSettings & OwnerSettings

export const lineKind = (line: Pick<BankLine, 'amount'>): BankBookingKind => (Number(line.amount) < 0 ? 'expense' : 'bank_income')

export function lineTransaction(line: Pick<BankLine, 'cells'>): EasybankTransaction {
  const tx = transactionOfCells(line.cells)
  if (!tx) throw new BookamatError('bookamat', 'This statement line cannot be read', 400)
  return tx
}

// A line as the engine books it: the Analyse (lib/expenses/analyse.ts) with what the owner set
// on it — the rule picked, the fields, the split lines, the bookings said not to be it.
export function lineRow(
  line: Pick<BankLine, 'cells' | 'amount' | 'review' | 'receipt_path'>, vendors: readonly Vendor[], lists: BookamatAccounts | null,
): { kind: 'expense'; row: MatchedTransaction } | { kind: 'bank_income'; row: MatchedIncomeTransaction } {
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

// ─── Bookamat's bookings around the lines ────────────────────────────────────

type ListPage = { results?: unknown[]; next?: string | null } | unknown[] | null

// Every booking dated in the window, year by year (Bookmatic lib/bookamat.ts
// getBookingsInWindow); a year Bookamat does not have has none. Deleted ones are left out.
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
      const results = (Array.isArray(res) ? res : res?.results ?? []) as (BookingLike & { status?: unknown })[]
      out.push(...results.filter(b => b && Number.isInteger(Number(b.id)) && String(b.status ?? '1') !== '3').map(b => toBookingLite({ ...b, id: Number(b.id) })))
      if (Array.isArray(res) || !res?.next || !results.length) break
    }
  }
  return out
}

// ─── Booking ─────────────────────────────────────────────────────────────────

export type LineResult =
  | { id: string; status: 'booked'; bookingId: string; year: number; date: string; title: string; corrections: string[]; receiptError: string | null; recovered?: true; problems?: BookingProblem[] }
  | { id: string; status: 'duplicate'; existing: DuplicateMatch }
  | { id: string; status: 'dry_run'; payload: BookingPayload; problems: BookingProblem[]; wouldDuplicate: DuplicateMatch | { error: string } | null }
  | { id: string; status: 'skipped'; reason: string }
  | { id: string; status: 'error'; error: string; code?: string; problems?: BookingProblem[] }

export type LoadReceipt = (line: Pick<BankLine, 'id' | 'receipt_path' | 'receipt_name'>) => Promise<{ bytes: Uint8Array; name: string | null } | null>

export const CHECK_FAILED = 'Duplikatprüfung fehlgeschlagen — nicht gebucht'
export const INVOICE_PAYMENT_TEXT = 'Zahlung auf eine Rechnung — im Tab „Einnahmen“ erfasst, hier nicht buchen'
export const NO_REVENUE_ACCOUNT_TEXT = 'Kein Ertragskonto gewählt'

const notBooked = (problems: BookingProblem[]) => `Nicht gebucht — ${problemText(blockingProblems(problems))}`
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500)

// A Bookamat 400's body as adaptBookingPayload reads it
const refusalText = (err: BookamatError) =>
  err.body && typeof err.body === 'object' ? JSON.stringify(err.body) : String(err.body ?? err.message)

const LINE_COLUMNS = 'id, line_key, cells, amount, status, review, receipt_path, receipt_name, bookamat_claim, bookamat_pending'

type Line = Pick<BankLine, 'id' | 'line_key' | 'cells' | 'amount' | 'status' | 'review' | 'receipt_path' | 'receipt_name' | 'bookamat_claim' | 'bookamat_pending'>

export async function bookLines(
  supabase: SupabaseClient,
  settings: LineSettings,
  ids: readonly string[],
  opts: { dryRun?: boolean; deadline?: number; loadReceipt?: LoadReceipt } = {},
): Promise<LineResult[]> {
  setExpenseOwner(expenseOwnerOf(settings))
  const creds = credentialsOf(settings)

  const { data: lineData, error: lineErr } = await supabase.from('bank_lines').select(LINE_COLUMNS).in('id', [...ids])
  if (lineErr) throw new BookamatError('database', lineErr.message)
  const byId = new Map(((lineData ?? []) as Line[]).map(l => [l.id, l]))
  const lines = ids.map(id => byId.get(id)).filter((l): l is Line => !!l)

  const { data: ruleData, error: ruleErr } = await supabase.from('booking_rules').select('*').order('name').order('id')
  if (ruleErr) throw new BookamatError('database', ruleErr.message)
  const rules = (ruleData ?? []) as BookingRule[]

  // Credits recorded on an invoice in the „Einnahmen“ tab are that invoice's money (8b books it)
  const { data: payData, error: payErr } = await supabase.from('payments').select('import_ref').in('import_ref', lines.map(l => l.line_key))
  if (payErr) throw new BookamatError('database', payErr.message)
  const invoicePaid = new Set(((payData ?? []) as { import_ref: string }[]).map(p => p.import_ref))

  // Each line is checked against the books of the year it is booked in
  const listsOf = new Map<number, Promise<BookamatAccounts>>()
  const accounts = (year: number) => {
    let p = listsOf.get(year)
    if (!p) { p = readExpenseAccounts(creds, year, opts.deadline); listsOf.set(year, p) }
    return p
  }

  // The duplicate check reads Bookamat once for every line; while it cannot, nothing is booked
  const planned = lines.flatMap(line => {
    try {
      const tx = lineTransaction(line)
      const kind = lineKind(line)
      return [{ line, tx, kind, date: bookingDateOf(tx, line.review?.override, kind === 'expense' ? 'expense' : 'income') }]
    } catch { return [] }
  })
  const w = windowFor(planned.flatMap(p => bankRows(p.tx, { kind: p.kind === 'expense' ? 'expense' : 'income', bookedDate: p.date }).windowRows))
  let index: BookingLite[] = []
  let indexError: string | null = null
  if (w) {
    try { index = await readBookingsInWindow(creds, w, opts.deadline) } catch (err) { indexError = errorText(err) }
  }
  // Bookings made by this run: never a later line's duplicate
  const runIds = new Set<number>()

  const results: LineResult[] = []
  for (const line of lines) {
    try {
      results.push(await bookLine(line))
    } catch (err) {
      results.push({ id: line.id, status: 'error', error: errorText(err), ...(err instanceof BookamatError ? { code: err.code } : {}) })
    }
  }
  for (const id of ids) if (!byId.has(id)) results.push({ id, status: 'error', error: 'Statement line not found', code: 'not_found' })
  return results

  async function bookLine(line: Line): Promise<LineResult> {
    if (line.status === 'booked') return { id: line.id, status: 'skipped', reason: 'Bereits gebucht' }
    if (line.status === 'skipped') return { id: line.id, status: 'skipped', reason: 'Übersprungen' }
    const kind = lineKind(line)
    if (kind === 'bank_income' && invoicePaid.has(line.line_key)) return { id: line.id, status: 'skipped', reason: INVOICE_PAYMENT_TEXT }

    const tx = lineTransaction(line)
    const engineKind = kind === 'expense' ? 'expense' : 'income'
    const year = Number(bookingDateOf(tx, line.review?.override, engineKind).slice(0, 4))
    const lists = await accounts(year)
    const vendors = vendorsOf(rules, lists)
    const built = lineRow(line, vendors, lists)
    const ov = (built.row.override ?? {}) as Record<string, string>
    const ack = built.row.ack_duplicate_ids ?? []

    // The refusals before a payload
    if (built.kind === 'expense') {
      const choice = ruleChoiceReason(built.row, ov, vendors)
      if (choice) return { id: line.id, status: 'error', error: choice }
    } else {
      if (built.row.refund) return { id: line.id, status: 'skipped', reason: refundNote(built.row.refund) }
      if (!resolveIncomeDefaults(built.row, ov, lineBankAccountId(tx, lists)).revenueAccountId) return { id: line.id, status: 'error', error: NO_REVENUE_ACCOUNT_TEXT }
    }

    const ctx = { ...payloadContext(lists), csvBankId: lineBankAccountId(tx, lists) }
    let payload = built.kind === 'expense' ? buildExpenseBookingPayload(built.row, ov, ctx) : buildIncomeBookingPayload(built.row, ov, ctx)
    const problems = validatePayload(payload, engineKind, lists, {
      ...(built.kind === 'expense' ? { expectedTotal: tx.amount } : {}), year, pay: payDay(tx, engineKind),
    })

    // Bookamat's bookings of this payment: around its bank date and day of payment, then
    // around the Buchungsdatum the owner moved it to
    const dup = (): DuplicateMatch | { error: string } | null => {
      if (indexError) return { error: indexError }
      const exclude = new Set([...runIds, ...ack])
      const { row } = bankRows(tx, { kind: engineKind, bookedDate: payload.date, title: payload.title })
      const first = assignDuplicates([row], index, exclude)[0]
      if (first || payload.date === row.date || payload.date === row.payDate || !nearBankDate(row.date, payload.date)) return first ?? null
      return assignDuplicates([{ ...row, date: payload.date, payDate: null, invoiceKey: null }], index, exclude)[0] ?? null
    }

    if (opts.dryRun) return { id: line.id, status: 'dry_run', payload, problems, wouldDuplicate: dup() }

    // The line's claim: one attempt at a time
    const claimedAt = new Date().toISOString()
    const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const { data: claimed, error: claimErr } = await supabase.from('bank_lines')
      .update({ bookamat_claim: claimedAt })
      .eq('id', line.id)
      .eq('status', 'open')
      .or(`bookamat_claim.is.null,bookamat_claim.lt."${cutoff}"`)
      .select('bookamat_pending')
    if (claimErr) throw new BookamatError('database', claimErr.message)
    if (!claimed?.length) return { id: line.id, status: 'error', error: 'A booking of this line is already running, or it is no longer open', code: 'in_progress' }

    const saveJournal = async (entry: BankLinePending | null): Promise<boolean> => {
      const { data: kept, error } = await supabase.from('bank_lines').update({ bookamat_pending: entry })
        .eq('id', line.id).eq('bookamat_claim', claimedAt).select('id')
      return !error && !!kept?.length
    }
    const record = async (entry: BankLinePending, bookingId: string): Promise<void> => {
      const { error: insertErr } = await supabase.from('bookamat_bookings').insert({
        bank_line_id: line.id, year: entry.year, booking_id: bookingId, amount: entry.amount, kind, booked_on: entry.date,
      })
      if (insertErr && insertErr.code !== '23505') throw new BookamatError('db_write', `Booked in Bookamat (#${bookingId}) but not recorded in Mado: ${insertErr.message}`)
      if (insertErr) {
        // Recorded already: on this line it is done, on any other it is not this line's booking
        const { data: same, error: sameErr } = await supabase.from('bookamat_bookings').select('bank_line_id').eq('year', entry.year).eq('booking_id', bookingId)
        if (sameErr) throw new BookamatError('database', sameErr.message)
        if (!(same ?? []).some((r: { bank_line_id: string | null }) => r.bank_line_id === line.id)) {
          throw new BookamatError('db_write', `Booking #${bookingId} is recorded on another document or statement line`)
        }
      }
      const { error: lineUpd } = await supabase.from('bank_lines').update({ status: 'booked', bookamat_pending: null, bookamat_claim: null })
        .eq('id', line.id)
      if (lineUpd) throw new BookamatError('db_write', `Booked in Bookamat (#${bookingId}) and recorded, but the line is not marked: ${lineUpd.message}`)
    }

    try {
      // An earlier attempt whose outcome is open is settled first
      const open = (claimed[0] as { bookamat_pending: BankLinePending | null }).bookamat_pending
      if (open) {
        const found = open.booking_id ?? await findBooking(supabase, creds, open, opts.deadline)
        if (found) {
          await record(open, found)
          runIds.add(Number(found))
          return { id: line.id, status: 'booked', bookingId: found, year: open.year, date: open.date, title: open.title, corrections: [], receiptError: null, recovered: true }
        }
        if (!await saveJournal(null)) throw new BookamatError('in_progress', 'Another booking of this line took over meanwhile', 409)
      }

      const d = dup()
      if (d && 'error' in d) return { id: line.id, status: 'error', error: `${CHECK_FAILED} (${d.error})`, code: 'duplicate_check_failed' }
      if (d) return { id: line.id, status: 'duplicate', existing: d }
      if (blockingProblems(problems).length) return { id: line.id, status: 'error', error: notBooked(problems), problems }

      // Written before the post: a lost answer is looked up next time, never posted again
      const entry: BankLinePending = {
        year, kind, booking_id: null, amount: Number(line.amount), date: payload.date, title: payload.title, at: new Date().toISOString(),
      }
      if (!await saveJournal(entry)) throw new BookamatError('in_progress', 'Another booking of this line took over meanwhile; nothing was sent to Bookamat', 409)

      const corrections: string[] = []
      let bookingId: string | null = null
      for (let attempt = 1; !bookingId; attempt++) {
        try {
          const booked = await bookamatFetch<{ id?: unknown }>(creds, year, 'bookings/', { method: 'POST', body: payload, deadline: opts.deadline })
          bookingId = validId(booked?.id)
          if (!bookingId) throw new BookamatError('unconfirmed', 'Bookamat accepted the booking but returned no id; check Bookamat, then book again', 0)
        } catch (err) {
          if (err instanceof BookamatError && err.status === 409) {
            bookingId = conflictBookingId(err.body)
            if (bookingId) break
          }
          if (err instanceof BookamatError && (err.code === 'timeout' || err.code === 'network' || err.code === 'unconfirmed')) {
            throw new BookamatError('unconfirmed', 'Bookamat did not confirm the booking; the next attempt checks Bookamat before booking again', 0)
          }
          // Refused (a 400 books nothing): healed where Bookamat names the cause, every
          // correction said; else the journal goes and the refusal is the answer
          const healed = err instanceof BookamatError && err.status === 400 && attempt < MAX_TRIES ? adaptBookingPayload(payload, refusalText(err)) : null
          if (!healed) {
            await saveJournal(null)
            throw err
          }
          corrections.push(...healed.notes)
          payload = healed.payload
          const moved: BankLinePending = { ...entry, date: payload.date, title: payload.title }
          if (!await saveJournal(moved)) throw new BookamatError('in_progress', 'Another booking of this line took over meanwhile; nothing more was sent to Bookamat', 409)
          entry.date = moved.date
          entry.title = moved.title
        }
      }
      entry.booking_id = bookingId
      await saveJournal(entry)
      await record(entry, bookingId)
      runIds.add(Number(bookingId))

      let receiptError: string | null = null
      if (line.receipt_path && opts.loadReceipt) receiptError = await attachReceipt(line, year, bookingId, payload)
      return {
        id: line.id, status: 'booked', bookingId, year, date: payload.date, title: payload.title, corrections, receiptError,
        ...(problems.length ? { problems } : {}),
      }
    } finally {
      await supabase.from('bank_lines').update({ bookamat_claim: null }).eq('id', line.id).eq('bookamat_claim', claimedAt)
    }
  }

  // The Beleg, after the booking exists: a failure never fails the line, it is said
  async function attachReceipt(line: Line, year: number, bookingId: string, payload: BookingPayload): Promise<string | null> {
    try {
      const file = await opts.loadReceipt!(line)
      if (!file) return 'Beleg nicht gefunden — nicht angehängt'
      const named = attachmentName(file.bytes, `${payload.title}_${payload.date}`.replace(/\s+/g, '_'), file.name)
      if (named.error !== undefined) return named.error
      await bookamatFetch(creds, year, 'bookings/attachments/', {
        method: 'POST', body: { booking: Number(bookingId), name: safeAttachmentName(named.name ?? ''), file: Buffer.from(file.bytes).toString('base64') },
        timeoutMs: 30_000, deadline: opts.deadline,
      })
      const { error } = await supabase.from('bookamat_bookings').update({ pdf_attached_at: new Date().toISOString() }).eq('bank_line_id', line.id).eq('booking_id', bookingId)
      if (error) console.error('[expenses] pdf_attached_at not recorded:', error.message)
      return null
    } catch (err) {
      return `Beleg nicht angehängt (${errorText(err)})`.slice(0, 300)
    }
  }
}

// ─── „Buchung vergessen“ and „Offenen Versuch verwerfen“ ──────────────────────

// A line's booking was deleted in Bookamat: forgotten in Mado, the line open again. Bookamat
// is asked first: while it still has the booking, nothing is forgotten.
export async function forgetLineBooking(supabase: SupabaseClient, settings: BookamatSettings, lineId: string): Promise<{ forgotten: string }> {
  const { data, error } = await supabase.from('bookamat_bookings').select('year, booking_id').eq('bank_line_id', lineId)
  if (error) throw new BookamatError('database', error.message)
  const row = (data ?? [])[0] as { year: number; booking_id: string } | undefined
  if (!row) throw new BookamatError('forget_not_found', 'This line has no booking to forget', 404)
  try {
    const live = await bookamatFetch<{ status?: unknown }>(credentialsOf(settings), row.year, `bookings/${row.booking_id}/?format=json`)
    if (String(live?.status ?? '1') !== '3') throw new BookamatError('forget_still_booked', `Bookamat still has booking #${row.booking_id}: delete it there first`, 409, { id: row.booking_id })
  } catch (err) {
    // Bookamat answers 404 for a booking it does not have (bookamatFetch calls any 404 year_missing)
    if (!(err instanceof BookamatError && err.code === 'year_missing')) throw err
  }
  const { error: delErr } = await supabase.from('bookamat_bookings').delete().eq('bank_line_id', lineId).eq('booking_id', row.booking_id)
  if (delErr) throw new BookamatError('database', delErr.message)
  const { error: updErr } = await supabase.from('bank_lines').update({ status: 'open' }).eq('id', lineId)
  if (updErr) throw new BookamatError('database', updErr.message)
  return { forgotten: row.booking_id }
}

// An attempt whose outcome is open: discarded when Bookamat has no booking of it; when it has
// one, booking the line again records that one instead.
export async function discardLinePending(supabase: SupabaseClient, settings: BookamatSettings, lineId: string): Promise<{ discarded: boolean }> {
  const { data, error } = await supabase.from('bank_lines').select('bookamat_pending').eq('id', lineId).maybeSingle()
  if (error) throw new BookamatError('database', error.message)
  const open = (data as { bookamat_pending: BankLinePending | null } | null)?.bookamat_pending
  if (!open) return { discarded: false }
  const found = open.booking_id ?? await findBooking(supabase, credentialsOf(settings), open)
  if (found) throw new BookamatError('unknown_outcome', `Bookamat has booking #${found} of this line: book the line again to record it`, 409, { id: found })
  const { error: updErr } = await supabase.from('bank_lines').update({ bookamat_pending: null, bookamat_claim: null }).eq('id', lineId)
  if (updErr) throw new BookamatError('database', updErr.message)
  return { discarded: true }
}
