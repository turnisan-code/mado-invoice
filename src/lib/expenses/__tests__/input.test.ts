import './owner'
// What the expense routes accept from the page, and how a stored line is rebuilt from its cells
// (never from what the page says it is). Made-up values only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLineInputs, parseReview, parseRule, receiptPathOk } from '../input'
import { lineRecord } from '../statement'

const OWN = 'AT611904300234573201'
const LINE_ID = '0b9c8b1e-6c1f-4b8e-9d2a-1f2e3d4c5b6a'

test('a stored line comes from its cells: the signed amount, the Buchungsdatum, SPESEN, the payee', () => {
  const debit = lineRecord({ key: 'k1', cells: [OWN, 'Bezahlung Karte MC/000000901|POS 4711 D002 12.06. 09:15|SPESEN: 1,50|Musterladen', '15.06.2026', '15.06.2026', '-101,50', 'EUR'] })!
  assert.deepEqual([debit.amount, debit.booked_on, debit.value_on, debit.fee, debit.currency, debit.statement_iban], [-101.5, '2026-06-15', '2026-06-15', 1.5, 'EUR', OWN])
  const credit = lineRecord({ key: 'k2', cells: [OWN, 'Gutschrift|TESTATWWXXX AT991234567890123456 Max Muster|RN-209906001', '15.06.2026', '14.06.2026', '840,00', 'EUR'] })!
  assert.deepEqual([credit.amount, credit.value_on, credit.counterparty], [840, '2026-06-14', 'Max Muster'])
  assert.equal(lineRecord({ key: 'k3', cells: [OWN, 'kaputt', '31.06.2026', '', '10,00', 'EUR'] }), null)
})

test('the lines a page sends: 1–3000, each a key and 5–12 cells of text', () => {
  assert.deepEqual(parseLineInputs([{ key: 'k1', cells: [OWN, 'x', '15.06.2026', '15.06.2026', '-1,00', 'EUR'] }])?.length, 1)
  assert.equal(parseLineInputs([]), null)
  assert.equal(parseLineInputs([{ key: '', cells: [OWN, 'x', '15.06.2026', '15.06.2026', '-1,00'] }]), null)
  assert.equal(parseLineInputs([{ key: 'k', cells: [OWN, 1, '15.06.2026', '15.06.2026', '-1,00'] }]), null)
  assert.equal(parseLineInputs([{ key: 'k', cells: ['a', 'b'] }]), null)
})

test('a line\'s review: only the editor\'s fields, each in its form', () => {
  assert.deepEqual(parseReview({ override: { cost_account_id: '12', tax_percent: '20', date_invoice: '2026-06-01', vatin: '', title: 'Miete Juni ' } }),
    { override: { cost_account_id: '12', tax_percent: '20', date_invoice: '2026-06-01', vatin: '', title: 'Miete Juni ' } })
  assert.equal(parseReview({ override: { amount: '1' } }), null)
  assert.equal(parseReview({ override: { cost_account_id: 'Miete' } }), null)
  assert.equal(parseReview({ override: { tax_percent: '120' } }), null)
  assert.equal(parseReview({ override: { date: '15.06.2026' } }), null)
  assert.equal(parseReview({ rule_id: 'r1' }), null)
  assert.deepEqual(parseReview({ rule_id: LINE_ID, ack_duplicate_ids: [7001] }), { rule_id: LINE_ID, ack_duplicate_ids: [7001] })
  assert.deepEqual(parseReview({ lines: [{ label: 'Speisen', amount_gross: 33, vat_percent: 10, deductibility_amount_percent: 50 }] }),
    { lines: [{ label: 'Speisen', amount_gross: 33, vat_percent: 10, deductibility_amount_percent: 50 }] })
  assert.equal(parseReview({ lines: [{ label: 'x', amount_gross: 1, vat_percent: 10, cost_account_id: -1 }] }), null)
  assert.equal(parseReview({ other: 1 }), null)
  assert.deepEqual(parseReview({}), {})
})

test('a Beleg\'s path is in the line\'s own folder', () => {
  assert.equal(receiptPathOk(LINE_ID, `${LINE_ID}/Rechnung_Juni.pdf`), true)
  assert.equal(receiptPathOk(LINE_ID, `${LINE_ID}/../x.pdf`), false)
  assert.equal(receiptPathOk(LINE_ID, `${LINE_ID}/a/b.pdf`), false)
  assert.equal(receiptPathOk(LINE_ID, 'other/x.pdf'), false)
})

test('a Buchungsregel: its name, its texts, its rates and its range', () => {
  const ok = {
    name: ' Software Abo ', active: true, category: 'Software', match_strings: ['MUSTER SOFTWARE', ' '], email_sender: '', email_body_keywords: [],
    cost_account: 'Lizenzgebühren', tax_account: 'IG Erwerb von Leistungen', bank_account: '', tax_percent: 20, ba_amount: 100, ba_tax: 100,
    country: 'ie', vatin: 'IE1234567X', title_template: 'Software {month_short}', notes_template: '', amount_min: 9, amount_max: 12,
    invoice_address_match: '', skip_receipt: false,
  }
  const r = parseRule(ok)!
  assert.deepEqual([r.name, r.match_strings, r.country, r.amount_min, r.amount_max], ['Software Abo', ['MUSTER SOFTWARE'], 'IE', 9, 12])
  assert.equal(parseRule({ ...ok, name: ' ' }), null)
  assert.equal(parseRule({ ...ok, tax_percent: 120 }), null)
  assert.equal(parseRule({ ...ok, amount_min: 20, amount_max: 10 }), null)
  assert.equal(parseRule({ ...ok, amount_min: '' })?.amount_min, null)
  assert.equal(parseRule({ ...ok, skip_receipt: 'yes' }), null)
})
