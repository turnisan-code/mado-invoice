import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bookingDateOf, cardForeignAmount, deDate, defaultBookingDate, fifteenDayHint, fifteenDayLoose, payDay, payDayLabel, viennaDate, type PayDay } from '../booking-dates'
import { parseEasybankCsv } from '../csv-parser'
import type { BookamatAccount } from '@/lib/expenses/types'

// Synthetic easybank rows only (PR 4b spec §3): zero IBANs, made-up card references,
// terminals, times, merchants and amounts. col1 is the Buchungstext, col2 the posting
// date, col3 the Valutadatum.
const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const row = (text: string, posted: string, valuta = de(posted)) =>
  ({ date: posted, reference: text, raw: { col0: 'AT000000000000000000', col1: text, col2: de(posted), col3: valuta } })
// A card payment: the first segment padded to 57 characters with its MC/ reference, then
// the card stamp line, then the merchant („|“ is easybank's line break)
const cardText = (stampLine: string, merchant = 'SHOP EXAMPLE\\WIEN\\1010', ref = 'MC/000000901') =>
  `Bezahlung Karte                              ${ref}|${stampLine}|${merchant}|SPESEN: 0,00`
const cardRow = (stampLine: string, posted: string, valuta?: string, merchant?: string) =>
  row(cardText(stampLine, merchant), posted, valuta)
const transferText = 'Abbuchung Echtzeitueberweisung               FE/000000910|TESTATWWXXX AT000000000000000004 Example Supplier GmbH|Rechnung 2026-1231'
const creditText = 'Gutschrift Echtzeitueberweisung              FE/000000911|TESTDEFFXXX DE00000000000000000000 Example Client GmbH|Projekt 12/2026'
const cardCreditText = 'Gutschrift Karte                             MC/000000903|E-COMM        13,37 276 D002 30.12. 18:05|SHOP EXAMPLE\\WIEN\\1010'

const card = (payDate: string, bankDate: string): PayDay => ({ bankDate, payDate, source: 'card', card: true, stampUnreadable: false })
const payDateOf = (stampLine: string, posted: string) => payDay(cardRow(stampLine, posted)).payDate

describe('payDay — the card stamp', () => {
  test('E-COMM with amount and country', () => {
    assert.deepEqual(payDay(cardRow('E-COMM        13,37 276 D002 30.12. 18:05', '2027-01-04')),
      { bankDate: '2027-01-04', payDate: '2026-12-30', source: 'card', card: true, stampUnreadable: false })
  })
  test('E-COMM with a code, E-COMM without an amount', () => {
    assert.equal(payDateOf('E-COMM      X7Y2Z9 K002 22.11. 10:30', '2026-11-24'), '2026-11-22')
    assert.equal(payDateOf('E-COMM                 D002 05.08. 07:45', '2026-08-07'), '2026-08-05')
  })
  test('POS, POS in a foreign currency, a merchant token instead of POS', () => {
    assert.equal(payDateOf('POS          4711  D002 28.05. 09:15', '2026-06-01'), '2026-05-28')
    assert.equal(payDateOf('POS        12,34 840 K002 14.03. 16:20', '2026-03-17'), '2026-03-14')
    assert.equal(payDateOf('EXMPL        4711  K002 07.10. 13:44', '2026-10-09'), '2026-10-07')
  })
  test('a card refund credit: the stamp is read, but income never takes it', () => {
    const r = row(cardCreditText, '2027-01-04', '30.12.2026')
    assert.equal(payDay(r).payDate, '2026-12-30')
    assert.deepEqual(payDay(r, 'income'), { bankDate: '2027-01-04', payDate: null, source: null, card: true, stampUnreadable: false })
  })
  test('the year boundary: a December stamp on a January posting is the year before', () => {
    assert.equal(payDateOf('E-COMM        21,11 276 K002 29.12. 21:10', '2027-01-04'), '2026-12-29')
    assert.equal(payDateOf('POS          4711  D002 31.12. 23:59', '2027-01-04'), '2026-12-31')
    assert.equal(payDateOf('E-COMM        11,11 372 D002 01.01. 13:46', '2027-01-04'), '2027-01-01')
  })
  test('a stamp wrapped by „|“ is read', () => {
    assert.equal(payDateOf('POS          4711  D002 01.1|1. 21:05', '2026-11-03'), '2026-11-01')
  })
  test('a merchant starting with a digit right after the time (CD-F4)', () => {
    assert.equal(payDay(cardRow('POS          4711  D002 30.12. 18:05', '2027-01-04', undefined, '1A SHOP EXAMPLE\\WIEN\\1010')).payDate, '2026-12-30')
  })
  test('a date that is not real, or further back than 31 days, is unreadable', () => {
    for (const [stamp, posted] of [['31.04. 10:00', '2026-05-02'], ['29.02. 10:00', '2027-03-01'], ['01.02. 10:00', '2026-12-02']]) {
      const p = payDay(cardRow(`POS          4711  D002 ${stamp}`, posted))
      assert.deepEqual([p.payDate, p.stampUnreadable], [null, true], `${stamp} posted ${posted}`)
    }
    assert.equal(payDateOf('POS          4711  D002 29.02. 10:00', '2028-03-01'), '2028-02-29')
  })
  test('the text of `reference` when the row has no col1', () => {
    assert.equal(payDay({ date: '2027-01-04', reference: cardText('POS          4711  D002 30.12. 18:05'), raw: {} }).payDate, '2026-12-30')
  })
  test('a stamp on the posting day leaves nothing to move, and the Valutadatum is not consulted', () => {
    assert.deepEqual(payDay(cardRow('POS          4711  D002 04.01. 08:00', '2027-01-04', '31.12.2026')),
      { bankDate: '2027-01-04', payDate: null, source: null, card: true, stampUnreadable: false })
  })
  test('a row without a card reference is no card row', () => {
    assert.deepEqual(payDay(row(transferText, '2026-07-15')),
      { bankDate: '2026-07-15', payDate: null, source: null, card: false, stampUnreadable: false })
  })
})

