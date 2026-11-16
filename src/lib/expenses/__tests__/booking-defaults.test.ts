import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { csvBankAccountId } from '../bank-account'
import { counterpartyVatin } from '../vatin'
import {
  defaultDeductTaxPercent, isBewirtungAccount, lineDeductTaxDefault, resolveExpenseDefaults, resolveIncomeDefaults,
} from '../row-defaults'
import { adaptBookingPayload } from '../adapt-payload'
import type { AiIncomeSuggestion, AiSuggestion, BookingPayload, Vendor } from '@/lib/expenses/types'

// bookamat's bank accounts in the order its API lists them (turnisan, 2026).
const BANKS = [
  { id: 3217, name: 'Barzahlung' },
  { id: 3218, name: 'Buchungen ohne Zahlungsvorgang' },
  { id: 3219, name: 'Geschäftskonto - Musterbank' },
  { id: 3220, name: 'Mastercard' },
  { id: 3221, name: 'Paypal' },
  { id: 3222, name: 'N26' },
  { id: 3223, name: 'Miles and More' },
  { id: 3224, name: 'Geschäftskonto - Easybank' },
]

describe('csvBankAccountId', () => {
  test('the CSV is easybank → Easybank, not the first „Geschäftskonto“ in the list', () => {
    // The old /easybank|geschäftskonto/ test returned Musterbank (#3219).
    assert.equal(csvBankAccountId(BANKS), 3224)
  })
  test('no account names the bank → 0 (the row asks), never a guess', () => {
    assert.equal(csvBankAccountId(BANKS.filter(b => b.id !== 3224)), 0)
    assert.equal(csvBankAccountId([]), 0)
    assert.equal(csvBankAccountId(null), 0)
  })
})

describe('counterpartyVatin', () => {
  test('the own UID is never the counterparty’s, however it is written', () => {
    assert.equal(counterpartyVatin('ATU12345675'), '')
    assert.equal(counterpartyVatin('atu 123 456 75'), '')
    assert.equal(counterpartyVatin('ATU-12345675'), '')
  })
  test('a country prefix without a number is no UID (a booking carried „ATU“)', () => {
    assert.equal(counterpartyVatin('ATU'), '')
    assert.equal(counterpartyVatin('DE'), '')
    assert.equal(counterpartyVatin(''), '')
    assert.equal(counterpartyVatin(null), '')
  })
  test('a supplier’s UID is kept as written, trimmed', () => {
    assert.equal(counterpartyVatin('DE123456789'), 'DE123456789')
    assert.equal(counterpartyVatin(' IE6388047V '), 'IE6388047V')
  })
})

describe('isBewirtungAccount', () => {
  test('by the Steuerkonto’s name', () => {
    assert.ok(isBewirtungAccount('Bewirtungskosten'))
    assert.ok(isBewirtungAccount('Besprechungskosten'))
    assert.ok(isBewirtungAccount('Repräsentationsaufwand'))
    assert.ok(!isBewirtungAccount('Internet'))
    assert.ok(!isBewirtungAccount(undefined))
  })
})

