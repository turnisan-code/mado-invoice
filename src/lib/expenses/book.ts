// Booking statement lines in Bookamat (PR 9a): Bookmatic's booking route (app/api/bookings/
// route.ts) per line — the refusals, the payload and its checks, the duplicate check that
// books nothing while it cannot run, the self-heal of a refused booking, the Beleg — inside the
// guards Mado's own sync has (8a/8b): a claim per line; an earlier attempt settled first; a
// journal written before the post; nothing posted in a run's last seconds; a lost answer looked
// up in Bookamat (by title, date and amount) and only taken as never arrived two minutes on; the
// booking recorded once (bookamat_bookings, bank_lines_booking_guard).
//
// Only the owner books, from the „Kontoauszug“ page: no daily job, and Claude cannot (D9). Mado
// books statement lines only from the switch-over date the owner set (until then Bookmatic does,
// decision D2), from the owner's business accounts, in euros.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankBookingKind, BankLine, BankLinePending, BookingRule } from '@/types'
import {
  BookamatError, bookamatFetch, conflictBookingId, credentialsOf, validId,
  type BookamatCredentials, type BookamatSettings,
} from '@/lib/bookamat'
import { readExpenseAccounts } from './accounts'
import { vendorsOf } from './rules'
import { lineBankAccountId } from './analyse'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, payloadContext } from './booking-payload'
import { blockingProblems, problemText, validatePayload, type BookingProblem } from './booking-validation'
import { toBookingLite, type BookingLike, type DuplicateMatch } from './duplicates'
import { bookingDateOf, payDay } from './booking-dates'
import { adaptBookingPayload, safeAttachmentName } from './adapt-payload'
import { attachmentName } from './attachment'
import { ruleChoiceReason } from './rule-match'
import { resolveIncomeDefaults } from './row-defaults'
import { refundNote } from './refunds'
import { normalizeCountry } from './vat-origin'
import { normIban } from './own-transfer'
import { expenseOwnerOf, setExpenseOwner, type OwnerSettings } from './owner'
import { madoDocumentText, namedDocument, readMadoNumbers } from './mado-numbers'
import { payloadFingerprint } from './fingerprint'
import { bookamatWritesAllowed } from '@/lib/deployment'
import { checkDuplicates, engineKind, lineKind, lineRow, lineTransaction, LINE_COLUMNS, type LineRow, type StoredLine } from './lines'
import type { BookamatAccounts, BookingPayload, EasybankTransaction } from './types'

export { lineKind, lineRow, lineTransaction } from './lines'

export const CLAIM_TTL_MS = 3 * 60_000
// A post whose answer was lost is only taken as never arrived when Bookamat still has no such
// booking this long after it was sent (as Mado's own sync, src/lib/bookamat.ts)
export const UNCONFIRMED_MS = 2 * 60_000
// Below this much time left in a run nothing is claimed or posted any more, and no Beleg attached
const MIN_POST_MS = 8_000
const MIN_ATTACH_MS = 10_000
// As Bookmatic: the first post and up to four corrections
const MAX_POSTS = 5

export type LineSettings = BookamatSettings & OwnerSettings & { expenses_from?: string | null }

