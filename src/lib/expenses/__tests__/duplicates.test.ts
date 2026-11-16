import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, assignDuplicates, backWindowFrom, bankRows, madoBookingOf, nearBankDate, pastYearWindow, toBookingLite, windowFor, yearsOf, type BookingLite, type PaymentRow } from '../duplicates'
import { madoInvoiceInText, madoInvoiceKey, madoInvoiceOfCredit, MADO_FIRST_INVOICE } from '../invoice-parsing'
import type { EasybankTransaction } from '@/lib/expenses/types'

const exp = (id: number, title: string, date: string, ...lines: string[]): BookingLite =>
  toBookingLite({ id, title, date, amounts: lines.map(amount => ({ group: '2', amount })) })
const inc = (id: number, title: string, date: string, ...lines: string[]): BookingLite =>
  toBookingLite({ id, title, date, amounts: lines.map(amount => ({ group: '1', amount })) })
const debit = (date: string, amount: number, extra: Partial<PaymentRow> = {}): PaymentRow =>
  ({ date, amount, income: false, direction: 'back', ...extra })

describe('assignDuplicates — totals, not lines (P1-6)', () => {
  test('a split booking is found by its total, and not by one of its lines', () => {
    const split = exp(71080, 'Bewirtung', '2026-03-10', '289.00', '57.80')
    assert.equal(assignDuplicates([debit('2026-03-10', 346.8)], [split])[0]?.id, 71080)
    assert.equal(assignDuplicates([debit('2026-03-10', 289)], [split])[0], null)
  })
  test('a debit with a bundled bank fee matches a booking of the net amount', () => {
    const receipt = exp(1, 'Hertz – Juli 2026', '2026-07-05', '293.65')
    assert.equal(assignDuplicates([debit('2026-07-06', 296.94, { netAmount: 293.65 })], [receipt])[0]?.id, 1)
  })
  test('direction: an expense never matches an income booking, nor the other way round', () => {
    assert.equal(assignDuplicates([debit('2026-07-01', 100)], [inc(1, 'X', '2026-07-01', '100.00')])[0], null)
    assert.equal(assignDuplicates([{ date: '2026-07-01', amount: 100, income: true, direction: 'back' }], [exp(2, 'Y', '2026-07-01', '100.00')])[0], null)
  })
})

describe('assignDuplicates — the 5-day card window (P0-4)', () => {
  test('up to 5 days earlier is „möglicherweise“; 6 days is not a match', () => {
    const r = assignDuplicates([debit('2026-04-29', 53)], [exp(1, 'Magdas – April 2026', '2026-04-24', '53.00')])[0]
    assert.equal(r?.certain, false)
    assert.equal(assignDuplicates([debit('2026-04-30', 53)], [exp(1, 'Magdas – April 2026', '2026-04-24', '53.00')])[0], null)
  })
  test('a booking dated after the debit is not the debit’s (a later purchase)', () => {
    assert.equal(assignDuplicates([debit('2026-04-24', 53)], [exp(1, 'X', '2026-04-25', '53.00')])[0], null)
  })
  test('a receipt looks forward to the card debit, not back', () => {
    const r: PaymentRow = { date: '2026-09-27', amount: 46.8, income: false, direction: 'forward' }
    assert.equal(assignDuplicates([r], [exp(1, 'Tony Zhang', '2026-09-29', '46.80')])[0]?.id, 1)
    assert.equal(assignDuplicates([r], [exp(2, 'Tony Zhang', '2026-09-25', '46.80')])[0], null)
  })
  test('credits match only their own day', () => {
    const r: PaymentRow = { date: '2026-07-03', amount: 1170, income: true, direction: 'back' }
    assert.equal(assignDuplicates([r], [inc(1, 'RN-202606013 – Geyrhalter', '2026-07-02', '1170.00')])[0], null)
  })
})

