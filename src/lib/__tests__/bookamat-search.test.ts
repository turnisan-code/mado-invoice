// What counts as "Bookamat already has this money", how a found booking fits Mado's plan, and how
// Bookamat is read for it. Synthetic bookings only (made-up names, ids 9001…, amounts that are no
// real invoice's).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PAGES, bookingKey, candidateFit, describeCandidate, euro, findCandidates, numberPattern, otherNumberIn, readYear, toBookingLite,
  type BookingLite, type GetPage,
} from '@/lib/bookamat-search'

const income = (id: number, date: string, title: string, amount: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '1', amount }], ...extra })
const expense = (id: number, date: string, title: string, amount: string) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '2', amount }] })
const lite = (raw: unknown, year = 2026) => toBookingLite(year, raw) as BookingLite

test('a booking as Mado compares it: signed total, direction, kind of lines, deleted ones dropped', () => {
  assert.deepEqual(lite(income(9001, '2026-03-02', 'RN-209903001 – Muster', '123.40')), {
    year: 2026, id: '9001', date: '2026-03-02', title: 'RN-209903001 – Muster', description: '', total: 123.4, moneyIn: true, lines: 'income',
  })
  const split = lite({ id: 9002, title: 'x', date: '2026-03-02', amounts: [{ group: '1', amount: '100.00' }, { group: '1', amount: '-10.00' }] })
  assert.equal(split.total, 90)
  const out = lite(expense(9003, '2026-03-02', 'Studio Miete', '50.00'))
  assert.deepEqual([out.moneyIn, out.lines], [false, 'expense'])
  // A refund booked as negative income moves money out, and is still an income booking.
  const refund = lite(income(9004, '2026-03-02', 'Rückzahlung', '-20.00'))
  assert.deepEqual([refund.moneyIn, refund.lines], [false, 'income'])
  // Lines without a group are taken for income money (a doubt is shown), but not as Mado's kind.
  const nogroup = lite({ id: 9005, title: 'x', date: '2026-03-02', amounts: [{ amount: '5.00' }] })
  assert.deepEqual([nogroup.moneyIn, nogroup.lines], [true, 'mixed'])
  assert.equal(toBookingLite(2026, income(9006, '2026-03-02', 'x', '1.00', { status: '3' })), null)
  assert.equal(toBookingLite(2026, { id: 'abc' }), null)
  assert.equal(toBookingLite(2026, { id: 9007, title: 'no lines' }), null)
})

test('one long digit run is found by its digits however the prefix is written', () => {
  const p = numberPattern('RN-209903001')!
  for (const title of ['RN-209903001 – Muster GmbH', 'RN_209903001 - Muster', 'Rechnung 209903001', 'RN: 209903001', 'RN 209903001_Muster']) {
    assert.equal(p.test(title), true, title)
  }
  for (const title of ['RN-2099030011', '1209903001', 'RN-209903002']) assert.equal(p.test(title), false, title)
})

test('a number of several parts is found only whole, letters included', () => {
  const p = numberPattern('R-2099-001')!
  for (const title of ['R-2099-001 Muster', 'R 2099/001', 'r2099001']) assert.equal(p.test(title), true, title)
  for (const title of ['G-2099-001', 'Rechnung 2099/001', 'R-2099-0012', '2099001']) assert.equal(p.test(title), false, title)
  const odd = numberPattern('2099-R-001')!
  assert.equal(odd.test('Zahlung 2099-R-001'), true)
  assert.equal(numberPattern('R-12'), null)
})

test('another number of the same numbering', () => {
  assert.equal(otherNumberIn('RN_209903002 - Muster', 'RN-209903001'), 'RN_209903002')
  assert.equal(otherNumberIn('Gutschrift 209903002', 'RN-209903001'), '209903002')
  assert.equal(otherNumberIn('RN-209903001 – Muster', 'RN-209903001'), null)
  assert.equal(otherNumberIn('MDW MIETE 01/26', 'RN-209903001'), null)
  assert.equal(otherNumberIn('G-2099-002 Muster', 'R-2099-001'), null)
  assert.equal(otherNumberIn('R-2099-002 Muster', 'R-2099-001'), 'R-2099-002')
  // References of the same length are no invoice unless they start like one (the same year).
  for (const text of ['Auftraggeberreferenz 104857600', 'Kd-Nr. 100200300', 'Ref 000123456']) assert.equal(otherNumberIn(text, 'RN-209903001'), null, text)
  for (const text of ['Tel 0664 1234567', 'Ref 7654321']) assert.equal(otherNumberIn(text, 'AN-2099001'), null, text)
})

