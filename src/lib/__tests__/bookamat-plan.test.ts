// What a document books (Ist-Besteuerung, money only, one booking per payment — PR 8b), and what
// is left to book next to the bookings Mado has. Synthetic amounts and dates only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookamatState, hasMoneyToBook, hasUnbookedMoney, planBookings, unbookedPlan } from '@/lib/bookamat-client'
import { bookingLines } from '@/lib/bookamat'

test('one booking per payment, on its own date, numbered as part payments', () => {
  const { bookings } = planBookings({
    type: 'invoice',
    total: 300,
    rows: [
      { id: 'p3', date: '2027-01-05', amount: 100, kind: 'payment' },
      { id: 'p1', date: '2026-03-10', amount: 100, kind: 'payment' },
      { id: 'p2', date: '2026-05-20', amount: 100, kind: 'payment' },
    ],
  })
  assert.deepEqual(bookings.map(b => [b.paymentId, b.year, b.date, b.amount, b.before, b.part]), [
    ['p1', 2026, '2026-03-10', 100, 0, 1],
    ['p2', 2026, '2026-05-20', 100, 100, 2],
    ['p3', 2027, '2027-01-05', 100, 200, 3],
  ])
})

test('one payment of the whole amount is no part payment; one of less is part 1', () => {
  const whole = planBookings({ type: 'invoice', total: 300, rows: [{ id: 'p1', date: '2026-03-10', amount: 300, kind: 'payment' }] })
  assert.equal(whole.bookings[0].part, null)
  const first = planBookings({ type: 'invoice', total: 300, rows: [{ id: 'p1', date: '2026-03-10', amount: 100, kind: 'payment' }] })
  assert.equal(first.bookings[0].part, 1)
  // A Skonto or a write-off closing the rest leaves one payment that settles the invoice.
  const skonto = planBookings({
    type: 'invoice', total: 300,
    rows: [{ id: 'p1', date: '2026-03-10', amount: 294, kind: 'payment' }, { id: 's1', date: '2026-03-10', amount: 6, kind: 'skonto' }],
  })
  assert.deepEqual(skonto.bookings.map(b => [b.amount, b.part]), [[294, null]])
})

test('Skonto, write-off and fees are not booked; an overpayment is cut, latest money last', () => {
  const { bookings, fees } = planBookings({
    type: 'invoice',
    total: 270,
    rows: [
      { id: 'p1', date: '2026-08-04', amount: 258, kind: 'payment' },
      { id: 'w1', date: '2026-11-11', amount: 12, kind: 'writeoff' },
      { id: 'f1', date: '2026-11-11', amount: 5, kind: 'fee' },
    ],
  })
  assert.deepEqual(bookings.map(b => [b.amount, b.part]), [[258, null]])
  assert.equal(fees, 5)
  const over = planBookings({
    type: 'invoice', total: 100,
    rows: [{ id: 'p2', date: '2026-01-05', amount: 50, kind: 'payment' }, { id: 'p1', date: '2026-01-02', amount: 80, kind: 'payment' }],
  })
  assert.deepEqual(over.bookings.map(b => [b.paymentId, b.amount]), [['p1', 80], ['p2', 20]])
  // An applied credit note lowers what money has to cover.
  const credited = planBookings({
    type: 'invoice', total: 100,
    rows: [{ id: 'c1', date: '2026-01-02', amount: 30, kind: 'credit' }, { id: 'p1', date: '2026-01-09', amount: 70, kind: 'payment' }],
  })
  assert.deepEqual(credited.bookings.map(b => [b.amount, b.part]), [[70, null]])
})

test('a refund books on the credit note, one per refund', () => {
  const { bookings } = planBookings({
    type: 'credit_note', total: 100,
    rows: [{ id: 'r1', date: '2026-02-01', amount: 40, kind: 'refund' }, { id: 'r2', date: '2026-02-20', amount: 60, kind: 'refund' }],
  })
  assert.deepEqual(bookings.map(b => [b.kind, b.paymentId, b.amount, b.part]), [['refund', 'r1', 40, 1], ['refund', 'r2', 60, 2]])
})

test('cash goes by each payment\'s own method', () => {
  const { bookings } = planBookings({
    type: 'invoice',
    total: 500,
    rows: [
      { id: 'p1', date: '2026-08-01', amount: 200, kind: 'payment', method: 'bank' },
      { id: 'p2', date: '2026-08-31', amount: 300, kind: 'payment', method: 'cash' },
    ],
  })
  assert.deepEqual(bookings.map(b => b.cash), [0, 300])
})