describe('assignDuplicates — one booking per payment', () => {
  test('two 40,52 € Magenta debits on one day, one booking: only the matching row is booked', () => {
    const rows = [
      debit('2026-07-16', 40.52, { title: 'Internet Home Office 07/2026' }),
      debit('2026-07-16', 40.52, { title: 'Internet Studio 07/2026' }),
    ]
    const out = assignDuplicates(rows, [exp(9, 'Internet Studio 07/2026', '2026-07-16', '40.52')])
    assert.equal(out[0], null)
    assert.deepEqual(out[1], { id: 9, title: 'Internet Studio 07/2026', date: '2026-07-16', total: 40.52, certain: true })
  })
  test('another title on the same day is „möglicherweise“, not „bereits gebucht“', () => {
    const r = assignDuplicates([debit('2026-07-16', 40.52, { title: 'Internet Home Office 07/2026' })],
      [exp(9, 'Internet Studio 07/2026', '2026-07-16', '40.52')])[0]
    assert.equal(r?.certain, false)
  })
  test('without a known title (an AI row) the same day and total is „bereits gebucht“', () => {
    assert.equal(assignDuplicates([debit('2026-07-17', 21.24)], [exp(1, 'Anthropic – Prepaid', '2026-07-17', '20.00', '1.24')])[0]?.certain, true)
  })
  test('the same day wins over an earlier day', () => {
    const out = assignDuplicates([debit('2026-07-10', 10)], [exp(1, 'A', '2026-07-07', '10.00'), exp(2, 'B', '2026-07-10', '10.00')])
    assert.equal(out[0]?.id, 2)
  })
  test('acknowledged bookings are skipped', () => {
    assert.equal(assignDuplicates([debit('2026-07-10', 10)], [exp(1, 'A', '2026-07-10', '10.00')], new Set([1]))[0], null)
  })
})

describe('assignDuplicates — review fixes', () => {
  test('a split booked up to 2 cents off the debit is still found on re-import', () => {
    const r = assignDuplicates([debit('2026-04-24', 53)], [exp(1, 'Magdas – April 2026', '2026-04-24', '23.10', '26.40', '3.49')])[0]
    assert.equal(r?.id, 1)
  })
  test('a voucher line counts with its sign: 100,00 − 10,00 is 90,00', () => {
    const b = toBookingLite({ id: 2, title: 'X', date: '2026-07-01', amounts: [{ group: '2', amount: '100.00' }, { group: '2', amount: '-10.00' }] })
    assert.equal(b.total, 90)
    assert.equal(assignDuplicates([debit('2026-07-01', 90)], [b])[0]?.id, 2)
  })
  test('a refund booked as negative income is money out, like a debit', () => {
    const refund = toBookingLite({ id: 3, title: 'Gutschrift', date: '2026-07-01', amounts: [{ group: '1', amount: '-50.00' }] })
    assert.equal(refund.income, false)
  })
  test('the phone finds its card debit booked as goods + a 0 % Bankspesen line, as „möglicherweise“', () => {
    const csv = toBookingLite({ id: 4, title: 'HERTZ UK – Mietwagen', date: '2026-07-06', amounts: [
      { group: '2', amount: '293.65', tax_percent: '20.00' }, { group: '2', amount: '3.29', tax_percent: '0.00' }] })
    const r = assignDuplicates([{ date: '2026-07-05', amount: 293.65, income: false, title: 'HERTZ UK – Juli 2026', direction: 'forward' }], [csv])[0]
    assert.equal(r?.id, 4)
    assert.equal(r?.certain, false)
  })
})

