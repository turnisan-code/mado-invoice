// What counts as "Bookamat already has this money", and how Bookamat is read for it. Synthetic
// bookings only (made-up names, ids 9001…, amounts that are no real invoice's).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PAGES, bookingKey, describeCandidate, findCandidates, numberPattern, numberQuery, readBookingsInWindow,
  readBookingsTitled, readYear, toBookingLite, type BookingLite, type GetPage,
} from '@/lib/bookamat-search'

const income = (id: number, date: string, title: string, amount: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '1', amount }], ...extra })
const expense = (id: number, date: string, title: string, amount: string) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '2', amount }] })
const lite = (raw: unknown, year = 2026) => toBookingLite(year, raw) as BookingLite

test('a booking as Mado compares it: signed total, direction, deleted ones dropped', () => {
  assert.deepEqual(lite(income(9001, '2026-03-02', 'RN-209903001 – Muster', '123.40')), {
    year: 2026, id: '9001', date: '2026-03-02', title: 'RN-209903001 – Muster', description: '', total: 123.4, moneyIn: true,
  })
  const split = lite({ id: 9002, title: 'x', date: '2026-03-02', amounts: [{ group: '1', amount: '100.00' }, { group: '1', amount: '-10.00' }] })
  assert.equal(split.total, 90)
  assert.equal(lite(expense(9003, '2026-03-02', 'Studio Miete', '50.00')).moneyIn, false)
  // A refund booked as negative income moves money out.
  assert.equal(lite(income(9004, '2026-03-02', 'Rückzahlung', '-20.00')).moneyIn, false)
  // Lines without a group are taken for income: a doubt is shown, never booked past.
  assert.equal(lite({ id: 9005, title: 'x', date: '2026-03-02', amounts: [{ amount: '5.00' }] }).moneyIn, true)
  assert.equal(toBookingLite(2026, income(9006, '2026-03-02', 'x', '1.00', { status: '3' })), null)
  assert.equal(toBookingLite(2026, { id: 'abc' }), null)
})

test('the number is found however a booking spells it, and nowhere else', () => {
  const p = numberPattern('RN-209903001')!
  for (const title of ['RN-209903001 – Muster GmbH', 'RN_209903001 - Muster', 'Rechnung 209903001', 'RN: 209903001', 'Zahlung RN 209903001 (2099)']) {
    assert.equal(p.test(title), true, title)
  }
  for (const title of ['RN-2099030011', '1209903001', 'RN-209903002']) assert.equal(p.test(title), false, title)
  const dashed = numberPattern('R-2099-001')!
  assert.equal(dashed.test('Rechnung 2099/001'), true)
  assert.equal(dashed.test('2099001'), true)
  assert.equal(numberPattern('R-12'), null)
  assert.equal(numberQuery('RN-209903001'), '209903001')
  assert.equal(numberQuery('R-12'), null)
})

test('candidates: the number at any date, the same amount within ±10 days, the same direction only', () => {
  const bookings = [
    lite(income(9101, '2026-01-10', 'RN_209903001 - Muster', '500.00')), // names it, months away
    lite(income(9102, '2026-06-08', 'Gutschrift Muster', '840.00')), // same amount, 7 days before
    lite(income(9103, '2026-06-30', 'Gutschrift Andere', '840.00')), // same amount, 15 days after
    lite(income(9104, '2026-06-15', 'Gutschrift', '840.01')), // within 2 cents
    lite(expense(9105, '2026-06-15', 'Lieferant', '840.00')), // money out
    lite(income(9106, '2026-06-15', 'Gutschrift', '841.00')), // a euro off
  ]
  const found = findCandidates({
    moneyIn: true,
    pattern: numberPattern('RN-209903001'),
    targets: [{ date: '2026-06-15', amounts: [840] }],
    bookings,
    exclude: new Set(),
  })
  assert.deepEqual(found.map(c => [c.bookingId, c.reason]), [['9101', 'number'], ['9102', 'amount'], ['9104', 'amount']])
})

