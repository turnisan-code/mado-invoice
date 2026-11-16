// „Mit Bookamat abgleichen“ (Settings → Bookamat), read only: Mado's documents against a year's
// bookings in Bookamat. Pure: the route reads both and hands them in.
// - every booking Mado recorded: is it in Bookamat, with the same amount and date?
// - money the sync would book but has not: does Bookamat have it already (the sync's rules), and
//   can that booking be taken over (candidateFit)?
// - for a document whose money Mado booked itself: another booking naming its number — possibly
//   booked twice;
// - bookings naming a number in Mado's invoice range that no Mado document has.
// Each document is looked at on its own, so the order of the documents changes nothing.
import { calcTotals } from '@/lib/utils/document'
import { creditNoteSettled } from '@/lib/status'
import { hasMoneyToBook, planBookings, unbookedPlan, type BookingRow, type MoneyRow } from '@/lib/bookamat-client'
import {
  bookingKey, candidateFit, findCandidates, numberPattern, type BookingCandidate, type BookingLite, type MoneyTarget,
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
const longestRun = (number: string) => (number.match(/\d+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '')

// `applied`: per credit note, what was credited to invoices (it settles the credit note like a refund).
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
    const total = calcTotals(d.document_items ?? [], [], discount, d.tax_treatment).total
    const refunded = rows.filter(r => r.kind === 'refund').reduce((s, r) => s + r.amount, 0)
    // What the sync would book now: a paid invoice, a settled credit note, in EUR.
    const offered = (d.currency ?? 'EUR') === 'EUR' && (moneyIn
      ? hasMoneyToBook({ type: 'invoice', number: d.number, status: d.status, payments: rows })
      : d.status === 'sent' && refunded > 0 && creditNoteSettled(total, input.applied?.[d.id] ?? 0, refunded))
    const todo = offered ? unbookedPlan(planBookings({ type: d.type, total, rows }).bookings, recorded) : []
    const planned = todo.map(p => ({ year: p.year, amount: p.amount }))
    const moneyKind = moneyIn ? 'payment' : 'refund'
    const mine = new Set<string>()
    for (const p of todo.filter(x => years.has(x.year))) {
      const targets: MoneyTarget[] = [{ date: p.date, amounts: [p.amount, total] }]
      for (const r of rows) {
        if (r.kind !== moneyKind || !(r.amount > 0) || Number(r.date.slice(0, 4)) !== p.year) continue
        const fees = rows.filter(f => f.kind === 'fee' && f.date === r.date).reduce((s, f) => s + f.amount, 0)
        targets.push({ date: r.date, amounts: [r.amount, r.amount + fees, p.amount, total] })
      }
      const candidates = findCandidates({ moneyIn, pattern, targets, bookings: input.bookings, exclude: recordedKeys })
        .filter(c => !mine.has(bookingKey(c.year, c.bookingId)))
        .map(c => ({ ...c, ...candidateFit(byKey.get(bookingKey(c.year, c.bookingId))!, { documentNumber: d.number, planned }) }))
      for (const c of candidates) {
        mine.add(bookingKey(c.year, c.bookingId))
        named.add(bookingKey(c.year, c.bookingId))
      }
      report.unbooked.push({ documentId: d.id, type: d.type, number: d.number, client: d.client, year: p.year, amount: p.amount, date: p.date, candidates })
    }

    // Possibly booked twice: only where Mado booked this document's money itself.
    if (!pattern || !recorded.length) continue
    for (const b of input.bookings) {
      const key = bookingKey(b.year, b.id)
      if (recordedKeys.has(key) || mine.has(key) || b.moneyIn !== moneyIn) continue
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