describe('the account a booking is on (P2-4)', () => {
  const EASY = { id: 808, name: 'Firmenkonto Easybank' }
  const CASH = { id: 801, name: 'Barzahlung' }
  const lines = (...banks: ({ id: number; name: string } | undefined)[]) =>
    banks.map((bankaccount, i) => ({ group: '2', amount: i ? '11.20' : '12.50', ...(bankaccount ? { bankaccount } : {}) }))
  test('every line on the same account: its name', () => {
    const b = toBookingLite({ id: 9001, title: 'Testcafé Nord', date: '2026-10-01', amounts: lines(EASY, EASY) })
    assert.deepEqual(b, { id: 9001, title: 'Testcafé Nord', date: '2026-10-01', total: 23.7, income: false, zeroTax: 0, bank: 'Firmenkonto Easybank' })
  })
  test('mixed accounts, a line without one, or none at all: no key', () => {
    for (const amounts of [lines(EASY, CASH), lines(EASY, undefined), lines(undefined, undefined), []]) {
      const b = toBookingLite({ id: 9002, title: 'Testcafé Nord', date: '2026-10-01', amounts })
      assert.ok(!('bank' in b), JSON.stringify(amounts))
    }
    // the same name under another id is another account
    const twin = toBookingLite({ id: 9003, title: 'X', date: '2026-10-01', amounts: lines(EASY, { id: 809, name: EASY.name }) })
    assert.ok(!('bank' in twin))
    // no name, or an id alone (as a booking is sent), names none
    const bare = toBookingLite({ id: 9004, title: 'X', date: '2026-10-01', amounts: [{ group: '2', amount: '5.00', bankaccount: { id: 808 } }] })
    assert.ok(!('bank' in bare))
  })
  test('assignDuplicates carries it into the match, only when known', () => {
    const row: PaymentRow = { date: '2026-10-01', amount: 23.7, income: false, title: 'Testcafé Nord', direction: 'forward' }
    const known = toBookingLite({ id: 9001, title: 'Testcafé Nord', date: '2026-10-03', amounts: lines(EASY, EASY) })
    assert.deepEqual(assignDuplicates([row], [known])[0],
      { id: 9001, title: 'Testcafé Nord', date: '2026-10-03', total: 23.7, certain: false, bank: 'Firmenkonto Easybank' })
    const unknown = toBookingLite({ id: 9002, title: 'Testcafé Nord', date: '2026-10-03', amounts: lines(EASY, CASH) })
    assert.deepEqual(assignDuplicates([row], [unknown])[0],
      { id: 9002, title: 'Testcafé Nord', date: '2026-10-03', total: 23.7, certain: false })
  })
  test('the account plays no part in the match: a „Bar“ receipt still finds its debit on the Easybank account', () => {
    const row: PaymentRow = { date: '2026-10-01', amount: 23.7, income: false, title: 'Testcafé Nord', direction: 'forward' }
    const on = (bank: { id: number; name: string }) => toBookingLite({ id: 9001, title: 'Testcafé Nord', date: '2026-10-01', amounts: lines(bank, bank) })
    assert.equal(assignDuplicates([row], [on(EASY)])[0]?.certain, true)
    assert.equal(assignDuplicates([row], [on(CASH)])[0]?.certain, true)
  })
})

