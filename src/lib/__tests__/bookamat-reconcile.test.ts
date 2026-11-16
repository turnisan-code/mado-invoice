// „Mit Bookamat abgleichen“, read only. Synthetic documents and bookings only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, type ReconcileDoc } from '@/lib/bookamat-reconcile'
import { toBookingLite, type BookingLite } from '@/lib/bookamat-search'

const item = (net: number) => ({ line_type: 'item', sort_order: 0, quantity: 1, unit_price: net, vat_rate: 20, discount_type: null, discount_value: null })
const doc = (id: string, number: string, net: number, payments: ReconcileDoc['payments'], bookings: ReconcileDoc['bookamat_bookings'] = [], status = 'paid'): ReconcileDoc => ({
  id, type: 'invoice', number, status, currency: 'EUR', tax_treatment: 'at_vat', discount_type: null, discount_value: null,
  document_items: [item(net)], payments, bookamat_bookings: bookings, client: 'Muster',
})
const booking = (id: number, date: string, title: string, amount: string, group = '1'): BookingLite =>
  toBookingLite(Number(date.slice(0, 4)), { id, status: '1', title, date, description: '', amounts: [{ group, amount }] })!
const row = (year: number, id: string, amount: number, bookedOn: string) => ({ year, booking_id: id, amount, kind: 'income' as const, booked_on: bookedOn, pdf_attached_at: null })

test('recorded bookings: found, missing, different', () => {
  const docs = [
    doc('d1', 'RN-209905008', 100, [{ date: '2026-05-20', amount: 120, kind: 'payment' }], [row(2026, '9701', 120, '2026-05-20')]),
    doc('d2', 'RN-209905009', 500, [{ date: '2026-06-17', amount: 600, kind: 'payment' }], [row(2026, '9702', 600, '2026-06-17')]),
    doc('d3', 'RN-209905010', 1000, [{ date: '2026-06-26', amount: 1200, kind: 'payment' }], [row(2026, '9703', 1200, '2026-06-26')]),
  ]
  const bookings = [booking(9701, '2026-05-20', 'RN-209905008 – Muster', '120.00'), booking(9703, '2026-06-27', 'RN-209905010 – Muster', '1200.00')]
  const r = reconcile({ docs, bookings, years: [2025, 2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.recorded.map(c => [c.number, c.status]), [['RN-209905008', 'ok'], ['RN-209905009', 'missing'], ['RN-209905010', 'differs']])
  assert.deepEqual(r.unbooked, [])
  assert.deepEqual(r.doubles, [])
})

test('money Mado should book: listed, with what Bookamat may already have', () => {
  const docs = [
    doc('d1', 'RN-209906013', 975, [{ date: '2026-07-03', amount: 1170, kind: 'payment' }]),
    doc('d2', 'RN-209906014', 270, [{ date: '2026-08-04', amount: 258, kind: 'payment' }, { date: '2026-11-11', amount: 12, kind: 'writeoff' }]),
    // Part-paid: Mado books it once fully paid, so it is not listed yet.
    doc('d3', 'RN-209907017', 700, [{ date: '2026-08-01', amount: 100, kind: 'payment' }], [], 'sent'),
  ]
  const bookings = [booking(9801, '2026-07-03', 'RN_209906013 - Muster', '1170.00')]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.unbooked.map(u => [u.number, u.amount, u.date, u.candidates.map(c => c.bookingId)]), [
    ['RN-209906013', 1170, '2026-07-03', ['9801']],
    ['RN-209906014', 258, '2026-08-04', []],
  ])
  assert.deepEqual(r.doubles, [])
})

test('a second booking of money Mado already booked is a possible double booking', () => {
  const docs = [doc('d1', 'RN-209905010', 1000, [{ date: '2026-06-26', amount: 1200, kind: 'payment' }], [row(2026, '9901', 1200, '2026-06-26')])]
  const bookings = [
    booking(9901, '2026-06-26', 'RN-209905010 – Muster', '1200.00'),
    booking(9902, '2026-06-26', 'RN_209905010 - Muster', '1200.00'),
    booking(9903, '2026-06-26', 'Rückzahlung RN-209905010', '1200.00', '2'),
  ]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.doubles.map(x => x.booking.bookingId), ['9902'])
})