test('candidates: the number at any date, the same amount within ±10 days, the same direction only', () => {
  const bookings = [
    lite(income(9101, '2026-01-10', 'RN_209903001 - Muster', '500.00')), // names it, months away
    lite({ ...income(9107, '2026-02-01', 'Gutschrift', '1.00'), description: 'Zahlung RN 209903001' }), // in the description
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
  assert.deepEqual(found.map(c => [c.bookingId, c.reason]), [['9101', 'number'], ['9107', 'number'], ['9102', 'amount'], ['9104', 'amount']])
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
    pattern: numberPattern('AN-2099007'),
    targets: [{ date: '2026-02-01', amounts: [60] }],
    bookings: [lite(income(9301, '2026-02-01', 'Erstattung', '60.00')), lite(expense(9302, '2026-02-02', 'Rückzahlung an Kunde', '60.00'))],
    exclude: new Set(),
  })
  assert.deepEqual(found.map(c => c.bookingId), ['9302'])
})

test('how a found booking fits what Mado still books', () => {
  const ctx = { documentNumber: 'RN-209906001', planned: [{ year: 2026, amount: 600 }] }
  const fit = (raw: unknown, year = 2026) => candidateFit(lite(raw, year), ctx)
  assert.deepEqual(fit(income(9401, '2026-06-15', 'RN_209906001 - Muster', '600.00')), { fit: 'exact', planned: 600, plannedYears: [2026] })
  assert.equal(fit(income(9402, '2026-06-15', 'RN_209906001 - Muster', '300.00')).fit, 'part')
  assert.equal(fit(income(9403, '2026-06-15', 'RN_209906001 - Muster', '640.00')).fit, 'more')
  assert.equal(fit(income(9404, '2025-12-31', 'RN_209906001 - Muster', '600.00'), 2025).fit, 'year')
  assert.equal(fit(expense(9405, '2026-06-15', 'RN_209906001 - Muster', '600.00')).fit, 'kind')
  assert.deepEqual(fit(income(9406, '2026-06-15', 'RN_209906002 - Andere', '600.00')), { fit: 'other_number', other: 'RN_209906002', plannedYears: [2026] })
  // Both invoices in one transfer: this money and more, never "another invoice".
  assert.equal(fit(income(9407, '2026-06-15', 'RN-209906001 + RN-209906002 Muster', '1200.00')).fit, 'more')
  // An exact booking whose description carries a bank reference stays exact.
  assert.equal(fit({ ...income(9408, '2026-06-15', 'RN_209906001 Muster', '600.00'), description: 'Auftraggeberreferenz 104857600' }).fit, 'exact')
  // A year whose money Mado booked already: possibly booked twice there.
  assert.equal(candidateFit(lite(income(9409, '2025-12-20', 'RN_209906001 - Muster', '300.00'), 2025), { ...ctx, bookedYears: [2025] }).fit, 'booked')
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

test('a year is read page by page', async () => {
  const { get, calls } = stub({ 2026: [[income(9501, '2026-12-28', 'a', '1.00')], [income(9502, '2026-12-30', 'b', '2.00')]] })
  const found = await readYear(get, 2026)
  assert.deepEqual(found.map(b => `${b.year}:${b.id}`), ['2026:9501', '2026:9502'])
  assert.deepEqual(calls, ['2026 bookings/?format=json&limit=100', '2026 bookings/?format=json&limit=100&page=2'])
})

test('a year without books is empty only where it may be missing; any other failure is thrown', async () => {
  const missing = stub({}, () => Object.assign(new Error('404'), { code: 'year_missing' }))
  assert.deepEqual(await readYear(missing.get, 2027), [])
  await assert.rejects(readYear(missing.get, 2027, { missingIsEmpty: false }), /404/)
  const down = stub({}, () => Object.assign(new Error('Bookamat did not answer in time'), { code: 'timeout' }))
  await assert.rejects(readYear(down.get, 2026), /did not answer/)
  await assert.rejects(readYear((async () => ({ detail: 'no list' })) as GetPage, 2026), /unexpected answer/)
  // A booking without lines cannot be compared: an error, not a skipped booking.
  await assert.rejects(readYear(stub({ 2026: [[{ id: 9601, status: '1', title: 'x', date: '2026-01-01' }]] }).get, 2026), /unexpected booking/)
})

test('more pages than the limit is an error, never a cut-off list', async () => {
  const many = Array.from({ length: MAX_PAGES + 1 }, (_, i) => [income(9700 + i, '2026-05-01', 't', '1.00')])
  await assert.rejects(readYear(stub({ 2026: many }).get, 2026), /more than/)
})

test('a candidate and an amount in a stored error text', () => {
  assert.equal(describeCandidate({ bookingId: '9801', date: '2026-01-19', total: 1400, title: 'RN_209901001 Muster' }), '#9801 · 19.01.2026 · 1.400,00 € · RN_209901001 Muster')
  assert.equal(euro(-20), '−20,00 €')
})
