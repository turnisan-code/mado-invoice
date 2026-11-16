import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { amountIn, amountMatchesTransaction, amountsInText, cents, eur, moneyOf } from '../money'
import { amountMatchesTransaction as amountMatchesFromCsvParser, parseEasybankCsv } from '../csv-parser'

describe('eur — an amount as the German texts write it', () => {
  test('thousands with „.“, cents with „,“, then „ €“', () => {
    assert.equal(eur(1250), '1.250,00 €')
    assert.equal(eur(1000), '1.000,00 €')
    assert.equal(eur(1234567.891), '1.234.567,89 €')
    assert.equal(eur(318.25), '318,25 €')
    assert.equal(eur(40.65), '40,65 €')
    assert.equal(eur(0), '0,00 €')
  })
  test('rounded to cents as toFixed(2) rounds; a rounding that reaches the thousands groups it', () => {
    assert.equal(eur(318.249), '318,25 €')
    assert.equal(eur(318.244), '318,24 €')
    assert.equal(eur(999.999), '1.000,00 €')
  })
  test('a negative amount keeps its sign unless it rounds to zero', () => {
    assert.equal(eur(-28.3), '-28,30 €')
    assert.equal(eur(-1250), '-1.250,00 €')
    assert.equal(eur(-0.001), '0,00 €')
    assert.equal(eur(-0), '0,00 €')
  })
  test('below 1.000 € the same text as the booking checks write today', () => {
    for (const n of [0, 0.5, 6.56, 39.27, 381.9, 999.99]) assert.equal(eur(n), `${n.toFixed(2).replace('.', ',')} €`, String(n))
  })
  test('no number: written as JavaScript writes it, never a throw', () => {
    assert.equal(eur(Number.NaN), 'NaN €')
    assert.equal(eur(Number.POSITIVE_INFINITY), 'Infinity €')
  })
})

describe('amountIn — an amount in another currency, written as eur writes it', () => {
  test('„25,00 USD“; thousands and cents as in euros', () => {
    assert.equal(amountIn(25, 'USD'), '25,00 USD')
    assert.equal(amountIn(123.4, 'GBP'), '123,40 GBP')
    assert.equal(amountIn(1234.5, 'CHF'), '1.234,50 CHF')
    assert.equal(amountIn(6.789, 'USD'), '6,79 USD')
  })
  test('the same digits as eur, only the code differs (sign, rounding, no number)', () => {
    for (const n of [0, 0.5, 6.78, 123.4, 999.999, 1234567.891, -28.3, -0.001, Number.NaN]) {
      assert.equal(amountIn(n, 'USD'), eur(n).replace(/ €$/, ' USD'), String(n))
    }
  })
})

describe('cents — amounts are compared in whole cents', () => {
  test('rounded to the nearest cent', () => {
    assert.equal(cents(40.52), 4052)
    assert.equal(cents(40.5), 4050)
    assert.equal(cents(0.1 + 0.2), 30)
    assert.equal(cents(27.6 - 0.41), 2719)
    assert.equal(cents(0), 0)
    assert.equal(cents(1234.56), 123456)
  })
})