test('the VAT split runs on across part payments: the groups add up to the cent', () => {
  // 100 net at 20 % and 100 net at 10 %: 120 + 110 gross, paid as 100 and 130.
  const groups = [{ rate: 20 as const, base: 100, amount: 20 }, { rate: 10 as const, base: 100, amount: 10 }]
  const accounts = { bank: 1, cash: null, cost: 2, vat: { 20: 3, 10: 4 } }
  const { bookings } = planBookings({
    type: 'invoice', total: 230,
    rows: [{ id: 'p1', date: '2026-03-01', amount: 100, kind: 'payment' }, { id: 'p2', date: '2026-04-01', amount: 130, kind: 'payment' }],
  })
  const lines = bookings.map(b => bookingLines(b, groups, accounts).map(l => [l.tax_percent, l.amount]))
  assert.deepEqual(lines, [
    [['20.00', '52.17'], ['10.00', '47.83']],
    [['20.00', '67.83'], ['10.00', '62.17']],
  ])
  // Three equal thirds of an odd amount: no cent goes missing per rate.
  const thirds = planBookings({
    type: 'invoice', total: 230,
    rows: ['2026-03-01', '2026-04-01', '2026-05-01'].map((date, i) => ({ id: `t${i}`, date, amount: i < 2 ? 76.67 : 76.66, kind: 'payment' })),
  })
  const sums: Record<string, number> = {}
  for (const b of thirds.bookings) {
    const ls = bookingLines(b, groups, accounts)
    assert.equal(ls.reduce((s, l) => Math.round((s + Number(l.amount)) * 100) / 100, 0), b.amount)
    for (const l of ls) sums[l.tax_percent] = Math.round(((sums[l.tax_percent] ?? 0) + Number(l.amount)) * 100) / 100
  }
  assert.deepEqual(sums, { '20.00': 120, '10.00': 110 })
})

test('a booked payment is not booked again; the others still are', () => {
  const planned = planBookings({
    type: 'invoice', total: 300,
    rows: [{ id: 'p1', date: '2026-03-10', amount: 100, kind: 'payment' }, { id: 'p2', date: '2026-05-20', amount: 200, kind: 'payment' }],
  })
  assert.deepEqual(unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 100, payment_id: 'p1' }]).map(p => p.paymentId), ['p2'])
  assert.deepEqual(unbookedPlan(planned, [
    { year: 2026, kind: 'income', amount: 100, payment_id: 'p1' }, { year: 2026, kind: 'income', amount: 200, payment_id: 'p2' },
  ]), [])
  // A refund booking covers no income.
  assert.equal(unbookedPlan(planned, [{ year: 2026, kind: 'refund', amount: -300 }]).length, 2)
})

test('a booking from before bookings per payment covers its year first, then later years', () => {
  const planned = planBookings({
    type: 'invoice', total: 200,
    rows: [{ id: 'p1', date: '2026-12-30', amount: 100, kind: 'payment' }, { id: 'p2', date: '2027-01-03', amount: 100, kind: 'payment' }],
  })
  assert.deepEqual(unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 100 }]).map(p => p.paymentId), ['p2'])
  assert.deepEqual(unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 200 }]), [])
  // Part of a payment covered: the rest is booked, its VAT split going on from there.
  const rest = unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 150, payment_id: null }])
  assert.deepEqual(rest.map(p => [p.paymentId, p.amount, p.before, p.part]), [['p2', 50, 150, 2]])
})

test('an extra payment dated before a booked one is not booked on top of it', () => {
  // The client's second transfer of the same 840, recorded after the first was booked, sorting first.
  const twice = planBookings({
    type: 'invoice', total: 840,
    rows: [{ id: 'pb', date: '2026-06-15', amount: 840, kind: 'payment' }, { id: 'pa', date: '2026-06-15', amount: 840, kind: 'payment' }],
  })
  assert.deepEqual(unbookedPlan(twice, [{ year: 2026, kind: 'income', amount: 840, payment_id: 'pb' }]), [])
  const earlier = planBookings({
    type: 'invoice', total: 840,
    rows: [{ id: 'p2', date: '2026-06-20', amount: 840, kind: 'payment' }, { id: 'p1', date: '2026-06-01', amount: 840, kind: 'payment' }],
  })
  assert.deepEqual(unbookedPlan(earlier, [{ year: 2026, kind: 'income', amount: 840, payment_id: 'p2' }]), [])
  // A real part payment dated before a booked part: booked after it, as the next part.
  const parts = planBookings({
    type: 'invoice', total: 300,
    rows: [{ id: 'p1', date: '2026-03-10', amount: 100, kind: 'payment' }, { id: 'p0', date: '2026-03-01', amount: 100, kind: 'payment' }],
  })
  assert.deepEqual(unbookedPlan(parts, [{ year: 2026, kind: 'income', amount: 100, payment_id: 'p1' }]).map(p => [p.paymentId, p.amount, p.before, p.part]), [['p0', 100, 100, 2]])
})

test('an overpaid invoice has nothing left to book once its money is booked', () => {
  const doc = {
    type: 'invoice', number: 'RN-209901002', status: 'paid', total: 100,
    payments: [{ id: 'p1', date: '2026-03-10', kind: 'payment', amount: 100 }, { id: 'p2', date: '2026-03-20', kind: 'payment', amount: 30 }],
    bookamat_bookings: [{ year: 2026, kind: 'income', amount: 100, payment_id: 'p1' }],
  }
  assert.equal(hasUnbookedMoney(doc), false)
  assert.equal(bookamatState(doc), 'synced')
  // A booking from before bookings per payment that the backfill left without its payment.
  assert.equal(bookamatState({ ...doc, payments: [{ id: 'p1', date: '2026-03-10', kind: 'payment', amount: 110 }], bookamat_bookings: [{ year: 2026, kind: 'income', amount: 100 }] }), 'synced')
})

