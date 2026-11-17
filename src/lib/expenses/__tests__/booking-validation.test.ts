import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockingProblems, bookingYearProblem, ruleBlockText, ruleProblems, validatePayload, type ValidationLists } from '../booking-validation'
import type { PayDay } from '../booking-dates'
import { buildExpenseBookingPayload, buildIncomeBookingPayload, payloadContext } from '../booking-payload'
import { lineDefaults, resolveExpenseDefaults, resolveIncomeDefaults } from '../row-defaults'
import { locksOf } from '../account-locks'
import { isSalesTaxAccount, taxAccountSide } from '../tax-accounts'
import { OWN_VATIN } from '../vatin'
import type { AiIncomeSuggestion, AiSuggestion, BookamatAccount, BookingPayload, MatchedIncomeTransaction, MatchedTransaction } from '@/lib/expenses/types'

// bookamat's lists as the 2026 books have them (GET /preferences/…, checked live)
const pt = (id: number, name: string, group: '1' | '2'): BookamatAccount => ({ id, name, group })
const TAX = {
  ustInland: pt(6588, 'Umsatzsteuer Inland', '1'),
  vstInland: pt(6589, 'Vorsteuer Inland', '2'),
  igLeistungen: pt(6592, 'IG Leistungen', '1'),
  igErwerbLeist: pt(6594, 'IG Erwerb von Leistungen', '2'),
  drittlandLeist: pt(6596, 'Drittland Leistungen', '1'),
  drittlandErwerb: pt(6597, 'Drittland Erwerb von Leistungen', '2'),
  einfuhr: pt(6598, 'Einfuhr-UST (Zollbehörde)', '2'),
  keineUst: pt(6600, 'Keine Umsatzsteuer', '1'),
  keineVst: pt(6601, 'Keine Vorsteuer', '2'),
}
const links = (...a: BookamatAccount[]) => a.map(({ id, name }) => ({ id, name }))
const cost = (id: number, name: string, tax: string | null, amount: string | null, linked: BookamatAccount[]): BookamatAccount =>
  ({ id, name, deductibility_tax_percent: tax, deductibility_amount_percent: amount, purchasetaxaccounts: links(...linked) })
const COST = {
  lizenz: cost(28213, 'Lizenzgebühren', null, null, [TAX.vstInland, TAX.igErwerbLeist, TAX.drittlandErwerb, TAX.keineVst]),
  internet: cost(28209, 'Internet', null, null, [TAX.vstInland, TAX.keineVst]),
  bewirtung: cost(28215, 'Bewirtungskosten', null, null, [TAX.vstInland, TAX.keineVst]),
  svs: cost(28184, 'Sozialversicherung', '0.00', '100.00', [TAX.keineVst]),
  eust: cost(28188, 'Einfuhrumsatzsteuer', null, '0.00', [TAX.einfuhr]),
  gwg: cost(28230, 'GWG (Abschreibung)', null, '0.00', [TAX.vstInland, TAX.keineVst]),
  privat: cost(28234, 'Privatentnahmen', '0.00', '0.00', [TAX.keineVst]),
  bankspesen: cost(28194, 'Bankspesen', null, null, [TAX.keineVst]),
}
const REV = {
  einnahmen: cost(28180, 'Einnahmen', '100.00', '100.00', [TAX.ustInland, TAX.igLeistungen, TAX.drittlandLeist, TAX.keineUst]),
  privateinlagen: cost(28235, 'Privateinlagen', '0.00', '0.00', [TAX.keineUst]),
  sonstige: cost(28183, 'Sonstige Einnahmen', null, null, [TAX.ustInland, TAX.keineUst]),
}
const LISTS: ValidationLists = {
  cost_accounts: Object.values(COST),
  revenue_accounts: Object.values(REV),
  purchasetax_accounts: Object.values(TAX),
  bank_accounts: [{ id: 3219, name: 'Geschäftskonto - Musterbank' }, { id: 3224, name: 'Geschäftskonto - Easybank' }],
}
const ctx = payloadContext(LISTS)

const line = (patch: Partial<BookingPayload['amounts'][number]> = {}): BookingPayload['amounts'][number] => ({
  bankaccount: 3224, costaccount: 28213, purchasetaxaccount: 6589, amount: '21.60', tax_percent: '20.00',
  deductibility_tax_percent: '100.00', deductibility_amount_percent: '100.00', country_dep: '', country_rec: '', ...patch,
})
const payload = (patch: Partial<BookingPayload> = {}, amounts = [line()]): BookingPayload => ({
  title: 'Anthropic – Juli 2026', date: '2026-07-03', date_invoice: '2026-07-01', amounts, vatin: '', country: '', description: '', ...patch,
})
const messages = (p: BookingPayload, kind: 'expense' | 'income' = 'expense', opts = {}) =>
  validatePayload(p, kind, LISTS, opts).map(x => x.message)

describe('tax account sides (bookamat’s group)', () => {
  test('group 1 is the sales side, 2 the purchase side; the name decides only without a group', () => {
    assert.equal(taxAccountSide(TAX.drittlandLeist), 'sales')
    assert.equal(taxAccountSide(TAX.keineVst), 'purchase')
    assert.ok(isSalesTaxAccount({ id: 1, name: 'Drittland Leistungen' }))
    assert.ok(isSalesTaxAccount({ id: 1, name: 'Umsatzsteuer Inland' }))
    assert.ok(!isSalesTaxAccount({ id: 1, name: 'Drittland Erwerb von Leistungen' }))
    assert.ok(!isSalesTaxAccount({ id: 1, name: 'Keine Vorsteuer' }))
  })
  test('a free account is not locked at 0 (Number(null) is 0)', () => {
    assert.deepEqual(locksOf(COST.lizenz), { tax: null, amount: null })
    assert.deepEqual(locksOf(COST.svs), { tax: 0, amount: 100 })
    assert.deepEqual(locksOf(COST.eust), { tax: null, amount: 0 })
  })
})

