// „Mit Bookamat abgleichen“ (Settings → Bookamat), read only: Mado's documents against a year's
// bookings in Bookamat. Pure: the route reads both and hands them in.
// - every booking Mado recorded: is it in Bookamat, with the same amount and date?
// - money the sync would book but has not: does Bookamat have it already (the sync's rules), and
//   can that booking be taken over (candidateFit)?
// - for a document whose money Mado booked itself: another booking naming its number — possibly
//   booked twice;
// - bookings naming a number in Mado's invoice range that no Mado document has.
// Each document is looked at on its own, so the order of the documents changes nothing.
import { calcTotals, roundCents } from '@/lib/utils/document'
import { hasMoneyToBook, planBookings, unbookedPlan, type BookingRow, type MoneyRow, type PlannedBooking } from '@/lib/bookamat-client'
import {
  bookingKey, candidateFit, daysApart, findCandidates, moneyTarget, numberPattern, type BookingCandidate, type BookingLite,
} from '@/lib/bookamat-search'

export type ReconcileDoc = {
  id: string
  type: string
  number: string
  status: string
  currency: string | null
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0] | null
  payments: MoneyRow[] | null
  bookamat_bookings: BookingRow[] | null
  client: string
}

export type RecordedCheck = {
  documentId: string
  type: string
  number: string
  year: number
  bookingId: string
  amount: number
  bookedOn: string | null
  status: 'ok' | 'missing' | 'differs'
  bookamat: { date: string; total: number; title: string } | null
}

export type UnbookedMoney = {
  documentId: string
  type: string
  number: string
  client: string
  year: number
  amount: number
  date: string
  // The payment (or refund) it is; null only for a row read without its id.
  paymentId: string | null
  candidates: BookingCandidate[]
}

export type ReconcileReport = {
  years: number[]
  bookingsRead: number
  recorded: RecordedCheck[]
  unbooked: UnbookedMoney[]
  doubles: { documentId: string; type: string; number: string; booking: BookingCandidate }[]
  unknown: { number: string; booking: BookingCandidate }[]
}