describe('amountMatchesTransaction — gross or net of SPESEN, within 2 cents, compared in cents', () => {
  test('debit 40,52: 40,50 and 40,54 match, 40,49 and 40,55 do not (as floats 40,50 failed: 0.0200000000000031)', () => {
    const debit = { amount: 40.52 }
    assert.equal(amountMatchesTransaction(debit, 40.5), true)
    assert.equal(amountMatchesTransaction(debit, 40.54), true)
    assert.equal(amountMatchesTransaction(debit, 40.52), true)
    assert.equal(amountMatchesTransaction(debit, 40.49), false)
    assert.equal(amountMatchesTransaction(debit, 40.55), false)
  })
  test('debit 27,60 with SPESEN 0,41 (net 27,19): 27,19 and 27,17 match the net, 27,16 does not', () => {
    const debit = { amount: 27.6, fee: 0.41, net_amount: 27.19 }
    assert.equal(amountMatchesTransaction(debit, 27.19), true)
    assert.equal(amountMatchesTransaction(debit, 27.17), true)
    assert.equal(amountMatchesTransaction(debit, 27.16), false)
    assert.equal(amountMatchesTransaction(debit, 27.6), true)
    // Without a net amount only the gross counts
    assert.equal(amountMatchesTransaction({ amount: 27.6 }, 27.19), false)
    assert.equal(amountMatchesTransaction({ amount: 27.6, net_amount: null }, 27.19), false)
  })
  test('every debit from 0,01 € to 1.000,00 €: 2 cents either way match, 3 cents do not', () => {
    const wrong: string[] = []
    for (let c = 1; c <= 100_000; c++) {
      const debit = { amount: c / 100 }
      for (let d = -3; d <= 3; d++) {
        if (c + d >= 0 && amountMatchesTransaction(debit, (c + d) / 100) !== Math.abs(d) <= 2) wrong.push(`${c / 100} vs ${(c + d) / 100}`)
      }
    }
    assert.deepEqual(wrong.slice(0, 5), [])
  })
  test('the net amount as the parser sets it from „SPESEN: 0,41“', () => {
    const csv = 'AT000000000000000000;Bezahlung Karte                              MC/000000901|POS          27,60 0001 K002 03.07. 18:12|SHOP EXAMPLE\\WIEN\\1010|SPESEN: 0,41;04.07.2026;03.07.2026;-27,60;EUR'
    const [tx] = parseEasybankCsv(csv).transactions
    assert.deepEqual([tx.amount, tx.fee, tx.net_amount], [27.6, 0.41, 27.19])
    assert.deepEqual([27.19, 27.17, 27.16, 27.62, 27.63].map(c => amountMatchesTransaction(tx, c)), [true, true, false, true, false])
  })
  test('another tolerance is counted in whole cents too (the Drive check’s 0,50; 0,29 is 28.999… × 100)', () => {
    const debit = { amount: 120.25 }
    assert.equal(amountMatchesTransaction(debit, 119.75, 0.5), true)
    assert.equal(amountMatchesTransaction(debit, 120.75, 0.5), true)
    assert.equal(amountMatchesTransaction(debit, 119.74, 0.5), false)
    assert.equal(amountMatchesTransaction(debit, 120.76, 0.5), false)
    assert.equal(amountMatchesTransaction({ amount: 10 }, 10.29, 0.29), true)
    assert.equal(amountMatchesTransaction({ amount: 10 }, 10.3, 0.29), false)
  })
  test('no number never matches', () => {
    assert.equal(amountMatchesTransaction({ amount: 40.52, net_amount: 40 }, Number.NaN), false)
  })
  test('lib/csv-parser.ts still exports it: the same function, so its callers stay', () => {
    assert.equal(amountMatchesFromCsvParser, amountMatchesTransaction)
    const src = readFileSync(join(import.meta.dirname, '..', 'csv-parser.ts'), 'utf8')
    assert.match(src, /^export \{ amountMatchesTransaction \} from '\.\/money'$/m)
    assert.doesNotMatch(src, /function amountMatchesTransaction/)
  })
})