test('a number in Mado\'s range that no Mado document has', () => {
  const docs = [
    doc('d1', 'RN-209905008', 100, [{ date: '2026-05-20', amount: 120, kind: 'payment' }], [row(2026, '9601', 120, '2026-05-20')]),
    doc('d2', 'RN-209907017', 700, [], [], 'sent'),
  ]
  const bookings = [
    booking(9601, '2026-05-20', 'RN-209905008 – Muster', '120.00'),
    booking(9602, '2026-08-01', 'RN_209907016 - Jemand', '840.00'), // in the range, unknown
    booking(9603, '2026-02-01', 'RN_209902002 - Älter', '500.00'), // before Mado's first number
    booking(9604, '2026-03-01', 'Miete MDW 03/26', '633.60'),
  ]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.unknown.map(u => [u.number, u.booking.bookingId]), [['RN-209907016', '9602']])
  assert.equal(reconcile({ docs, bookings, years: [2026], invoicePrefix: null }).unknown.length, 0)
})

test('a year outside the check is not reported', () => {
  const docs = [doc('d1', 'RN-209905008', 100, [{ date: '2025-05-20', amount: 120, kind: 'payment' }], [row(2025, '9501', 120, '2025-05-20')])]
  const r = reconcile({ docs, bookings: [], years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.recorded, [])
})

test('the order of the documents changes nothing, and another invoice\'s booking is never offered', () => {
  const a = doc('dA', 'RN-209906101', 700, [{ date: '2026-06-15', amount: 840, kind: 'payment' }])
  const b = doc('dB', 'RN-209906102', 700, [{ date: '2026-06-10', amount: 840, kind: 'payment' }], [row(2026, '9921', 840, '2026-06-10')])
  const bookings = [booking(9921, '2026-06-10', 'RN-209906102 – Muster', '840.00'), booking(9922, '2026-06-10', 'RN_209906102 - Muster', '840.00')]
  for (const docs of [[a, b], [b, a]]) {
    const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
    assert.deepEqual(r.doubles.map(d => [d.number, d.booking.bookingId]), [['RN-209906102', '9922']])
    const offered = r.unbooked.find(u => u.number === 'RN-209906101')!
    assert.deepEqual(offered.candidates.map(c => [c.bookingId, c.fit]), [['9922', 'other_number']])
  }
})

test('a hand booking of money Mado does not book is no double booking', () => {
  const docs = [
    { ...doc('d1', 'RN-209906201', 100, [{ date: '2026-06-01', amount: 120, kind: 'payment' }]), currency: 'USD' },
    doc('d2', 'RN-209906202', 500, [{ date: '2026-06-02', amount: 100, kind: 'payment' }], [], 'sent'),
  ]
  const bookings = [booking(9931, '2026-06-01', 'RN-209906201 USD', '110.00'), booking(9932, '2026-06-02', 'RN 209906202 Teilzahlung', '100.00')]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.doubles, [])
  assert.deepEqual(r.unbooked, [])
})

test('a credit note is listed only once it is settled', () => {
  const credit = (payments: ReconcileDoc['payments']): ReconcileDoc => ({ ...doc('c1', 'AN-2099001', 500, payments), type: 'credit_note', status: 'sent' })
  const partly = credit([{ date: '2026-06-10', amount: 200, kind: 'refund' }])
  assert.deepEqual(reconcile({ docs: [partly], bookings: [], years: [2026], invoicePrefix: 'RN' }).unbooked, [])
  // 200 refunded and 400 credited to the invoice settle the 600.
  const r = reconcile({ docs: [partly], bookings: [], years: [2026], invoicePrefix: 'RN', applied: { c1: 400 } })
  assert.deepEqual(r.unbooked.map(u => [u.number, u.amount]), [['AN-2099001', 200]])
})