// What the booking says about a line, in the words the page shows
const deDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
export const LINE_TEXT = {
  notSwitched: 'Mado bucht Kontozeilen erst ab dem Umstellungsdatum (Einstellungen → Buchungsregeln) — bis dahin bucht Bookmatic',
  beforeSwitch: (from: string) => `Vor der Umstellung am ${deDay(from)} — diese Zeile bucht Bookmatic`,
  notBusiness: (iban: string) => `Konto ${iban || '—'} ist keines deiner Geschäftskonten (Einstellungen → Buchungsregeln) — nicht gebucht`,
  currency: (currency: string) => `In ${currency}, nicht in Euro — in Bookamat selbst buchen`,
  accounts: (year: number) => `Konten von Bookamat ${year} nicht ladbar — nichts gebucht`,
  split: 'Eine Aufteilung braucht mindestens zwei Zeilen',
  changed: 'Die Zeile hat sich seit der Anzeige geändert — Seite neu laden, prüfen, dann buchen',
  unconfirmed: 'Bookamat hat die Buchung noch nicht bestätigt — in zwei Minuten erneut buchen: Mado sieht dann zuerst in Bookamat nach',
  noTime: 'Keine Zeit mehr in diesem Durchgang — nichts gesendet, erneut buchen',
  inProgress: 'Diese Zeile wird gerade gebucht, oder sie ist nicht mehr offen',
  madoBooking: (title: string, id: number) => `In Bookamat schon für einen Beleg aus Mado gebucht („${title}“, #${id}) — dort erfasst, hier nicht buchen`,
  noRevenueAccount: 'Kein Ertragskonto gewählt',
  invoicePayment: 'Zahlung auf eine Rechnung — im Tab „Einnahmen“ erfasst, hier nicht buchen',
  checkFailed: 'Duplikatprüfung fehlgeschlagen — nicht gebucht',
  recordedElsewhere: (id: string) => `Buchung #${id} ist in Mado schon bei einem Beleg oder einer anderen Kontozeile vermerkt — in Bookamat prüfen`,
  preview: 'Diese Version bucht nicht in Bookamat — nur die Produktion bucht',
}
// Only production writes (lib/deployment.ts): before anything is claimed, journaled or posted
function refuseOutsideProduction(): void {
  if (!bookamatWritesAllowed()) throw new BookamatError('preview', LINE_TEXT.preview, 403)
}

// Kept for the tests and the page
export const CHECK_FAILED = LINE_TEXT.checkFailed
export const INVOICE_PAYMENT_TEXT = LINE_TEXT.invoicePayment
export const NO_REVENUE_ACCOUNT_TEXT = LINE_TEXT.noRevenueAccount

export type LineResult =
  | { id: string; status: 'booked'; bookingId: string; year: number; date: string; title: string; corrections: string[]; receiptError: string | null; recovered?: true; problems?: BookingProblem[] }
  | { id: string; status: 'duplicate'; existing: DuplicateMatch }
  | { id: string; status: 'dry_run'; payload: BookingPayload; problems: BookingProblem[]; wouldDuplicate: DuplicateMatch | { error: string } | null }
  | { id: string; status: 'skipped'; reason: string }
  | { id: string; status: 'error'; error: string; code?: string; problems?: BookingProblem[] }

export type LoadReceipt = (line: Pick<BankLine, 'id' | 'receipt_path' | 'receipt_name'>) => Promise<{ bytes: Uint8Array; name: string | null } | null>

// A line to book, with the fingerprint of the booking the page showed for it
export type BookEntry = { id: string; fingerprint?: string | null }

const notBooked = (problems: BookingProblem[]) => `Nicht gebucht — ${problemText(blockingProblems(problems))}`
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500)
const error = (id: string, text: string, code?: string, problems?: BookingProblem[]): LineResult =>
  ({ id, status: 'error', error: text, ...(code ? { code } : {}), ...(problems ? { problems } : {}) })

// A Bookamat 400's body as adaptBookingPayload reads it
const refusalText = (err: BookamatError) =>
  err.body && typeof err.body === 'object' ? JSON.stringify(err.body) : String(err.body ?? err.message)

// The business accounts a statement may come from: the IBAN on the owner's invoices, the other
// business accounts, and any Zahlungsmittelkonto Bookamat keeps with its IBAN
function isBusinessAccount(iban: string, settings: OwnerSettings, lists: BookamatAccounts | null): boolean {
  const own = [settings.iban ?? '', ...(settings.own_ibans ?? [])].map(normIban)
  return !!iban && (own.includes(iban) || (lists?.bank_accounts ?? []).some(a => normIban(a.iban) === iban))
}

type ListAnswer = { results?: unknown; next?: unknown } | unknown[] | null