describe('payDay — the Valutadatum (A7)', () => {
  test('an instant transfer valued 31.12.2026, posted 04.01.2027, was paid on 31.12.', () => {
    assert.deepEqual(payDay(row(transferText, '2027-01-04', '31.12.2026')),
      { bankDate: '2027-01-04', payDate: '2026-12-31', source: 'valuta', card: false, stampUnreadable: false })
  })
  test('one day earlier in the same month counts', () => {
    assert.equal(payDay(row(transferText, '2026-07-15', '14.07.2026')).payDate, '2026-07-14')
  })
  test('the same day, more than 7 days earlier, a later day or no real date: none', () => {
    for (const valuta of ['04.01.2027', '27.12.2026', '05.01.2027', '', '32.12.2026', '2026-12-31']) {
      assert.equal(payDay(row(transferText, '2027-01-04', valuta)).payDate, null, valuta)
    }
  })
  test('an MC row without a stamp falls back to the Valutadatum and says the stamp is unreadable', () => {
    assert.deepEqual(payDay(cardRow('E-COMM        19,19 040 D002', '2027-01-04', '30.12.2026')),
      { bankDate: '2027-01-04', payDate: '2026-12-30', source: 'valuta', card: true, stampUnreadable: true })
  })
  test('the card stamp wins over another Valutadatum', () => {
    const p = payDay(cardRow('E-COMM        21,11 276 K002 29.12. 21:10', '2027-01-04', '31.12.2026'))
    assert.deepEqual([p.payDate, p.source], ['2026-12-29', 'card'])
  })
  test('income: the Valutadatum of a transfer, never of a card credit', () => {
    assert.equal(payDay(row(creditText, '2027-01-04', '31.12.2026'), 'income').payDate, '2026-12-31')
    assert.equal(payDay(row(cardCreditText, '2027-01-04', '31.12.2026'), 'income').payDate, null)
  })
})