test('booked one after the other, part payments add up per VAT rate to the cent', () => {
  const groups = [{ rate: 20 as const, base: 100, amount: 20 }, { rate: 10 as const, base: 77.77, amount: 7.78 }, { rate: 0 as const, base: 33.33, amount: 0 }]
  const accounts = { bank: 1, cash: null, cost: 2, vat: { 20: 3, 10: 4, 0: 5 } }
  const total = 238.88
  const once = Object.fromEntries(bookingLines({ year: 2026, kind: 'income', date: '2026-01-01', amount: total, cash: 0, paymentId: 'x', before: 0, part: null }, groups, accounts)
    .map(l => [l.tax_percent, Number(l.amount)]))
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let run = 0; run < 2000; run++) {
    // 2–4 parts of at least 1 €, in cents, recorded in a random order of dates.
    const n = 2 + Math.floor(random() * 3)
    const cuts = Array.from({ length: n - 1 }, () => 100 + Math.floor(random() * (total * 100 - 100 * n))).sort((a, b) => a - b)
    const cents = [...cuts, total * 100].map((c, i, all) => c - (i ? all[i - 1] : 0))
    if (cents.some(c => c < 100)) continue
    const rows = cents.map((c, i) => ({ id: `p${i}`, date: `2026-0${1 + Math.floor(random() * 9)}-1${i}`, amount: c / 100, kind: 'payment' }))
    const plan = planBookings({ type: 'invoice', total, rows })
    const booked: { year: number; kind: string; amount: number; payment_id: string }[] = []
    const sums: Record<string, number> = {}
    for (let todo = unbookedPlan(plan, booked); todo.length; todo = unbookedPlan(plan, booked)) {
      const p = todo[0]
      const lines = bookingLines(p, groups, accounts)
      assert.equal(Math.round(lines.reduce((s, l) => s + Number(l.amount), 0) * 100), Math.round(p.amount * 100))
      for (const l of lines) sums[l.tax_percent] = Math.round(((sums[l.tax_percent] ?? 0) + Number(l.amount)) * 100) / 100
      booked.push({ year: p.year, kind: p.kind, amount: p.amount, payment_id: p.paymentId! })
    }
    assert.deepEqual(sums, once, `run ${run}: ${JSON.stringify(cents)}`)
  }
})

test('money is offered as soon as it is recorded, part payments too', () => {
  const paid = { type: 'invoice', number: 'RN-209901001', status: 'paid', payments: [{ kind: 'payment', amount: 10 }] }
  assert.equal(hasMoneyToBook(paid), true)
  assert.equal(hasMoneyToBook({ ...paid, status: 'sent' }), true)
  assert.equal(hasMoneyToBook({ ...paid, status: 'overdue' }), true)
  assert.equal(hasMoneyToBook({ ...paid, status: 'draft' }), false)
  assert.equal(hasMoneyToBook({ ...paid, number: null }), false)
  assert.equal(hasMoneyToBook({ ...paid, payments: [{ kind: 'writeoff', amount: 10 }] }), false)
  const credit = { type: 'credit_note', number: 'GS-209901001', status: 'sent', payments: [{ kind: 'refund', amount: 5 }] }
  assert.equal(hasMoneyToBook(credit), true)
  assert.equal(hasMoneyToBook({ ...credit, status: 'cancelled' }), false)
})

test('the state follows each payment: a new part payment makes a booked invoice unsynced again', () => {
  const p1 = { id: 'p1', date: '2026-03-10', kind: 'payment', amount: 100 }
  const p2 = { id: 'p2', date: '2026-05-20', kind: 'payment', amount: 50 }
  const doc = { type: 'invoice', number: 'RN-209901001', status: 'sent', payments: [p1] }
  const booked1 = { year: 2026, kind: 'income', amount: 100, payment_id: 'p1' }
  assert.equal(bookamatState(doc), 'unsynced')
  assert.equal(bookamatState({ ...doc, bookamat_bookings: [booked1] }), 'synced')
  assert.equal(hasUnbookedMoney({ ...doc, payments: [p1, p2], bookamat_bookings: [booked1] }), true)
  assert.equal(bookamatState({ ...doc, payments: [p1, p2], bookamat_bookings: [booked1] }), 'unsynced')
  assert.equal(bookamatState({ ...doc, bookamat_bookings: [booked1], bookamat_error: 'x' }), 'failed')
  // A booking from before bookings per payment covers the money of its year.
  assert.equal(bookamatState({ ...doc, payments: [p1, p2], bookamat_bookings: [{ year: 2026, kind: 'income', amount: 150 }] }), 'synced')
  // Rows read without ids (an older caller): any booking counts as covering everything.
  assert.equal(bookamatState({ ...doc, payments: [{ kind: 'payment', amount: 10 }], bookamat_bookings: [booked1] }), 'synced')
})
