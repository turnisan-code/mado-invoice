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
const row = (year: number, id: string, amount: number, bookedOn: string, paymentId: string | null = null) =>
  ({ year, booking_id: id, amount, kind: 'income' as const, booked_on: bookedOn, pdf_attached_at: null, payment_id: paymentId })

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

test('money Mado should book: listed per payment, with what Bookamat may already have', () => {
  const docs = [
    doc('d1', 'RN-209906013', 975, [{ id: 'p1', date: '2026-07-03', amount: 1170, kind: 'payment' }]),
    doc('d2', 'RN-209906014', 270, [{ id: 'p2', date: '2026-08-04', amount: 258, kind: 'payment' }, { id: 'w2', date: '2026-11-11', amount: 12, kind: 'writeoff' }]),
    // Part-paid: each payment is booked as it arrives (D2), so it is listed.
    doc('d3', 'RN-209907017', 700, [{ id: 'p3', date: '2026-08-01', amount: 100, kind: 'payment' }], [], 'sent'),
  ]
  const bookings = [booking(9801, '2026-07-03', 'RN_209906013 - Muster', '1170.00')]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.unbooked.map(u => [u.number, u.paymentId, u.amount, u.date, u.candidates.map(c => [c.bookingId, c.paymentId])]), [
    ['RN-209906013', 'p1', 1170, '2026-07-03', [['9801', 'p1']]],
    ['RN-209906014', 'p2', 258, '2026-08-04', []],
    ['RN-209907017', 'p3', 100, '2026-08-01', []],
  ])
  assert.deepEqual(r.doubles, [])
})

test('part payments of one year: each is listed, a booking under the payment it books', () => {
  const docs = [doc('d1', 'RN-209906301', 500, [
    { id: 'p1', date: '2026-03-02', amount: 300, kind: 'payment' },
    { id: 'p2', date: '2026-05-04', amount: 300, kind: 'payment' },
  ], [], 'paid')]
  const bookings = [booking(9951, '2026-05-05', 'RN_209906301 Teilzahlung', '300.00')]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.unbooked.map(u => [u.paymentId, u.candidates.map(c => [c.bookingId, c.fit, c.paymentId])]), [
    ['p1', []],
    ['p2', [['9951', 'exact', 'p2']]],
  ])
  // Once the first part is booked by Mado, only the second is listed; Mado's own is no double.
  const booked = reconcile({
    docs: [{ ...docs[0], bookamat_bookings: [row(2026, '9950', 300, '2026-03-02', 'p1')] }],
    bookings: [booking(9950, '2026-03-02', 'RN-209906301 (Teilzahlung 1) – Muster', '300.00'), ...bookings],
    years: [2026], invoicePrefix: 'RN',
  })
  assert.deepEqual(booked.unbooked.map(u => [u.paymentId, u.candidates.map(c => c.bookingId)]), [['p2', ['9951']]])
  assert.deepEqual(booked.doubles, [])
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

test('a booking Mado made from a statement line is no document\'s and no unknown number', () => {
  const docs = [
    doc('d1', 'RN-209905008', 100, [{ date: '2026-05-20', amount: 120, kind: 'payment' }], [row(2026, '9601', 120, '2026-05-20')]),
    doc('d2', 'RN-209907017', 700, [], [], 'sent'),
  ]
  const bookings = [
    booking(9601, '2026-05-20', 'RN-209905008 – Muster', '120.00'),
    booking(9605, '2026-08-02', 'Gutschrift RN_209907016', '50.00'),
  ]
  assert.deepEqual(reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' }).unknown.map(u => u.booking.bookingId), ['9605'])
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN', lineBookings: [{ year: 2026, booking_id: '9605' }] })
  assert.deepEqual([r.unknown, r.doubles], [[], []])
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

test('a hand booking of money Mado does not book is no double booking; a part payment\'s is its candidate', () => {
  const docs = [
    { ...doc('d1', 'RN-209906201', 100, [{ id: 'p1', date: '2026-06-01', amount: 120, kind: 'payment' }]), currency: 'USD' },
    doc('d2', 'RN-209906202', 500, [{ id: 'p2', date: '2026-06-02', amount: 100, kind: 'payment' }], [], 'sent'),
  ]
  const bookings = [booking(9931, '2026-06-01', 'RN-209906201 USD', '110.00'), booking(9932, '2026-06-02', 'RN 209906202 Teilzahlung', '100.00')]
  const r = reconcile({ docs, bookings, years: [2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.doubles, [])
  assert.deepEqual(r.unbooked.map(u => [u.number, u.amount, u.candidates.map(c => [c.bookingId, c.fit, c.paymentId])]), [['RN-209906202', 100, [['9932', 'exact', 'p2']]]])
})

test('a credit note is listed once money is paid back, for what it did not credit', () => {
  const credit = (payments: ReconcileDoc['payments']): ReconcileDoc => ({ ...doc('c1', 'AN-2099001', 500, payments), type: 'credit_note', status: 'sent' })
  const partly = credit([{ id: 'r1', date: '2026-06-10', amount: 200, kind: 'refund' }])
  assert.deepEqual(reconcile({ docs: [partly], bookings: [], years: [2026], invoicePrefix: 'RN' }).unbooked.map(u => [u.number, u.paymentId, u.amount]), [['AN-2099001', 'r1', 200]])
  // 400 of the 600 credited to an invoice: the 200 paid back is the rest.
  const r = reconcile({ docs: [partly], bookings: [], years: [2026], invoicePrefix: 'RN', applied: { c1: 400 } })
  assert.deepEqual(r.unbooked.map(u => [u.number, u.amount]), [['AN-2099001', 200]])
  // Paid back beyond what was not credited: only the rest is a refund of revenue.
  const over = reconcile({ docs: [partly], bookings: [], years: [2026], invoicePrefix: 'RN', applied: { c1: 450 } })
  assert.deepEqual(over.unbooked.map(u => u.amount), [150])
  // A cancelled credit note books nothing.
  assert.deepEqual(reconcile({ docs: [{ ...partly, status: 'cancelled' }], bookings: [], years: [2026], invoicePrefix: 'RN' }).unbooked, [])
})

test('a booking found by the number is listed under its own payment', () => {
  const docs = [doc('d1', 'RN-209912010', 1000, [{ id: 'p1', date: '2025-12-20', amount: 600, kind: 'payment' }, { id: 'p2', date: '2026-03-08', amount: 600, kind: 'payment' }])]
  const bookings = [booking(9941, '2026-03-08', 'RN_209912010 - Muster', '600.00')]
  const r = reconcile({ docs, bookings, years: [2025, 2026], invoicePrefix: 'RN' })
  assert.deepEqual(r.unbooked.map(u => [u.year, u.paymentId, u.candidates.map(c => [c.bookingId, c.fit])]), [[2025, 'p1', []], [2026, 'p2', [['9941', 'exact']]]])
})