test('recorded and acknowledged bookings never count, and each booking is named once', () => {
  const b = lite(income(9201, '2026-06-15', 'RN-209903001 – Muster', '840.00'))
  const base = { moneyIn: true, pattern: numberPattern('RN-209903001'), targets: [{ date: '2026-06-15', amounts: [840, 840] }], bookings: [b, b] }
  assert.equal(findCandidates({ ...base, exclude: new Set() }).length, 1)
  assert.equal(findCandidates({ ...base, exclude: new Set([bookingKey(2026, '9201')]) }).length, 0)
  // Another year's booking with the same id is another booking.
  assert.equal(findCandidates({ ...base, exclude: new Set([bookingKey(2025, '9201')]) }).length, 1)
})

test('a refund looks for money going out', () => {
  const found = findCandidates({
    moneyIn: false,
    pattern: numberPattern('G-2099-0007'),
    targets: [{ date: '2026-02-01', amounts: [60] }],
    bookings: [lite(income(9301, '2026-02-01', 'Erstattung', '60.00')), lite(expense(9302, '2026-02-02', 'Rückzahlung an Kunde', '60.00'))],
    exclude: new Set(),
  })
  assert.deepEqual(found.map(c => c.bookingId), ['9302'])
})

// A stand-in for Bookamat's list endpoint: `pages[year]` are the pages it answers, in order.
function stub(pages: Record<number, unknown[][]>, fail?: (year: number, path: string) => unknown) {
  const calls: string[] = []
  const get: GetPage = async (year, path) => {
    calls.push(`${year} ${path}`)
    const err = fail?.(year, path)
    if (err) throw err
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1')
    const list = pages[year] ?? []
    return { count: list.flat().length, next: page < list.length ? `https://www.bookamat.com/api/v1/at/${year}/bookings/?page=${page + 1}` : null, results: list[page - 1] ?? [] }
  }
  return { get, calls }
}

test('the window is read page by page, in every year it touches', async () => {
  const { get, calls } = stub({
    2026: [[income(9401, '2026-12-28', 'a', '1.00')], [income(9402, '2026-12-30', 'b', '2.00')]],
    2027: [[income(9403, '2027-01-03', 'c', '3.00')]],
  })
  const found = await readBookingsInWindow(get, '2026-12-25', '2027-01-04')
  assert.deepEqual(found.map(b => `${b.year}:${b.id}`), ['2026:9401', '2026:9402', '2027:9403'])
  assert.deepEqual(calls, [
    '2026 bookings/?date_from=2026-12-25&date_until=2026-12-31&format=json&limit=100',
    '2026 bookings/?date_from=2026-12-25&date_until=2026-12-31&format=json&limit=100&page=2',
    '2027 bookings/?date_from=2027-01-01&date_until=2027-01-04&format=json&limit=100',
  ])
})

test('a year Bookamat has no books for has no bookings; any other failure is thrown', async () => {
  const missing = stub({}, year => (year === 2027 ? Object.assign(new Error('404'), { code: 'year_missing' }) : null))
  assert.deepEqual(await readBookingsInWindow(missing.get, '2027-01-01', '2027-01-05'), [])
  const down = stub({}, () => Object.assign(new Error('Bookamat did not answer in time'), { code: 'timeout' }))
  await assert.rejects(readBookingsTitled(down.get, [2026], '209903001'), /did not answer/)
  const odd = { get: (async () => ({ detail: 'no list' })) as GetPage }
  await assert.rejects(readYear(odd.get, 2026), /unexpected answer/)
})

test('more pages than the limit is an error, never a cut-off list', async () => {
  const many = Array.from({ length: MAX_PAGES + 1 }, (_, i) => [income(9500 + i, '2026-05-01', 't', '1.00')])
  await assert.rejects(readYear(stub({ 2026: many }).get, 2026), /more than/)
})

test('a candidate in a stored error text', () => {
  assert.equal(describeCandidate({ bookingId: '9601', date: '2026-01-19', total: 1400, title: 'RN_209901001 Muster' }), '#9601 · 19.01.2026 · 1.400,00 € · RN_209901001 Muster')
})