describe('defaultBookingDate and bookingDateOf', () => {
  test('a card payment across the year or a month books its card date', () => {
    assert.equal(defaultBookingDate(cardRow('E-COMM        13,37 276 D002 30.12. 18:05', '2027-01-04')), '2026-12-30')
    assert.equal(defaultBookingDate(cardRow('POS          4711  D002 28.05. 09:15', '2026-06-01')), '2026-05-28')
  })
  test('within one month, and a card date of 01.01. posted 04.01., keep the bank date', () => {
    assert.equal(defaultBookingDate(cardRow('POS          4711  D002 13.06. 12:00', '2026-06-15')), '2026-06-15')
    assert.equal(defaultBookingDate(cardRow('E-COMM        11,11 372 D002 01.01. 13:46', '2027-01-04')), '2027-01-04')
  })
  test('a Valutadatum across the year books that day, expense and income; within a month it does not', () => {
    assert.equal(defaultBookingDate(row(transferText, '2027-01-04', '31.12.2026')), '2026-12-31')
    assert.equal(defaultBookingDate(row(creditText, '2027-01-04', '31.12.2026'), 'income'), '2026-12-31')
    assert.equal(defaultBookingDate(row(transferText, '2026-07-15', '14.07.2026')), '2026-07-15')
  })
  test('no lag, or an unreadable stamp without a lag: the bank date', () => {
    assert.equal(defaultBookingDate(row(transferText, '2026-12-30')), '2026-12-30')
    assert.equal(defaultBookingDate(cardRow('E-COMM        19,19 040 D002', '2026-12-28')), '2026-12-28')
  })
  test('the owner’s date wins; an empty one gives the default', () => {
    const r = cardRow('E-COMM        13,37 276 D002 30.12. 18:05', '2027-01-04')
    assert.equal(bookingDateOf(r, { date: '2027-01-04' }), '2027-01-04')
    assert.equal(bookingDateOf(r, { date: '' }), '2026-12-30')
    assert.equal(bookingDateOf(r, null), '2026-12-30')
    assert.equal(bookingDateOf(row(creditText, '2027-01-04', '31.12.2026'), {}, 'income'), '2026-12-31')
  })
  test('the synthetic year-boundary CSV (spec P4) through the real parser', () => {
    const csv = [
      'AT000000000000000000;Bezahlung Karte                              MC/000000901|POS          1234  D002 30.12. 18:05|CAFE EXAMPLE\\WIEN\\1010|SPESEN: 0,00;04.01.2027;30.12.2026;-13,37;EUR',
      'AT000000000000000000;Bezahlung Karte                              MC/000000902|E-COMM        21,11 276 K002 29.12. 21:10|SHOP EXAMPLE\\BERLIN\\10115|SPESEN: 0,00;04.01.2027;29.12.2026;-21,11;EUR',
      'AT000000000000000000;Bezahlung Karte                              MC/000000903|E-COMM        11,11 372 D002 01.01. 13:46|SOFTWARE EXAMPLE\\DUBLIN\\D02|SPESEN: 0,00;04.01.2027;01.01.2027;-11,11;EUR',
      'AT000000000000000000;Abbuchung SEPA-Zahlung                       OG/000000907|TESTATWWXXX AT000000000000000003 Example Supplies KG|Rechnung 2026-1207;30.12.2026;30.12.2026;-15,15;EUR',
      'AT000000000000000000;Bezahlung Karte                              MC/000000908|E-COMM        18,18 276 D002 13.12. 22:56|SHOP EXAMPLE\\BERLIN\\10115|SPESEN: 0,00;15.12.2026;14.12.2026;-18,18;EUR',
      'AT000000000000000000;Bezahlung Karte                              MC/000000909|E-COMM        19,19 040 D002|SHOP EXAMPLE\\WIEN\\1010|SPESEN: 0,00;28.12.2026;28.12.2026;-19,19;EUR',
      `AT000000000000000000;${transferText};04.01.2027;31.12.2026;-55,55;EUR`,
      `AT000000000000000000;${creditText};04.01.2027;31.12.2026;77,77;EUR`,
      'AT000000000000000000;Bezahlung Karte                              MC/000000912|POS          4711  D002 30.12. 19:20|1A SHOP EXAMPLE\\WIEN\\1010|SPESEN: 0,00;04.01.2027;30.12.2026;-12,12;EUR',
    ].join('\r\n')
    const { transactions, errors } = parseEasybankCsv(csv)
    assert.deepEqual(errors, [])
    assert.deepEqual(transactions.map(t => defaultBookingDate(t, t.type)),
      ['2026-12-30', '2026-12-29', '2027-01-04', '2026-12-30', '2026-12-15', '2026-12-28', '2026-12-31', '2026-12-31', '2026-12-30'])
    assert.deepEqual(transactions.map(t => payDay(t, t.type).stampUnreadable), [false, false, false, false, false, true, false, false, false])
  })
})