describe('resolveExpenseDefaults — one resolver for the row and the payload', () => {
  const names: Record<number, string> = { 28209: 'Internet', 28213: 'Lizenzgebühren', 28215: 'Bewirtungskosten', 28221: 'Besprechungskosten' }
  const costName = (id: number) => names[id]
  const rule = (patch: Partial<Vendor> = {}) => ({
    cost_account_id: 28213, purchasetax_account_id: 6589, bank_account_id: 3224,
    tax_percent: 20, deductibility_amount_percent: 100, deductibility_tax_percent: 100,
    vatin: '', country: '', ...patch,
  }) as Vendor
  const ai = (patch: Partial<AiSuggestion> = {}) => ({
    cost_account_id: 28209, purchasetax_account_id: 6589, bank_account_id: 3224,
    tax_percent: 20, deductibility_amount_percent: 100, vatin: '', country: '',
    category: 'Software', ...patch,
  }) as AiSuggestion

  test('a rule row with an AI suggestion books — and shows — the rule (P0-8)', () => {
    // Receipt attached to a rule row: the AI says IG Erwerb from DE, the rule says domestic.
    const d = resolveExpenseDefaults(
      { vendor: rule(), ai_suggested: ai({ purchasetax_account_id: 6593, tax_percent: 20, country: 'DE', vatin: 'DE123456789' }) },
      {}, costName, 3224)
    assert.equal(d.costAccountId, 28213)
    assert.equal(d.purchasetaxAccountId, 6589)
    assert.equal(d.country, '')
    assert.equal(d.vatin, '')
  })

  test('the owner’s override wins; a cleared field stays cleared', () => {
    const t = { vendor: rule({ vatin: 'DE123456789', country: 'DE' }) }
    const d = resolveExpenseDefaults(t, { cost_account_id: '28209', vatin: '', country: '', purchasetax_account_id: '' }, costName, 3224)
    assert.equal(d.costAccountId, 28209)
    assert.equal(d.vatin, '')          // used to fall back to the rule's UID
    assert.equal(d.country, '')
    assert.equal(d.purchasetaxAccountId, 0)
  })

  test('an empty percentage override is no override', () => {
    const d = resolveExpenseDefaults({ vendor: rule({ tax_percent: 10 }) }, { tax_percent: '', deductibility_amount_percent: '' }, costName)
    assert.equal(d.taxPercent, 10)
    assert.equal(d.deductAmountPercent, 100)
  })

  test('bank: the CSV’s account wins over a stale AI or rule value; an override wins over both', () => {
    assert.equal(resolveExpenseDefaults({ vendor: null, ai_suggested: ai({ bank_account_id: 3219 }) }, {}, costName, 3224).bankAccountId, 3224)
    assert.equal(resolveExpenseDefaults({ vendor: rule({ bank_account_id: 3219 }) }, {}, costName, 3224).bankAccountId, 3224)
    assert.equal(resolveExpenseDefaults({ vendor: rule() }, {}, costName, 0).bankAccountId, 3224)
    assert.equal(resolveExpenseDefaults({ vendor: rule() }, { bank_account_id: '3217' }, costName, 3224).bankAccountId, 3217)
    assert.equal(resolveExpenseDefaults({ vendor: rule() }, { bank_account_id: '' }, costName, 3224).bankAccountId, 0)
  })

  test('BA USt: Bewirtung is recognised by the Steuerkonto, not only the AI category (P0-9)', () => {
    // A meal on „Besprechungskosten“ with AI category „Reise“ used to book 50/50.
    const d = resolveExpenseDefaults(
      { vendor: null, ai_suggested: ai({ cost_account_id: 28221, category: 'Reise', deductibility_amount_percent: 50 }) },
      {}, costName, 3224)
    assert.equal(d.deductAmountPercent, 50)
    assert.equal(d.deductTaxPercent, 100)
  })

  test('BA USt: a partly private expense follows BA Betrag (60/60)', () => {
    const d = resolveExpenseDefaults(
      { vendor: null, ai_suggested: ai({ cost_account_id: 28209, deductibility_amount_percent: 60 }) },
      {}, costName, 3224)
    assert.equal(d.deductTaxPercent, 60)
  })

  test('BA USt: a rule’s own value, including 0, is kept', () => {
    assert.equal(resolveExpenseDefaults({ vendor: rule({ deductibility_amount_percent: 60, deductibility_tax_percent: 60 }) }, {}, costName).deductTaxPercent, 60)
    assert.equal(resolveExpenseDefaults({ vendor: rule({ deductibility_tax_percent: 0 }) }, {}, costName).deductTaxPercent, 0)
    assert.equal(resolveExpenseDefaults({ vendor: rule() }, { deductibility_tax_percent: '50' }, costName).deductTaxPercent, 50)
  })
})

describe('stored defaults never book the owner’s UID', () => {
  test('a rule imported from an old booking with ATU12345675 books no UID', () => {
    const d = resolveExpenseDefaults({ vendor: { vatin: 'ATU12345675', cost_account_id: 28213 } as Vendor }, {})
    assert.equal(d.vatin, '')
  })
  test('a draft’s AI suggestion from before the guard books no UID', () => {
    const d = resolveExpenseDefaults({ vendor: null, ai_suggested: { vatin: 'ATU 12345675' } as AiSuggestion }, {})
    assert.equal(d.vatin, '')
  })
})

describe('defaultDeductTaxPercent', () => {
  test('Bewirtung keeps the full Vorsteuer while any part is deductible', () => {
    assert.equal(defaultDeductTaxPercent(true, 50), 100)
    assert.equal(defaultDeductTaxPercent(true, 0), 0)        // a non-deductible meal claims no Vorsteuer
    assert.equal(defaultDeductTaxPercent(false, 60), 60)
  })
})

describe('lineDeductTaxDefault — a split line without its own BA USt', () => {
  const names: Record<number, string> = { 28209: 'Internet', 28215: 'Bewirtungskosten' }
  const row = { costAccountId: 28209, deductTaxPercent: 60 }
  test('a line on the row’s Steuerkonto takes the row’s value', () => {
    assert.equal(lineDeductTaxDefault({}, row, id => names[id]), 60)
    assert.equal(lineDeductTaxDefault({ cost_account_id: 28209, deductibility_amount_percent: 100 }, row, id => names[id]), 60)
  })
  test('a line moved to Bewirtungskosten is decided by that account', () => {
    assert.equal(lineDeductTaxDefault({ cost_account_id: 28215, deductibility_amount_percent: 50 }, row, id => names[id]), 100)
    assert.equal(lineDeductTaxDefault({ cost_account_id: 28215, deductibility_amount_percent: 0 }, row, id => names[id]), 0)
  })
})