// „mit Trinkgeld?“ (P2-3): a restaurant receipt booked from the phone without its tip finds
// its card debit booked from the CSV with the tip on top. Forward only: Job 1's 'back' rows
// never use it.
describe('a debit with the tip on top (P2-3, forward only)', () => {
  const receipt = (amount: number, extra: Partial<PaymentRow> = {}): PaymentRow =>
    ({ date: '2026-10-01', amount, income: false, title: 'Testcafé Nord – Oktober 2026', direction: 'forward', restaurant: true, ...extra })
  const card = (id: number, date: string, ...lines: string[]) => exp(id, 'TESTCAFE NORD', date, ...lines)
  test('23,70 against an expense booking of 25,50 two days later: a match, never certain, viaTip', () => {
    assert.deepEqual(assignDuplicates([receipt(23.7)], [card(9001, '2026-10-03', '25.50')])[0],
      { id: 9001, title: 'TESTCAFE NORD', date: '2026-10-03', total: 25.5, certain: false, viaTip: true })
    // on the receipt's own day too: still never „bereits gebucht“, with or without the title
    assert.equal(assignDuplicates([receipt(23.7)], [card(9002, '2026-10-01', '25.50')])[0]?.certain, false)
    assert.equal(assignDuplicates([receipt(23.7, { title: null })], [card(9003, '2026-10-01', '25.50')])[0]?.certain, false)
  })
  test('23,72 is the same amount: an amountOk match without viaTip; 30,00 is none', () => {
    const same = assignDuplicates([receipt(23.7)], [card(9001, '2026-10-03', '23.72')])[0]
    assert.deepEqual(same, { id: 9001, title: 'TESTCAFE NORD', date: '2026-10-03', total: 23.72, certain: false })
    assert.equal(assignDuplicates([receipt(23.7)], [card(9002, '2026-10-03', '30.00')])[0], null)
  })
  test('3 cents to a quarter above, in whole cents', () => {
    const tip = (amount: number, ...booked: string[]) =>
      assignDuplicates([receipt(amount)], [card(9001, '2026-10-02', ...booked)])[0]?.viaTip ?? null
    assert.equal(tip(23.7, '23.73'), true)
    // 20,00 € + 5,00 € is exactly a quarter; 5,01 € is more
    assert.equal(tip(20, '25.00'), true)
    assert.equal(tip(20, '25.01'), null)
    // the debit booked as a split with its own Trinkgeld line: the booking's total counts
    assert.equal(tip(23.7, '12.50', '11.20', '1.80'), true)
  })
  test('not a restaurant, a back row, an income row: none', () => {
    const booking = card(9001, '2026-10-03', '25.50')
    assert.equal(assignDuplicates([receipt(23.7, { restaurant: false })], [booking])[0], null)
    assert.equal(assignDuplicates([receipt(23.7, { restaurant: undefined })], [booking])[0], null)
    // the CSV import's row looks back to a receipt booked before it: never with a tip
    assert.equal(assignDuplicates([debit('2026-10-03', 23.7, { restaurant: true })], [card(9002, '2026-10-01', '25.50')])[0], null)
    assert.equal(assignDuplicates([debit('2026-10-03', 25.5, { restaurant: true })], [card(9003, '2026-10-01', '23.70')])[0], null)
    // income
    assert.equal(assignDuplicates([receipt(23.7, { income: true })], [inc(9004, 'TESTCAFE NORD', '2026-10-01', '25.50')])[0], null)
  })
  test('the card window still holds: a day before or six days later is none', () => {
    assert.equal(assignDuplicates([receipt(23.7)], [card(9001, '2026-09-30', '25.50')])[0], null)
    assert.equal(assignDuplicates([receipt(23.7)], [card(9002, '2026-10-07', '25.50')])[0], null)
    assert.equal(assignDuplicates([receipt(23.7)], [card(9003, '2026-10-06', '25.50')])[0]?.viaTip, true)
  })
  test('neither amountOk nor viaFee: a debit booked as goods + a 0 % Bankspesen line stays a viaFee match', () => {
    const csv = toBookingLite({ id: 9001, title: 'TESTCAFE NORD', date: '2026-10-02', amounts: [
      { group: '2', amount: '23.70', tax_percent: '20.00' }, { group: '2', amount: '0.50', tax_percent: '0.00' }] })
    assert.deepEqual(assignDuplicates([receipt(23.7)], [csv])[0],
      { id: 9001, title: 'TESTCAFE NORD', date: '2026-10-02', total: 24.2, certain: false })
  })
  test('the same amount is named before a tip on top, even on a later day', () => {
    const out = assignDuplicates([receipt(23.7)], [card(9001, '2026-10-01', '25.50'), card(9002, '2026-10-04', '23.70')])
    assert.equal(out[0]?.id, 9002)
    assert.ok(!('viaTip' in out[0]!))
    // acknowledged („Trotzdem buchen“), the next attempt names the tip match
    assert.equal(assignDuplicates([receipt(23.7)], [card(9001, '2026-10-01', '25.50'), card(9002, '2026-10-04', '23.70')], new Set([9002]))[0]?.viaTip, true)
  })
  test('the account is carried next to it', () => {
    const csv = toBookingLite({ id: 9001, title: 'TESTCAFE NORD', date: '2026-10-03', amounts: [
      { group: '2', amount: '25.50', bankaccount: { id: 808, name: 'Firmenkonto Easybank' } }] })
    assert.deepEqual(assignDuplicates([receipt(23.7)], [csv])[0],
      { id: 9001, title: 'TESTCAFE NORD', date: '2026-10-03', total: 25.5, certain: false, bank: 'Firmenkonto Easybank', viaTip: true })
  })
})

