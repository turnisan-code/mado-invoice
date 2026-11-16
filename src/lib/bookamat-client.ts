// The browser-safe half of the Bookamat integration: what a document books, its state in lists,
// error texts and the call to the sync route. The server half (HTTP, sync, cron) is bookamat.ts.
import { roundCents } from '@/lib/utils/document'
import { knownApiError } from '@/lib/api-errors'
import type { DictKey, TFn } from '@/lib/i18n'
import type { BookamatBooking, BookamatBookingKind, BookamatState } from '@/types'
import type { BookingCandidate, BookingRef } from '@/lib/bookamat-search'

// ─── Errors ──────────────────────────────────────────────────────────────────

// Failures the UI words itself (books.errors.<code>, with `detail` as variables). 'bookamat'
// carries Bookamat's own message: why it refused a booking is the most useful thing to show.
// 'held' only ever comes back to the cron (autoSyncBookamat), which logs it as held back, and to a
// sync Claude prepared (src/lib/mcp/actions/bookamat-sync.ts), which words it as a refusal.
// 'preview': this deployment does not write to Bookamat (src/lib/deployment.ts).
// 'external_duplicate': Bookamat has a booking Mado did not make that may be this money (the
// failure carries the `candidates`); 'duplicate_check_failed': Bookamat could not be searched for
// one. Either way nothing was booked.
export type BookamatErrorCode =
  | 'not_configured' | 'not_found' | 'not_issued' | 'not_eur' | 'not_settled' | 'nothing_to_book' | 'no_items'
  | 'cash_account_missing' | 'vat_account_missing' | 'account_missing' | 'accounts_stale' | 'in_progress' | 'auth'
  | 'year_missing' | 'timeout' | 'network' | 'bookamat' | 'db_write' | 'database' | 'not_synced' | 'unconfirmed'
  | 'unknown_outcome' | 'held' | 'preview' | 'external_duplicate' | 'duplicate_check_failed'
  | 'adopt_not_found' | 'adopt_mismatch' | 'adopt_taken' | 'adopt_other_year' | 'adopt_kind' | 'adopt_other_number'
  | 'adopt_unsettled' | 'adopt_nothing_left' | 'adopt_booked_year' | 'adopt_payment_booked'

export type ErrorDetail = Record<string, string | number>

const ERROR_CODES: readonly BookamatErrorCode[] = [
  'not_configured', 'not_found', 'not_issued', 'not_eur', 'not_settled', 'nothing_to_book', 'no_items',
  'cash_account_missing', 'vat_account_missing', 'account_missing', 'accounts_stale', 'in_progress', 'auth',
  'year_missing', 'timeout', 'network', 'bookamat', 'db_write', 'database', 'not_synced', 'unconfirmed',
  'unknown_outcome', 'preview', 'external_duplicate', 'duplicate_check_failed', 'adopt_not_found', 'adopt_mismatch',
  'adopt_taken', 'adopt_other_year', 'adopt_kind', 'adopt_other_number', 'adopt_unsettled', 'adopt_nothing_left', 'adopt_booked_year', 'adopt_payment_booked',
]

// A route's error payload in the UI language; the general API codes (signed out, bad request) are
// worded by api-errors, and a payload without any known code gets `fallback`. Only Bookamat's own
// answer ('bookamat') is shown as it came; the text of any other failure (the database's, a
// server's) goes to the console.
export function bookamatErrorMessage(t: TFn, payload: unknown, fallback = t('common.unknownError')): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown; detail?: unknown }
  const raw = typeof p.error === 'string' && p.error ? p.error : null
  const code = ERROR_CODES.find(c => c === p.code)
  const detail = p.detail && typeof p.detail === 'object' ? p.detail as ErrorDetail : {}
  if (code === 'bookamat') return t('books.errors.bookamat', { ...detail, message: raw ?? fallback })
  const known = code ? t(`books.errors.${code}` as DictKey, detail) : knownApiError(t, p)
  if (raw && (!known || code === 'database')) console.error('[bookamat] failed:', p.code ?? '', raw)
  return known ?? fallback
}