describe('payDayLabel', () => {
  test('the chip of a card payment and of a Valutadatum', () => {
    assert.equal(payDayLabel(card('2026-12-30', '2027-01-04')), 'Kartenzahlung 30.12.2026 · Bank 04.01.2027')
    assert.equal(payDayLabel(payDay(row(transferText, '2027-01-04', '31.12.2026'))), 'Valuta 31.12.2026 · Bank 04.01.2027')
  })
  test('none without a day of payment', () => {
    assert.equal(payDayLabel(payDay(row(transferText, '2027-01-04'))), null)
    assert.equal(payDayLabel(null), null)
  })
  test('deDate', () => {
    assert.equal(deDate('2026-12-31'), '31.12.2026')
    assert.equal(deDate('31.12.2026'), '31.12.2026')
  })
})

describe('cardForeignAmount — the card stamp’s amount when the card paid in another currency', () => {
  const foreign = (stampLine: string, merchant?: string) => cardForeignAmount(cardRow(stampLine, '2026-07-07', undefined, merchant))
  const gbp = { amount: 123.4, currency: 'GBP' }, usd = { amount: 6.78, currency: 'USD' }, chf = { amount: 1234.5, currency: 'CHF' }
  test('POS with an alphabetic code: „123,40 GBP“', () => {
    assert.deepEqual(foreign('POS          123,40 GBP K002 05.07. 10:51', 'CAR RENTAL EXAMPLE\\LONDON'), gbp)
  })
  test('E-COMM with an alphabetic code and an amount after it: „6,78 USD 0,00“', () => {
    assert.deepEqual(foreign('E-COMM 6,78 USD 0,00 01.11. 23:26'), usd)
  })
  test('a numeric code is the merchant’s country, the amount is in euros: none', () => {
    for (const stamp of ['E-COMM        13,37 276 D002 30.12. 18:05', 'E-COMM        19,19 040 D002', 'E-COMM        11,11 372 D002 01.01. 13:46',
      'POS        12,34 840 K002 14.03. 16:20', 'POS          3,50 0001 K002 19.10. 08:10']) {
      assert.equal(foreign(stamp), null, stamp)
    }
  })
  test('a stamp without an amount, or one that starts with neither POS nor E-COMM: none', () => {
    for (const stamp of ['E-COMM      X7Y2Z9 K002 22.11. 10:30', 'E-COMM                 D002 05.08. 07:45', 'POS          4711  D002 28.05. 09:15',
      'EXMPL        12,00 USD K002 07.10. 13:44']) {
      assert.equal(foreign(stamp), null, stamp)
    }
  })
  test('thousands with „.“: „1.234,50 CHF“ → 1234.5', () => {
    assert.deepEqual(foreign('POS        1.234,50 CHF K002 12.08. 14:02'), chf)
  })
  test('a stamp cut at „|“ is joined: in the amount, the code, „E-COMM“ or the card reference', () => {
    assert.deepEqual(foreign('POS          123,4|0 GBP K002 05.07. 10:51'), gbp)
    assert.deepEqual(foreign('POS        1.23|4,50 CHF K002 12.08. 14:02'), chf)
    assert.deepEqual(foreign('POS          123,40 G|BP K002 05.07. 10:51'), gbp)
    assert.deepEqual(foreign('E-CO|MM 6,78 USD 0,00 01.11. 23:26'), usd)
    assert.deepEqual(cardForeignAmount(row(cardText('E-COMM 6,78 USD 0,00 01.11. 23:26', undefined, 'MC/0000|00665'), '2026-11-03')), usd)
  })
  test('EUR is no other currency, a longer word no code, and 0,00 no amount', () => {
    assert.equal(foreign('POS          12,00 EUR K002 05.07. 10:51'), null)
    assert.equal(foreign('POS          12,00 GBPX K002 05.07. 10:51'), null)
    assert.equal(foreign('POS          0,00 USD K002 05.07. 10:51'), null)
  })
  test('only a card payment’s stamp: a row without the card reference has none', () => {
    assert.equal(cardForeignAmount(row('Abbuchung Echtzeitueberweisung               FE/000000910|POS 12,00 USD K002|Example Supplier GmbH', '2026-07-15')), null)
    assert.equal(cardForeignAmount(row(transferText, '2026-07-15')), null)
  })
  test('col1 first, the text of `reference` when the row has no col1; no text: none', () => {
    assert.deepEqual(cardForeignAmount({ reference: transferText, raw: { col1: cardText('POS          123,40 GBP K002 05.07. 10:51') } }), gbp)
    assert.deepEqual(cardForeignAmount({ reference: cardText('POS          123,40 GBP K002 05.07. 10:51'), raw: {} }), gbp)
    assert.equal(cardForeignAmount({ reference: null, raw: null }), null)
  })
  test('through the real parser: the debit stays the euro amount, with its SPESEN', () => {
    const csv = 'AT000000000000000000;Bezahlung Karte                              MC/000000905|POS          123,40 GBP K002 05.07. 10:51|CAR RENTAL EXAMPLE\\LONDON|SPESEN: 2,10;07.07.2026;05.07.2026;-145,67;EUR'
    const [tx] = parseEasybankCsv(csv).transactions
    assert.deepEqual(cardForeignAmount(tx), gbp)
    assert.deepEqual([tx.amount, tx.fee, tx.net_amount], [145.67, 2.1, 143.57])
  })
})