describe('windows and years', () => {
  test('a CSV row reads 5 days back; a receipt 5 days forward', () => {
    assert.deepEqual(windowFor([{ date: '2026-07-03', income: false, direction: 'back' }, { date: '2026-07-17', income: false, direction: 'back' }]),
      { from: '2026-06-28', until: '2026-07-17' })
    assert.deepEqual(windowFor([{ date: '2026-12-29', income: false, direction: 'forward' }]), { from: '2026-12-29', until: '2027-01-03' })
  })
  test('years spanned, for bookamat’s per-year books', () => {
    assert.deepEqual(yearsOf({ from: '2025-12-28', until: '2026-01-02' }), [2025, 2026])
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })
  test('pastYearWindow: 12 months back, the years newest first (the few-shot examples)', () => {
    assert.deepEqual(pastYearWindow('2026-11-12'), { from: '2025-11-12', until: '2026-11-12', years: [2026, 2025] })
    assert.deepEqual(pastYearWindow('2027-01-05'), { from: '2026-01-05', until: '2027-01-05', years: [2027, 2026] })
    assert.deepEqual(pastYearWindow('2026-12-31'), { from: '2025-12-31', until: '2026-12-31', years: [2026, 2025] })
  })
  test('pastYearWindow: on 29.02. from 01.03. of the year before; a day that is no date spans no year', () => {
    assert.deepEqual(pastYearWindow('2028-02-29'), { from: '2027-03-01', until: '2028-02-29', years: [2028, 2027] })
    for (const bad of ['', '2026-02-30', '12.11.2026', '2026-13-01']) {
      assert.deepEqual(pastYearWindow(bad).years, [], bad)
    }
  })
})

describe('the day of payment: card date and Valutadatum (PR 4b)', () => {
  // A card payment of 29.12.2026 that the bank posts on Mon 04.01.2027: six days
  const card = (extra: Partial<PaymentRow> = {}) => debit('2027-01-04', 21.11, { payDate: '2026-12-29', ...extra })
  const on = (date: string, id = 1, title = 'Shop Example') => exp(id, title, date, '21.11')

  test('a booking on the card date is this payment: „bereits gebucht“', () => {
    assert.deepEqual(assignDuplicates([card()], [on('2026-12-29')])[0],
      { id: 1, title: 'Shop Example', date: '2026-12-29', total: 21.11, certain: true })
  })
  test('without the day of payment it lies outside the 5-day window (the miss before)', () => {
    assert.equal(assignDuplicates([debit('2027-01-04', 21.11)], [on('2026-12-29')])[0], null)
  })
  test('the bank date is certain, a day between is „möglicherweise“, outside is nothing', () => {
    assert.equal(assignDuplicates([card()], [on('2027-01-04')])[0]?.certain, true)
    assert.equal(assignDuplicates([card()], [on('2026-12-31')])[0]?.certain, false)
    assert.equal(assignDuplicates([card()], [on('2026-12-28')])[0], null)
    assert.equal(assignDuplicates([card()], [on('2027-01-05')])[0], null)
  })
  test('a short lag (card 24.04., bank 27.04.): the 5-day window still reaches back', () => {
    const short = debit('2026-04-27', 21.11, { payDate: '2026-04-24' })
    assert.equal(assignDuplicates([short], [on('2026-04-22')])[0]?.certain, false)
    assert.equal(assignDuplicates([short], [on('2026-04-24')])[0]?.certain, true)
    assert.equal(assignDuplicates([debit('2026-04-27', 21.11)], [on('2026-04-24')])[0]?.certain, false)
  })
  test('the title rule holds on the card date too', () => {
    const r = assignDuplicates([card({ payDate: '2026-12-30', title: 'Adobe – Jänner 2027' })], [on('2026-12-30', 1, 'Adobe – Dezember 2026')])[0]
    assert.equal(r?.certain, false)
  })
  test('two rows of one amount each get the booking on their own day of payment (CD-F11)', () => {
    // card 13.06./bank 15.06. and card 15.06./bank 15.06. (no earlier day); the booking
    // on 13.06. has the higher id
    const rows = [debit('2026-06-15', 9.99, { payDate: '2026-06-13' }), debit('2026-06-15', 9.99)]
    const out = assignDuplicates(rows, [exp(2, 'Shop Example', '2026-06-13', '9.99'), exp(1, 'Shop Example', '2026-06-15', '9.99')])
    assert.deepEqual(out.map(m => [m?.id, m?.certain]), [[2, true], [1, true]])
  })
  test('a credit valued 31.12.: a booking on 31.12. is certain, one on 30.12. is not matched', () => {
    const credit: PaymentRow = { date: '2027-01-04', amount: 77.77, income: true, direction: 'back', payDate: '2026-12-31' }
    assert.equal(assignDuplicates([credit], [inc(1, 'Example Client', '2026-12-31', '77.77')])[0]?.certain, true)
    assert.equal(assignDuplicates([credit], [inc(1, 'Example Client', '2026-12-30', '77.77')])[0], null)
  })
  test('a receipt looking forward ignores a payment day', () => {
    const r: PaymentRow = { date: '2026-09-27', amount: 46.8, income: false, direction: 'forward', payDate: '2026-09-20' }
    assert.equal(assignDuplicates([r], [exp(1, 'Cafe Example', '2026-09-20', '46.80')])[0], null)
    assert.equal(backWindowFrom(r), '2026-09-27')
    assert.deepEqual(windowFor([r]), { from: '2026-09-27', until: '2026-10-02' })
  })
  test('the window reaches back to the card date, across both years’ books', () => {
    const w = windowFor([card()])!
    assert.deepEqual(w, { from: '2026-12-29', until: '2027-01-04' })
    assert.deepEqual(yearsOf(w), [2026, 2027])
  })
  test('backWindowFrom: a day of payment before the lag, within it, none', () => {
    assert.equal(backWindowFrom(card()), '2026-12-29')
    assert.equal(backWindowFrom(debit('2026-04-27', 1, { payDate: '2026-04-24' })), '2026-04-22')
    assert.equal(backWindowFrom(debit('2026-04-27', 1)), '2026-04-22')
    assert.equal(backWindowFrom({ date: '2027-01-04', income: true, direction: 'back', payDate: '2026-12-31' }), '2026-12-31')
    assert.equal(backWindowFrom({ date: '2027-01-04', income: true, direction: 'back' }), '2027-01-04')
  })
  test('nearBankDate: a real date within a year of the bank date', () => {
    assert.equal(nearBankDate('2027-01-04', '2026-12-20'), true)
    assert.equal(nearBankDate('2027-01-04', '0026-12-30'), false)
    assert.equal(nearBankDate('2027-01-04', '2026-13-01'), false)
    assert.equal(nearBankDate('2027-01-04', '2029-01-04'), false)
    assert.equal(nearBankDate('2027-01-04', ''), false)
  })
})