describe('amountsInText — every amount with two decimals a text shows', () => {
  const cases: [string, number[]][] = [
    ['Gesamt 1.234,56 €', [1234.56]],
    ['Total EUR 1,234.56', [1234.56]],
    ['1234,56', [1234.56]],
    ['Total: 1234.56', [1234.56]],
    ['Summe 12345,00', [12345]],
    ["CHF 1'234.50", [1234.5]],
    ['Rechnungsdatum 17.07.2026', []],
    ['Menge 2 450,00', [450]],
    ['Betrag 19,99 € inkl. 20 % USt 3,33 €', [19.99, 3.33]],
  ]
  for (const [text, amounts] of cases) {
    test(`„${text}“ → [${amounts.join(', ')}]`, () => assert.deepEqual(amountsInText(text), amounts))
  }
  test('more groups, a Swiss amount with a comma, an amount right before or after a currency', () => {
    assert.deepEqual(amountsInText('1.234.567,89'), [1234567.89])
    assert.deepEqual(amountsInText('1,234,567.89'), [1234567.89])
    assert.deepEqual(amountsInText("1'234,50"), [1234.5])
    assert.deepEqual(amountsInText('€23.45 · 23,45EUR · 0,99'), [23.45, 23.45, 0.99])
  })
  test('every amount in the text’s order, repeats included; the sign is not read', () => {
    assert.deepEqual(amountsInText('Netto 19,38 €\nUSt 20 % 3,88 €\nBrutto 23,26 €\nZahlbetrag 23,26 €'), [19.38, 3.88, 23.26, 23.26])
    assert.deepEqual(amountsInText('Gutschrift -23,45 €'), [23.45])
  })
  test('a date never counts, „dd.mm.“ included; an amount that ends a sentence does', () => {
    for (const text of ['17.07.26', '2026.07.17', 'Leistungszeitraum 01.07.–31.07.2026', 'Lieferdatum 17.07.', 'gültig bis 31.12. 10:30']) {
      assert.deepEqual(amountsInText(text), [], text)
    }
    assert.deepEqual(amountsInText('Lieferung 17.07. Betrag 23,45 €'), [23.45])
    assert.deepEqual(amountsInText('Der Betrag ist 23,45.'), [23.45])
    // No day and month („45“ is no month, „32“ no day), or no „.“ after it
    assert.deepEqual(amountsInText('Total 23.45.'), [23.45])
    assert.deepEqual(amountsInText('Total 32.10.'), [32.1])
    assert.deepEqual(amountsInText('Total 12.10 €'), [12.1])
  })
  test('no two decimals, mixed separators, numbers and IBANs: none', () => {
    for (const text of ['1.234', '1,234', '12,5', '1.234,5', '1.234.56', '1,234,56', '12,345', "1'23.45", 'Rechnungsnr. 910000000123', 'AT00 0000 0000 0000 0000', '20 %']) {
      assert.deepEqual(amountsInText(text), [], text)
    }
  })
  test('no text: none', () => {
    assert.deepEqual(amountsInText(''), [])
    assert.deepEqual(amountsInText(null), [])
    assert.deepEqual(amountsInText(undefined), [])
  })
  // Generated PDFs and toLocaleString group thousands with a no-break space (U+00A0) or a
  // narrow one (U+202F): accepted where „.“ / „,“ / „'“ are — groups of three digits before
  // the decimals —, a plain space never (P2-11, commit 13)
  const NBSP = '\u00A0'
  const NNBSP = '\u202F'
  test('a no-break space between thousands (U+00A0, U+202F): one amount, with either decimal separator', () => {
    for (const sp of [NBSP, NNBSP]) {
      assert.deepEqual(amountsInText(`Gesamt 1${sp}234,56 €`), [1234.56], JSON.stringify(sp))
      assert.deepEqual(amountsInText(`Total 1${sp}234.56`), [1234.56], JSON.stringify(sp))
      assert.deepEqual(amountsInText(`Summe 12${sp}345${sp}678,90`), [12345678.9], JSON.stringify(sp))
      assert.deepEqual(amountsInText(`Menge 2${sp}450,00`), [2450], JSON.stringify(sp))
    }
    // the same with a plain space: two numbers, the amount the second
    assert.deepEqual(amountsInText('Menge 2 450,00'), [450])
    assert.deepEqual(amountsInText('Gesamt 1 234,56 €'), [234.56])
  })
  test('a no-break space only between groups of three before the decimals: around an amount it is no part of it', () => {
    for (const sp of [NBSP, NNBSP]) {
      // before or after a currency
      assert.deepEqual(amountsInText(`€${sp}12,50 · 23,45${sp}EUR`), [12.5, 23.45], JSON.stringify(sp))
      // groups of two or four are no thousands: the last number with decimals only
      assert.deepEqual(amountsInText(`12${sp}34,56`), [34.56], JSON.stringify(sp))
      assert.deepEqual(amountsInText(`1${sp}2345,67`), [2345.67], JSON.stringify(sp))
      // no decimals, or a date after it: none
      assert.deepEqual(amountsInText(`1${sp}234`), [], JSON.stringify(sp))
      assert.deepEqual(amountsInText(`Datum${sp}17.07.2026`), [], JSON.stringify(sp))
    }
  })
})