// ─── Plan: what a document books ─────────────────────────────────────────────

// A money row of a document as the plan reads it; `id` names the payment a booking books.
export type MoneyRow = { id?: string; date: string; amount: number; kind: string; method?: string | null }

export type PlannedBooking = {
  year: number
  kind: BookamatBookingKind
  // The payment's (or refund's) own date: the booking date.
  date: string
  // Gross booked, always positive here; a refund books it negative.
  amount: number
  cash: number
  // The money row it books; null only for rows a caller passed without their id.
  paymentId: string | null
  // Money of this kind planned before it, in date order: the VAT split goes on from there, so the
  // bookings of a document add up per VAT rate without a cent of drift.
  before: number
  // A part payment's number („Teilzahlung n“); null when one payment books the whole document.
  part: number | null
}

// A booking as the plan compares it; `payment_id` null: one from before bookings per payment.
export type BookedLike = { year: number; kind: string; amount: number; payment_id?: string | null }

// Ist-Besteuerung, money only: one booking per payment, on its own date, so a part payment lands
// in its own UVA period. An invoice books its 'payment' rows (a Skonto taken, a write-off or an
// applied credit note moves no money and is not booked), a credit note its 'refund' rows. What
// arrives beyond the amount still to be paid (an overpayment) is not turnover and is left out,
// latest money last. Dunning fees and interest ('fee') are reported back, never booked.
export function planBookings(input: { type: 'invoice' | 'credit_note'; total: number; rows: MoneyRow[] }): { bookings: PlannedBooking[]; fees: number } {
  const moneyKind = input.type === 'invoice' ? 'payment' : 'refund'
  const kind: BookamatBookingKind = input.type === 'invoice' ? 'income' : 'refund'
  const sumOf = (kinds: string[]) => roundCents(input.rows.filter(r => kinds.includes(r.kind)).reduce((s, r) => s + r.amount, 0))
  const credited = input.type === 'invoice' ? sumOf(['credit']) : 0
  const fees = sumOf(['fee'])
  const due = roundCents(Math.max(0, input.total - credited))
  // What money has to cover: a Skonto or a write-off closes the rest without a transfer.
  const whole = roundCents(Math.max(0, due - (input.type === 'invoice' ? sumOf(['skonto', 'writeoff']) : 0)))
  let remaining = due
  let before = 0

  const money = input.rows
    .filter(r => r.kind === moneyKind && r.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id ?? '').localeCompare(String(b.id ?? '')))
  const bookings: PlannedBooking[] = []
  for (const r of money) {
    const amount = roundCents(Math.min(r.amount, remaining))
    if (amount <= 0) continue
    remaining = roundCents(remaining - amount)
    bookings.push({ year: Number(r.date.slice(0, 4)), kind, date: r.date, amount, cash: r.method === 'cash' ? amount : 0, paymentId: r.id ?? null, before, part: null })
    before = roundCents(before + amount)
  }
  // Part payments are numbered: several bookings, or one that does not cover the document.
  if (bookings.length > 1 || (bookings.length === 1 && bookings[0].amount < whole - 0.005)) bookings.forEach((b, i) => { b.part = i + 1 })
  return { bookings, fees }
}

// `p` with only `amount` of it left to book: the part before it counts as booked already.
function remainderOf(p: PlannedBooking, amount: number): PlannedBooking {
  return { ...p, amount, cash: roundCents(p.cash * amount / p.amount), before: roundCents(p.before + p.amount - amount) }
}