// A booking an earlier attempt of this line may have created although its answer never
// arrived: the year's live booking with exactly the journal's title and date, its amount and its
// direction, that Mado has recorded nowhere. Two such bookings: only the owner can tell.
export async function findLineBooking(
  supabase: SupabaseClient, creds: BookamatCredentials, entry: Pick<BankLinePending, 'year' | 'title' | 'date' | 'amount' | 'kind'>, deadline?: number,
): Promise<string | null> {
  const q = (v: string) => encodeURIComponent(v).replace(/\./g, '%2E')
  const data = await bookamatFetch<ListAnswer>(creds, entry.year, `bookings/?title=${q(entry.title)}&date=${q(entry.date)}&format=json`, { deadline })
  const page = data && typeof data === 'object' && !Array.isArray(data) ? data : null
  const list = Array.isArray(data) ? data : Array.isArray(page?.results) ? page.results : null
  const unknown = () => new BookamatError('unknown_outcome', `In Bookamat ${entry.year} ist nicht eindeutig zu finden, ob „${entry.title}“ am ${deDay(entry.date)} gebucht wurde — dort nachsehen; danach den Versuch verwerfen (in Bookamat geprüft)`, 0, { year: entry.year, title: entry.title })
  if (!entry.title || !list || page?.next) throw unknown()
  const items = list as (BookingLike & { status?: unknown })[]
  if (items.some(i => !i || i.title !== entry.title || i.date !== entry.date)) throw unknown()
  const fits = items.filter(i => String(i.status ?? '1') !== '3' && Array.isArray(i.amounts)).filter(i => {
    const lite = toBookingLite({ ...i, id: Number(i.id) })
    return Math.abs(lite.total - Math.abs(entry.amount)) <= 0.005 && lite.income === (entry.kind === 'bank_income')
  }).map(i => validId(i.id)).filter((id): id is string => !!id)
  if (!fits.length) return null
  const { data: taken, error: takenErr } = await supabase.from('bookamat_bookings').select('booking_id').eq('year', entry.year).in('booking_id', fits)
  if (takenErr) throw new BookamatError('database', takenErr.message)
  const recorded = new Set(((taken ?? []) as { booking_id: string }[]).map(r => String(r.booking_id)))
  const free = fits.filter(id => !recorded.has(id))
  if (free.length > 1) throw unknown()
  return free[0] ?? null
}

