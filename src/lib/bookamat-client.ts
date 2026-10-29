// The browser-safe half of the Bookamat integration: what a document books, its state in lists,
// error texts and the call to the sync route. The server half (HTTP, sync, cron) is bookamat.ts.
import { roundCents } from '@/lib/utils/document'
import type { DictKey, TFn } from '@/lib/i18n'
import type { BookamatBooking, BookamatBookingKind, BookamatState } from '@/types'

// ─── Errors ──────────────────────────────────────────────────────────────────

// Failures the UI words itself (books.errors.<code>, with `detail` as variables). 'bookamat'
// carries Bookamat's own message.
export type BookamatErrorCode =
  | 'not_configured' | 'not_found' | 'not_issued' | 'not_eur' | 'not_settled' | 'nothing_to_book' | 'no_items'
  | 'cash_account_missing' | 'vat_account_missing' | 'account_missing' | 'accounts_stale' | 'in_progress' | 'auth'
  | 'year_missing' | 'timeout' | 'network' | 'bookamat' | 'db_write' | 'database' | 'not_synced' | 'unconfirmed'
  | 'unknown_outcome'

export type ErrorDetail = Record<string, string | number>

const ERROR_CODES: readonly BookamatErrorCode[] = [
  'not_configured', 'not_found', 'not_issued', 'not_eur', 'not_settled', 'nothing_to_book', 'no_items',
  'cash_account_missing', 'vat_account_missing', 'account_missing', 'accounts_stale', 'in_progress', 'auth',
  'year_missing', 'timeout', 'network', 'bookamat', 'db_write', 'database', 'not_synced', 'unconfirmed',
  'unknown_outcome',
]

// A route's error payload in the UI language; unknown payloads fall back to their raw message.
export function bookamatErrorMessage(t: TFn, payload: unknown, fallback = t('common.unknownError')): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown; detail?: unknown }
  const message = typeof p.error === 'string' && p.error ? p.error : fallback
  const code = ERROR_CODES.find(c => c === p.code)
  if (!code) return message
  const detail = p.detail && typeof p.detail === 'object' ? p.detail as ErrorDetail : {}
  return t(`books.errors.${code}` as DictKey, { message, ...detail })
}

// ─── Plan: what a document books ─────────────────────────────────────────────

export type MoneyRow = { date: string; amount: number; kind: string; method?: string | null }

export type PlannedBooking = {
  year: number
  kind: BookamatBookingKind
  // Last money movement of that year: the booking date.
  date: string
  // Gross booked, always positive here; a refund books it negative.
  amount: number
  cash: number
}

// Ist-Besteuerung, money only. An invoice books its 'payment' rows (a Skonto taken, a write-off
// or an applied credit note moves no money and is not booked), a credit note its 'refund' rows.
// One booking per calendar year, dated on that year's last movement. What arrives beyond the
// amount still to be paid (an overpayment) is not turnover and is left out, latest money last.
// Dunning fees and interest ('fee') are reported back, never booked.
export function planBookings(input: { type: 'invoice' | 'credit_note'; total: number; rows: MoneyRow[] }): { bookings: PlannedBooking[]; fees: number } {
  const moneyKind = input.type === 'invoice' ? 'payment' : 'refund'
  const credited = input.type === 'invoice' ? input.rows.filter(r => r.kind === 'credit').reduce((s, r) => s + r.amount, 0) : 0
  const fees = roundCents(input.rows.filter(r => r.kind === 'fee').reduce((s, r) => s + r.amount, 0))
  let remaining = roundCents(Math.max(0, input.total - credited))

  const byYear = new Map<number, MoneyRow[]>()
  for (const r of input.rows) {
    if (r.kind !== moneyKind || !(r.amount > 0)) continue
    const year = Number(r.date.slice(0, 4))
    byYear.set(year, [...(byYear.get(year) ?? []), r])
  }

  const bookings: PlannedBooking[] = []
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const rows = byYear.get(year)!
    const received = roundCents(rows.reduce((s, r) => s + r.amount, 0))
    const amount = roundCents(Math.min(received, remaining))
    if (amount <= 0) continue
    remaining = roundCents(remaining - amount)
    const cashReceived = rows.filter(r => r.method === 'cash').reduce((s, r) => s + r.amount, 0)
    bookings.push({
      year,
      kind: input.type === 'invoice' ? 'income' : 'refund',
      date: rows.map(r => r.date).sort().at(-1)!,
      amount,
      cash: roundCents(cashReceived * (amount / received)),
    })
  }
  return { bookings, fees }
}

