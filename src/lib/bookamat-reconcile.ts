// „Mit Bookamat abgleichen“ (Settings → Bookamat), read only: Mado's documents against a year's
// bookings in Bookamat. Pure: the route reads both and hands them in.
// - every booking Mado recorded: is it in Bookamat, with the same amount and date?
// - money Mado should have booked but has not: does Bookamat have it already (the sync's rules)?
// - bookings naming a Mado document's number that Mado did not record although it booked that
//   money itself: possibly booked twice;
// - bookings naming a number in Mado's invoice range that no Mado document has.
import { calcTotals } from '@/lib/utils/document'
import { hasMoneyToBook, planBookings, unbookedPlan, type BookingRow, type MoneyRow } from '@/lib/bookamat-client'
import {
  bookingKey, findCandidates, numberPattern, numberQuery, type BookingCandidate, type BookingLite, type MoneyTarget,
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

export function reconcile(input: { docs: ReconcileDoc[]; bookings: BookingLite[]; years: number[]; invoicePrefix: string | null }): ReconcileReport {
  const years = new Set(input.years)
  const byKey = new Map(input.bookings.map(b => [bookingKey(b.year, b.id), b]))
  const recordedKeys = new Set(input.docs.flatMap(d => (d.bookamat_bookings ?? []).map(r => bookingKey(r.year, String(r.booking_id)))))
  const report: ReconcileReport = { years: input.years, bookingsRead: input.bookings.length, recorded: [], unbooked: [], doubles: [], unknown: [] }
  const named = new Set<string>()

  for (const d of input.docs) {
    if (d.type !== 'invoice' && d.type !== 'credit_note') continue
    for (const r of d.bookamat_bookings ?? []) {
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
    const offered = (d.currency ?? 'EUR') === 'EUR' && (d.type === 'invoice'
      ? hasMoneyToBook({ type: 'invoice', number: d.number, status: d.status, payments: rows })
      : d.status === 'sent' && rows.some(r => r.kind === 'refund' && r.amount > 0))
    const discount = d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null
    const total = calcTotals(d.document_items ?? [], [], discount, d.tax_treatment).total
    const todo = offered
      ? unbookedPlan(planBookings({ type: d.type, total, rows }).bookings, d.bookamat_bookings ?? []).filter(p => years.has(p.year))
      : []
    const moneyKind = moneyIn ? 'payment' : 'refund'
    for (const p of todo) {
      const targets: MoneyTarget[] = [{ date: p.date, amounts: [p.amount, total] }]
      for (const r of rows) if (r.kind === moneyKind && r.amount > 0 && Number(r.date.slice(0, 4)) === p.year) targets.push({ date: r.date, amounts: [r.amount, p.amount, total] })
      const candidates = findCandidates({ moneyIn, pattern, targets, bookings: input.bookings, exclude: recordedKeys })
      for (const c of candidates) named.add(bookingKey(c.year, c.bookingId))
      report.unbooked.push({ documentId: d.id, type: d.type, number: d.number, client: d.client, year: p.year, amount: p.amount, date: p.date, candidates })
    }

    if (!pattern) continue
    for (const b of input.bookings) {
      const key = bookingKey(b.year, b.id)
      if (recordedKeys.has(key) || named.has(key) || b.moneyIn !== moneyIn) continue
      if (!pattern.test(b.title) && !pattern.test(b.description)) continue
      named.add(key)
      report.doubles.push({ documentId: d.id, type: d.type, number: d.number, booking: toCandidate(b, 'number') })
    }
  }

  // Numbers shaped like Mado's invoice numbers, from its first one on, that no document has.
  const runs = input.docs.filter(d => d.type === 'invoice').map(d => numberQuery(d.number)).filter((r): r is string => !!r)
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