export async function bookLines(
  supabase: SupabaseClient,
  settings: LineSettings,
  entries: readonly BookEntry[],
  opts: { dryRun?: boolean; deadline?: number; loadReceipt?: LoadReceipt } = {},
): Promise<LineResult[]> {
  // A preview (or a local server without BOOKAMAT_ALLOW_WRITES) writes nothing — no claim, no
  // journal, no booking — as 8b's sync; a dry run only reads
  if (!opts.dryRun) refuseOutsideProduction()
  setExpenseOwner(expenseOwnerOf(settings))
  const creds = credentialsOf(settings)
  // One attempt per line, whatever the page sent twice
  const wanted = [...new Map(entries.map(e => [e.id, e])).values()]

  const { data: lineData, error: lineErr } = await supabase.from('bank_lines').select(LINE_COLUMNS).in('id', wanted.map(e => e.id))
  if (lineErr) throw new BookamatError('database', lineErr.message)
  const byId = new Map(((lineData ?? []) as StoredLine[]).map(l => [l.id, l]))

  const { data: ruleData, error: ruleErr } = await supabase.from('booking_rules').select('*').order('name').order('id')
  if (ruleErr) throw new BookamatError('database', ruleErr.message)
  const rules = (ruleData ?? []) as BookingRule[]

  // Credits recorded on an invoice in the „Einnahmen“ tab are that invoice's money (8b books it)
  const keys = [...byId.values()].map(l => l.line_key)
  const { data: payData, error: payErr } = keys.length
    ? await supabase.from('payments').select('import_ref').in('import_ref', keys)
    : { data: [], error: null }
  if (payErr) throw new BookamatError('database', payErr.message)
  const invoicePaid = new Set(((payData ?? []) as { import_ref: string }[]).map(p => p.import_ref))
  const madoNumbers = await readMadoNumbers(supabase)

  // Each line against the books of the year it is booked in
  const yearOf = (l: StoredLine, tx: EasybankTransaction) => Number(bookingDateOf(tx, l.review?.override, engineKind(lineKind(l))).slice(0, 4))
  const lists = new Map<number, BookamatAccounts | null>()
  for (const l of byId.values()) {
    let year: number
    try { year = yearOf(l, lineTransaction(l)) } catch { continue }
    if (lists.has(year)) continue
    try { lists.set(year, await readExpenseAccounts(creds, year, opts.deadline)) } catch { lists.set(year, null) }
  }
  const listsOf = (year: number) => lists.get(year) ?? null

  // The duplicate check the page showed: over every open line, read once
  const open = [...byId.values()].filter(l => l.status === 'open').flatMap(l => {
    try {
      const l2 = listsOf(yearOf(l, lineTransaction(l)))
      return [{ ...l, built: lineRow(l, vendorsOf(rules, l2), l2) }]
    } catch { return [] }
  })
  const dup = await checkDuplicates(supabase, creds, open, rules, listsOf, opts.deadline)
  const builtOf = new Map(open.map(o => [o.id, o.built]))

  const results: LineResult[] = []
  for (const entry of wanted) {
    const line = byId.get(entry.id)
    if (!line) { results.push(error(entry.id, 'Kontozeile nicht gefunden', 'not_found')); continue }
    try {
      results.push(await bookLine(line, entry))
    } catch (err) {
      results.push(error(line.id, errorText(err), err instanceof BookamatError ? err.code : undefined))
    }
  }
  return results

  // Everything the booking checks before anything is posted: a refusal, or the payload
  type Prepared = { result: LineResult } | { payload: BookingPayload; problems: BookingProblem[]; year: number; kind: BankBookingKind }
  function prepare(line: StoredLine, entry: BookEntry): Prepared {
    const kind = lineKind(line)
    const ek = engineKind(kind)
    const tx = lineTransaction(line)
    const named = namedDocument(tx, madoNumbers)
    if (named) return { result: { id: line.id, status: 'skipped', reason: madoDocumentText(named, kind === 'bank_income') } }
    if (kind === 'bank_income' && invoicePaid.has(line.line_key)) return { result: { id: line.id, status: 'skipped', reason: LINE_TEXT.invoicePayment } }
    // The switch-over: until the owner's date Bookmatic books the statement (D2)
    if (!settings.expenses_from) return { result: error(line.id, LINE_TEXT.notSwitched, 'not_switched') }
    if (String(line.booked_on) < settings.expenses_from) return { result: error(line.id, LINE_TEXT.beforeSwitch(settings.expenses_from), 'before_switch') }
    const year = yearOf(line, tx)
    const yearLists = listsOf(year)
    if (!yearLists) return { result: error(line.id, LINE_TEXT.accounts(year), 'accounts') }
    const iban = normIban(tx.raw?.col0)
    if (!isBusinessAccount(iban, settings, yearLists)) return { result: error(line.id, LINE_TEXT.notBusiness(iban), 'not_business_account') }
    const currency = (tx.currency || 'EUR').trim().toUpperCase()
    if (currency !== 'EUR') return { result: error(line.id, LINE_TEXT.currency(currency), 'currency') }

    const vendors = vendorsOf(rules, yearLists)
    const built: LineRow = builtOf.get(line.id) ?? lineRow(line, vendors, yearLists)
    const ov = (built.row.override ?? {}) as Record<string, string>
    if (built.kind === 'expense') {
      if ((built.row.booking_lines?.length ?? 0) === 1) return { result: error(line.id, LINE_TEXT.split, 'split') }
      const choice = ruleChoiceReason(built.row, ov, vendors)
      if (choice) return { result: error(line.id, choice, 'rule_choice') }
    } else {
      if (built.row.refund) return { result: { id: line.id, status: 'skipped', reason: refundNote(built.row.refund) } }
      if (!resolveIncomeDefaults(built.row, ov, lineBankAccountId(tx, yearLists)).revenueAccountId) return { result: error(line.id, LINE_TEXT.noRevenueAccount, 'no_revenue_account') }
    }

    const ctx = { ...payloadContext(yearLists), csvBankId: lineBankAccountId(tx, yearLists) }
    const payload = built.kind === 'expense' ? buildExpenseBookingPayload(built.row, ov, ctx) : buildIncomeBookingPayload(built.row, ov, ctx)
    const problems = validatePayload(payload, ek, yearLists, { ...(built.kind === 'expense' ? { expectedTotal: tx.amount } : {}), year, pay: payDay(tx, ek) })
    // What the page showed is what is booked, or nothing
    if (entry.fingerprint && payloadFingerprint(payload) !== entry.fingerprint) return { result: error(line.id, LINE_TEXT.changed, 'changed') }

    // Bookamat's bookings of this payment, as the page showed them
    const checked = dup.rows.get(line.id)
    if (dup.failed || !checked || checked.duplicate_check_failed) {
      return { result: error(line.id, `${LINE_TEXT.checkFailed} (${dup.failed ?? checked?.duplicate_check_failed ?? '—'})`, 'duplicate_check_failed') }
    }
    // A booking Mado recorded on a document is that document's money, whatever the owner said
    const docBooking = dup.documentMatches.get(line.id)
    if (docBooking) return { result: error(line.id, LINE_TEXT.madoBooking(docBooking.title, docBooking.id), 'mado_booking') }
    const match = checked.duplicate_of ?? null
    if (match) return { result: { id: line.id, status: 'duplicate', existing: { id: match.id, title: match.title, date: match.date, total: match.total, certain: match.certain } } }
    if (blockingProblems(problems).length) return { result: error(line.id, notBooked(problems), 'problems', problems) }
    return { payload, problems, year, kind }
  }

  async function bookLine(line: StoredLine, entry: BookEntry): Promise<LineResult> {
    if (line.status === 'booked') return { id: line.id, status: 'skipped', reason: 'Bereits gebucht' }
    if (line.status === 'skipped') return { id: line.id, status: 'skipped', reason: 'Übersprungen' }

    if (opts.dryRun) {
      const prep = prepare(line, entry)
      if ('result' in prep) {
        const r = prep.result
        return r.status === 'duplicate'
          ? { id: line.id, status: 'dry_run', payload: emptyPayload(), problems: [], wouldDuplicate: r.existing }
          : r
      }
      return { id: line.id, status: 'dry_run', payload: prep.payload, problems: prep.problems, wouldDuplicate: null }
    }

    // Nothing is claimed or sent in a run's last seconds
    if (opts.deadline && opts.deadline - Date.now() < MIN_POST_MS) return error(line.id, LINE_TEXT.noTime, 'timeout')

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
    if (!claimed?.length) return error(line.id, LINE_TEXT.inProgress, 'in_progress')

    const saveJournal = async (pending: BankLinePending | null): Promise<boolean> => {
      const { data: kept, error: saveErr } = await supabase.from('bank_lines').update({ bookamat_pending: pending })
        .eq('id', line.id).eq('bookamat_claim', claimedAt).select('id')
      return !saveErr && !!kept?.length
    }
    const markBooked = async (bookingId: string) => {
      const { error: lineUpd } = await supabase.from('bank_lines').update({ status: 'booked', bookamat_pending: null, bookamat_claim: null }).eq('id', line.id)
      if (lineUpd) throw new BookamatError('db_write', `In Bookamat gebucht (#${bookingId}) und vermerkt, die Zeile aber nicht als gebucht markiert (${lineUpd.message}) — erneut buchen markiert sie`)
    }
    const record = async (pending: BankLinePending, bookingId: string): Promise<void> => {
      const { error: insertErr } = await supabase.from('bookamat_bookings').insert({
        bank_line_id: line.id, year: pending.year, booking_id: bookingId, amount: pending.amount, kind: pending.kind, booked_on: pending.date,
      })
      if (insertErr && insertErr.code !== '23505') throw new BookamatError('db_write', `In Bookamat gebucht (#${bookingId}), in Mado aber nicht vermerkt (${insertErr.message}) — erneut buchen vermerkt sie`)
      if (insertErr) {
        // Recorded already: on this line it is done, on anything else it is not this line's booking
        const { data: same, error: sameErr } = await supabase.from('bookamat_bookings').select('bank_line_id').eq('year', pending.year).eq('booking_id', bookingId)
        if (sameErr) throw new BookamatError('database', sameErr.message)
        if (!(same ?? []).some((r: { bank_line_id: string | null }) => r.bank_line_id === line.id)) {
          throw new BookamatError('db_write', LINE_TEXT.recordedElsewhere(bookingId))
        }
      }
      await markBooked(bookingId)
    }
    const booked = (bookingId: string, pending: BankLinePending, extra: Partial<Extract<LineResult, { status: 'booked' }>> = {}): LineResult =>
      ({ id: line.id, status: 'booked', bookingId, year: pending.year, date: pending.date, title: pending.title, corrections: [], receiptError: null, ...extra })

    try {
      // 1. Booked already: a booking recorded on this line whose line was not marked
      const { data: ledger, error: ledgerErr } = await supabase.from('bookamat_bookings').select('year, booking_id, booked_on, amount').eq('bank_line_id', line.id)
      if (ledgerErr) throw new BookamatError('database', ledgerErr.message)
      const mine = (ledger ?? [])[0] as { year: number; booking_id: string; booked_on: string | null; amount: number } | undefined
      if (mine) {
        await markBooked(String(mine.booking_id))
        return booked(String(mine.booking_id), { year: mine.year, kind: lineKind(line), booking_id: String(mine.booking_id), amount: Number(mine.amount), date: mine.booked_on ?? String(line.booked_on), title: '', at: claimedAt }, { recovered: true })
      }

      // 2. An earlier attempt whose outcome is open: recorded if Bookamat has it; taken as never
      //    arrived only two minutes after it was sent
      const pending = (claimed[0] as { bookamat_pending: BankLinePending | null }).bookamat_pending
      if (pending) {
        const found = pending.booking_id ?? await findLineBooking(supabase, creds, pending, opts.deadline)
        if (found) {
          await record(pending, found)
          return booked(found, pending, { recovered: true })
        }
        if (Date.now() - Date.parse(pending.at) < UNCONFIRMED_MS) return error(line.id, LINE_TEXT.unconfirmed, 'unconfirmed')
        if (!await saveJournal(null)) throw new BookamatError('in_progress', LINE_TEXT.inProgress, 409)
      }

      // 3. The checks
      const prep = prepare(line, entry)
      if ('result' in prep) return prep.result

      // 4. The post: journaled first; Bookamat refusing it for a cause it names is corrected
      let payload: BookingPayload = { ...prep.payload, title: prep.payload.title.trim() }
      const corrections: string[] = []
      const country = normalizeCountry(payload.country)
      // Only a real alias (UK → GB), not upper-casing, is worth a line (as Bookmatic)
      if (country !== (payload.country || '').trim().toUpperCase()) corrections.push(`Land „${payload.country}“ → „${country}“`)
      payload = { ...payload, country }
      // The journal keeps what is posted (a split may be a cent or two off the bank's amount):
      // a lost answer is looked up by that
      const total = Math.round(payload.amounts.reduce((s, a) => s + (Number(a.amount) || 0), 0) * 100) / 100
      const journal: BankLinePending = {
        year: prep.year, kind: prep.kind, booking_id: null, amount: prep.kind === 'expense' ? -total : total, date: payload.date, title: payload.title, at: new Date().toISOString(),
      }
      if (opts.deadline && opts.deadline - Date.now() < MIN_POST_MS) return error(line.id, LINE_TEXT.noTime, 'timeout')
      if (!await saveJournal(journal)) throw new BookamatError('in_progress', `${LINE_TEXT.inProgress} — nichts gesendet`, 409)

      let bookingId: string | null = null
      for (let attempt = 1; !bookingId; attempt++) {
        if (opts.deadline && opts.deadline - Date.now() < MIN_POST_MS) {
          // Nothing of this attempt was sent (a refused post books nothing)
          await saveJournal(null)
          return error(line.id, LINE_TEXT.noTime, 'timeout')
        }
        try {
          const answer = await bookamatFetch<{ id?: unknown }>(creds, prep.year, 'bookings/', { method: 'POST', body: payload, deadline: opts.deadline })
          bookingId = validId(answer?.id)
          if (!bookingId) throw new BookamatError('unconfirmed', 'Bookamat hat die Buchung angenommen, aber keine Nummer genannt', 0)
        } catch (err) {
          if (err instanceof BookamatError && err.status === 409) {
            bookingId = conflictBookingId(err.body)
            if (bookingId) break
          }
          // No answer, Bookamat failing, or an answer without the booking: it may exist. The
          // journal stays; the next attempt looks it up first.
          if (err instanceof BookamatError && (err.code === 'timeout' || err.code === 'network' || err.code === 'unconfirmed' || err.status === 409 || err.status >= 500)) {
            // Bookamat's own words go with it: a failure that lasts is seen as what it is
            const said = err.status ? ` (Bookamat ${err.status}: ${err.message.slice(0, 200)})` : ''
            throw new BookamatError('unconfirmed', `${LINE_TEXT.unconfirmed}${said}`, 0)
          }
          // Refused (a 4xx books nothing): healed where Bookamat names the cause, every correction
          // said; else the journal goes and the refusal is the answer
          const healed = err instanceof BookamatError && err.status === 400 && attempt < MAX_POSTS ? adaptBookingPayload(payload, refusalText(err)) : null
          if (!healed) {
            await saveJournal(null)
            throw err
          }
          corrections.push(...healed.notes)
          payload = healed.payload
        }
      }
      journal.booking_id = bookingId
      await saveJournal(journal)
      await record(journal, bookingId)

      let receiptError: string | null = null
      if (line.receipt_path && opts.loadReceipt) {
        receiptError = opts.deadline && opts.deadline - Date.now() < MIN_ATTACH_MS
          ? 'Beleg nicht angehängt (keine Zeit mehr) — „Beleg anhängen“ an der Zeile'
          : await attachTo(supabase, creds, line, prep.year, bookingId, payload, opts.loadReceipt, opts.deadline)
      }
      return booked(bookingId, journal, { corrections, receiptError, ...(prep.problems.length ? { problems: prep.problems } : {}) })
    } finally {
      await supabase.from('bank_lines').update({ bookamat_claim: null }).eq('id', line.id).eq('bookamat_claim', claimedAt)
    }
  }
}