describe('bankRows — the one row builder (CD-F3)', () => {
  // Synthetic rows (spec P4 S2 and S11): zero IBANs, made-up merchants and amounts
  const s2 = 'Bezahlung Karte                              MC/000000902|E-COMM        21,11 276 K002 29.12. 21:10|SHOP EXAMPLE\\BERLIN\\10115|SPESEN: 0,00'
  const s11 = 'Gutschrift Echtzeitueberweisung              FE/000000911|TESTDEFFXXX DE00000000000000000000 Example Client GmbH|Projekt 12/2026'
  const tx = (reference: string, type: 'expense' | 'income', amount: number, valuta: string): EasybankTransaction => ({
    date: '2027-01-04', counterparty: 'Example', amount, type, currency: 'EUR', reference,
    raw: { col0: 'AT000000000000000000', col1: reference, col2: '04.01.2027', col3: valuta },
  })

  test('a card row: checked on its card date, and the window reaches back to it', () => {
    const { row, windowRows } = bankRows(tx(s2, 'expense', 21.11, '29.12.2026'), { kind: 'expense', bookedDate: '2026-12-29', title: 'Shop Example – Jänner 2027' })
    assert.deepEqual(row, { date: '2027-01-04', payDate: '2026-12-29', amount: 21.11, netAmount: null, income: false,
      title: 'Shop Example – Jänner 2027', invoiceKey: null, direction: 'back' })
    assert.equal(windowRows.length, 1)
    assert.equal(windowFor(windowRows)!.from, '2026-12-29')
  })
  test('a credit valued 31.12.: from 31.12.', () => {
    const { row, windowRows } = bankRows(tx(s11, 'income', 77.77, '31.12.2026'), { kind: 'income', bookedDate: '2026-12-31', invoiceKey: '202612001' })
    assert.deepEqual([row.payDate, row.income, row.netAmount, row.invoiceKey], ['2026-12-31', true, undefined, '202612001'])
    assert.equal(windowFor(windowRows)!.from, '2026-12-31')
  })
  test('a Buchungsdatum moved to another day adds that day to the window', () => {
    const { windowRows } = bankRows(tx(s2, 'expense', 21.11, '29.12.2026'), { kind: 'expense', bookedDate: '2026-12-20' })
    assert.deepEqual(windowRows[1], { date: '2026-12-20', income: false, direction: 'back' })
    assert.equal(windowFor(windowRows)!.from, '2026-12-15')
  })
  test('booked on the bank date or the day of payment, or a mistyped date: the row alone', () => {
    for (const bookedDate of ['2027-01-04', '2026-12-29', '0026-12-29']) {
      assert.equal(bankRows(tx(s2, 'expense', 21.11, '29.12.2026'), { kind: 'expense', bookedDate }).windowRows.length, 1, bookedDate)
    }
  })
})