// The receipt reader's money fields (P2-3: tip, paid_total, a line's amount_net/amount_vat).
// Synthetic amounts only (spec „Conventions“): a tip of 1,80 €, a card slip „Betrag 25,50“,
// 11,36 € netto + 1,14 € MwSt.
describe('moneyOf — an amount the receipt reader answers', () => {
  test('a finite number, rounded to cents', () => {
    assert.equal(moneyOf(1.8), 1.8)
    assert.equal(moneyOf(25.5), 25.5)
    assert.equal(moneyOf(11.36), 11.36)
    assert.equal(moneyOf(23.456), 23.46)
    assert.equal(moneyOf(1.8049), 1.8)
    assert.equal(moneyOf(1250), 1250)
  })
  test('a text holding one: spaces, „€“, „EUR“ and a decimal comma or point allowed', () => {
    assert.equal(moneyOf('1,80'), 1.8)
    assert.equal(moneyOf('25.50'), 25.5)
    assert.equal(moneyOf(' 25,50 € '), 25.5)
    assert.equal(moneyOf('€25,50'), 25.5)
    assert.equal(moneyOf('EUR 25,50'), 25.5)
    assert.equal(moneyOf('25,50EUR'), 25.5)
    assert.equal(moneyOf('25,50 eur'), 25.5)
    assert.equal(moneyOf('11,36'), 11.36)
    assert.equal(moneyOf('12,5'), 12.5)
    assert.equal(moneyOf('2'), 2)
    // a no-break or narrow space between thousands, as generated PDFs write it
    assert.equal(moneyOf('1 234,56'), 1234.56)
    assert.equal(moneyOf('1 234,56 €'), 1234.56)
  })
  test('never a rate: a text with „%“ is null, so a suggested „10 %“ is no 10 € tip', () => {
    for (const v of ['10%', '10 %', '2,37 (10 %)', '%', '1,80%']) assert.equal(moneyOf(v), null, v)
  })
  test('only an amount above 0,00 counts: 0, a negative amount or one that rounds to 0,00 is null', () => {
    for (const v of [0, -0, -1, -1.8, 0.004, '0', '0,00', '-1', '-1,80']) assert.equal(moneyOf(v), null, String(v))
    assert.equal(moneyOf(0.005), 0.01)
  })
  test('anything else is null: no number, „null“, a word, a thousands point, more than two decimals, NaN, Infinity, true, an object', () => {
    for (const v of ['', ' ', 'null', 'abc', 'n/a', '€', '1.234,56', '1,234.56', '1.234', '1,805', '1e3', '+1,80', '1,80 Euro', '1 80 €x',
      NaN, Infinity, -Infinity, true, false, null, undefined, {}, [], [1.8]]) {
      assert.equal(moneyOf(v), null, JSON.stringify(v) ?? String(v))
    }
  })
  test('a space inside an amount only between groups of three digits: „1 80“ may be 1,80 € and is never 180 € (spec check)', () => {
    for (const v of ['1 80', '1 80 €', 'EUR 1 80', '12 50', '0 50', '1 2', '25 ,50', '25, 50', '1 2345', '12 34,56', '1  234,56']) {
      assert.equal(moneyOf(v), null, v)
      assert.equal(moneyOf(v, { zero: true }), null, v)
    }
    // groups of three, with a plain, a no-break or a narrow space
    assert.equal(moneyOf('1 234'), 1234)
    assert.equal(moneyOf('12 345,60 €'), 12345.6)
    assert.equal(moneyOf('1 234 567,89'), 1234567.89)
    assert.equal(moneyOf('1 234,56'), 1234.56)
    assert.equal(moneyOf('€ 1 234,56'), 1234.56)
  })
  test('with `zero` (a line’s printed MwSt): 0,00 counts too, and is 0 — never -0; a negative amount is still null', () => {
    for (const v of [0, -0, '0', '0,00', '0.00 €', 0.004, -0.004]) {
      const r = moneyOf(v, { zero: true })
      assert.ok(Object.is(r, 0), `${JSON.stringify(v)} → ${String(r)}`)
    }
    assert.equal(moneyOf(1.14, { zero: true }), 1.14)
    assert.equal(moneyOf('1,14', { zero: true }), 1.14)
    for (const v of [-1, '-1,14', '20%', 'null', '', null, undefined, NaN]) assert.equal(moneyOf(v, { zero: true }), null, String(v))
  })
})

describe('client-safe', () => {
  test('lib/money.ts imports nothing and reads no env variable (the page and the server write alike)', () => {
    const code = readFileSync(join(import.meta.dirname, '..', 'money.ts'), 'utf8').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /(?:\bfrom|\bimport|\brequire\()\s*['"]/)
    assert.doesNotMatch(code, /process\.env|toLocaleString\(|Intl\./)
  })
})