const emptyPayload = (): BookingPayload => ({ title: '', date: '', date_invoice: null, amounts: [], vatin: '', country: '', description: '' })

// The Beleg, after the booking exists: a failure never fails the line, it is said
async function attachTo(
  supabase: SupabaseClient, creds: BookamatCredentials, line: Pick<BankLine, 'id' | 'receipt_path' | 'receipt_name'>,
  year: number, bookingId: string, payload: Pick<BookingPayload, 'title' | 'date'>, loadReceipt: LoadReceipt, deadline?: number,
): Promise<string | null> {
  try {
    const file = await loadReceipt(line)
    if (!file) return 'Beleg nicht gefunden — nicht angehängt'
    const named = attachmentName(file.bytes, `${payload.title}_${payload.date}`.replace(/\s+/g, '_'), file.name)
    if (named.error !== undefined) return named.error
    await bookamatFetch(creds, year, 'bookings/attachments/', {
      method: 'POST', body: { booking: Number(bookingId), name: safeAttachmentName(named.name ?? ''), file: Buffer.from(file.bytes).toString('base64') },
      timeoutMs: 30_000, deadline,
    })
    const { error: markErr } = await supabase.from('bookamat_bookings').update({ pdf_attached_at: new Date().toISOString() }).eq('bank_line_id', line.id).eq('booking_id', bookingId)
    if (markErr) console.error('[expenses] pdf_attached_at not recorded:', markErr.message)
    return null
  } catch (err) {
    return `Beleg nicht angehängt (${errorText(err)})`.slice(0, 300)
  }
}