describe('madoInvoiceKey — which credits Mado books', () => {
  test(`RN-${MADO_FIRST_INVOICE} and later, however written`, () => {
    for (const t of ['RN-202605008', 'RN_202605010', 'RN: 202606013', 'RN 202607018', '202605009', 'RN-202701001']) {
      assert.ok(madoInvoiceKey(t), t)
    }
  })
  test('older invoices stay bookable here', () => {
    assert.equal(madoInvoiceKey('RN-202605006'), null)
    assert.equal(madoInvoiceKey('RN-202605007'), null)
    assert.equal(madoInvoiceKey('RN_202603005 - Rott'), null)
  })
  test('other numbers never count: a 12-digit refund reference, a 7-digit „2026/042“, an implausible month', () => {
    assert.equal(madoInvoiceKey('920191840126'), null)
    assert.equal(madoInvoiceKey('2026042'), null)
    assert.equal(madoInvoiceKey('202613001'), null)
    assert.equal(madoInvoiceKey('Rechnung 920191840126'), null)
    assert.equal(madoInvoiceKey(null, undefined, ''), null)
  })
  test('the first text that names one wins', () => {
    assert.equal(madoInvoiceKey(null, 'Gutschrift RN-202605010 FE/000000595'), '202605010')
  })
})

describe('madoInvoiceInText — the number as clients write it in a transfer', () => {
  test('after the usual words, or as the whole purpose', () => {
    for (const t of ['Rechnung Nr. 202606014', 'Rechnungsnr. 202606014', 'Rechnungsnummer: 202606014', 'Re-Nr. 202606014',
      'Rg.-Nr. 202606014', 'Invoice #202606014', 'Inv. 202606014', 'RE 202606014', 'RN - 202606014', 'Gutschrift|202606014|Client GmbH']) {
      assert.equal(madoInvoiceInText(t), '202606014', t)
    }
  })
  test('not after another word, not inside a word, not an older or impossible number', () => {
    for (const t of ['Auftrag 202607123', 'Kundennr. 202606014', 'Bestellnr. 202606014', 'Ihre 202606014', 'RN-202605006', 'RN-202613001', 'Rechnung 920191840126']) {
      assert.equal(madoInvoiceInText(t), null, t)
    }
  })
  test('a credit’s reference and counterparty are both read', () => {
    assert.equal(madoInvoiceOfCredit({ reference: 'VD/000000606|OBKLAT2LXXX AT36…', counterparty: 'Re-Nr. 202606013 Geyrhalter' }), '202606013')
  })
})

describe('madoBookingOf — a match that reveals a Mado invoice', () => {
  test('Mado’s booking of a Mado invoice', () => {
    assert.equal(madoBookingOf({ title: 'RN-202606013 – Nikolaus Geyrhalter Filmproduk' }), '202606013')
  })
  test('not this app’s per-payment booking, not an older invoice, not an ordinary title', () => {
    assert.equal(madoBookingOf({ title: 'RN_202606013 - Geyrhalter' }), null)
    assert.equal(madoBookingOf({ title: 'RN-202605006 – Rott' }), null)
    assert.equal(madoBookingOf({ title: 'Internet Studio 07/2026' }), null)
  })
})

