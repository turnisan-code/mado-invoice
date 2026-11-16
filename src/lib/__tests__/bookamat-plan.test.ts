// What a document books today (Ist: money only, one booking per calendar year): pinned before the
// sync learns to look in Bookamat first. Synthetic amounts and dates only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookamatState, hasMoneyToBook, planBookings, unbookedPlan } from '@/lib/bookamat-client'

test('one booking per calendar year, dated on that year\'s last payment', () => {
  const { bookings } = planBookings({
    type: 'invoice',
    total: 300,
    rows: [
      { date: '2026-03-10', amount: 100, kind: 'payment' },
      { date: '2026-05-20', amount: 100, kind: 'payment' },
      { date: '2027-01-05', amount: 100, kind: 'payment' },
    ],
  })
  assert.deepEqual(bookings.map(b => [b.year, b.date, b.amount]), [[2026, '2026-05-20', 200], [2027, '2027-01-05', 100]])
})

test('Skonto, write-off and fees are not booked; an overpayment is cut', () => {
  const { bookings, fees } = planBookings({
    type: 'invoice',
    total: 270,
    rows: [
      { date: '2026-08-04', amount: 258, kind: 'payment' },
      { date: '2026-11-11', amount: 12, kind: 'writeoff' },
      { date: '2026-11-11', amount: 5, kind: 'fee' },
    ],
  })
  assert.deepEqual(bookings.map(b => b.amount), [258])
  assert.equal(fees, 5)
  assert.deepEqual(planBookings({ type: 'invoice', total: 100, rows: [{ date: '2026-01-02', amount: 120, kind: 'payment' }] }).bookings.map(b => b.amount), [100])
})

test('cash share follows the payments of the year', () => {
  const { bookings } = planBookings({
    type: 'invoice',
    total: 500,
    rows: [{ date: '2026-08-31', amount: 500, kind: 'payment', method: 'cash' }],
  })
  assert.equal(bookings[0].cash, 500)
})

test('a recorded year is not booked again; a lump booking covers later years\' money', () => {
  const planned = planBookings({
    type: 'invoice',
    total: 200,
    rows: [{ date: '2026-12-30', amount: 100, kind: 'payment' }, { date: '2027-01-03', amount: 100, kind: 'payment' }],
  }).bookings
  assert.deepEqual(unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 100 }]).map(p => p.year), [2027])
  assert.deepEqual(unbookedPlan(planned, [{ year: 2026, kind: 'income', amount: 200 }]), [])
})

test('only paid (or cancelled) invoices with money are offered; the state says why', () => {
  const paid = { type: 'invoice', number: 'RN-202601001', status: 'paid', payments: [{ kind: 'payment', amount: 10 }] }
  assert.equal(hasMoneyToBook(paid), true)
  assert.equal(hasMoneyToBook({ ...paid, status: 'sent' }), false)
  assert.equal(hasMoneyToBook({ ...paid, number: null }), false)
  assert.equal(bookamatState(paid), 'unsynced')
  assert.equal(bookamatState({ ...paid, bookamat_bookings: [{}] }), 'synced')
  assert.equal(bookamatState({ ...paid, bookamat_bookings: [{}], bookamat_error: 'x' }), 'failed')
})
