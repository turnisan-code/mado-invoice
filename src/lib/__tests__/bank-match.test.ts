// What the bank import ticks on its own (only a credit naming the invoice's number whole, and not
// possibly recorded already) and what it offers as bank charges (a short payment on an invoice
// without VAT, D5). Made-up invoices, names and amounts only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBankFee, matchTransactions, preTicked, toggledSelection, type OpenInvoice } from '@/lib/bank/match'
import type { BankTransaction } from '@/lib/bank/types'

const invoice = (o: Partial<OpenInvoice> & Pick<OpenInvoice, 'id' | 'number' | 'total'>): OpenInvoice => ({
  clientName: 'Max Muster', clientCompany: null, date: '2026-06-01', dueDate: '2026-06-15', paid: 0, balance: o.total,
  skontoPercent: null, skontoDays: null, reminderLevel: 0, taxTreatment: 'at_vat', ...o,
})
let seq = 0
const credit = (o: Partial<BankTransaction> & Pick<BankTransaction, 'amount'>): BankTransaction =>
  ({ id: `tx${++seq}`, date: '2026-06-20', currency: 'EUR', counterparty: null, text: '', reference: null, raw: '', ...o })
const match = (txs: BankTransaction[], invoices: OpenInvoice[], closed?: { id: string; number: string }[]) =>
  matchTransactions(txs, invoices, new Set(), { otherPrefixes: ['AN', 'GS'], closed })

test('only a credit naming the number whole is ticked without a look', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906001', total: 840 })
  const [byNumber] = match([credit({ amount: 840, text: 'Zahlung RN-209906001' })], [inv])
  assert.deepEqual([byNumber.status, byNumber.exactNumber, preTicked(byNumber)], ['match', true, true])
  // The same amount from someone who names no number: suggested, not ticked.
  const [byAmount] = match([credit({ amount: 840, text: 'Überweisung', counterparty: 'Erika Beispiel' })], [inv])
  assert.deepEqual([byAmount.status, byAmount.invoiceId, byAmount.reasons, preTicked(byAmount)], ['match', 'i1', ['amount'], false])
  // A number with spaces in it is weaker evidence.
  const [split] = match([credit({ amount: 840, text: 'RN 2099 06001' })], [inv])
  assert.deepEqual([split.status, preTicked(split)], ['match', false])
})

test('the bare digits count as the number only from the client', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906003', total: 500, clientName: 'Erika Beispiel' })
  // Someone else quoting the same digits (their quote's number, say): suggested, not ticked —
  // also when it is exactly the open amount.
  assert.equal(preTicked(match([credit({ amount: 300, text: 'Anzahlung 209906003', counterparty: 'Max Muster' })], [inv])[0]), false)
  assert.equal(preTicked(match([credit({ amount: 500, text: 'Anzahlung 209906003', counterparty: 'Max Muster' })], [inv])[0]), false)
  // The client's own transfer with the digits: ticked.
  assert.equal(preTicked(match([credit({ amount: 250, text: '209906003 erste Hälfte', counterparty: 'Erika Beispiel' })], [inv])[0]), true)
})

test('a number easybank broke across lines counts whole; a name glued to the next line finds none', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906001', total: 840 })
  const [row] = match([credit({ amount: 840, text: 'Zahlung RN-2099 06001', search: 'Zahlung RN-209906001' })], [inv])
  assert.equal(preTicked(row), true)
  // „Max Muster|AN-209906001 Anzahlung“: the quote's number is no invoice, glued or not.
  const quote = invoice({ id: 'i2', number: 'RN-209906001', total: 500, clientName: 'Erika Beispiel' })
  const [glued] = match([credit({
    amount: 300, counterparty: 'Max Muster',
    text: 'Gutschrift Überweisung TESTATWWXXX AT991234567890123456 Max Muster AN-209906001 Anzahlung',
    search: 'Gutschrift ÜberweisungTESTATWWXXX AT991234567890123456 Max MusterAN-209906001 Anzahlung',
  })], [quote])
  assert.deepEqual([glued.status, preTicked(glued)], ['unmatched', false])
})

test('a short payment from the client on an invoice without VAT is offered with the rest as bank charges', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906014', total: 270, taxTreatment: 'non_eu', clientName: 'Sample Radio Inc' })
  const [row] = match([credit({ amount: 258, text: 'Gutschrift Auslandsüberweisung INVOICE PAYMENT', counterparty: 'Sample Radio Inc' })], [inv])
  assert.deepEqual([row.status, row.invoiceId, preTicked(row), row.bankFees], ['match', 'i1', false, 12])
  assert.deepEqual(row.reasons, ['name', 'short'])
  // With VAT the rest stays open: no suggestion from the name alone.
  const [vat] = match([credit({ amount: 258, counterparty: 'Sample Radio Inc' })], [{ ...inv, taxTreatment: 'at_vat' }])
  assert.deepEqual([vat.status, vat.bankFees], ['unmatched', 0])
  // More short than 5 % (13,50 € here) is no bank charge.
  assert.equal(match([credit({ amount: 255, counterparty: 'Sample Radio Inc' })], [inv])[0].bankFees, 0)
  // The number found: ticked, and the rest offered too.
  const [numbered] = match([credit({ amount: 258, text: 'RN-209906014' })], [inv])
  assert.deepEqual([preTicked(numbered), numbered.bankFees], [true, 12])
})