describe('fifteenDayLoose — by the dates alone', () => {
  test('paid 05.01.: a December invoice, none, or one of January before the payment', () => {
    for (const inv of ['2026-12-31', null, undefined, '', '2026-02-30', '2027-01-02', '2027-01-05']) {
      assert.equal(fifteenDayLoose('2027-01-05', inv), true, String(inv))
    }
  })
  test('an invoice after the payment, or of November: no', () => {
    assert.equal(fifteenDayLoose('2027-01-05', '2027-01-06'), false)
    assert.equal(fifteenDayLoose('2027-01-05', '2026-11-30'), false)
  })
  test('paid after the 15th, or in December: no', () => {
    assert.equal(fifteenDayLoose('2027-01-16', '2026-12-31'), false)
    assert.equal(fifteenDayLoose('2026-12-31', '2026-12-01'), false)
    assert.equal(fifteenDayLoose('', null), false)
  })
})

describe('fifteenDayHint — § 19 EStG', () => {
  // The 2026 books' tax accounts (ids as in booking-validation.test.ts)
  const pt = (id: number, name: string, group: '1' | '2'): BookamatAccount => ({ id, name, group })
  const TAX = [
    pt(6589, 'Vorsteuer Inland', '2'), pt(6592, 'IG Leistungen', '1'), pt(6594, 'IG Erwerb von Leistungen', '2'),
    pt(6597, 'Drittland Erwerb von Leistungen', '2'), pt(6598, 'Einfuhr-UST (Zollbehörde)', '2'), pt(6601, 'Keine Vorsteuer', '2'),
  ]
  const byId = new Map(TAX.map(a => [a.id, a]))
  const taxAccount = (id: number) => byId.get(id)
  const ln = (purchasetaxaccount: number | undefined, tax_percent = '20.00') => ({ purchasetaxaccount, tax_percent })
  const RC = ln(6594), DRITTLAND = ln(6597), ZERO = ln(6601, '0.00'), VST = ln(6589), EINFUHR = ln(6598), UNKNOWN = ln(99999)
  const hint = (date: string, inv: string | null, amounts: ReturnType<typeof ln>[], year: number | undefined = 2026) =>
    fifteenDayHint({ date, date_invoice: inv, amounts }, taxAccount, year)

  const HEAD = '15-Tage-Regel? Rechnung vom 31.12.2026, bezahlt am 05.01.2027.'
  const DEC = ' Ist das eine regelmäßige Zahlung für Dezember (z. B. ein Abo), zählt sie für die Einkommensteuer noch zu 2026 (§ 19 EStG);'
  const EARLY = ' Rechnet sie den Dezember ab (regelmäßig, im Nachhinein — z. B. Google), zählt sie für die Einkommensteuer noch zu 2026 (§ 19 EStG);'
  const T_RC = ' die Reverse-Charge-Steuer gehört ohnehin in den Monat der Leistung.'
  const T_ZERO = ' Umsatzsteuer ist keine dabei.'

  test('a December invoice of reverse charge or 0 % only: the question and the button', () => {
    for (const amounts of [[RC], [DRITTLAND], [RC, ZERO]]) {
      assert.deepEqual(hint('2027-01-05', '2026-12-31', amounts), { moveTo: '2026-12-31', message: HEAD + DEC + T_RC })
    }
    assert.deepEqual(hint('2027-01-05', '2026-12-31', [ZERO]), { moveTo: '2026-12-31', message: HEAD + DEC + T_ZERO })
  })
  test('a December invoice with domestic tax: asked, never moved here', () => {
    const domestic = `${HEAD} Ist das eine regelmäßige Zahlung für Dezember, zählt sie für die Einkommensteuer zu 2026 (§ 19 EStG), die Vorsteuer aber zum Jänner 2027 (Ist-Versteuerung) — hier nicht verschieben, mit dem Steuerberater klären.`
    for (const amounts of [[VST], [EINFUHR], [UNKNOWN], [RC, VST]]) {
      const h = hint('2027-01-05', '2026-12-31', amounts)
      assert.deepEqual(h, { moveTo: null, message: domestic })
      assert.match(h!.message, /Vorsteuer aber zum Jänner 2027 .* Steuerberater/)
    }
  })
  test('a sales-side account is no reverse charge', () => {
    assert.equal(hint('2027-01-05', '2026-12-31', [ln(6592)])?.moveTo, null)
  })
  test('widened (JT-F2): reverse charge without a Rechnungsdatum, or with one of January before the payment', () => {
    assert.deepEqual(hint('2027-01-04', null, [RC]), {
      moveTo: '2026-12-31',
      message: '15-Tage-Regel? Kein Rechnungsdatum, bezahlt am 04.01.2027.' + EARLY + T_RC + ' Gilt sie für Jänner (im Voraus bezahlt), nichts ändern.',
    })
    const jan = hint('2027-01-04', '2027-01-01', [RC])
    assert.equal(jan?.moveTo, '2026-12-31')
    assert.ok(jan?.message.startsWith('15-Tage-Regel? Rechnung vom 01.01.2027, bezahlt am 04.01.2027. Rechnet sie den Dezember ab'))
  })
  test('widened: not after the payment, and never with domestic tax', () => {
    assert.equal(hint('2027-01-04', '2027-01-06', [RC]), null)
    assert.equal(hint('2027-01-04', null, [VST]), null)
    assert.equal(hint('2027-01-04', '2027-01-01', [VST]), null)
  })
  test('after the switch (2027 set): no button, booked by hand in 2026', () => {
    assert.deepEqual(hint('2027-01-05', '2026-12-31', [RC], 2027), {
      moveTo: null,
      message: HEAD + DEC + T_RC + ' Buchungsjahr ist schon 2027: in bookamat 2026 von Hand auf 31.12.2026 buchen (falls noch nicht geschehen) und hier nicht ankreuzen — auch nicht bei einem späteren Import.',
    })
    const widened = hint('2027-01-05', null, [ZERO], 2027)
    assert.deepEqual(widened, {
      moveTo: null,
      message: '15-Tage-Regel? Kein Rechnungsdatum, bezahlt am 05.01.2027.' + EARLY + T_ZERO + ' Dann: Buchungsjahr ist schon 2027 — in bookamat 2026 von Hand auf 31.12.2026 buchen (falls noch nicht geschehen) und hier nicht ankreuzen, auch nicht bei einem späteren Import. Gilt sie für Jänner (im Voraus bezahlt): wie üblich ankreuzen.',
    })
  })
  test('the year set unknown: asked, but nothing to move', () => {
    assert.deepEqual(fifteenDayHint({ date: '2027-01-05', date_invoice: '2026-12-31', amounts: [RC] }, taxAccount),
      { moveTo: null, message: HEAD + DEC + T_RC })
  })
  test('paid on 20.01. or on 31.12.: none', () => {
    assert.equal(hint('2027-01-20', '2026-12-31', [RC]), null)
    assert.equal(hint('2026-12-31', '2026-12-01', [RC]), null)
  })
  test('the head, exactly', () => {
    assert.ok(hint('2027-01-05', '2026-12-31', [ZERO])!.message.startsWith('15-Tage-Regel? Rechnung vom 31.12.2026, bezahlt am 05.01.2027.'))
  })

  // TAX-01: a payment of 01.–15.01. posted after the 15th keeps the bank date as its
  // Buchungsdatum (same month); the rule asks by the day of payment
  describe('on the day of payment (TAX-01)', () => {
    const paidHint = (date: string, inv: string | null, amounts: ReturnType<typeof ln>[], year: number | undefined, payDate: string | null | undefined) =>
      fifteenDayHint({ date, date_invoice: inv, amounts }, taxAccount, year, payDate)
    // A card payment of Fri 15.01.2027 21:00, posted Mon 18.01.2027
    const card15 = cardRow('E-COMM        15,15 276 D002 15.01. 21:00', '2027-01-18')
    const booked = defaultBookingDate(card15)
    const paid = payDay(card15).payDate
    const HEAD_PAID = '15-Tage-Regel? Rechnung vom 31.12.2026, bezahlt am 15.01.2027.'

    test('the card payment of 15.01. posted 18.01. books 18.01. and was paid on 15.01.', () => {
      assert.deepEqual([booked, paid], ['2027-01-18', '2027-01-15'])
    })
    test('fifteenDayLoose by the payment day; by the Buchungsdatum alone it said no', () => {
      assert.equal(fifteenDayLoose(booked, '2026-12-31', paid), true)
      assert.equal(fifteenDayLoose(booked, null, paid), true)
      assert.equal(fifteenDayLoose(booked, '2027-01-15', paid), true)
      assert.equal(fifteenDayLoose(booked, '2026-12-31'), false)
      assert.equal(fifteenDayLoose(booked, '2026-12-31', null), false)
      // an invoice dated after the payment (between the card date and the bank date): no
      assert.equal(fifteenDayLoose(booked, '2027-01-16', paid), false)
    })
    test('a December invoice of reverse charge: the question, the button, the head on the payment day', () => {
      assert.deepEqual(paidHint(booked, '2026-12-31', [RC], 2026, paid), { moveTo: '2026-12-31', message: HEAD_PAID + DEC + T_RC })
      assert.equal(paidHint(booked, '2026-12-31', [RC], 2026, null), null)
    })
    test('after the switch (2027 set): no button, booked by hand in 2026', () => {
      assert.deepEqual(paidHint(booked, '2026-12-31', [RC], 2027, paid), {
        moveTo: null,
        message: HEAD_PAID + DEC + T_RC + ' Buchungsjahr ist schon 2027: in bookamat 2026 von Hand auf 31.12.2026 buchen (falls noch nicht geschehen) und hier nicht ankreuzen — auch nicht bei einem späteren Import.',
      })
    })
    test('moved to 31.12. by the button: no hint, nothing loose', () => {
      assert.equal(paidHint('2026-12-31', '2026-12-31', [RC], 2026, paid), null)
      assert.equal(paidHint('2026-12-31', null, [RC], 2026, paid), null)
      assert.equal(fifteenDayLoose('2026-12-31', '2026-12-31', paid), false)
      assert.equal(fifteenDayLoose('2026-12-31', null, paid), false)
    })
    test('a transfer valued 15.01.2027, posted 18.01.2027, domestic with a December invoice: the Steuerberater text, no button', () => {
      const fe = row(transferText, '2027-01-18', '15.01.2027')
      assert.deepEqual([defaultBookingDate(fe), payDay(fe).payDate], ['2027-01-18', '2027-01-15'])
      assert.deepEqual(paidHint(defaultBookingDate(fe), '2026-12-05', [VST], 2026, payDay(fe).payDate), {
        moveTo: null,
        message: '15-Tage-Regel? Rechnung vom 05.12.2026, bezahlt am 15.01.2027. Ist das eine regelmäßige Zahlung für Dezember, zählt sie für die Einkommensteuer zu 2026 (§ 19 EStG), die Vorsteuer aber zum Jänner 2027 (Ist-Versteuerung) — hier nicht verschieben, mit dem Steuerberater klären.',
      })
    })
    test('S3: card 01.01.2027 posted 04.01.2027, no invoice — paid on 01.01., and gone after the move', () => {
      const s3 = cardRow('E-COMM        11,11 372 D002 01.01. 13:46', '2027-01-04')
      const [b, p] = [defaultBookingDate(s3), payDay(s3).payDate]
      assert.deepEqual([b, p], ['2027-01-04', '2027-01-01'])
      assert.deepEqual(paidHint(b, null, [RC], 2026, p), {
        moveTo: '2026-12-31',
        message: '15-Tage-Regel? Kein Rechnungsdatum, bezahlt am 01.01.2027.' + EARLY + T_RC + ' Gilt sie für Jänner (im Voraus bezahlt), nichts ändern.',
      })
      assert.equal(paidHint('2026-12-31', null, [RC], 2026, p), null)
      // an invoice of 02.01. is after the payment: no question
      assert.equal(paidHint(b, '2027-01-02', [RC], 2026, p), null)
    })
    test('without a day of payment: as before', () => {
      for (const payDate of [null, undefined, '', '2027-02-30']) {
        assert.deepEqual(paidHint('2027-01-05', '2026-12-31', [RC], 2026, payDate), hint('2027-01-05', '2026-12-31', [RC]), String(payDate))
        assert.deepEqual(paidHint('2027-01-04', null, [ZERO], 2027, payDate), hint('2027-01-04', null, [ZERO], 2027), String(payDate))
        assert.equal(fifteenDayLoose('2027-01-05', null, payDate), true, String(payDate))
        assert.equal(fifteenDayLoose('2027-01-16', null, payDate), false, String(payDate))
      }
    })
    test('a card payment of 30.12. with its Buchungsdatum retyped to the January bank date: none (A2 refuses it)', () => {
      const dec = cardRow('E-COMM        13,37 276 D002 30.12. 18:05', '2027-01-04')
      assert.equal(payDay(dec).payDate, '2026-12-30')
      assert.equal(paidHint('2027-01-04', null, [RC], 2026, payDay(dec).payDate), null)
      assert.equal(fifteenDayLoose('2027-01-04', null, payDay(dec).payDate), false)
    })
  })
})