describe('resolveIncomeDefaults — the income row and its payload', () => {
  const ai = (patch: Partial<AiIncomeSuggestion> = {}) => ({
    revenue_account_id: 28180, vat_account_id: 6588, bank_account_id: 3219, vat_percent: 20,
    vatin: 'DE123456789', country: 'DE', ...patch,
  }) as AiIncomeSuggestion
  test('a cleared UID, country or USt-Konto stays cleared (the payload used to refill them)', () => {
    const d = resolveIncomeDefaults({ ai_suggested: ai() }, { vatin: '', country: '', vat_account_id: '' }, 3224)
    assert.equal(d.vatin, '')
    assert.equal(d.country, '')
    assert.equal(d.vatAccountId, 0)
  })
  test('a cleared Ertragskonto is none, so the row is not bookable', () => {
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai() }, { revenue_account_id: '' }, 3224).revenueAccountId, 0)
  })
  test('bank: the CSV’s account over the AI’s; an override wins', () => {
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai() }, {}, 3224).bankAccountId, 3224)
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai() }, { bank_account_id: '3217' }, 3224).bankAccountId, 3217)
    assert.equal(resolveIncomeDefaults({ ai_suggested: null }, {}, 3224).bankAccountId, 3224)
  })
  test('USt %: the override, else the AI, else 20; never the owner’s UID by default', () => {
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai({ vat_percent: 0 }) }, {}).vatPercent, 0)
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai() }, { vat_percent: '10' }).vatPercent, 10)
    assert.equal(resolveIncomeDefaults({ ai_suggested: null }, {}).vatPercent, 20)
    assert.equal(resolveIncomeDefaults({ ai_suggested: ai({ vatin: 'ATU12345675' }) }, {}).vatin, '')
  })
})

describe('adaptBookingPayload — self-heal only the line bookamat names (P0-10)', () => {
  const line = (patch: Partial<BookingPayload['amounts'][number]> = {}) => ({
    bankaccount: 3224, costaccount: 28213, purchasetaxaccount: 6593,
    amount: '500.00', tax_percent: '20.00',
    deductibility_tax_percent: '100.00', deductibility_amount_percent: '100.00',
    country_dep: '', country_rec: '', ...patch,
  })
  const payload = (amounts = [line()]): BookingPayload => ({
    title: 'T', date: '2026-06-15', date_invoice: null, amounts, vatin: '', country: '', description: '',
  })
  const TAX_BLOCKED = 'Deductibility tax percent is blocked with the selected cost account.'

  test('two lines, the second blocked → only the second is zeroed, and it is reported', () => {
    const p = payload([line(), line({ costaccount: 28194, amount: '1.50', tax_percent: '0.00', purchasetaxaccount: 6601 })])
    const out = adaptBookingPayload(p, JSON.stringify({ amounts: [{}, { non_field_errors: [TAX_BLOCKED] }] }))
    assert.ok(out)
    assert.equal(out!.payload.amounts[0].deductibility_tax_percent, '100.00')   // the 500 € IG-Erwerb line keeps its Vorsteuer
    assert.equal(out!.payload.amounts[1].deductibility_tax_percent, '0.00')
    assert.deepEqual(out!.notes, ['Zeile 2: BA USt auf 0 % gesetzt — bookamat sperrt das Feld für dieses Steuerkonto'])
    assert.equal(p.amounts[1].deductibility_tax_percent, '100.00')               // input untouched
  })

  test('several lines and no line named → no guess, the error surfaces', () => {
    const p = payload([line(), line()])
    assert.equal(adaptBookingPayload(p, JSON.stringify({ non_field_errors: [TAX_BLOCKED] })), null)
  })

  test('one line → healed, reported without a line number', () => {
    const out = adaptBookingPayload(payload(), JSON.stringify({ amounts: [{ non_field_errors: [TAX_BLOCKED] }] }))
    assert.equal(out!.payload.amounts[0].deductibility_tax_percent, '0.00')
    assert.deepEqual(out!.notes, ['BA USt auf 0 % gesetzt — bookamat sperrt das Feld für dieses Steuerkonto'])
  })

  test('date and country corrections are reported too', () => {
    const d = adaptBookingPayload(payload(), JSON.stringify({ non_field_errors: ['Date invoice is required because of the selected purchasetax account.'] }))
    assert.equal(d!.payload.date_invoice, '2026-06-15')
    assert.deepEqual(d!.notes, ['Rechnungsdatum fehlte — Zahlungsdatum 2026-06-15 eingesetzt, bitte prüfen'])
    const c = adaptBookingPayload({ ...payload(), country: 'UK' }, '{"country":["\\"UK\\" is not a valid choice."]}')
    assert.equal(c!.payload.country, 'GB')
    assert.deepEqual(c!.notes, ['Land „UK“ → „GB“'])
  })
})
