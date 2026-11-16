// What Bookamat already has, read only. Before the sync posts it looks for a booking of the same
// money that Mado did not make (Bookmatic, bookamat's own bank import, a hand booking), so money
// is never booked twice (Bookmatic audit P0-2). Browser-safe and free of the HTTP client: the
// readers take a GET function, and bookamat.ts turns any failure into "nothing booked".

// A booking as Mado compares it. `total`: the signed sum of its lines (a 100,00 line with a
// −10,00 line is 90,00). `moneyIn`: income money (lines of group 1, or of no group) with a
// positive sum, or expense lines with a negative one; Bookamat marks each line „1“ (income) or
// „2“ (expense).
export type BookingLite = {
  year: number
  id: string
  date: string
  title: string
  description: string
  total: number
  moneyIn: boolean
}

// A booking that may be the money a sync is about to book. `reason`: it names the document's
// number, or it moves the same amount within the window.
export type BookingCandidate = {
  year: number
  bookingId: string
  date: string
  title: string
  total: number
  reason: 'number' | 'amount'
}

// A booking the owner said is not this money („trotzdem buchen“), or one to take over.
export type BookingRef = { year: number; bookingId: string }

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

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

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
  if (!/^\d{1,18}$/.test(id) || String(o.status ?? '1') === '3') return null
  const date = typeof o.date === 'string' && ISO.test(o.date) ? o.date : ''
  const lines = Array.isArray(o.amounts) ? o.amounts as Record<string, unknown>[] : []
  const signed = lines.reduce((s, l) => s + (Number.parseFloat(String(l?.amount ?? '0')) || 0), 0)
  const expense = lines.length > 0 && lines.every(l => l && l.group != null && String(l.group) === '2')
  return {
    year,
    id,
    date,
    title: typeof o.title === 'string' ? o.title : '',
    description: typeof o.description === 'string' ? o.description : '',
    total: round2(Math.abs(signed)),
    moneyIn: !expense !== (signed < 0),
  }
}

// The document number's digits as a booking may spell them: "RN-202605010" is found in
// "RN-202605010 – Talentir GmbH", "RN_202605010 - Talentir" and "Rechnung 202605010", never in
// "2026050101". Separators may differ ("R-2026-001" in "2026/001"). Fewer than five digits would
// match too much: such a number is compared by amount only.
export function numberPattern(documentNumber: string): RegExp | null {
  const groups = documentNumber.match(/\d+/g) ?? []
  if (groups.join('').length < 5) return null
  return new RegExp(`(?<!\\d)${groups.join('[^\\p{L}\\p{N}]*')}(?!\\d)`, 'u')
}

// What Bookamat's title filter (a case-insensitive substring) is asked for: the longest digit run,
// if it is long enough to find the document and few others.
export function numberQuery(documentNumber: string): string | null {
  const longest = (documentNumber.match(/\d+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '')
  return longest.length >= 5 ? longest : null
}

// Money the sync is about to book: a payment's (or refund's) date and the amounts that would be
// that money in a booking (the payment, the year's booking, the document's total).
export type MoneyTarget = { date: string; amounts: number[] }

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

// ─── Readers ─────────────────────────────────────────────────────────────────

// A GET of a path relative to a year's API base ("bookings/?…"), answering the parsed JSON.
// It throws what the HTTP client throws; an error whose `code` is 'year_missing' (Bookamat's 404
// for a year it has no books for) means that year has no bookings.
export type GetPage = (year: number, path: string) => Promise<unknown>

const isYearMissing = (err: unknown) => !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'year_missing'

export class SearchLimitError extends Error {}

// Every booking of `query` in `year`, page by page (Bookamat pages by `page`; `next` is null on
// the last page). More pages than MAX_PAGES is an error, never a cut-off list.
async function readPages(get: GetPage, year: number, query: URLSearchParams): Promise<BookingLite[]> {
  const out: BookingLite[] = []
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new SearchLimitError(`more than ${MAX_PAGES * PAGE_SIZE} bookings to search in ${year}`)
    const params = new URLSearchParams(query)
    params.set('format', 'json')
    params.set('limit', String(PAGE_SIZE))
    if (page > 1) params.set('page', String(page))
    let data: unknown
    try {
      data = await get(year, `bookings/?${params}`)
    } catch (err) {
      if (page === 1 && isYearMissing(err)) return []
      throw err
    }
    const body = data && typeof data === 'object' && !Array.isArray(data) ? data as { results?: unknown; next?: unknown } : null
    const results = Array.isArray(data) ? data : body?.results
    if (!Array.isArray(results)) throw new Error(`unexpected answer for bookings of ${year}`)
    for (const raw of results) {
      const b = toBookingLite(year, raw)
      if (b) out.push(b)
    }
    if (Array.isArray(data) || !body?.next || !results.length) return out
  }
}

// Every booking dated within [from, until], from each year's books the window touches.
export async function readBookingsInWindow(get: GetPage, from: string, until: string): Promise<BookingLite[]> {
  const out: BookingLite[] = []
  for (const year of yearsBetween(from, until)) {
    const lo = from > `${year}-01-01` ? from : `${year}-01-01`
    const hi = until < `${year}-12-31` ? until : `${year}-12-31`
    out.push(...await readPages(get, year, new URLSearchParams({ date_from: lo, date_until: hi })))
  }
  return out
}

// Every booking whose title contains `text`, in each of `years`.
export async function readBookingsTitled(get: GetPage, years: number[], text: string): Promise<BookingLite[]> {
  const out: BookingLite[] = []
  for (const year of years) out.push(...await readPages(get, year, new URLSearchParams({ title_contains: text })))
  return out
}

// All of a year's bookings (the read-only reconciliation).
export async function readYear(get: GetPage, year: number): Promise<BookingLite[]> {
  return readPages(get, year, new URLSearchParams())
}

// "#71099 · 19.01.2026 · 1.400,00 € · RN_202601001 Rönngard": a candidate in a stored error text.
export function describeCandidate(c: Pick<BookingCandidate, 'bookingId' | 'date' | 'total' | 'title'>): string {
  const date = ISO.test(c.date) ? `${c.date.slice(8, 10)}.${c.date.slice(5, 7)}.${c.date.slice(0, 4)}` : c.date
  const amount = c.total.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return [`#${c.bookingId}`, date, `${amount} €`, c.title.trim()].filter(Boolean).join(' · ')
}
