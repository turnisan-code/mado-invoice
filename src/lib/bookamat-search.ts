// What Bookamat already has, read only. Before the sync posts it looks for a booking of the same
// money that Mado did not make (Bookmatic, bookamat's own bank import, a hand booking), so money
// is never booked twice (Bookmatic audit P0-2). Browser-safe and free of the HTTP client: the
// readers take a GET function, and bookamat.ts turns any failure into "nothing booked".
import type { MoneyRow, PlannedBooking } from '@/lib/bookamat-client'

// A booking as Mado compares it. `total`: the size of the signed sum of its lines (a 100,00 line
// with a −10,00 line is 90,00). `moneyIn`: income money (lines of group 1, or of no group) with a
// positive sum, or expense lines with a negative one; Bookamat marks each line „1“ (income) or
// „2“ (expense). `lines`: what all its lines are; only an 'income' booking is what Mado itself
// books (revenue, or a refund as negative revenue).
export type BookingLite = {
  year: number
  id: string
  date: string
  title: string
  description: string
  total: number
  moneyIn: boolean
  lines: 'income' | 'expense' | 'mixed'
}

// Whether a candidate can be taken over as Mado's booking of one payment:
// - 'exact': income, the amount of a payment of its year still to book (±2 cents) — „übernehmen“
//   (`paymentId`: that payment, the one nearest its date among several of that amount);
// - 'part' / 'more': less or more than the nearest payment of its year (several payments in one
//   booking, a reminder fee in the same transfer): the money is in Bookamat, but not in Mado's shape;
// - 'year': it lies in a year Mado books none of this money in (a payment dated across New Year);
// - 'booked': it lies in a year whose money Mado booked already: possibly booked twice there;
// - 'kind': not an income booking (booked as an expense);
// - 'other_number': it names another invoice of the same numbering, and not this one (a booking
//   naming both is a combined one: 'more').
export type CandidateFit = 'exact' | 'part' | 'more' | 'year' | 'booked' | 'kind' | 'other_number'

// A booking that may be the money a sync is about to book. `reason`: it names the document's
// number, or it moves the same amount within the window. `fit` and what it was compared with
// (`planned`: the amount Mado books for that year; `plannedYears`: the years it books money in;
// `other`: the other number it names) come from candidateFit.
export type BookingCandidate = {
  year: number
  bookingId: string
  date: string
  title: string
  total: number
  reason: 'number' | 'amount'
  fit?: CandidateFit
  planned?: number
  plannedYears?: number[]
  other?: string
  // For an exact fit: the payment it books.
  paymentId?: string | null
  // The payment whose search found it (the sync searches per payment).
  foundFor?: string | null
}

// A booking the owner said is not this money („trotzdem buchen“), or one to take over.
// `paymentId`: the payment it books (a take-over), or the one it was found for (an
// acknowledgement, which then counts for that payment only).
export type BookingRef = { year: number; bookingId: string; paymentId?: string | null }

export const WINDOW_DAYS = 10
const TOLERANCE = 0.02
const PAGE_SIZE = 100
export const MAX_PAGES = 20

export const bookingKey = (year: number, id: string) => `${year}:${id}`

const round2 = (n: number) => Math.round(n * 100) / 100
const ISO = /^\d{4}-\d{2}-\d{2}$/

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

export function yearsBetween(from: string, until: string): number[] {
  const out: number[] = []
  for (let y = Number(from.slice(0, 4)); y <= Number(until.slice(0, 4)); y++) out.push(y)
  return out
}