// „Beleg anhängen“: a booked line's Beleg that was not attached when it was booked
export async function attachLineReceipt(supabase: SupabaseClient, settings: BookamatSettings, lineId: string, loadReceipt: LoadReceipt): Promise<{ attached: true }> {
  refuseOutsideProduction()
  const { data: line, error: lineErr } = await supabase.from('bank_lines').select('id, status, receipt_path, receipt_name').eq('id', lineId).maybeSingle()
  if (lineErr) throw new BookamatError('database', lineErr.message)
  const l = line as Pick<BankLine, 'id' | 'status' | 'receipt_path' | 'receipt_name'> | null
  if (!l || l.status !== 'booked' || !l.receipt_path) throw new BookamatError('not_found', 'Diese Zeile hat keine Buchung mit Beleg zum Anhängen', 404)
  const { data: rows, error: rowErr } = await supabase.from('bookamat_bookings').select('year, booking_id, booked_on, pdf_attached_at').eq('bank_line_id', lineId)
  if (rowErr) throw new BookamatError('database', rowErr.message)
  const row = (rows ?? [])[0] as { year: number; booking_id: string; booked_on: string | null; pdf_attached_at: string | null } | undefined
  if (!row) throw new BookamatError('not_found', 'Diese Zeile hat keine Buchung mit Beleg zum Anhängen', 404)
  if (row.pdf_attached_at) return { attached: true }
  const failed = await attachTo(supabase, credentialsOf(settings), l, row.year, String(row.booking_id), { title: 'Beleg', date: row.booked_on ?? '' }, loadReceipt)
  if (failed) throw new BookamatError('bookamat', failed, 502)
  return { attached: true }
}