// What is still to book: the planned payments without their own booking. A booking from before
// bookings per payment (no payment_id) covers the money of its year first, in date order, and
// what it books beyond that (a payment date moved across New Year) covers money of any year;
// none of that money is booked a second time.
export function unbookedPlan(planned: PlannedBooking[], booked: BookedLike[]): PlannedBooking[] {
  const out: PlannedBooking[] = []
  for (const kind of new Set(planned.map(p => p.kind))) {
    const mine = booked.filter(b => b.kind === kind)
    const byPayment = new Set(mine.filter(b => b.payment_id).map(b => String(b.payment_id)))
    const cover = new Map<number, number>()
    for (const b of mine.filter(x => !x.payment_id)) cover.set(b.year, roundCents((cover.get(b.year) ?? 0) + Math.abs(Number(b.amount))))
    const rest: PlannedBooking[] = []
    for (const p of planned.filter(x => x.kind === kind && !(x.paymentId && byPayment.has(x.paymentId)))) {
      const c = cover.get(p.year) ?? 0
      const used = roundCents(Math.min(c, p.amount))
      if (used > 0) cover.set(p.year, roundCents(c - used))
      const left = roundCents(p.amount - used)
      if (left > 0) rest.push(used > 0 ? remainderOf(p, left) : p)
    }
    let spare = roundCents([...cover.values()].reduce((s, v) => s + v, 0))
    for (const p of rest) {
      const used = roundCents(Math.min(spare, p.amount))
      spare = roundCents(spare - used)
      const left = roundCents(p.amount - used)
      if (left > 0) out.push(used > 0 ? remainderOf(p, left) : p)
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.before - b.before)
}

// ─── State shown in lists ────────────────────────────────────────────────────

export type StateInput = {
  type?: string
  number: string | null
  status: string
  bookamat_error?: string | null
  bookamat_booking_id?: string | null
  bookamat_bookings?: BookedLike[] | null
  payments?: { id?: string; date?: string; kind?: string | null; amount: number }[] | null
}

// Something to book: money received on an issued invoice — part payments included, each in its
// own period —, or on a cancelled one (its Storno books the refund); a credit note once money was
// paid back. An invoice closed without money (a zero total, an applied credit note) books
// nothing, so it is neither offered nor synced automatically.
export function hasMoneyToBook(doc: StateInput): boolean {
  if (!doc.number) return false
  const payments = doc.payments ?? []
  if ((doc.type ?? 'invoice') === 'credit_note') return doc.status === 'sent' && payments.some(p => p.kind === 'refund' && p.amount > 0)
  return ['sent', 'overdue', 'paid', 'cancelled'].includes(doc.status) && payments.some(p => (p.kind ?? 'payment') === 'payment' && p.amount > 0)
}

// Money the document's bookings do not cover yet. Without payment ids and dates (an older caller)
// any booking counts as covering everything, as before bookings per payment.
export function hasUnbookedMoney(doc: StateInput): boolean {
  if (!hasMoneyToBook(doc)) return false
  const bookings = doc.bookamat_bookings ?? []
  const rows = doc.payments ?? []
  if (rows.some(r => !r.id || !r.date)) return bookings.length === 0 && !doc.bookamat_booking_id
  const type = (doc.type ?? 'invoice') === 'credit_note' ? 'credit_note' : 'invoice'
  const plan = planBookings({ type, total: Number.MAX_SAFE_INTEGER, rows: rows.map(r => ({ id: r.id, date: r.date!, amount: r.amount, kind: r.kind ?? 'payment' })) })
  return unbookedPlan(plan.bookings, bookings).length > 0
}

export function bookamatState(doc: StateInput): BookamatState {
  const synced = (doc.bookamat_bookings?.length ?? 0) > 0 || !!doc.bookamat_booking_id
  // An old failure on a document that has nothing to book (e.g. settled only by a credit note) is moot.
  if (doc.bookamat_error && (synced || hasMoneyToBook(doc))) return 'failed'
  if (hasUnbookedMoney(doc)) return 'unsynced'
  if (synced) return 'synced'
  return 'none'
}

// "#123 (2025), #456 (2026)"
export function formatBookings(t: TFn, bookings: { year: number; booking_id?: string; bookingId?: string }[]): string {
  return bookings.map(b => t('books.sync.booking', { id: b.booking_id ?? b.bookingId ?? '', year: b.year })).join(', ')
}

// ─── Sync route ──────────────────────────────────────────────────────────────

export type BookingRow = Pick<BookamatBooking, 'year' | 'booking_id' | 'amount' | 'kind' | 'booked_on' | 'pdf_attached_at' | 'payment_id'>
export const BOOKING_COLUMNS = 'year, booking_id, amount, kind, booked_on, pdf_attached_at, payment_id'

// A booking Bookamat accepted that could not be recorded here: sent back as `adopt`, it is
// recorded instead of booked a second time. `paymentId`: the payment it books (absent from a tab
// opened before bookings per payment).
export type AdoptBooking = { year: number; kind: BookamatBookingKind; bookingId: string; paymentId?: string | null }

export type SyncSuccess = {
  ok: true
  bookings: BookingRow[]
  created: { year: number; bookingId: string; amount: number; adopted: boolean }[]
  fees: number
  pdf: { attached: number; error: string | null }
}

export type SyncFailure = {
  ok: false
  status: number
  code: BookamatErrorCode
  error: string
  detail?: ErrorDetail
  pending?: AdoptBooking[]
  // 'external_duplicate': the bookings in Bookamat that may be this money.
  candidates?: BookingCandidate[]
}

// The bookings a sync refused over ('external_duplicate'), from its error payload; [] otherwise.
export function duplicateCandidates(payload: unknown): BookingCandidate[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { code?: unknown; candidates?: unknown }
  return p.code === 'external_duplicate' && Array.isArray(p.candidates) ? p.candidates as BookingCandidate[] : []
}

// A booking Bookamat already had, taken over for the document's money ('adopt' route).
export type AdoptSuccess = {
  ok: true
  bookings: BookingRow[]
  adopted: { year: number; bookingId: string; amount: number; date: string; paymentId: string | null }
}

type SyncResponse = { ok: true; data: SyncSuccess } | { ok: false; payload: unknown }

// „Das ist diese Zahlung — übernehmen“: records the booking for the document, books nothing.
export async function requestBookamatAdopt(documentId: string, ref: BookingRef): Promise<{ ok: true; data: AdoptSuccess } | { ok: false; payload: unknown }> {
  const res = await fetch('/api/bookamat/adopt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, year: ref.year, bookingId: ref.bookingId, ...(ref.paymentId ? { paymentId: ref.paymentId } : {}) }),
  }).catch(() => null)
  if (!res) return { ok: false, payload: { code: 'network', error: 'Network error' } }
  const payload: unknown = await res.json().catch(() => ({}))
  return res.ok ? { ok: true, data: payload as AdoptSuccess } : { ok: false, payload }
}