test('bank charges: 0,5–5 % of what was due before the payment, at most 25 €, without VAT only', () => {
  assert.equal(isBankFee(12, 270, 'non_eu'), true)
  assert.equal(isBankFee(13.5, 270, 'non_eu'), true)
  assert.equal(isBankFee(14, 270, 'non_eu'), false)
  assert.equal(isBankFee(25, 2000, 'eu_reverse_charge'), true)
  assert.equal(isBankFee(26, 2000, 'eu_reverse_charge'), false)
  // A few cents short is rounding, not a bank's charge.
  assert.equal(isBankFee(0.5, 270, 'non_eu'), false)
  // 15 € left of the last 20 € is no bank charge, whatever the invoice's total.
  assert.equal(isBankFee(15, 20, 'non_eu'), false)
  assert.equal(isBankFee(12, 270, 'at_vat'), false)
  assert.equal(isBankFee(12, 270, null), false)
})

test('a Skonto settlement is no short payment', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906020', total: 300, taxTreatment: 'non_eu', skontoPercent: 2, skontoDays: 30 })
  const [row] = match([credit({ amount: 294, text: 'RN-209906020' })], [inv])
  assert.deepEqual([row.skontoAmount, row.bankFees], [6, 0])
})

test('a payment already on the invoice is never ticked again', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906001', total: 840, paid: 420, balance: 420, payments: [{ date: '2026-06-18', amount: 420 }] })
  const [again] = match([credit({ amount: 420, date: '2026-06-20', text: 'Teilzahlung RN-209906001' })], [inv])
  assert.deepEqual([again.status, again.exactNumber, again.recorded, preTicked(again)], ['match', true, { date: '2026-06-18', amount: 420 }, false])
  // Entered by hand ten days later with that day's date: still possibly the same money.
  const [late] = match([credit({ amount: 420, date: '2026-06-08', text: 'Teilzahlung RN-209906001' })], [inv])
  assert.equal(preTicked(late), false)
  // An imported part weeks before is another transfer: a second part of the same amount is new money.
  const imported = { ...inv, payments: [{ date: '2026-05-20', amount: 420, imported: true }] }
  assert.equal(match([credit({ amount: 420, date: '2026-06-20', text: 'Teilzahlung RN-209906001' })], [imported])[0].recorded, null)
})

test('a suggestion takes no open amount from the credits after it', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906003', total: 500 })
  // Someone's 500 € without a number first, then the client's own transfer: the client's takes the
  // open amount whatever the order, and nothing is left to suggest the other for.
  const [stranger, own] = match([
    credit({ amount: 500, text: 'Überweisung', counterparty: 'Hans Anders' }),
    credit({ amount: 500, date: '2026-06-21', text: 'Zahlung RN-209906003' }),
  ], [inv])
  assert.deepEqual([own.status, own.invoiceId, preTicked(own)], ['match', 'i1', true])
  assert.deepEqual([stranger.status, preTicked(stranger)], ['unmatched', false])
  // A Skonto is worked out against what is really open, not against an unticked suggestion.
  const skonto = invoice({ id: 'i2', number: 'RN-209906004', total: 300, skontoPercent: 2, skontoDays: 30 })
  const [first, second] = match([
    credit({ amount: 100, text: 'RN 2099 06004' }),
    credit({ amount: 194, date: '2026-06-21', text: 'RN-209906004' }),
  ], [skonto])
  assert.equal(preTicked(first), false)
  assert.deepEqual([second.skontoAmount, preTicked(second)], [0, true])
})

test('a credit naming an invoice that is no longer open is suggested for no other', () => {
  const next = invoice({ id: 'i2', number: 'RN-209907001', total: 840 })
  const [row] = match([credit({ amount: 840, text: 'Gutschrift RN-209906001', counterparty: 'Max Muster' })], [next], [{ id: 'i1', number: 'RN-209906001' }])
  assert.deepEqual([row.status, row.invoiceId, row.names], ['unmatched', null, 'RN-209906001'])
  // Naming the open one as well, it stays a suggestion for that one.
  const [both] = match([credit({ amount: 840, text: 'RN-209906001 RN-209907001' })], [next], [{ id: 'i1', number: 'RN-209906001' }])
  assert.equal(both.invoiceId, 'i2')
})

test('„Alle“ keeps what was ticked by hand; unticking clears every row', () => {
  const ticked = toggledSelection({ a: true, b: false }, ['c', 'd'], ['a', 'b', 'c', 'd'], true)
  assert.deepEqual(ticked, { a: true, b: false, c: true, d: true })
  assert.deepEqual(toggledSelection(ticked, ['c', 'd'], ['a', 'b', 'c', 'd'], false), { a: false, b: false, c: false, d: false })
})
