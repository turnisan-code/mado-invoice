import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, rowInvoiceDate } from '../booking-payload'
import { fifteenDayLoose } from '../booking-dates'
import { resolveExpenseDefaults } from '../row-defaults'
import type { AiIncomeSuggestion, AiSuggestion, MatchedIncomeTransaction, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// The booking route builds every CSV payload with these two functions and the
// account context it loaded from bookamat; the review row uses the same resolver.
const names: Record<number, string> = { 28209: 'Internet', 28213: 'Lizenzgebühren', 28215: 'Bewirtungskosten', 28230: 'Werbekosten' }
const ctx = { costAccountName: (id: number) => names[id], csvBankId: 3224 }
const tx = { date: '2026-07-03', counterparty: 'ANTHROPIC\\SAN FRANCISCO', amount: 21.6, type: 'expense', currency: 'EUR', reference: 'Ref 1', raw: {} }

const expenseRow = (patch: Partial<MatchedTransaction>) => ({
  transaction: tx, vendor: null, title: 'Anthropic – Juli 2026', ...patch,
}) as MatchedTransaction
const ai = (patch: Partial<AiSuggestion> = {}) => ({
  cost_account_id: 28213, purchasetax_account_id: 6597, bank_account_id: 3219, tax_percent: 20,
  deductibility_amount_percent: 100, vatin: '', country: 'US', title: 'Anthropic API', category: 'Software', ...patch,
}) as AiSuggestion

describe('buildExpenseBookingPayload', () => {
  test('an AI row books the CSV’s bank account, not a stale Musterbank from a draft', () => {
    const p = buildExpenseBookingPayload(expenseRow({ ai_suggested: ai() }), {}, ctx)
    assert.equal(p.amounts[0].bankaccount, 3224)
  })
  test('the title is the one the row shows', () => {
    const p = buildExpenseBookingPayload(expenseRow({ ai_suggested: ai({ title: 'Anthropic API (neu)' }) }), {}, ctx)
    assert.equal(p.title, 'Anthropic – Juli 2026')
    assert.equal(buildExpenseBookingPayload(expenseRow({ ai_suggested: ai() }), { title: 'Eigener Titel' }, ctx).title, 'Eigener Titel')
  })
  test('an AI „Bewirtung“ on a non-Bewirtung Steuerkonto still keeps the full Vorsteuer', () => {
    const p = buildExpenseBookingPayload(expenseRow({ ai_suggested: ai({ cost_account_id: 28230, category: 'Bewirtung', deductibility_amount_percent: 50, purchasetax_account_id: 6589, country: '' }) }), {}, ctx)
    assert.equal(p.amounts[0].deductibility_amount_percent, '50.00')
    assert.equal(p.amounts[0].deductibility_tax_percent, '100.00')
  })
  test('a rule row books the rule and its own BA USt, ignoring an old AI suggestion', () => {
    const rule = { cost_account_id: 28209, purchasetax_account_id: 6589, bank_account_id: 3224, tax_percent: 20,
      deductibility_amount_percent: 60, deductibility_tax_percent: 60, vatin: '', country: '' } as Vendor
    const p = buildExpenseBookingPayload(expenseRow({ vendor: rule, title: 'Magenta Home Office – Juli 2026', ai_suggested: ai() }), {}, ctx)
    assert.deepEqual(
      [p.amounts[0].costaccount, p.amounts[0].purchasetaxaccount, p.amounts[0].deductibility_amount_percent, p.amounts[0].deductibility_tax_percent, p.country],
      [28209, 6589, '60.00', '60.00', ''])
  })
  test('a cleared UID and Vorsteuerkonto are booked cleared', () => {
    const p = buildExpenseBookingPayload(expenseRow({ ai_suggested: ai({ vatin: 'DE123456789' }) }), { vatin: '', purchasetax_account_id: '' }, ctx)
    assert.equal(p.vatin, '')
    assert.equal(p.amounts[0].purchasetaxaccount, undefined)
  })
})

describe('buildIncomeBookingPayload', () => {
  const incomeRow = (s: Partial<AiIncomeSuggestion> | null, patch: Partial<MatchedIncomeTransaction> = {}) => ({
    transaction: { ...tx, type: 'income', amount: 1170 }, title: 'RN_202606013 - Geyrhalter',
    ai_suggested: s ? { revenue_account_id: 28180, vat_account_id: 6588, bank_account_id: 3219, vat_percent: 20, vatin: 'ATU12345675', country: '', ...s } : null,
    ...patch,
  }) as unknown as MatchedIncomeTransaction
  test('the CSV’s bank, the AI’s accounts, never the owner’s own UID', () => {
    const p = buildIncomeBookingPayload(incomeRow({}), {}, ctx)
    assert.deepEqual([p.amounts[0].bankaccount, p.amounts[0].costaccount, p.amounts[0].purchasetaxaccount, p.vatin], [3224, 28180, 6588, ''])
  })
  test('cleared fields stay cleared', () => {
    const p = buildIncomeBookingPayload(incomeRow({ vatin: 'DE123456789', country: 'DE' }), { vatin: '', country: '', vat_account_id: '' }, ctx)
    assert.deepEqual([p.vatin, p.country, p.amounts[0].purchasetaxaccount], ['', '', undefined])
  })
  test('a manual Ertragskonto without an AI suggestion books the CSV’s bank (it used to be 0)', () => {
    const p = buildIncomeBookingPayload(incomeRow(null), { revenue_account_id: '28181' }, ctx)
    assert.deepEqual([p.amounts[0].costaccount, p.amounts[0].bankaccount], [28181, 3224])
  })
})

describe('the Buchungsdatum from the day of payment (PR 4b)', () => {
  // Synthetic rows (spec P4 S12, S10, S11): zero IBANs, made-up merchants and amounts
  const s12 = 'Bezahlung Karte                              MC/000000912|POS          4711  D002 30.12. 19:20|1A SHOP EXAMPLE\\WIEN\\1010|SPESEN: 0,00'
  const s10 = 'Abbuchung Echtzeitueberweisung               FE/000000910|TESTATWWXXX AT000000000000000004 Example Supplier GmbH|Rechnung 2026-1231'
  const s11 = 'Gutschrift Echtzeitueberweisung              FE/000000911|TESTDEFFXXX DE00000000000000000000 Example Client GmbH|Projekt 12/2026'
  const posted = (reference: string, type: 'expense' | 'income', amount: number, valuta: string) => ({
    date: '2027-01-04', counterparty: 'Example', amount, type, currency: 'EUR', reference,
    raw: { col0: 'AT000000000000000000', col1: reference, col2: '04.01.2027', col3: valuta },
  })
  const credit = (reference: string, valuta: string) => ({
    transaction: posted(reference, 'income', 77.77, valuta), title: 'Example Client – Projekt',
    ai_suggested: { revenue_account_id: 28180, vat_account_id: 6588, bank_account_id: 3224, vat_percent: 20, vatin: '', country: '' },
  }) as unknown as MatchedIncomeTransaction

  test('a card payment of 30.12. posted 04.01.2027 is booked on 30.12.', () => {
    const row = expenseRow({ transaction: posted(s12, 'expense', 12.12, '30.12.2026'), ai_suggested: ai() })
    assert.equal(buildExpenseBookingPayload(row, {}, ctx).date, '2026-12-30')
    assert.equal(buildExpenseBookingPayload(row, { date: '2026-12-31' }, ctx).date, '2026-12-31')
    assert.equal(buildExpenseBookingPayload(row, { date: '' }, ctx).date, '2026-12-30')
  })
  test('a transfer valued 31.12.2026 posted 04.01.2027 is booked on 31.12.', () => {
    const row = expenseRow({ transaction: posted(s10, 'expense', 55.55, '31.12.2026'), ai_suggested: ai() })
    assert.equal(buildExpenseBookingPayload(row, {}, ctx).date, '2026-12-31')
  })
  test('a credit valued 31.12.2026 is booked on 31.12.; one with a card text keeps the bank date', () => {
    assert.equal(buildIncomeBookingPayload(credit(s11, '31.12.2026'), {}, ctx).date, '2026-12-31')
    assert.equal(buildIncomeBookingPayload(credit(s12, '30.12.2026'), {}, ctx).date, '2027-01-04')
  })
})

describe('rowInvoiceDate — the Rechnungsdatum a row books, and the ticks on an upload test (TAX-03)', () => {
  test('the owner’s, else the receipt attached by hand, else the found one unless it was removed', () => {
    assert.equal(rowInvoiceDate(undefined, null, '2026-11-30', true), null)
    assert.equal(rowInvoiceDate(undefined, null, '2026-11-30', false), '2026-11-30')
    assert.equal(rowInvoiceDate(undefined, '2026-12-31', '2026-11-30', true), '2026-12-31')
    assert.equal(rowInvoiceDate('2027-01-02', null, '2026-11-30', true), '2027-01-02')
    assert.equal(rowInvoiceDate('', undefined, null, false), null)
  })
  test('a removed Gmail receipt’s date no longer spares a row paid 07.01. its 15-day question', () => {
    assert.equal(fifteenDayLoose('2027-01-07', rowInvoiceDate(undefined, null, '2026-11-30', true)), true)
    // the stale date the tick used to test: no question, so it was ticked
    assert.equal(fifteenDayLoose('2027-01-07', '2026-11-30'), false)
  })
  test('the payload books the date the ticks test (the row built as the import page builds it)', () => {
    for (const ov of [undefined, '', '2027-01-02']) {
      for (const assigned of [undefined, null, '', '2026-12-31']) {
        for (const found of [null, '2026-11-30']) {
          for (const cleared of [false, true]) {
            const row = expenseRow({ ai_suggested: ai(), extracted_invoice_date: rowInvoiceDate(undefined, assigned, found, cleared) })
            const p = buildExpenseBookingPayload(row, ov === undefined ? {} : { date_invoice: ov }, ctx)
            assert.equal(p.date_invoice, rowInvoiceDate(ov, assigned, found, cleared), JSON.stringify([ov, assigned, found, cleared]))
          }
        }
      }
    }
  })
})

describe('resolveExpenseDefaults — AI category', () => {
  test('the AI category „Bewirtung“ counts even when the account name does not say so', () => {
    const d = resolveExpenseDefaults({ vendor: null, ai_suggested: ai({ cost_account_id: 28230, category: 'Bewirtung', deductibility_amount_percent: 50 }) }, {}, ctx.costAccountName)
    assert.equal(d.deductTaxPercent, 100)
  })
})