describe('validatePayload — what bookamat would refuse (P1-2, P1-3)', () => {
  test('a clean expense has no problem', () => {
    assert.deepEqual(validatePayload(payload(), 'expense', LISTS), [])
  })
  test('Anthropic on „Drittland Leistungen“ (an outbound account) is blocked and says what to choose', () => {
    const out = validatePayload(payload({ country: 'US' }, [line({ purchasetaxaccount: 6596 })]), 'expense', LISTS)
    assert.equal(blockingProblems(out).length, 1)
    assert.match(out[0].message, /„Drittland Leistungen“ ist ein Konto für eigene Verkäufe/)
    assert.match(out[0].message, /„Drittland Erwerb von Leistungen“/)
    assert.match(out[0].message, /„Keine Vorsteuer“/)
  })
  test('„Umsatzsteuer Inland“ on an expense points to „Vorsteuer Inland“', () => {
    assert.match(messages(payload({}, [line({ purchasetaxaccount: 6588 })]))[0], /„Vorsteuer Inland“ wählen/)
  })
  test('VDT (DE, 0 %, no Vorsteuerkonto): blocked, with the two possible answers', () => {
    const m = messages(payload({ country: 'DE' }, [line({ purchasetaxaccount: undefined, tax_percent: '0.00' })]))
    assert.equal(m.length, 1)
    assert.match(m[0], /^Vorsteuerkonto fehlt — Reverse Charge/)
  })
  test('a domestic 0 % line without one is told to use „Keine Vorsteuer“', () => {
    assert.match(messages(payload({}, [line({ purchasetaxaccount: undefined, tax_percent: '0.00' })]))[0], /„Keine Vorsteuer“$/)
  })
  test('a Vorsteuerkonto the Steuerkonto does not allow is blocked, naming the allowed ones', () => {
    const m = messages(payload({ vatin: 'IE6388047V' }, [line({ costaccount: 28209, purchasetaxaccount: 6594 })]))
    assert.deepEqual(m, ['„IG Erwerb von Leistungen“ ist mit dem Steuerkonto „Internet“ nicht erlaubt — erlaubt: Vorsteuer Inland, Keine Vorsteuer'])
  })
  test('IG Erwerb needs the supplier’s UID; Drittland Erwerb does not', () => {
    assert.match(messages(payload({ country: 'IE' }, [line({ purchasetaxaccount: 6594 })]))[0], /braucht die UID des Lieferanten/)
    assert.deepEqual(messages(payload({ country: 'US' }, [line({ purchasetaxaccount: 6597 })])), [])
  })
  test('a BA value other than the account’s lock is reported', () => {
    const m = messages(payload({}, [line({ costaccount: 28184, purchasetaxaccount: 6601, tax_percent: '0.00' })]))
    assert.deepEqual(m, ['BA USt: „Sozialversicherung“ gibt 0 % vor (gesendet 100 %)'])
  })
  test('an Ertragskonto on an expense, an unknown account, missing fields', () => {
    assert.match(messages(payload({}, [line({ costaccount: 28180 })]))[0], /„Einnahmen“ ist ein Ertragskonto/)
    assert.match(messages(payload({}, [line({ costaccount: 99999 })]))[0], /Steuerkonto #99999 gibt es in bookamat nicht/)
    assert.deepEqual(messages(payload({ title: ' ' }, [line({ bankaccount: 0, costaccount: 0 })])),
      ['Buchungstitel fehlt', 'Zahlungsmittelkonto fehlt', 'Steuerkonto fehlt'])
  })
  test('a split that does not add up to the debit is blocked', () => {
    const p = payload({}, [line({ amount: '289.00' }), line({ amount: '50.00' })])
    assert.match(messages(p, 'expense', { expectedTotal: 346.8 }).join('\n'), /ergeben 339,00 €, abgebucht wurden 346,80 €/)
    assert.deepEqual(messages(p, 'expense', { expectedTotal: 339.01 }), [])
  })
  test('the same problem on every line is said once; one line’s is numbered', () => {
    const none = [line({ purchasetaxaccount: undefined }), line({ purchasetaxaccount: undefined })]
    assert.deepEqual(messages(payload({}, none)), ['Vorsteuerkonto fehlt'])
    const one = [line(), line({ costaccount: 28194, purchasetaxaccount: 6589, tax_percent: '0.00' })]
    assert.deepEqual(messages(payload({}, one)), ['Zeile 2: „Vorsteuer Inland“ ist mit dem Steuerkonto „Bankspesen“ nicht erlaubt — erlaubt: Keine Vorsteuer'])
  })
  test('a Buchungsdatum outside the books’ year is blocked', () => {
    assert.match(messages(payload({ date: '2027-01-02' }), 'expense', { year: 2026 })[0], /02\.01\.2027 liegt nicht im Buchungsjahr 2026/)
  })
  test('a missing Rechnungsdatum on a reverse-charge account is shown but does not block', () => {
    const out = validatePayload(payload({ date_invoice: null, country: 'US' }, [line({ purchasetaxaccount: 6597 })]), 'expense', LISTS)
    assert.equal(out.length, 1)
    assert.equal(out[0].blocking, false)
  })
  test('without account lists only the required fields are checked', () => {
    assert.deepEqual(validatePayload(payload({}, [line({ costaccount: 99999, purchasetaxaccount: 6596 })]), 'expense', null), [])
    assert.deepEqual(validatePayload(payload({}, [line({ costaccount: 0 })]), 'expense', {}).map(x => x.message), ['Steuerkonto fehlt'])
  })
  test('income: a Vorsteuerkonto, a missing UID on IG Leistungen, the lock', () => {
    const inc = (patch: Partial<BookingPayload['amounts'][number]>, p: Partial<BookingPayload> = {}) =>
      payload(p, [line({ costaccount: 28180, purchasetaxaccount: 6588, ...patch })])
    assert.deepEqual(messages(inc({}), 'income'), [])
    assert.match(messages(inc({ purchasetaxaccount: 6589 }), 'income')[0], /ist ein Vorsteuerkonto, nicht für eine Einnahme — „Umsatzsteuer Inland“ wählen/)
    assert.match(messages(inc({ purchasetaxaccount: 6592, tax_percent: '0.00' }, { country: 'DE' }), 'income')[0], /braucht die UID des Kunden/)
    assert.match(messages(inc({ costaccount: 28235, purchasetaxaccount: 6600, tax_percent: '0.00' }), 'income').join('\n'), /„Privateinlagen“ gibt 0 % vor/)
    assert.match(messages(inc({ costaccount: 28213 }), 'income')[0], /„Lizenzgebühren“ ist ein Aufwandskonto/)
  })
})

describe('validatePayload — the USt-Satz must fit the tax account', () => {
  test('a Munich dinner: 19 % on „Vorsteuer Inland“ is foreign VAT, not deductible', () => {
    assert.match(messages(payload({ country: 'DE' }, [line({ costaccount: 28215, tax_percent: '19.00' })]))[0], /^19 % ist kein österreichischer Steuersatz — .*„Keine Vorsteuer“ buchen$/)
  })
  test('„Keine Vorsteuer“ is 0 %, „Vorsteuer Inland“ is never 0 %', () => {
    assert.match(messages(payload({}, [line({ purchasetaxaccount: 6601, tax_percent: '20.00' })]))[0], /„Keine Vorsteuer“ wird mit 0 % gebucht/)
    assert.match(messages(payload({}, [line({ tax_percent: '0.00' })]))[0], /„Vorsteuer Inland“ mit 0 % — bei 0 % USt „Keine Vorsteuer“/)
  })
  test('Austrian rates pass: 20, 13, 10; reverse charge at 20; income abroad at 0', () => {
    for (const r of ['20.00', '13.00', '10.00']) assert.deepEqual(messages(payload({}, [line({ tax_percent: r })])), [], r)
    assert.deepEqual(messages(payload({ country: 'US' }, [line({ purchasetaxaccount: 6597 })])), [])
    assert.match(messages(payload({ country: 'US' }, [line({ purchasetaxaccount: 6597, tax_percent: '0.00' })]))[0], /Reverse Charge wird mit dem österreichischen Satz gebucht/)
    const inc = (pt: number, rate: string) => messages(payload({ country: 'US' }, [line({ costaccount: 28180, purchasetaxaccount: pt, tax_percent: rate })]), 'income')
    assert.deepEqual(inc(6596, '0.00'), [])
    assert.match(inc(6596, '20.00')[0], /„Drittland Leistungen“ wird mit 0 % gebucht/)
  })
  test('a foreign 0 % credit without a USt-Konto is pointed to IG/Drittland Leistungen, not „Keine Umsatzsteuer“', () => {
    const m = messages(payload({ country: 'DE', vatin: 'DE123456789' }, [line({ costaccount: 28180, purchasetaxaccount: undefined, tax_percent: '0.00' })]), 'income')
    assert.match(m[0], /„IG Leistungen“ .*„Drittland Leistungen“$/)
  })
  test('the out-of-year message never suggests moving the date', () => {
    assert.match(messages(payload({ date: '2026-12-30' }), 'expense', { year: 2027 })[0], /— direkt in bookamat im Jahr 2026 buchen$/)
  })
})

describe('the year by direction and by the day of payment (PR 4b)', () => {
  // A card payment of 30.12.2026 / a transfer valued 31.12.2026, posted on 04.01.2027
  const card = (payDate = '2026-12-30', bankDate = '2027-01-04'): PayDay => ({ bankDate, payDate, source: 'card', card: true, stampUnreadable: false })
  const valuta = (payDate = '2026-12-31', bankDate = '2027-01-04'): PayDay => ({ bankDate, payDate, source: 'valuta', card: false, stampUnreadable: false })
  const LATER = /erst nach der Umstellung auf 2027 hier buchen \(Einstellungen → Buchungsjahr\)$/

  test('an earlier year, generic: as before', () => {
    assert.deepEqual(bookingYearProblem('2026-12-30', { year: 2027 }),
      { blocking: true, message: 'Buchungsdatum 30.12.2026 liegt nicht im Buchungsjahr 2027 — direkt in bookamat im Jahr 2026 buchen' })
  })
  test('an earlier year names the card payment or the Valutadatum, and never the switch', () => {
    const c = bookingYearProblem('2026-12-30', { year: 2027, pay: card() })!
    assert.equal(c.message, 'Kartenzahlung vom 30.12.2026 (Bank 04.01.2027) liegt nicht im Buchungsjahr 2027 — direkt in bookamat im Jahr 2026 buchen')
    assert.doesNotMatch(c.message, /Umstellung|umstellen/)
    assert.equal(bookingYearProblem('2026-12-31', { year: 2027, pay: valuta() })?.message,
      'Zahlung vom 31.12.2026 (Valuta, Bank 04.01.2027) liegt nicht im Buchungsjahr 2027 — direkt in bookamat im Jahr 2026 buchen')
  })
  test('a later year waits for the switch, never „direkt in bookamat“', () => {
    const generic = bookingYearProblem('2027-01-05', { year: 2026 })!
    assert.equal(generic.message, 'Buchungsdatum 05.01.2027 liegt nicht im Buchungsjahr 2026 — erst nach der Umstellung auf 2027 hier buchen (Einstellungen → Buchungsjahr)')
    // A card payment of 01.01.2027 posted 04.01.: booked on the bank date (same month)
    const c = bookingYearProblem('2027-01-04', { year: 2026, pay: card('2027-01-01') })!
    assert.equal(c.message, 'Kartenzahlung vom 01.01.2027 (Bank 04.01.2027) liegt nicht im Buchungsjahr 2026 — erst nach der Umstellung auf 2027 hier buchen (Einstellungen → Buchungsjahr)')
    for (const m of [generic.message, c.message]) {
      assert.match(m, LATER)
      assert.doesNotMatch(m, /direkt in bookamat/)
    }
  })
  test('A2: a December payment typed onto its January bank date is refused, whatever year is set', () => {
    for (const year of [2026, 2027, undefined]) {
      assert.deepEqual(bookingYearProblem('2027-01-04', { year, pay: card() }), {
        blocking: true,
        message: 'Kartenzahlung vom 30.12.2026 gehört ins Jahr 2026 — Buchungsdatum 04.01.2027 liegt in 2027: Buchungsdatum auf 30.12.2026 setzen',
      }, String(year))
    }
    assert.equal(bookingYearProblem('2027-01-04', { year: 2026, pay: valuta() })?.message,
      'Zahlung vom 31.12.2026 (Valuta) gehört ins Jahr 2026 — Buchungsdatum 04.01.2027 liegt in 2027: Buchungsdatum auf 31.12.2026 setzen')
  })
  test('the other way is allowed: a January card payment moved to 31.12. (15 days)', () => {
    assert.equal(bookingYearProblem('2026-12-31', { year: 2026, pay: card('2027-01-01') }), null)
    assert.equal(bookingYearProblem('2026-12-31', { year: 2027, pay: card('2027-01-01') })?.message,
      'Buchungsdatum 31.12.2026 liegt nicht im Buchungsjahr 2027 — direkt in bookamat im Jahr 2026 buchen')
  })
  test('in the year: none; no year set: no year problem', () => {
    assert.equal(bookingYearProblem('2026-12-30', { year: 2026, pay: card() }), null)
    assert.equal(bookingYearProblem('2027-01-04', {}), null)
    assert.equal(bookingYearProblem('2026-12-31', { pay: valuta() }), null)
  })
  test('validatePayload checks the year by the day of payment', () => {
    const out = validatePayload(payload({ date: '2027-01-04' }), 'expense', LISTS, { year: 2026, pay: card() })
    assert.deepEqual(out, [{ line: undefined, blocking: true, message: 'Kartenzahlung vom 30.12.2026 gehört ins Jahr 2026 — Buchungsdatum 04.01.2027 liegt in 2027: Buchungsdatum auf 30.12.2026 setzen' }])
    assert.deepEqual(validatePayload(payload({ date: '2026-12-30' }), 'expense', LISTS, { year: 2026, pay: card() }), [])
  })
  test('an MC row with an unreadable stamp: exactly one line, not blocking (expenses only)', () => {
    const unreadable: PayDay = { bankDate: '2026-12-28', payDate: null, source: null, card: true, stampUnreadable: true }
    const out = validatePayload(payload({ date: '2026-12-28' }), 'expense', LISTS, { year: 2026, pay: unreadable })
    assert.equal(out.length, 1)
    assert.equal(out[0].blocking, false)
    assert.equal(out[0].message, 'Kartenzahlung ohne lesbares Kartendatum — Buchungsdatum prüfen: bezahlt ist am Tag der Kartenzahlung, nicht am Bankdatum')
    const credit = payload({ date: '2026-12-28' }, [line({ costaccount: 28180, purchasetaxaccount: 6588 })])
    assert.deepEqual(validatePayload(credit, 'income', LISTS, { year: 2026, pay: unreadable }), [])
  })
})

describe('an account id of another year (YEAR-2)', () => {
  // The 2027 books: the same names, every id another (here +100000)
  const shift = (a: BookamatAccount): BookamatAccount =>
    ({ ...a, id: a.id + 100000, ...(a.purchasetaxaccounts ? { purchasetaxaccounts: a.purchasetaxaccounts.map(shift) } : {}) })
  const LISTS_2027: ValidationLists = {
    cost_accounts: Object.values(COST).map(shift),
    revenue_accounts: Object.values(REV).map(shift),
    purchasetax_accounts: Object.values(TAX).map(shift),
    bank_accounts: LISTS.bank_accounts!.map(shift),
  }
  const jan = (amounts = [line()]) => payload({ date: '2027-01-05' }, amounts)
  const texts = (p: BookingPayload, kind: 'expense' | 'income', year?: number) =>
    validatePayload(p, kind, LISTS_2027, year ? { year } : {}).map(x => x.message)

  test('the ids of 2026 against the lists of 2027: each text names the year', () => {
    const out = validatePayload(jan(), 'expense', LISTS_2027, { year: 2027 })
    assert.deepEqual(out.map(x => x.message), [
      'Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen',
      'Steuerkonto #28213 gibt es in 2027 nicht — neu wählen',
      'Vorsteuerkonto #6589 gibt es in 2027 nicht — neu wählen',
    ])
    assert.ok(out.every(x => x.blocking))
  })
  test('income: the Ertragskonto and the Umsatzsteuerkonto the same way', () => {
    assert.deepEqual(texts(jan([line({ bankaccount: 103224, costaccount: 28180, purchasetaxaccount: 6588 })]), 'income', 2027), [
      'Ertragskonto #28180 gibt es in 2027 nicht — neu wählen',
      'Umsatzsteuerkonto #6588 gibt es in 2027 nicht — neu wählen',
    ])
  })
  test('no year known: „in bookamat“, as before', () => {
    assert.deepEqual(texts(jan(), 'expense'), [
      'Zahlungsmittelkonto #3224 gibt es in bookamat nicht — neu wählen',
      'Steuerkonto #28213 gibt es in bookamat nicht — neu wählen',
      'Vorsteuerkonto #6589 gibt es in bookamat nicht — neu wählen',
    ])
  })
  test('ruleBlockText: a Buchungsregel’s row names the rule; any other block stays as it is', () => {
    const block = blockingProblems(validatePayload(jan([line({ bankaccount: 103224 })]), 'expense', LISTS_2027, { year: 2027 }))[0].message
    assert.equal(ruleBlockText(block, 'Google Cloud'),
      'Steuerkonto #28213 gibt es in 2027 nicht — neu wählen — Buchungsregel „Google Cloud“ unter Buchungsregeln neu wählen')
    assert.equal(ruleBlockText('Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen', 'Magenta'),
      'Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen — Buchungsregel „Magenta“ unter Buchungsregeln neu wählen')
    // not a rule row, another block, no year in the text, nothing blocked
    assert.equal(ruleBlockText(block, undefined), block)
    assert.equal(ruleBlockText(block, null), block)
    assert.equal(ruleBlockText('Vorsteuerkonto fehlt', 'Google Cloud'), 'Vorsteuerkonto fehlt')
    assert.equal(ruleBlockText('Steuerkonto #28213 gibt es in bookamat nicht — neu wählen', 'Google Cloud'), 'Steuerkonto #28213 gibt es in bookamat nicht — neu wählen')
    assert.equal(ruleBlockText(null, 'Google Cloud'), null)
  })
  test('ruleBlockText: a rate that is no Austrian one, booked as the Buchungsregel sets it, says to check the rule’s rate — not to book the Vorsteuer away (review RULES-3)', () => {
    const block = '5 % ist kein österreichischer Steuersatz — ausländische USt ist hier nicht abziehbar: mit 0 % auf „Keine Vorsteuer“ buchen'
    const text = ruleBlockText(block, 'Muster Markt')
    assert.equal(text, '5 % ist kein österreichischer Steuersatz (20, 13, 10 oder 4,9 %) — USt-Satz der Buchungsregel „Muster Markt“ unter Buchungsregeln prüfen')
    assert.doesNotMatch(text ?? '', /Keine Vorsteuer/)
    // as the validation writes it for the rule's rate
    const real = blockingProblems(validatePayload(payload({}, [line({ tax_percent: '5.00' })]), 'expense', LISTS))[0].message
    assert.equal(real, block)
    // not a rule row, or the row books a rate of its own (typed, a split's lines): as it is
    assert.equal(ruleBlockText(block, null), block)
    assert.equal(ruleBlockText(block, 'Muster Markt', false), block)
    // an account of another year: the rule named whatever rate the row books
    assert.equal(ruleBlockText('Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen', 'Magenta', false),
      'Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen — Buchungsregel „Magenta“ unter Buchungsregeln neu wählen')
  })
  test('ruleProblems: the problems a Buchungsregel’s row lists say what its block says — never to book the Vorsteuer away at the rule’s rate (review check RULES-3)', () => {
    const problems = validatePayload(payload({}, [line({ tax_percent: '5.00' })]), 'expense', LISTS)
    const listed = ruleProblems(problems, 'Muster Markt')
    assert.equal(listed.length, problems.length)
    assert.equal(blockingProblems(listed)[0].message, ruleBlockText(blockingProblems(problems)[0].message, 'Muster Markt'))
    assert.ok(listed.every(p => !p.blocking || !/Keine Vorsteuer/.test(p.message)), JSON.stringify(listed))
    // the warnings, a row of no rule, a rate of the row's own: as they are
    assert.deepEqual(listed.filter(p => !p.blocking), problems.filter(p => !p.blocking))
    assert.equal(ruleProblems(problems, null), problems)
    assert.deepEqual(ruleProblems(problems, 'Muster Markt', false), problems)
  })
})

describe('locks applied up front (the row shows what bookamat books)', () => {
  const ai = (patch: Partial<AiSuggestion> = {}) => ({
    cost_account_id: 28184, purchasetax_account_id: 6601, bank_account_id: 3224, tax_percent: 0,
    deductibility_amount_percent: 100, vatin: '', country: '', category: 'Versicherung', ...patch,
  }) as AiSuggestion
  test('SVS books 0 / 100 whatever the AI or the owner says', () => {
    const d = resolveExpenseDefaults({ vendor: null, ai_suggested: ai() }, { deductibility_tax_percent: '100' }, ctx.costAccountName, 3224, ctx.costAccount)
    assert.deepEqual([d.deductTaxPercent, d.deductAmountPercent, d.locks], [0, 100, { tax: 0, amount: 100 }])
  })
  test('an asset account locks BA Betrag at 0, and the Vorsteuer stays deductible', () => {
    const d = resolveExpenseDefaults({ vendor: null, ai_suggested: ai({ cost_account_id: 28230, tax_percent: 20, purchasetax_account_id: 6589 }) }, {}, ctx.costAccountName, 3224, ctx.costAccount)
    assert.deepEqual([d.deductAmountPercent, d.deductTaxPercent], [0, 100])
  })
  test('a free account keeps the decided values', () => {
    const d = resolveExpenseDefaults({ vendor: null, ai_suggested: ai({ cost_account_id: 28209, deductibility_amount_percent: 60 }) }, {}, ctx.costAccountName, 3224, ctx.costAccount)
    assert.deepEqual([d.deductAmountPercent, d.deductTaxPercent, d.locks], [60, 60, { tax: null, amount: null }])
  })
  test('a split line on a locked account books the lock over its own values', () => {
    const ld = lineDefaults({ cost_account_id: 28234, deductibility_amount_percent: 100, deductibility_tax_percent: 100 },
      { costAccountId: 28209, deductTaxPercent: 100 }, ctx.costAccountName, ctx.costAccount)
    assert.deepEqual([ld.deductAmountPercent, ld.deductTaxPercent], [0, 0])
  })
  test('income: Privateinlagen books 0 / 0, Einnahmen 100 / 100, a free account 100 / 100', () => {
    const s = (revenue_account_id: number) => ({ ai_suggested: { revenue_account_id, vat_account_id: 6600, vat_percent: 0 } as AiIncomeSuggestion })
    const d = (id: number) => resolveIncomeDefaults(s(id), {}, 3224, ctx.revenueAccount)
    assert.deepEqual([d(28235).deductTaxPercent, d(28235).deductAmountPercent], [0, 0])
    assert.deepEqual([d(28180).deductTaxPercent, d(28183).deductAmountPercent], [100, 100])
  })
})

describe('one payload builder (the route and the page send the same)', () => {
  const tx = { date: '2026-07-02', counterparty: 'RESTAURANT X', amount: 346.8, type: 'expense', currency: 'EUR', reference: '', raw: {} }
  const row = (patch: Partial<MatchedTransaction> = {}) => ({
    transaction: tx, vendor: null, title: 'Restaurant X', status: 'needs_review',
    ai_suggested: { cost_account_id: 28215, purchasetax_account_id: 6589, bank_account_id: 3219, tax_percent: 20,
      deductibility_amount_percent: 50, vatin: '', country: '', category: 'Bewirtung' } as AiSuggestion,
    ...patch,
  }) as MatchedTransaction

  test('context from the lists: CSV bank, zero-rate accounts, lookups', () => {
    assert.deepEqual([ctx.csvBankId, ctx.keineVorsteuerId, ctx.keineUmsatzsteuerId, ctx.costAccountName?.(28215)], [3224, 6601, 6600, 'Bewirtungskosten'])
  })
  test('the expense Buchungsdatum the owner set is booked (P2-1)', () => {
    assert.equal(buildExpenseBookingPayload(row(), { date: '2026-06-30' }, ctx).date, '2026-06-30')
    assert.equal(buildExpenseBookingPayload(row(), {}, ctx).date, '2026-07-02')
  })
  test('a restaurant split: one line per rate, Trinkgeld on „Keine Vorsteuer“, Bewirtung 50 / 100', () => {
    const p = buildExpenseBookingPayload(row({ booking_lines: [
      { label: 'Speisen', amount_gross: 220, vat_percent: 10, deductibility_amount_percent: 50, deductibility_tax_percent: 100 },
      { label: 'Getränke', amount_gross: 110, vat_percent: 20, deductibility_amount_percent: 50, deductibility_tax_percent: 100 },
      { label: 'Trinkgeld', amount_gross: 16.8, vat_percent: 0, deductibility_amount_percent: 50, deductibility_tax_percent: 100 },
    ] }), {}, ctx)
    assert.deepEqual(p.amounts.map(a => [a.costaccount, a.purchasetaxaccount, a.amount, a.tax_percent, a.deductibility_amount_percent, a.deductibility_tax_percent, a.bankaccount]), [
      [28215, 6589, '220.00', '10.00', '50.00', '100.00', 3224],
      [28215, 6589, '110.00', '20.00', '50.00', '100.00', 3224],
      [28215, 6601, '16.80', '0.00', '50.00', '100.00', 3224],
    ])
    assert.deepEqual(validatePayload(p, 'expense', LISTS, { expectedTotal: tx.amount }), [])
  })
  test('a hand split whose lines all carry a Steuerkonto is a complete booking (item j)', () => {
    const p = buildExpenseBookingPayload(row({ ai_suggested: undefined, booking_lines: [
      { label: 'Lizenz', amount_gross: 300, vat_percent: 20, cost_account_id: 28213, purchasetax_account_id: 6589 },
      { label: 'Spesen', amount_gross: 46.8, vat_percent: 0, cost_account_id: 28194 },
    ] }), {}, ctx)
    assert.deepEqual(p.amounts.map(a => [a.costaccount, a.purchasetaxaccount]), [[28213, 6589], [28194, 6601]])
    assert.deepEqual(validatePayload(p, 'expense', LISTS, { expectedTotal: tx.amount }), [])
  })
  test('review: a 0 % split line on a reverse-charge row keeps the row’s account and is reported', () => {
    const tx2 = { ...tx, type: 'expense' as const, amount: 101.5, fee: 1.5, net_amount: 100 }
    const rc = row({ transaction: tx2, ai_suggested: { cost_account_id: 28213, purchasetax_account_id: 6597, tax_percent: 20, deductibility_amount_percent: 100, vatin: '', country: 'US' } as AiSuggestion,
      booking_lines: [
        { label: 'Ware / Leistung', amount_gross: 100, vat_percent: 0 },
        { label: 'Bankspesen', amount_gross: 1.5, vat_percent: 0, purchasetax_account_id: 6601 },
      ] })
    const p = buildExpenseBookingPayload(rc, {}, ctx)
    assert.deepEqual(p.amounts.map(a => a.purchasetaxaccount), [6597, 6601])
    assert.match(blockingProblems(validatePayload(p, 'expense', LISTS, { expectedTotal: 101.5 }))[0].message, /Reverse Charge wird mit dem österreichischen Satz gebucht/)
  })
  test('a single 0 % line gets „Keine Vorsteuer“ when domestic, none when foreign (then the row says so)', () => {
    const svs = row({ ai_suggested: { cost_account_id: 28184, purchasetax_account_id: 0, tax_percent: 0, deductibility_amount_percent: 100, vatin: '', country: '' } as AiSuggestion })
    const p = buildExpenseBookingPayload(svs, {}, ctx)
    assert.deepEqual([p.amounts[0].purchasetaxaccount, p.amounts[0].deductibility_tax_percent, p.amounts[0].deductibility_amount_percent], [6601, '0.00', '100.00'])
    const vdt = buildExpenseBookingPayload(row({ ai_suggested: { cost_account_id: 28213, purchasetax_account_id: 0, tax_percent: 0, deductibility_amount_percent: 100, vatin: '', country: 'DE' } as AiSuggestion }), {}, ctx)
    assert.equal(vdt.amounts[0].purchasetaxaccount, undefined)
    assert.match(blockingProblems(validatePayload(vdt, 'expense', LISTS))[0].message, /^Vorsteuerkonto fehlt/)
  })
  test('income: Privateinlage books 0 / 0 on „Keine Umsatzsteuer“', () => {
    const m = {
      transaction: { ...tx, type: 'income', amount: 500 }, title: 'Privateinlage 07/2026',
      ai_suggested: { revenue_account_id: 28235, vat_account_id: 0, bank_account_id: 3224, vat_percent: 0, vatin: '', country: '' },
    } as unknown as MatchedIncomeTransaction
    const p = buildIncomeBookingPayload(m, {}, ctx)
    assert.deepEqual([p.amounts[0].purchasetaxaccount, p.amounts[0].deductibility_tax_percent, p.amounts[0].deductibility_amount_percent], [6600, '0.00', '0.00'])
    assert.deepEqual(validatePayload(p, 'income', LISTS), [])
  })
})

// The same books with each tax account's rates, as bookamat 2026 lists them (`tax_values`,
// GET /preferences/purchasetaxaccounts/, read 12.11.2026): „Vorsteuer Inland“ and „IG
// Erwerb von Lieferungen“ 20, 10, 13, 4,9 — „IG/Drittland Erwerb von Leistungen“ 20, 10,
// 13 — „Keine Vorsteuer“ 0 — „Vorsteuer Rückforderung EU“ "" (any rate). „Umsatzsteuer
// Inland“ / „Keine Umsatzsteuer“ are modelled on their purchase-side twins. „Büromaterial“
// (made-up id) links the goods side.
const withRates = (a: BookamatAccount, ...tax_values: string[]): BookamatAccount => ({ ...a, tax_values })
const AT_2026 = ['20.00', '10.00', '13.00', '4.90']
const IG_ERWERB_LIEF = pt(6593, 'IG Erwerb von Lieferungen', '2')
const RUECK_EU = pt(6603, 'Vorsteuer Rückforderung EU', '2')
const TAX_RATES = {
  ...TAX,
  ustInland: withRates(TAX.ustInland, ...AT_2026),
  vstInland: withRates(TAX.vstInland, ...AT_2026),
  igErwerbLief: withRates(IG_ERWERB_LIEF, ...AT_2026),
  igErwerbLeist: withRates(TAX.igErwerbLeist, '20.00', '10.00', '13.00'),
  drittlandErwerb: withRates(TAX.drittlandErwerb, '20.00', '10.00', '13.00'),
  keineUst: withRates(TAX.keineUst, '0.00'),
  keineVst: withRates(TAX.keineVst, '0.00'),
  rueckEu: withRates(RUECK_EU, ''),
}
const BUERO = cost(28290, 'Büromaterial', null, null, [TAX.vstInland, IG_ERWERB_LIEF, TAX.keineVst, RUECK_EU])
const LISTS_RATES: ValidationLists = {
  ...LISTS,
  cost_accounts: [...Object.values(COST), BUERO],
  purchasetax_accounts: Object.values(TAX_RATES),
}
const withLists = (lists: ValidationLists) => (p: BookingPayload, kind: 'expense' | 'income' = 'expense') =>
  validatePayload(p, kind, lists).map(x => x.message)
const ratesMessages = withLists(LISTS_RATES)
// Both ways: bookamat's list, and a list read without it (today's rules)
const BOTH: [string, (p: BookingPayload, kind?: 'expense' | 'income') => string[]][] = [['tax_values', ratesMessages], ['no tax_values', messages]]

describe('the USt-Satz by the rates bookamat lists for each tax account (H1)', () => {
  test('4,9 % is Austrian (since 1.7.2026): accepted on „Vorsteuer Inland“, with bookamat’s list and without one', () => {
    for (const [how, check] of BOTH) {
      for (const r of ['20.00', '13.00', '10.00', '4.90', '4.9']) assert.deepEqual(check(payload({}, [line({ tax_percent: r })])), [], `${how} ${r}`)
      // A supermarket receipt: basic foods at 4,9 %, the rest at 20 %
      assert.deepEqual(check(payload({}, [line({ amount: '10.49', tax_percent: '4.90' }), line({ amount: '6.00', tax_percent: '20.00' })])), [], how)
    }
  })
  test('income: 4,9 % on „Umsatzsteuer Inland“ passes; a foreign rate names Austria’s four rates', () => {
    for (const [how, check] of BOTH) {
      const inc = (rate: string) => check(payload({}, [line({ costaccount: 28180, purchasetaxaccount: 6588, tax_percent: rate })]), 'income')
      assert.deepEqual(inc('4.90'), [], how)
      assert.deepEqual(inc('19.00'), ['19 % ist kein österreichischer Steuersatz (20, 13, 10 oder 4,9 %)'], how)
    }
  })
  test('a rate the account does not take is refused, saying the ones it takes: 4,9 % on „IG Erwerb von Leistungen“', () => {
    const p = payload({ country: 'IE', vatin: 'IE6388047V' }, [line({ purchasetaxaccount: 6594, tax_percent: '4.90' })])
    const out = validatePayload(p, 'expense', LISTS_RATES)
    assert.deepEqual(out, [{ line: undefined, blocking: true,
      message: '„IG Erwerb von Leistungen“ wird mit 20, 13 oder 10 % gebucht, nicht mit 4,9 % — USt-Satz ändern oder ein anderes Vorsteuerkonto wählen' }])
    // Goods may be 4,9 %: bookamat takes it on „IG Erwerb von Lieferungen“
    assert.deepEqual(ratesMessages(payload({ country: 'DE', vatin: 'DE123456789' }, [line({ costaccount: 28290, purchasetaxaccount: 6593, tax_percent: '4.90' })])), [])
    // Without the list (an older cached one): today's rule, which knows Austria's rates only
    assert.deepEqual(messages(p), [])
  })
  test('where the reason is known, today’s text says it — with bookamat’s list as without', () => {
    const cases: [BookingPayload, RegExp][] = [
      // A Munich dinner: foreign VAT is no Vorsteuer
      [payload({ country: 'DE' }, [line({ costaccount: 28215, tax_percent: '19.00' })]), /^19 % ist kein österreichischer Steuersatz — ausländische USt ist hier nicht abziehbar: mit 0 % auf „Keine Vorsteuer“ buchen$/],
      [payload({}, [line({ tax_percent: '0.00' })]), /^„Vorsteuer Inland“ mit 0 % — bei 0 % USt „Keine Vorsteuer“ wählen$/],
      [payload({}, [line({ purchasetaxaccount: 6601, tax_percent: '20.00' })]), /^„Keine Vorsteuer“ wird mit 0 % gebucht — USt-Satz auf 0 % setzen oder ein Vorsteuerkonto wählen$/],
      [payload({ country: 'US' }, [line({ purchasetaxaccount: 6597, tax_percent: '0.00' })]), /^Reverse Charge wird mit dem österreichischen Satz gebucht \(meist 20 %\), nicht mit 0 %$/],
      [payload({ country: 'US' }, [line({ purchasetaxaccount: 6597, tax_percent: '19.00' })]), /^Reverse Charge wird mit dem österreichischen Satz gebucht \(meist 20 %\), nicht mit 19 %$/],
    ]
    for (const [p, text] of cases) {
      const withList = validatePayload(p, 'expense', LISTS_RATES)
      assert.equal(withList.length, 1, p.amounts[0].tax_percent)
      assert.equal(withList[0].blocking, true)
      assert.match(withList[0].message, text)
      assert.deepEqual(withList.map(x => x.message), messages(p))
    }
  })
  test('„Vorsteuer Rückforderung EU“ takes any rate ([""]): German 19 % reclaimed in Germany passes', () => {
    assert.deepEqual(ratesMessages(payload({ country: 'DE', vatin: 'DE123456789' }, [line({ costaccount: 28290, purchasetaxaccount: 6603, tax_percent: '19.00' })])), [])
  })
  test('a list that says nothing ([""] or none) falls back to today’s rules', () => {
    const blank = withLists({ ...LISTS, purchasetax_accounts: Object.values({ ...TAX, vstInland: withRates(TAX.vstInland, '') }) })
    assert.deepEqual(blank(payload({}, [line({ tax_percent: '4.90' })])), [])
    assert.match(blank(payload({ country: 'DE' }, [line({ tax_percent: '19.00' })]))[0], /^19 % ist kein österreichischer Steuersatz — ausländische USt/)
  })
  test('outside the list where no rule explains it: the account’s own rates', () => {
    // „Einfuhr-UST (Zollbehörde)“ with a made-up list (its real one was not read): no
    // rule of its own, so only bookamat's list can refuse a rate
    const eust = withLists({ ...LISTS, purchasetax_accounts: Object.values({ ...TAX, einfuhr: withRates(TAX.einfuhr, '20.00', '10.00', '13.00') }) })
    const p = (rate: string) => payload({ country: 'CN' }, [line({ costaccount: 28188, purchasetaxaccount: 6598, tax_percent: rate, deductibility_amount_percent: '0.00' })])
    assert.deepEqual(eust(p('19.00')), ['„Einfuhr-UST (Zollbehörde)“ wird mit 20, 13 oder 10 % gebucht, nicht mit 19 % — USt-Satz ändern oder ein anderes Vorsteuerkonto wählen'])
    assert.deepEqual(eust(p('20.00')), [])
    assert.deepEqual(messages(p('19.00')), [])
  })
})

describe('V1 — a foreign Herkunftsland on „Vorsteuer Inland“ (shown, not blocking)', () => {
  const V1 = (c: string) =>
    `Herkunftsland ${c} mit „Vorsteuer Inland“ — ausländische USt ist hier nicht abziehbar: „Keine Vorsteuer“ mit 0 % wählen. Verrechnet der Lieferant österreichische USt, seine UID (ATU…) eintragen.`
  test('DE + 20 % on „Vorsteuer Inland“, no UID: exactly one problem, not blocking', () => {
    assert.deepEqual(validatePayload(payload({ country: 'DE' }), 'expense', LISTS), [{ line: undefined, message: V1('DE'), blocking: false }])
  })
  test('with bookamat’s list the same, and 4,9 % is an Austrian rate under a foreign country', () => {
    for (const [how, check] of BOTH) {
      assert.deepEqual(check(payload({ country: 'DE' })), [V1('DE')], how)
      assert.deepEqual(check(payload({ country: 'DE' }, [line({ tax_percent: '4.90' })])), [V1('DE')], how)
    }
  })
  test('not with the supplier’s ATU number (Amazon EU S.à r.l., LU), not for „“ or AT', () => {
    for (const vatin of ['ATU73569248', 'atu 735 692 48']) assert.deepEqual(messages(payload({ country: 'LU', vatin })), [], vatin)
    for (const country of ['', 'AT', 'at', ' AT ']) assert.deepEqual(messages(payload({ country })), [], country)
  })
  test('not on „Keine Vorsteuer“ at 0 %, not for income', () => {
    assert.deepEqual(messages(payload({ country: 'DE' }, [line({ purchasetaxaccount: 6601, tax_percent: '0.00' })])), [])
    assert.deepEqual(messages(payload({ country: 'DE' }, [line({ costaccount: 28180, purchasetaxaccount: 6588 })]), 'income'), [])
  })
  test('not twice beside the 19 % block: the foreign rate is said once, and blocks', () => {
    const out = validatePayload(payload({ country: 'DE' }, [line({ costaccount: 28215, tax_percent: '19.00' })]), 'expense', LISTS)
    assert.equal(out.length, 1)
    assert.equal(out[0].blocking, true)
    assert.match(out[0].message, /^19 % ist kein österreichischer Steuersatz/)
  })
  test('a split: said once, without a line number; a line’s own problem keeps its number', () => {
    const lines = [line({ costaccount: 28215, amount: '22.00', tax_percent: '10.00' }), line({ costaccount: 28215, amount: '12.00', tax_percent: '20.00' })]
    assert.deepEqual(validatePayload(payload({ country: 'FR' }, lines), 'expense', LISTS), [{ line: undefined, message: V1('FR'), blocking: false }])
    const mixed = validatePayload(payload({ country: 'FR' }, [line({ costaccount: 28215, amount: '22.00', tax_percent: '5.50' }), lines[1]]), 'expense', LISTS)
    assert.deepEqual(mixed.map(x => [x.message, x.blocking]), [
      ['Zeile 1: 5,5 % ist kein österreichischer Steuersatz — ausländische USt ist hier nicht abziehbar: mit 0 % auf „Keine Vorsteuer“ buchen', true],
      [V1('FR'), false],
    ])
  })
  test('a half-typed ATU number, a foreign UID or the owner’s own UID is no Austrian supplier', () => {
    assert.deepEqual(messages(payload({ country: 'DE', vatin: 'ATU7' })), [V1('DE')])
    // A marketplace seller charging Austrian VAT under OSS (decisions M1)
    assert.deepEqual(messages(payload({ country: 'PL', vatin: 'PL1234567890' })), [V1('PL')])
    assert.deepEqual(messages(payload({ country: 'DE', vatin: OWN_VATIN })), [V1('DE')])
  })
  test('the country as bookamat books it: EL is Greece, UK is GB', () => {
    assert.deepEqual(messages(payload({ country: 'el' })), [V1('GR')])
    assert.deepEqual(messages(payload({ country: 'UK' })), [V1('GB')])
  })
  test('the receipt route’s shape: V1 is no blocking problem — the route books it', () => {
    // One Bewirtung line on the form's accounts, BA Betrag 50, the country sent, no Rechnungsdatum
    const p = payload({ country: 'DE', date_invoice: null }, [line({ costaccount: 28215, amount: '36.00', deductibility_amount_percent: '50.00' })])
    const out = validatePayload(p, 'expense', LISTS_RATES, { year: 2026 })
    assert.deepEqual(blockingProblems(out), [])
    assert.deepEqual(out.map(x => x.message), [V1('DE')])
  })
})

describe('V2 — reverse charge with an Austrian UID (blocking)', () => {
  const V2 = (account: string, uid: string) =>
    `„${account}“ mit der österreichischen UID ${uid} — ein österreichischer Lieferant ist kein Reverse Charge: weist der Beleg österreichische USt aus, „Vorsteuer Inland“ mit dem Satz vom Beleg wählen; sonst die ausländische UID des Lieferanten eintragen.`
  const OWN_TEXT = `${OWN_VATIN} ist deine eigene UID — die UID des Lieferanten (steht auf der Rechnung) eintragen.`
  test('an Amazon row from an old tab: IG Erwerb with the supplier’s ATU number is refused, once', () => {
    const p = payload({ country: 'LU', vatin: 'ATU73569248' }, [line({ costaccount: 28290, purchasetaxaccount: 6593, amount: '39.99' })])
    assert.deepEqual(validatePayload(p, 'expense', LISTS_RATES), [{ line: undefined, message: V2('IG Erwerb von Lieferungen', 'ATU73569248'), blocking: true }])
  })
  test('IG Erwerb von Leistungen and Drittland Erwerb alike; the UID is shown as booked, without spaces', () => {
    for (const [how, check] of BOTH) {
      assert.deepEqual(check(payload({ vatin: 'atu 735 692 48' }, [line({ purchasetaxaccount: 6594 })])), [V2('IG Erwerb von Leistungen', 'ATU73569248')], how)
      assert.deepEqual(check(payload({ country: 'US', vatin: 'ATU73569248' }, [line({ purchasetaxaccount: 6597 })])), [V2('Drittland Erwerb von Leistungen', 'ATU73569248')], how)
    }
  })
  test('the owner’s own UID, however written: its own text, blocking, instead of „braucht die UID“', () => {
    const spaced = `${OWN_VATIN.slice(0, 3)} ${OWN_VATIN.slice(3, 6)} ${OWN_VATIN.slice(6)}`
    for (const vatin of [OWN_VATIN, spaced]) {
      const out = validatePayload(payload({ country: 'IE', vatin }, [line({ purchasetaxaccount: 6594 })]), 'expense', LISTS)
      assert.deepEqual(out, [{ line: undefined, message: OWN_TEXT, blocking: true }], vatin)
    }
  })
  test('a split on reverse charge: said once', () => {
    const out = validatePayload(payload({ vatin: 'ATU73569248' }, [line({ purchasetaxaccount: 6594 }), line({ purchasetaxaccount: 6594, amount: '5.00' })]), 'expense', LISTS)
    assert.deepEqual(out, [{ line: undefined, message: V2('IG Erwerb von Leistungen', 'ATU73569248'), blocking: true }])
  })
  test('not with a foreign UID, not without reverse charge, not for income', () => {
    assert.deepEqual(messages(payload({ country: 'DE', vatin: 'DE123456789' }, [line({ purchasetaxaccount: 6594 })])), [])
    assert.deepEqual(messages(payload({ vatin: 'ATU73569248' })), [])                                                         // „Vorsteuer Inland“
    assert.deepEqual(messages(payload({ vatin: 'ATU73569248' }, [line({ purchasetaxaccount: 6601, tax_percent: '0.00' })])), []) // „Keine Vorsteuer“
    assert.deepEqual(messages(payload({ vatin: 'ATU73569248' }, [line({ costaccount: 28180, purchasetaxaccount: 6588 })]), 'income'), [])
  })
})

// lane D note 5: a value in the UID field that is no whole UID passed the missing-UID check
// (the field is not empty) and V2 (no Austrian UID can be read from it)
describe('a UID without its whole number counts as none on IG Erwerb (blocking)', () => {
  const NEEDS = (account: string) =>
    `„${account}“ braucht die UID des Lieferanten (steht auf der Rechnung) — UID eintragen oder ein anderes Vorsteuerkonto wählen`
  const PARTIAL = ['ATU', 'ATU7', 'DE', 'atu 735 692 4', 'de 1234', 'IE123', 'RO1', 'N/A']
  test('a bare prefix or a half-typed number: „braucht die UID des Lieferanten“, once — with bookamat’s lists and without', () => {
    for (const vatin of PARTIAL) {
      for (const [how, check] of BOTH) {
        assert.deepEqual(check(payload({ country: 'IE', vatin }, [line({ purchasetaxaccount: 6594 })])), [NEEDS('IG Erwerb von Leistungen')], `${how}: ${vatin}`)
      }
      const goods = validatePayload(payload({ country: 'DE', vatin }, [line({ costaccount: 28290, purchasetaxaccount: 6593 })]), 'expense', LISTS_RATES)
      assert.deepEqual(goods, [{ line: undefined, message: NEEDS('IG Erwerb von Lieferungen'), blocking: true }], vatin)
    }
  })
  test('an Austrian UID is ATU and exactly 8 digits: without the U or with a ninth digit it is none either', () => {
    for (const vatin of ['AT73569248', 'ATU735692481']) {
      assert.deepEqual(messages(payload({ vatin }, [line({ purchasetaxaccount: 6594 })])), [NEEDS('IG Erwerb von Leistungen')], vatin)
    }
  })
  test('the same text as an empty UID field, so the row says one thing', () => {
    const empty = messages(payload({ country: 'IE', vatin: '' }, [line({ purchasetaxaccount: 6594 })]))
    assert.deepEqual(messages(payload({ country: 'IE', vatin: 'ATU7' }, [line({ purchasetaxaccount: 6594 })])), empty)
  })
  test('a whole number passes as before: the EU states’ shapes, Northern Ireland (XI), Romania’s short numbers', () => {
    for (const vatin of ['IE6388047V', 'IE1234567T', 'DE123456789', 'de 123 456 789', 'DE-123.456.789', 'PL1234567890', 'IT12345678901',
      'FR12345678901', 'NL123456789B01', 'EL123456789', 'XI123456789', 'RO1234567', 'RO12']) {
      assert.deepEqual(ratesMessages(payload({ country: 'DE', vatin }, [line({ costaccount: 28290, purchasetaxaccount: 6593 })])), [], vatin)
    }
  })
  test('an Austrian or the owner’s own whole UID still gets V2’s text, never „braucht die UID“', () => {
    assert.match(messages(payload({ vatin: 'atu 735 692 48' }, [line({ purchasetaxaccount: 6594 })]))[0], /mit der österreichischen UID ATU73569248 — /)
    assert.match(messages(payload({ vatin: OWN_VATIN }, [line({ purchasetaxaccount: 6594 })]))[0], /ist deine eigene UID/)
  })
  test('only where a UID is needed: Drittland Erwerb and „Vorsteuer Inland“ say nothing about it', () => {
    for (const vatin of ['ATU7', 'DE']) {
      assert.deepEqual(messages(payload({ country: 'US', vatin }, [line({ purchasetaxaccount: 6597 })])), [], vatin)
      assert.deepEqual(messages(payload({ vatin })), [], vatin)
    }
  })
})

// Follow-up of PR „Vorsteuer“: on income only an empty UID was refused, so „DE“, the AI's
// „DE1234“, the owner's own UID, an Austrian one or a customer's outside the EU was booked
// as an IG Leistung — which goes to the ZM under the customer's UID.
describe('income on „IG Leistungen/Lieferungen“ needs the customer’s whole UID of another EU state', () => {
  const NEEDS = '„IG Leistungen“ braucht die UID des Kunden — UID eintragen oder ein anderes Umsatzsteuerkonto wählen'
  const OWN_TEXT = `${OWN_VATIN} ist deine eigene UID — die UID des Kunden eintragen.`
  const AUSTRIAN = (account: string, uid: string, what: string) =>
    `„${account}“ mit der österreichischen UID ${uid} — ein Kunde in Österreich ist keine ${what}: „Umsatzsteuer Inland“ mit dem österreichischen Satz wählen.`
  const NO_CODE = (uid: string) =>
    `„IG Leistungen“: die UID ${uid} hat keinen Ländercode — die UID des Kunden mit Ländercode eintragen (z. B. DE123456789).`
  const NOT_EU = (account: string, uid: string, drittland: string) =>
    `„${account}“ mit der UID ${uid} — der Kunde sitzt nicht in einem anderen EU-Staat: „${drittland}“ wählen.`
  const LAND = (land: string, uid: string, state: string) =>
    `Kundenland ${land}, die UID ${uid} ist aus ${state} — Kundenland auf ${state} setzen.`
  const blocks = (message: string) => [{ line: undefined, message, blocking: true }]

  // A client's credit on „Einnahmen“ with „IG Leistungen“ at 0 %
  const ig = (vatin: string, country = 'DE') =>
    payload({ vatin, country }, [line({ costaccount: 28180, purchasetaxaccount: 6592, tax_percent: '0.00' })])
  const igCheck = (vatin: string, country = 'DE') => validatePayload(ig(vatin, country), 'income', LISTS)
  // The goods side: „IG Lieferungen“, linked by a made-up Ertragskonto (as „Büromaterial“ above)
  const IG_LIEF = pt(6591, 'IG Lieferungen', '1')
  const WAREN = cost(28291, 'Warenerlöse', '100.00', '100.00', [TAX.ustInland, IG_LIEF, TAX.keineUst])
  const LISTS_GOODS: ValidationLists = { ...LISTS, revenue_accounts: [...Object.values(REV), WAREN], purchasetax_accounts: [...Object.values(TAX), IG_LIEF] }
  const goods = (vatin: string, country = 'DE') =>
    validatePayload(payload({ vatin, country }, [line({ costaccount: 28291, purchasetaxaccount: 6591, tax_percent: '0.00' })]), 'income', LISTS_GOODS)

  test('a bare prefix or a half-typed number: exactly the text of an empty field, blocking — with bookamat’s lists and without', () => {
    assert.deepEqual(igCheck(''), blocks(NEEDS))
    for (const vatin of ['ATU', 'ATU7', 'DE', 'de 1234', 'IE123', 'RO1', 'N/A', 'AT12345678', 'ATU123456789']) {
      assert.deepEqual(igCheck(vatin), blocks(NEEDS), vatin)
      for (const [how, check] of BOTH) assert.deepEqual(check(ig(vatin), 'income'), [NEEDS], `${how}: ${vatin}`)
    }
    assert.deepEqual(goods('DE1234'), blocks('„IG Lieferungen“ braucht die UID des Kunden — UID eintragen oder ein anderes Umsatzsteuerkonto wählen'))
  })
  test('a whole UID of another EU state: nothing when the Kundenland is its state; else one hint, not blocking', () => {
    const whole: [string, string][] = [
      ['DE123456789', 'DE'], ['de 123 456 789', 'de'], ['DE-123.456.789', ' DE '], ['FR12345678901', 'FR'], ['IE1234567T', 'IE'],
      ['NL123456789B01', 'NL'], ['PL1234567890', 'PL'], ['EL123456789', 'GR'], ['EL123456789', 'EL'], ['RO1234567', 'RO'], ['RO12', 'RO'],
    ]
    for (const [vatin, country] of whole) {
      for (const [how, check] of BOTH) assert.deepEqual(check(ig(vatin, country), 'income'), [], `${how}: ${vatin} ${country}`)
    }
    for (const [country, land] of [['DE', 'DE'], ['', 'leer (Österreich)'], ['AT', 'AT']]) {
      assert.deepEqual(igCheck('FR12345678901', country), [{ line: undefined, message: LAND(land, 'FR12345678901', 'FR'), blocking: false }], country)
    }
    // The UID as booked, without spaces; Greece's EL is the Kundenland GR
    assert.deepEqual(igCheck('el 123.456.789', 'DE').map(x => x.message), [LAND('DE', 'EL123456789', 'GR')])
  })
  test('the owner’s own UID, however written: its own text, blocking', () => {
    const spaced = `${OWN_VATIN.slice(0, 3)} ${OWN_VATIN.slice(3, 6)} ${OWN_VATIN.slice(6)}`
    for (const vatin of [OWN_VATIN, spaced, OWN_VATIN.toLowerCase()]) {
      for (const country of ['DE', '', 'AT']) assert.deepEqual(igCheck(vatin, country), blocks(OWN_TEXT), `${vatin} ${country}`)
    }
  })
  test('an Austrian UID: a customer in Austria is no IG Leistung or Lieferung — blocking', () => {
    for (const country of ['AT', 'DE']) {
      assert.deepEqual(igCheck('atu 123 456 78', country), blocks(AUSTRIAN('IG Leistungen', 'ATU12345678', 'IG Leistung')), country)
    }
    assert.deepEqual(goods('ATU12345678'), blocks(AUSTRIAN('IG Lieferungen', 'ATU12345678', 'IG Lieferung')))
  })
  test('a number without a country code: blocking', () => {
    for (const [vatin, uid] of [['123 456 789', '123456789'], ['D-123456789', 'D123456789']]) {
      assert.deepEqual(igCheck(vatin), blocks(NO_CODE(uid)), vatin)
    }
  })
  test('a customer outside the EU: GB, CHE, NO, US and Northern Ireland are Drittland on „IG Leistungen“; for goods XI counts as EU', () => {
    const outside: [string, string, string][] = [
      ['GB123456789', 'GB', 'GB123456789'], ['CHE-123.456.789 MWST', 'CH', 'CHE123456789MWST'], ['NO 123 456 789 MVA', 'NO', 'NO123456789MVA'],
      ['XI123456789', 'GB', 'XI123456789'], ['US123456789', 'US', 'US123456789'],
    ]
    for (const [vatin, country, uid] of outside) {
      assert.deepEqual(igCheck(vatin, country), blocks(NOT_EU('IG Leistungen', uid, 'Drittland Leistungen')), vatin)
    }
    assert.deepEqual(goods('GB123456789', 'GB'), blocks(NOT_EU('IG Lieferungen', 'GB123456789', 'Drittland Lieferungen')))
    // Northern Ireland: no Kundenland is asked of it
    for (const country of ['GB', '', 'DE']) assert.deepEqual(goods('XI123456789', country), [], country)
    // A whole EU UID on the goods side as on services
    assert.deepEqual(goods('DE123456789', 'DE'), [])
    assert.deepEqual(goods('DE123456789', 'FR').map(x => [x.message, x.blocking]), [[LAND('FR', 'DE123456789', 'DE'), false]])
  })
  test('only „IG Leistungen/Lieferungen“ are judged: on „Umsatzsteuer Inland“ and „Drittland Leistungen“ the same UIDs say nothing', () => {
    for (const vatin of ['DE', 'ATU7', '123456789', OWN_VATIN, 'ATU12345678', 'GB123456789', 'FR12345678901']) {
      assert.notDeepEqual(igCheck(vatin, 'DE'), [], `IG Leistungen: ${vatin}`)
      for (const [how, check] of BOTH) {
        assert.deepEqual(check(payload({ vatin, country: 'DE' }, [line({ costaccount: 28180, purchasetaxaccount: 6588 })]), 'income'), [], `${how}: Umsatzsteuer Inland ${vatin}`)
        assert.deepEqual(check(payload({ vatin, country: 'GB' }, [line({ costaccount: 28180, purchasetaxaccount: 6596, tax_percent: '0.00' })]), 'income'), [], `${how}: Drittland Leistungen ${vatin}`)
      }
    }
  })
  test('through the payload the page and the route book: a half-typed UID, typed on the row or proposed by the AI, is refused', () => {
    const credit = (ai: Partial<AiIncomeSuggestion> = {}) => ({
      transaction: { date: '2026-07-02', counterparty: 'MUSTER GMBH', amount: 1200, type: 'income', currency: 'EUR', reference: 'RN 202501901', raw: {} },
      title: 'RN_202501901 - Muster GmbH',
      ai_suggested: { revenue_account_id: 28180, vat_account_id: 6592, bank_account_id: 3224, vat_percent: 0, vatin: 'DE123456789', country: 'DE', ...ai },
    }) as unknown as MatchedIncomeTransaction
    const check = (m: MatchedIncomeTransaction, ov: Record<string, string> = {}) =>
      validatePayload(buildIncomeBookingPayload(m, ov, ctx), 'income', LISTS, { year: 2026 })
    assert.deepEqual(check(credit()), [])
    // The owner's fields as the row sends them — a tab from before the update too
    const inland = credit({ vat_account_id: 6588, vat_percent: 20, vatin: '', country: '' })
    assert.deepEqual(check(inland, { vatin: 'DE', vat_account_id: '6592', vat_percent: '0', country: 'DE' }), blocks(NEEDS))
    assert.deepEqual(check(credit(), { vatin: OWN_VATIN }), blocks(OWN_TEXT))
    // The AI's „DE1234“ survives counterpartyVatin (it has a digit); its own UID does not
    assert.deepEqual(check(credit({ vatin: 'DE1234' })), blocks(NEEDS))
    assert.deepEqual(check(credit({ vatin: OWN_VATIN })), blocks(NEEDS))
  })
})

describe('the 2026 bookings that are right stay without a problem (V1, V2, rates)', () => {
  test('IE on IG Erwerb, US on Drittland Erwerb, GB and DE on „Keine Vorsteuer“, AT and Amazon EU on „Vorsteuer Inland“', () => {
    const right: BookingPayload[] = [
      payload({ country: 'IE', vatin: 'IE6388047V' }, [line({ purchasetaxaccount: 6594 })]),
      payload({ country: 'US' }, [line({ purchasetaxaccount: 6597 })]),
      payload({ country: 'GB' }, [line({ purchasetaxaccount: 6601, tax_percent: '0.00' })]),
      payload({ country: 'DE', vatin: 'DE123456789' }, [line({ purchasetaxaccount: 6601, tax_percent: '0.00' })]),
      payload({ country: 'AT', vatin: 'ATU73569248' }),
      payload({ country: '', vatin: 'ATU73569248' }),
    ]
    for (const [how, check] of BOTH) for (const p of right) assert.deepEqual(check(p), [], `${how}: ${p.country} ${p.vatin}`)
  })
})

describe('amounts in the texts as the app writes them (lib/money.ts)', () => {
  test('a split that does not add up: thousands with „.“', () => {
    const p = payload({}, [line({ amount: '1000.00' }), line({ amount: '250.00' })])
    assert.deepEqual(messages(p, 'expense', { expectedTotal: 1346.8 }), ['Die Zeilen ergeben 1.250,00 €, abgebucht wurden 1.346,80 € — Aufteilung anpassen'])
  })
})

describe('client-safe (the import page and the Belege form run it in the browser)', () => {
  test('lib/booking-validation.ts imports only pure modules at run time', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'booking-validation.ts'), 'utf8')
    const runtime = Array.from(src.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)).map(m => m[1]).sort()
    assert.deepEqual(runtime, ['./account-locks', './money', './tax-accounts', './vat-origin', './vatin'])
  })
})