describe('viennaDate — the calendar day in Vienna (moved here from receipt-year, env-free)', () => {
  test('around midnight, in winter and in summer time', () => {
    assert.equal(viennaDate(new Date('2026-12-31T22:59:00Z')), '2026-12-31')
    assert.equal(viennaDate(new Date('2026-12-31T23:00:00Z')), '2027-01-01')
    assert.equal(viennaDate(new Date('2026-07-01T21:59:00Z')), '2026-07-01')
    assert.equal(viennaDate(new Date('2026-07-01T22:00:00Z')), '2026-07-02')
  })
  test('around the change to summer time (29.03.2026) and back (25.10.2026)', () => {
    // The night before: still CET, UTC+1
    assert.equal(viennaDate(new Date('2026-03-28T22:59:00Z')), '2026-03-28')
    assert.equal(viennaDate(new Date('2026-03-28T23:00:00Z')), '2026-03-29')
    // 02:00 CET becomes 03:00 CEST
    assert.equal(viennaDate(new Date('2026-03-29T00:59:00Z')), '2026-03-29')
    assert.equal(viennaDate(new Date('2026-03-29T01:00:00Z')), '2026-03-29')
    // The night after: CEST, UTC+2
    assert.equal(viennaDate(new Date('2026-03-29T21:59:00Z')), '2026-03-29')
    assert.equal(viennaDate(new Date('2026-03-29T22:00:00Z')), '2026-03-30')
    // The night before the change back: CEST
    assert.equal(viennaDate(new Date('2026-10-24T21:59:00Z')), '2026-10-24')
    assert.equal(viennaDate(new Date('2026-10-24T22:00:00Z')), '2026-10-25')
    // The night after: CET again
    assert.equal(viennaDate(new Date('2026-10-25T22:59:00Z')), '2026-10-25')
    assert.equal(viennaDate(new Date('2026-10-25T23:00:00Z')), '2026-10-26')
  })
  test('an invalid date throws', () => {
    assert.throws(() => viennaDate(new Date('kein Datum')))
  })
})