// One booking of a Bookamat list or detail answer; null for anything that is not one, and for a
// deleted booking (status „3“), which no longer books money.
export function toBookingLite(year: number, raw: unknown): BookingLite | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id) : ''
  if (!/^\d{1,18}$/.test(id) || String(o.status ?? '1') === '3' || !Array.isArray(o.amounts)) return null
  const date = typeof o.date === 'string' && ISO.test(o.date) ? o.date : ''
  const lines = o.amounts as Record<string, unknown>[]
  const signed = lines.reduce((s, l) => s + (Number.parseFloat(String(l?.amount ?? '0')) || 0), 0)
  const groups = lines.map(l => (l && l.group != null ? String(l.group) : ''))
  const expense = groups.length > 0 && groups.every(g => g === '2')
  return {
    year,
    id,
    date,
    title: typeof o.title === 'string' ? o.title : '',
    description: typeof o.description === 'string' ? o.description : '',
    total: round2(Math.abs(signed)),
    moneyIn: !expense !== (signed < 0),
    lines: groups.length > 0 && groups.every(g => g === '1') ? 'income' : expense ? 'expense' : 'mixed',
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The document number as a booking may write it. One long digit run (Mado's YYYYMMNNN, 7 digits
// or more) is found by its digits alone, however the prefix is written or left out:
// "RN-202605010" in "RN-202605010 – Talentir", "RN_202605010 - Talentir", "Rechnung 202605010",
// never in "2026050101". A number of several shorter parts is found only whole, letters
// included, with any separators: "R-2026-001" in "R 2026/001", never in "G-2026-001". Fewer than
// five digits would match too much: such a number is compared by amount only.
export function numberPattern(documentNumber: string): RegExp | null {
  const digitRuns = documentNumber.match(/\d+/g) ?? []
  const digits = digitRuns.join('')
  if (digits.length < 5) return null
  if (digitRuns.length === 1 && digits.length >= 7) return new RegExp(`(?<!\\d)${digits}(?!\\d)`, 'u')
  const parts = documentNumber.match(/\p{L}+|\d+/gu) ?? []
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(escapeRe).join('[^\\p{L}\\p{N}]*')}(?!\\d)`, 'iu')
}

// Another number of the same numbering in `text` (a booking of another invoice): the same prefix
// letters with the same digit runs, or, for one long digit run, a bare run of that length that
// starts with the same four digits (the year: a bank or customer reference such as 104857600 is
// no invoice). null when there is none, or only this document's own.
export function otherNumberIn(text: string, documentNumber: string): string | null {
  const own = numberPattern(documentNumber)
  const digitRuns = documentNumber.match(/\d+/g) ?? []
  const parts = documentNumber.match(/\p{L}+|\d+/gu) ?? []
  if (!own || !parts.length) return null
  const shape = parts.map(p => (/^\d+$/.test(p) ? `\\d{${p.length}}` : escapeRe(p))).join('[^\\p{L}\\p{N}]*')
  const sources = [`(?<![\\p{L}\\p{N}])${shape}(?!\\d)`]
  if (digitRuns.length === 1 && digitRuns[0].length >= 7) sources.push(`(?<!\\d)${digitRuns[0].slice(0, 4)}\\d{${digitRuns[0].length - 4}}(?!\\d)`)
  for (const source of sources) {
    for (const m of text.matchAll(new RegExp(source, 'giu'))) {
      if (!own.test(m[0])) return m[0].trim()
    }
  }
  return null
}

// Money the sync is about to book: a payment's (or refund's) date and the amounts that would be
// that money in a booking (the payment with what came with it, the part Mado books, the total).
export type MoneyTarget = { date: string; amounts: number[] }

// What one payment still to book may look like in Bookamat: the amount Mado books, the payment
// itself, the payment with the dunning fees of its day (one transfer recorded as both), and the
// document's whole amount. The payment is found by its id, or (a row read without its id) as the
// first of its kind and date.
export function moneyTarget(
  p: Pick<PlannedBooking, 'kind' | 'date' | 'amount' | 'paymentId'>,
  rows: MoneyRow[],
  total: number,
): MoneyTarget {
  const moneyKind = p.kind === 'income' ? 'payment' : 'refund'
  const row = rows.find(r => r.kind === moneyKind && (p.paymentId ? r.id === p.paymentId : !r.id && r.date === p.date))
  const fees = row ? rows.filter(f => f.kind === 'fee' && f.date === row.date).reduce((s, f) => s + f.amount, 0) : 0
  return { date: p.date, amounts: [p.amount, ...(row ? [row.amount, row.amount + fees] : []), total] }
}

// The bookings among `bookings` that may already book this money: one naming the document's
// number (any date), or one moving the same amount (±2 cents) the same way within ±10 days of a
// payment. Bookings in `exclude` (recorded in Mado, or ones the owner said are other money) never
// count. Each booking is named once, by number before amount.
export function findCandidates(input: {
  moneyIn: boolean
  pattern: RegExp | null
  targets: MoneyTarget[]
  bookings: BookingLite[]
  exclude: ReadonlySet<string>
  windowDays?: number
}): BookingCandidate[] {
  const windowDays = input.windowDays ?? WINDOW_DAYS
  const out = new Map<string, BookingCandidate>()
  for (const b of input.bookings) {
    const key = bookingKey(b.year, b.id)
    if (input.exclude.has(key) || out.has(key) || b.moneyIn !== input.moneyIn) continue
    const names = !!input.pattern && (input.pattern.test(b.title) || input.pattern.test(b.description))
    const sameMoney = !!b.date && input.targets.some(t =>
      daysApart(t.date, b.date) <= windowDays && t.amounts.some(a => a > 0 && Math.abs(b.total - a) <= TOLERANCE))
    if (names || sameMoney) {
      out.set(key, { year: b.year, bookingId: b.id, date: b.date, title: b.title, total: b.total, reason: names ? 'number' : 'amount' })
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || Number(a.bookingId) - Number(b.bookingId))
}

// Whether `booking` can be taken over as the booking of one of the document's payments (see
// CandidateFit). `planned`: the payments Mado still books (amount, year, date); `bookedYears`: the
// years whose money Mado booked already. Among several payments of the booking's amount, the one
// nearest its date is the one it books.
export function candidateFit(
  booking: Pick<BookingLite, 'year' | 'date' | 'title' | 'description' | 'total' | 'lines'>,
  ctx: { documentNumber: string; planned: { year: number; amount: number; paymentId?: string | null; date?: string }[]; bookedYears?: number[] },
): Pick<BookingCandidate, 'fit' | 'planned' | 'plannedYears' | 'other' | 'paymentId'> {
  const plannedYears = [...new Set(ctx.planned.map(p => p.year))]
  const text = `${booking.title} ${booking.description}`
  const other = otherNumberIn(text, ctx.documentNumber)
  const ownToo = !!numberPattern(ctx.documentNumber)?.test(text)
  if (other && !ownToo) return { fit: 'other_number', other, plannedYears }
  if (booking.lines !== 'income') return { fit: 'kind', plannedYears }
  const near = (x: { date?: string }) => (x.date && booking.date ? daysApart(x.date, booking.date) : 0)
  const ofYear = ctx.planned.filter(x => x.year === booking.year).sort((a, b) => near(a) - near(b))
  if (!ofYear.length) return { fit: ctx.bookedYears?.includes(booking.year) ? 'booked' : 'year', plannedYears }
  const exact = ofYear.find(x => Math.abs(booking.total - x.amount) <= TOLERANCE)
  if (exact) return { fit: 'exact', planned: exact.amount, plannedYears, paymentId: exact.paymentId ?? null }
  const p = ofYear[0]
  return { fit: booking.total < p.amount ? 'part' : 'more', planned: p.amount, plannedYears }
}

// ─── Readers ─────────────────────────────────────────────────────────────────

// A GET of a path relative to a year's API base ("bookings/?…"), answering the parsed JSON.
// It throws what the HTTP client throws; an error whose `code` is 'year_missing' is Bookamat's 404
// (bookamatFetch calls every 404 that).
export type GetPage = (year: number, path: string) => Promise<unknown>

const isYearMissing = (err: unknown) => !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'year_missing'

export class SearchLimitError extends Error {
  constructor(readonly year: number) {
    super(`more than ${MAX_PAGES * PAGE_SIZE} bookings to search in ${year}`)
  }
}

// Every booking of a year, page by page (Bookamat pages by `page`; `next` is null on the last
// page). More pages than MAX_PAGES, an answer that is not a list of bookings, or a booking without
// lines is an error, never a cut-off list. A 404 on the first page means the year has no books:
// an empty year when `missingIsEmpty`, else an error (a year Mado books in, whose accounts were
// just read, cannot be missing).
export async function readYear(get: GetPage, year: number, opts: { missingIsEmpty?: boolean } = {}): Promise<BookingLite[]> {
  const out: BookingLite[] = []
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new SearchLimitError(year)
    const params = new URLSearchParams({ format: 'json', limit: String(PAGE_SIZE) })
    if (page > 1) params.set('page', String(page))
    let data: unknown
    try {
      data = await get(year, `bookings/?${params}`)
    } catch (err) {
      if (page === 1 && isYearMissing(err) && (opts.missingIsEmpty ?? true)) return []
      throw err
    }
    const body = data && typeof data === 'object' && !Array.isArray(data) ? data as { results?: unknown; next?: unknown } : null
    const results = Array.isArray(data) ? data : body?.results
    if (!Array.isArray(results)) throw new Error(`unexpected answer for bookings of ${year}`)
    for (const raw of results) {
      const b = toBookingLite(year, raw)
      if (b) out.push(b)
      else if (raw && typeof raw === 'object' && String((raw as { status?: unknown }).status ?? '1') !== '3') {
        throw new Error(`unexpected booking in the answer for ${year}`)
      }
    }
    if (Array.isArray(data) || !body?.next || !results.length) return out
  }
}

// "#71099 · 19.01.2026 · 1.400,00 € · RN_202601001 Rönngard": a candidate in a stored error text.
export function describeCandidate(c: Pick<BookingCandidate, 'bookingId' | 'date' | 'total' | 'title'>): string {
  const date = ISO.test(c.date) ? `${c.date.slice(8, 10)}.${c.date.slice(5, 7)}.${c.date.slice(0, 4)}` : c.date
  return [`#${c.bookingId}`, date, euro(c.total), c.title.trim()].filter(Boolean).join(' · ')
}

// "1.400,00 €": an amount in a stored error text (the owner's books are in euros).
export function euro(amount: number): string {
  const [int, dec] = Math.abs(amount).toFixed(2).split('.')
  return `${amount < 0 ? '−' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`
}
