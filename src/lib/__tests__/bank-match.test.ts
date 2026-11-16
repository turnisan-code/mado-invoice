// What the bank import ticks on its own (only a credit naming the invoice's number whole) and
// what it offers as bank charges (a short payment on an invoice without VAT, D5). Made-up
// invoices, names and amounts only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bankFeeCap, matchTransactions, type OpenInvoice } from '@/lib/bank/match'
import type { BankTransaction } from '@/lib/bank/types'

const invoice = (o: Partial<OpenInvoice> & Pick<OpenInvoice, 'id' | 'number' | 'total'>): OpenInvoice => ({
  clientName: 'Max Muster', clientCompany: null, date: '2026-06-01', dueDate: '2026-06-15', paid: 0, balance: o.total,
  skontoPercent: null, skontoDays: null, reminderLevel: 0, taxTreatment: 'at_vat', ...o,
})
let seq = 0
const credit = (o: Partial<BankTransaction> & Pick<BankTransaction, 'amount'>): BankTransaction =>
  ({ id: `tx${++seq}`, date: '2026-06-20', currency: 'EUR', counterparty: null, text: '', reference: null, raw: '', ...o })
const match = (txs: BankTransaction[], invoices: OpenInvoice[]) => matchTransactions(txs, invoices, new Set())

test('only a credit naming the number whole is ticked without a look', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906001', total: 840 })
  const [byNumber] = match([credit({ amount: 840, text: 'Zahlung RN-209906001' })], [inv])
  assert.deepEqual([byNumber.status, byNumber.exactNumber], ['match', true])
  // The same amount from someone who names no number: suggested, not ticked.
  const [byAmount] = match([credit({ amount: 840, text: 'Überweisung', counterparty: 'Erika Beispiel' })], [inv])
  assert.deepEqual([byAmount.status, byAmount.invoiceId, byAmount.exactNumber, byAmount.reasons], ['match', 'i1', false, ['amount']])
  // A number with spaces in it is weaker evidence.
  const [split] = match([credit({ amount: 840, text: 'RN 2099 06001' })], [inv])
  assert.deepEqual([split.status, split.exactNumber], ['match', false])
})

test('a number easybank broke across lines counts whole', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906001', total: 840 })
  const [row] = match([credit({ amount: 840, text: 'Zahlung RN-2099 06001', search: 'Zahlung RN-209906001' })], [inv])
  assert.equal(row.exactNumber, true)
})

test('a short payment from the client on an invoice without VAT is offered with the rest as bank charges', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906014', total: 270, taxTreatment: 'non_eu', clientName: 'Sample Radio Inc' })
  const [row] = match([credit({ amount: 258, text: 'Gutschrift Auslandsüberweisung INVOICE PAYMENT', counterparty: 'Sample Radio Inc' })], [inv])
  assert.deepEqual([row.status, row.invoiceId, row.exactNumber, row.bankFees], ['match', 'i1', false, 12])
  assert.deepEqual(row.reasons, ['name', 'short'])
  // With VAT the rest stays open: no suggestion from the name alone.
  const [vat] = match([credit({ amount: 258, counterparty: 'Sample Radio Inc' })], [{ ...inv, taxTreatment: 'at_vat' }])
  assert.deepEqual([vat.status, vat.bankFees], ['unmatched', 0])
  // More short than 5 % (13,50 € here) is no bank charge.
  const [far] = match([credit({ amount: 255, counterparty: 'Sample Radio Inc' })], [inv])
  assert.equal(far.bankFees, 0)
  // The number found: ticked, and the rest offered too.
  const [numbered] = match([credit({ amount: 258, text: 'RN-209906014' })], [inv])
  assert.deepEqual([numbered.exactNumber, numbered.bankFees], [true, 12])
})

test('bank charges stay within 5 % and 25 €, on invoices without VAT only', () => {
  assert.equal(bankFeeCap(270, 'non_eu'), 13.5)
  assert.equal(bankFeeCap(2000, 'eu_reverse_charge'), 25)
  assert.equal(bankFeeCap(2000, 'at_vat'), 0)
  assert.equal(bankFeeCap(2000, null), 0)
})

test('a Skonto settlement is no short payment', () => {
  const inv = invoice({ id: 'i1', number: 'RN-209906020', total: 300, taxTreatment: 'non_eu', skontoPercent: 2, skontoDays: 30 })
  const [row] = match([credit({ amount: 294, text: 'RN-209906020' })], [inv])
  assert.deepEqual([row.skontoAmount, row.bankFees], [6, 0])
})
