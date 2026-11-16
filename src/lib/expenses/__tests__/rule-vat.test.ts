import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RULE_VAT_RATES, rateLabel, ruleNotSavedText, ruleVatLabel, ruleVatOptionsFor, storedRateNote } from '../rule-vat'
import { AT_VAT_RATES } from '../vat-origin'
import { buildExpenseBookingPayload, payloadContext } from '../booking-payload'
import { resolveExpenseDefaults } from '../row-defaults'
import { validatePayload, type ValidationLists } from '../booking-validation'
import type { BookamatAccount, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// A Buchungsregel's USt-Satz in the rule editor (app/(app)/vendors/page.tsx, whose wiring
// fixed-rules-wiring.test.ts reads), and the way a rule's rate goes into a booking.
// Synthetic only: a made-up rule „Netzcom“ with a made-up amount and the example UID
// DE123456789, on the 2026 books' account ids as booking-validation.test.ts has them.

describe('RULE_VAT_RATES — the rates the editor offers', () => {
  test('Austria’s rates, 4,9 % among them, then 0 %', () => {
    assert.deepEqual([...RULE_VAT_RATES], [20, 13, 10, 4.9, 0])
    assert.deepEqual(RULE_VAT_RATES.slice(0, -1), [...AT_VAT_RATES])
  })
  test('each by its label: „4,9% (ermäßigt)“ with a comma', () => {
    assert.deepEqual(RULE_VAT_RATES.map(ruleVatLabel), ['20% (Standard)', '13% (ermäßigt)', '10% (ermäßigt)', '4,9% (ermäßigt)', '0% (steuerfrei/IG)'])
  })
})

describe('ruleVatOptionsFor — a stored rate is shown as it is', () => {
  test('an offered rate: the offered ones, nothing added', () => {
    for (const r of RULE_VAT_RATES) assert.deepEqual(ruleVatOptionsFor(r), RULE_VAT_RATES, String(r))
  })
  test('any other stored rate (a rule imported from bookamat, a rate Supabase rounded) gets its own option in order, „(gespeichert)“ — never shown as „20% (Standard)“', () => {
    assert.deepEqual(ruleVatOptionsFor(19).map(ruleVatLabel), ['20% (Standard)', '19% (gespeichert)', '13% (ermäßigt)', '10% (ermäßigt)', '4,9% (ermäßigt)', '0% (steuerfrei/IG)'])
    assert.deepEqual(ruleVatOptionsFor(5).map(ruleVatLabel), ['20% (Standard)', '13% (ermäßigt)', '10% (ermäßigt)', '5% (gespeichert)', '4,9% (ermäßigt)', '0% (steuerfrei/IG)'])
    assert.deepEqual(ruleVatOptionsFor(5.5), [20, 13, 10, 5.5, 4.9, 0])
    assert.equal(ruleVatLabel(5.5), '5,5% (gespeichert)')
  })
})

describe('rateLabel — a rate as the list and the import show it', () => {
  test('with a comma and at most two decimals; bookamat’s „4.90“ reads „4,9“', () => {
    const cases: [unknown, string][] = [[4.9, '4,9'], [20, '20'], [13, '13'], [0, '0'], ['4.90', '4,9'], ['20.00', '20'], [5.5, '5,5'], [12.25, '12,25'], [4.900000095367432, '4,9']]
    for (const [v, text] of cases) assert.equal(rateLabel(v), text, String(v))
  })
})

describe('after a save: the rate Supabase stored against the one sent (decision D4)', () => {
  const ROUNDED = 'Regel gespeichert, aber mit 5 % statt 4,9 % USt — Supabase rundet den Satz (Spalte vendors.tax_percent). Satz prüfen, bevor die Regel bucht.'
  test('stored as sent: nothing to say — compared in hundredths, as bookamat books them', () => {
    const cases: [number, unknown][] = [[4.9, 4.9], [4.9, '4.90'], [20, 20], [13, 13], [0, 0], [19, 19], [4.9, 4.900000001]]
    for (const [sent, stored] of cases) assert.equal(storedRateNote(sent, stored), null, `${sent} → ${stored}`)
  })
  test('a column without decimals rounds 4,9 to 5: said with both rates; the import names the rule', () => {
    assert.equal(storedRateNote(4.9, 5), ROUNDED)
    assert.equal(storedRateNote(4.9, '5'), ROUNDED)
    assert.equal(storedRateNote(5.5, 6), 'Regel gespeichert, aber mit 6 % statt 5,5 % USt — Supabase rundet den Satz (Spalte vendors.tax_percent). Satz prüfen, bevor die Regel bucht.')
    assert.equal(storedRateNote(4.9, 5, 'Netzcom'), 'Regel „Netzcom“ gespeichert, aber mit 5 % statt 4,9 % USt — Supabase rundet den Satz (Spalte vendors.tax_percent). Satz prüfen, bevor die Regel bucht.')
    assert.equal(storedRateNote(4.9, 5, ''), ROUNDED)
  })
  test('an answer without a rate is not compared — never read as 0 %', () => {
    for (const stored of [undefined, null, '', ' ', 'x']) assert.equal(storedRateNote(4.9, stored), null, String(stored))
  })
  test('a refused save names the rate it carried: an integer column refuses 4,9', () => {
    assert.equal(ruleNotSavedText(4.9, 'invalid input syntax for type integer: "4.9"'),
      'Regel mit 4,9 % USt nicht gespeichert — invalid input syntax for type integer: "4.9"')
    assert.equal(ruleNotSavedText(20, 'Fehler 500'), 'Regel mit 20 % USt nicht gespeichert — Fehler 500')
  })
})

describe('a rule’s rate on its rows: booked as offered, „4.90“ for 4,9 %', () => {
  // The 2026 tax accounts with the rates bookamat lists for them (`tax_values`), as
  // booking-validation.test.ts has them; „Lizenzgebühren“ links all three
  const pt = (id: number, name: string, ...tax_values: string[]): BookamatAccount => ({ id, name, group: '2', tax_values })
  const VST_INLAND = pt(6589, 'Vorsteuer Inland', '20.00', '10.00', '13.00', '4.90')
  const IG_ERWERB_LEIST = pt(6594, 'IG Erwerb von Leistungen', '20.00', '10.00', '13.00')
  const KEINE_VST = pt(6601, 'Keine Vorsteuer', '0.00')
  const TAX = [VST_INLAND, IG_ERWERB_LEIST, KEINE_VST]
  const LISTS: ValidationLists = {
    cost_accounts: [{ id: 28213, name: 'Lizenzgebühren', purchasetaxaccounts: TAX.map(({ id, name }) => ({ id, name })) }],
    purchasetax_accounts: TAX,
    bank_accounts: [{ id: 3224, name: 'Geschäftskonto - Easybank' }],
  }
  const ctx = payloadContext(LISTS)
  const tx = { date: '2026-07-03', counterparty: 'NETZCOM\\WIEN', amount: 10.49, type: 'expense', currency: 'EUR', reference: '', raw: {} }
  // A rule as the editor saves it
  const rule = (patch: Partial<Vendor>): Vendor => ({
    id: 'rule-1', name: 'Netzcom', match_strings: ['NETZCOM'], email_sender: '', email_body_keywords: [],
    cost_account_id: 28213, purchasetax_account_id: VST_INLAND.id, bank_account_id: 3224,
    tax_percent: 20, deductibility_tax_percent: 100, deductibility_amount_percent: 100, country: '', vatin: '',
    title_template: '{vendor} – {month}', category: 'Software', active: true, amount_min: null, amount_max: null,
    invoice_address_match: '', notes_template: '', skip_invoice_search: false, ...patch,
  })
  const row = (v: Vendor) => ({
    transaction: tx, vendor: v, title: 'Netzcom – Juli 2026', status: 'ready', extracted_invoice_date: '2026-07-01',
  }) as unknown as MatchedTransaction
  // What the rule's row books, and what the check before booking says
  const booked = (v: Vendor): [string, string[]] => {
    const p = buildExpenseBookingPayload(row(v), {}, ctx)
    assert.equal(p.amounts.length, 1)
    return [p.amounts[0].tax_percent, validatePayload(p, 'expense', LISTS).map(x => x.message)]
  }

  test('every rate the editor offers: the row shows it, the payload books it, „Vorsteuer Inland“ takes it (0 % on „Keine Vorsteuer“)', () => {
    assert.deepEqual(RULE_VAT_RATES.map(r => resolveExpenseDefaults(row(rule({ tax_percent: r })), {}).taxPercent), [...RULE_VAT_RATES])
    assert.deepEqual(RULE_VAT_RATES.map(r => booked(rule({ tax_percent: r, purchasetax_account_id: r === 0 ? KEINE_VST.id : VST_INLAND.id }))), [
      ['20.00', []], ['13.00', []], ['10.00', []], ['4.90', []], ['0.00', []],
    ])
  })
  test('„IG Erwerb von Leistungen“ takes 20, 13 and 10 %: a rule at 4,9 % on it is refused, naming them', () => {
    const ig = (r: number) => booked(rule({ tax_percent: r, purchasetax_account_id: IG_ERWERB_LEIST.id, country: 'DE', vatin: 'DE123456789' }))
    assert.deepEqual(RULE_VAT_RATES.filter(r => r > 0).map(ig), [
      ['20.00', []], ['13.00', []], ['10.00', []],
      ['4.90', ['„IG Erwerb von Leistungen“ wird mit 20, 13 oder 10 % gebucht, nicht mit 4,9 % — USt-Satz ändern oder ein anderes Vorsteuerkonto wählen']],
    ])
  })
})

describe('client-safe (the rule editor runs it in the browser)', () => {
  test('lib/rule-vat.ts imports only lib/vat-origin.ts and reads no env variable', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'rule-vat.ts'), 'utf8')
    assert.deepEqual(Array.from(src.matchAll(/^import\b.*$/gm)).map(m => m[0]), ["import { AT_VAT_RATES } from './vat-origin'"])
    assert.doesNotMatch(src, /process\.env|\brequire\(/)
  })
})
