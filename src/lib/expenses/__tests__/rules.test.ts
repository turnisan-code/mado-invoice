import './owner'
// Mado's Buchungsregeln: accounts by title in the year's books (D7), the statement's own
// Zahlungsmittelkonto by its IBAN, and Bookamat's account lists as the engine reads them.
// Made-up accounts, ids and IBANs only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BookingRule } from '@/types'
import { accountByTitle, ruleAccountIssues, vendorOf, vendorsOf } from '../rules'
import { statementBankAccountId } from '../bank-account'
import { bankAccountOf, costAccountOf, taxAccountOf } from '../accounts'
import type { BookamatAccounts } from '../types'

const LISTS: BookamatAccounts = {
  year: 2027,
  cost_accounts: [
    { id: 501, name: 'Lizenzgebühren', purchasetaxaccounts: [{ id: 702, name: 'IG Erwerb von Leistungen' }] },
    { id: 502, name: 'Miete und Pacht' },
    { id: 503, name: 'Internet' }, { id: 504, name: 'Internet' },
  ],
  purchasetax_accounts: [{ id: 701, name: 'Vorsteuer Inland', group: '2' }, { id: 702, name: 'IG Erwerb von Leistungen', group: '2' }],
  bank_accounts: [{ id: 901, name: 'Geschäftskonto - Musterbank' }, { id: 902, name: 'Geschäftskonto - Easybank', iban: 'AT61 1904 3002 3457 3201' }],
}

const rule = (o: Partial<BookingRule> = {}): BookingRule => ({
  id: 'r1', name: 'Software Abo', active: true, category: 'Software', match_strings: ['MUSTER SOFTWARE'], email_sender: '',
  email_body_keywords: [], cost_account: 'Lizenzgebühren', tax_account: 'IG Erwerb von Leistungen', bank_account: '',
  tax_percent: 20, ba_amount: 100, ba_tax: 100, country: 'IE', vatin: 'IE1234567X', title_template: 'Software {month_short}',
  notes_template: '', amount_min: null, amount_max: null, invoice_address_match: '', skip_receipt: false,
  created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', ...o,
})

test('an account by its title, whatever its case and spaces; none when missing or there twice', () => {
  assert.deepEqual(accountByTitle(LISTS.cost_accounts, '  lizenzgebühren '), { id: 501 })
  assert.deepEqual(accountByTitle(LISTS.cost_accounts, 'Miete  und Pacht'), { id: 502 })
  assert.deepEqual(accountByTitle(LISTS.cost_accounts, 'Bewirtung'), { id: 0, issue: 'missing' })
  assert.deepEqual(accountByTitle(LISTS.cost_accounts, 'Internet'), { id: 0, issue: 'ambiguous' })
  assert.deepEqual(accountByTitle(LISTS.cost_accounts, ''), { id: 0 })
})

test('a rule with the ids of the year: its own values, the statement\'s bank when it names none', () => {
  const v = vendorOf(rule({ amount_min: 9, amount_max: '12' as unknown as number, ba_amount: '60' as unknown as number, ba_tax: 60, skip_receipt: true }), LISTS)
  assert.deepEqual(
    [v.cost_account_id, v.purchasetax_account_id, v.bank_account_id, v.deductibility_amount_percent, v.deductibility_tax_percent, v.amount_min, v.amount_max, v.skip_invoice_search],
    [501, 702, 0, 60, 60, 9, 12, true],
  )
  assert.equal(vendorOf(rule({ bank_account: 'Geschäftskonto - Musterbank' }), LISTS).bank_account_id, 901)
  // Without the year's books nothing is resolved
  assert.deepEqual([vendorOf(rule(), null).cost_account_id, vendorOf(rule(), null).purchasetax_account_id], [0, 0])
  // The order given is kept: a tie is decided the same on the page and on the server
  assert.deepEqual(vendorsOf([rule({ id: 'b', name: 'B' }), rule({ id: 'a', name: 'A' })], LISTS).map(r => r.id), ['b', 'a'])
})

test('what a rule names that the year lacks or has twice is said', () => {
  assert.deepEqual(ruleAccountIssues(rule({ cost_account: 'Internet', tax_account: 'Vorsteuer Ausland', bank_account: '' }), LISTS), [
    { field: 'cost_account', title: 'Internet', issue: 'ambiguous' },
    { field: 'tax_account', title: 'Vorsteuer Ausland', issue: 'missing' },
  ])
  assert.deepEqual(ruleAccountIssues(rule(), LISTS), [])
  assert.deepEqual(ruleAccountIssues(rule(), null), [])
})

test('the statement\'s own Zahlungsmittelkonto: by its IBAN, else by the bank\'s name', () => {
  assert.equal(statementBankAccountId(LISTS.bank_accounts, 'at611904300234573201'), 902)
  assert.equal(statementBankAccountId([{ id: 901, name: 'Geschäftskonto - Musterbank', iban: 'AT611904300234573201' }, ...LISTS.bank_accounts.slice(1)], 'AT611904300234573201'), 902)
  assert.equal(statementBankAccountId([{ id: 901, name: 'Geschäftskonto - Musterbank', iban: 'AT990000000000000777' }], 'AT990000000000000777'), 901)
  assert.equal(statementBankAccountId([{ id: 901, name: 'Geschäftskonto - Musterbank' }], 'AT611904300234573201'), 0)
})

test('Bookamat\'s lists as the engine reads them: links, locks, side and rates, IBANs', () => {
  assert.deepEqual(costAccountOf({ id: 501, name: 'Lizenzgebühren', group: '2', section: 'Aufwand', purchasetaxaccounts: [{ id: 702, name: 'IG Erwerb von Leistungen' }, { id: 0 }], deductibility_tax_percent: null, deductibility_amount_percent: '0.00', inventory: false }), {
    id: 501, name: 'Lizenzgebühren', group: '2', section: 'Aufwand', purchasetaxaccounts: [{ id: 702, name: 'IG Erwerb von Leistungen' }],
    deductibility_tax_percent: null, deductibility_amount_percent: '0.00', inventory: false,
  })
  // A free value stays free: an empty one is no lock at 0
  assert.equal(costAccountOf({ id: 1, name: 'X', deductibility_tax_percent: '' })?.deductibility_tax_percent, null)
  assert.equal(costAccountOf({ id: 'x', name: 'X' }), null)
  assert.deepEqual(taxAccountOf({ id: 701, title: 'Vorsteuer Inland', group: 2, tax_values: ['20.00', '10.00'] }), { id: 701, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00'] })
  assert.deepEqual(bankAccountOf({ id: 902, name: 'Geschäftskonto - Easybank', iban: 'AT611904300234573201' }), { id: 902, name: 'Geschäftskonto - Easybank', iban: 'AT611904300234573201' })
})