// Bookings this tab learned of but the database could not record, per document; the server keeps
// them as well when it can write at all.
const unrecorded = new Map<string, AdoptBooking[]>()

function pendingOf(res: SyncResponse): AdoptBooking[] {
  if (res.ok || !res.payload || typeof res.payload !== 'object') return []
  const pending = (res.payload as { pending?: unknown }).pending
  return Array.isArray(pending) ? pending as AdoptBooking[] : []
}

// Calls the sync route. When Bookamat accepted a booking this database could not record, the
// second call hands it back as `adopt`, so it is recorded instead of booked twice; if that fails
// too, the next sync from this tab sends it again. `acknowledge`: bookings in Bookamat the owner
// said are other money („trotzdem buchen“); the sync's search still looks at all others.
export async function requestBookamatSync(documentId: string, opts: { acknowledge?: BookingRef[] } = {}): Promise<SyncResponse> {
  const acknowledge = opts.acknowledge?.length ? { acknowledge: opts.acknowledge } : {}
  const post = async (adopt?: AdoptBooking[]): Promise<SyncResponse> => {
    const res = await fetch('/api/bookamat/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, ...(adopt?.length ? { adopt } : {}), ...acknowledge }),
    }).catch(() => null)
    if (!res) return { ok: false, payload: { code: 'network', error: 'Network error' } }
    const payload: unknown = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, data: payload as SyncSuccess } : { ok: false, payload }
  }
  let res = await post(unrecorded.get(documentId))
  if (pendingOf(res).length) res = await post(pendingOf(res))
  const left = pendingOf(res)
  if (left.length) unrecorded.set(documentId, left)
  else if (res.ok) unrecorded.delete(documentId)
  return res
}