const toCandidate = (b: BookingLite, reason: BookingCandidate['reason']): BookingCandidate =>
  ({ year: b.year, bookingId: b.id, date: b.date, title: b.title, total: b.total, reason })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const longestRun = (number: string) => (number.match(/\d+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '')

// `applied`: per credit note, what was credited to invoices (its refunds book the rest).
export function reconcile(input: {
  docs: ReconcileDoc[]
  bookings: BookingLite[]
  years: number[]
  invoicePrefix: string | null
  applied?: Record<string, number>
}): ReconcileReport {
  const years = new Set(input.years)
  const byKey = new Map(input.bookings.map(b => [bookingKey(b.year, b.id), b]))
  const recordedKeys = new Set(input.docs.flatMap(d => (d.bookamat_bookings ?? []).map(r => bookingKey(r.year, String(r.booking_id)))))
  const report: ReconcileReport = { years: input.years, bookingsRead: input.bookings.length, recorded: [], unbooked: [], doubles: [], unknown: [] }
  // Bookings some document already explains: never an unknown number.
  const named = new Set<string>()

  for (const d of input.docs) {
    if (d.type !== 'invoice' && d.type !== 'credit_note') continue
    const recorded = d.bookamat_bookings ?? []
    for (const r of recorded) {
      if (!years.has(r.year)) continue
      const b = byKey.get(bookingKey(r.year, String(r.booking_id)))
      const amount = Number(r.amount)
      const same = !!b && Math.abs(b.total - Math.abs(amount)) <= 0.02 && (!r.booked_on || b.date === r.booked_on)
      report.recorded.push({
        documentId: d.id, type: d.type, number: d.number, year: r.year, bookingId: String(r.booking_id), amount, bookedOn: r.booked_on,
        status: !b ? 'missing' : same ? 'ok' : 'differs',
        bookamat: b ? { date: b.date, total: b.total, title: b.title } : null,
      })
    }

    const moneyIn = d.type === 'invoice'
    const pattern = numberPattern(d.number)
    const rows = d.payments ?? []
    const discount = d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null
    const gross = calcTotals(d.document_items ?? [], [], discount, d.tax_treatment).total
    // As the sync books it (bookableTotal): a credit note's refunds book what it did not credit.
    const total = moneyIn ? gross : roundCents(Math.max(0, gross - (input.applied?.[d.id] ?? 0)))
    // What the sync would book now: money received on an issued invoice, part payments too, or
    // paid back on an issued credit note, in EUR.
    const offered = (d.currency ?? 'EUR') === 'EUR' && hasMoneyToBook({ type: d.type, number: d.number, status: d.status, payments: rows })
    const todo = offered ? unbookedPlan(planBookings({ type: d.type, total, rows }), recorded) : []
    const planned = todo.map(p => ({ year: p.year, amount: p.amount, paymentId: p.paymentId, date: p.date }))
    const bookedYears = recorded.map(r => r.year)
    const shown = todo.filter(x => years.has(x.year))
    // The sync's search, per payment (moneyTarget).
    const found = new Map<string, BookingCandidate>()
    for (const p of shown) {
      for (const c of findCandidates({ moneyIn, pattern, targets: [moneyTarget(p, rows, total)], bookings: input.bookings, exclude: recordedKeys })) {
        const key = bookingKey(c.year, c.bookingId)
        if (!found.has(key)) found.set(key, c)
      }
    }
    // Each booking is listed once, under the payment it books: the one its fit names, else the
    // nearest payment of its year, else the first.
    const listed = new Map<PlannedBooking, BookingCandidate[]>(shown.map(p => [p, []]))
    for (const [key, c] of found) {
      const fit = candidateFit(byKey.get(key)!, { documentNumber: d.number, planned, bookedYears })
      const ofYear = shown.filter(p => p.year === c.year).sort((a, b) => daysApart(a.date, c.date) - daysApart(b.date, c.date))
      const item = shown.find(p => !!fit.paymentId && p.paymentId === fit.paymentId) ?? ofYear[0] ?? shown[0]
      listed.get(item)!.push({ ...c, ...fit })
      named.add(key)
    }
    for (const p of shown) {
      const candidates = listed.get(p)!.sort((a, b) => a.date.localeCompare(b.date) || Number(a.bookingId) - Number(b.bookingId))
      report.unbooked.push({ documentId: d.id, type: d.type, number: d.number, client: d.client, year: p.year, amount: p.amount, date: p.date, paymentId: p.paymentId, candidates })
    }

    // Possibly booked twice: only where Mado booked this document's money itself.
    if (!pattern || !recorded.length) continue
    for (const b of input.bookings) {
      const key = bookingKey(b.year, b.id)
      if (recordedKeys.has(key) || found.has(key) || b.moneyIn !== moneyIn) continue
      if (!pattern.test(b.title) && !pattern.test(b.description)) continue
      named.add(key)
      report.doubles.push({ documentId: d.id, type: d.type, number: d.number, booking: toCandidate(b, 'number') })
    }
  }

  // Numbers shaped like Mado's invoice numbers, from its first one on, that no document has.
  const runs = input.docs.filter(d => d.type === 'invoice').map(d => longestRun(d.number)).filter(r => r.length >= 5)
  const prefix = input.invoicePrefix?.trim()
  if (prefix && runs.length) {
    const length = runs[0].length
    const known = new Set(runs)
    const first = Math.min(...runs.filter(r => r.length === length).map(Number))
    const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(prefix)}[\\s:_\\-/]*(\\d{${length}})(?!\\d)`, 'i')
    for (const b of input.bookings) {
      const key = bookingKey(b.year, b.id)
      if (!b.moneyIn || recordedKeys.has(key) || named.has(key)) continue
      const m = re.exec(b.title) ?? re.exec(b.description)
      if (m && Number(m[1]) >= first && !known.has(m[1])) report.unknown.push({ number: `${prefix}-${m[1]}`, booking: toCandidate(b, 'number') })
    }
  }
  return report
}