// What is still to book: the planned years without a booking, capped by the planned money the
// bookings already made do not cover. A booking from before yearly bookings covers all money in
// one year, and a payment date moved across New Year leaves the old year's booking behind;
// neither may book the same money a second time.
export function unbookedPlan(planned: PlannedBooking[], booked: { year: number; kind: string; amount: number }[]): PlannedBooking[] {
  const out: PlannedBooking[] = []
  for (const kind of new Set(planned.map(p => p.kind))) {
    const ofKind = planned.filter(p => p.kind === kind).sort((a, b) => a.year - b.year)
    const done = booked.filter(b => b.kind === kind)
    let budget = roundCents(ofKind.reduce((s, p) => s + p.amount, 0) - done.reduce((s, b) => s + Math.abs(Number(b.amount)), 0))
    for (const p of ofKind) {
      if (done.some(b => b.year === p.year)) continue
      const amount = roundCents(Math.min(p.amount, budget))
      if (amount <= 0) break
      budget = roundCents(budget - amount)
      out.push(amount === p.amount ? p : { ...p, amount, cash: roundCents(p.cash * amount / p.amount) })
    }
  }
  return out.sort((a, b) => a.year - b.year)
}

// ─── State shown in lists ────────────────────────────────────────────────────

export type StateInput = {
  type?: string
  number: string | null
  status: string
  bookamat_error?: string | null
  bookamat_booking_id?: string | null
  bookamat_bookings?: unknown[] | null
  payments?: { kind?: string | null; amount: number }[] | null
}

// Something to book: a paid invoice, or a cancelled one that had received money (its Storno books
// the refund); a credit note once money was paid back.
export function hasMoneyToBook(doc: StateInput): boolean {
  if (!doc.number) return false
  const payments = doc.payments ?? []
  if ((doc.type ?? 'invoice') === 'credit_note') return doc.status === 'sent' && payments.some(p => p.kind === 'refund' && p.amount > 0)
  return doc.status === 'paid' || (doc.status === 'cancelled' && payments.some(p => (p.kind ?? 'payment') === 'payment' && p.amount > 0))
}

export function bookamatState(doc: StateInput): BookamatState {
  if (doc.bookamat_error) return 'failed'
  if ((doc.bookamat_bookings?.length ?? 0) > 0 || doc.bookamat_booking_id) return 'synced'
  return hasMoneyToBook(doc) ? 'unsynced' : 'none'
}

// "#123 (2025), #456 (2026)"
export function formatBookings(t: TFn, bookings: { year: number; booking_id?: string; bookingId?: string }[]): string {
  return bookings.map(b => t('books.sync.booking', { id: b.booking_id ?? b.bookingId ?? '', year: b.year })).join(', ')
}

// ─── Sync route ──────────────────────────────────────────────────────────────

export type BookingRow = Pick<BookamatBooking, 'year' | 'booking_id' | 'amount' | 'kind' | 'booked_on' | 'pdf_attached_at'>
export const BOOKING_COLUMNS = 'year, booking_id, amount, kind, booked_on, pdf_attached_at'

// A booking Bookamat accepted that could not be recorded here: sent back as `adopt`, it is
// recorded instead of booked a second time.
export type AdoptBooking = { year: number; kind: BookamatBookingKind; bookingId: string }

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
}

type SyncResponse = { ok: true; data: SyncSuccess } | { ok: false; payload: unknown }

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
// too, the next sync from this tab sends it again.
export async function requestBookamatSync(documentId: string): Promise<SyncResponse> {
  const post = async (adopt?: AdoptBooking[]): Promise<SyncResponse> => {
    const res = await fetch('/api/bookamat/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, ...(adopt?.length ? { adopt } : {}) }),
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