// ─── „Buchung vergessen“ and „Offenen Versuch verwerfen“ ──────────────────────

// A line's booking was deleted in Bookamat: forgotten in Mado, the line open again. Bookamat
// is asked first: while it still has the booking, nothing is forgotten. A booked line without a
// booking (an earlier forget that did not finish) is opened again.
export async function forgetLineBooking(supabase: SupabaseClient, settings: BookamatSettings, lineId: string): Promise<{ forgotten: string | null }> {
  refuseOutsideProduction()
  const { data, error: rowErr } = await supabase.from('bookamat_bookings').select('year, booking_id').eq('bank_line_id', lineId)
  if (rowErr) throw new BookamatError('database', rowErr.message)
  const row = (data ?? [])[0] as { year: number; booking_id: string } | undefined
  if (!row) {
    const { data: reopened, error: reopenErr } = await supabase.from('bank_lines').update({ status: 'open' }).eq('id', lineId).eq('status', 'booked').select('id')
    if (reopenErr) throw new BookamatError('database', reopenErr.message)
    if (!reopened?.length) throw new BookamatError('forget_not_found', 'Diese Zeile hat keine Buchung zum Vergessen', 404)
    return { forgotten: null }
  }
  try {
    const live = await bookamatFetch<{ status?: unknown }>(credentialsOf(settings), row.year, `bookings/${row.booking_id}/?format=json`)
    if (String(live?.status ?? '1') !== '3') throw new BookamatError('forget_still_booked', `Bookamat hat Buchung #${row.booking_id} noch — zuerst dort löschen, dann hier vergessen`, 409, { id: row.booking_id, year: row.year })
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

// An attempt whose outcome is open, discarded under the line's claim: never within two minutes of
// its post; not while Bookamat has a booking of it (booking the line again records that one) —
// unless the owner checked Bookamat (`force`) for an attempt Bookamat never confirmed.
export async function discardLinePending(
  supabase: SupabaseClient, settings: BookamatSettings, lineId: string, opts: { force?: boolean } = {},
): Promise<{ discarded: boolean }> {
  refuseOutsideProduction()
  const claimedAt = new Date().toISOString()
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
  const { data: claimed, error: claimErr } = await supabase.from('bank_lines')
    .update({ bookamat_claim: claimedAt })
    .eq('id', lineId)
    .or(`bookamat_claim.is.null,bookamat_claim.lt."${cutoff}"`)
    .select('bookamat_pending')
  if (claimErr) throw new BookamatError('database', claimErr.message)
  if (!claimed?.length) throw new BookamatError('in_progress', LINE_TEXT.inProgress, 409)
  try {
    const pending = (claimed[0] as { bookamat_pending: BankLinePending | null }).bookamat_pending
    if (!pending) return { discarded: false }
    if (Date.now() - Date.parse(pending.at) < UNCONFIRMED_MS) throw new BookamatError('unconfirmed', LINE_TEXT.unconfirmed, 409)
    if (pending.booking_id) throw new BookamatError('unknown_outcome', `Bookamat hat Buchung #${pending.booking_id} dieser Zeile angenommen — erneut buchen erfasst sie`, 409, { id: pending.booking_id, year: pending.year, title: pending.title })
    if (!opts.force) {
      const found = await findLineBooking(supabase, credentialsOf(settings), pending)
      if (found) throw new BookamatError('unknown_outcome', `Bookamat hat Buchung #${found} dieser Zeile — erneut buchen erfasst sie`, 409, { id: found, year: pending.year, title: pending.title })
    }
    const { data: kept, error: updErr } = await supabase.from('bank_lines').update({ bookamat_pending: null })
      .eq('id', lineId).eq('bookamat_claim', claimedAt).select('id')
    if (updErr) throw new BookamatError('database', updErr.message)
    if (!kept?.length) throw new BookamatError('in_progress', LINE_TEXT.inProgress, 409)
    return { discarded: true }
  } finally {
    await supabase.from('bank_lines').update({ bookamat_claim: null }).eq('id', lineId).eq('bookamat_claim', claimedAt)
  }
}
