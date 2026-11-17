import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allowedRates,
  AT_VAT_RATES,
  countryFromVatin,
  EU_COUNTRY_CODES,
  EU_OWN_RATES,
  isForeignCurrency,
  isoCountry,
  looksOss,
  normalizeCountry,
  regionOfCountry,
  supplierAtuInText,
  vatOrigin,
} from '../vat-origin'

// Synthetic UIDs in each country's shape. ATU73569248 (Amazon EU S.à r.l.) and the owner's
// own ATU12345675 are AUDIT.md's published figures, as the existing fixtures use them.
const AMAZON_ATU = 'ATU73569248'
const OWN = 'ATU12345675'

describe('AT_VAT_RATES — Austria’s rates', () => {
  test('20, 13, 10 and, since 1.7.2026, 4.9 %; 0 % says nothing about origin', () => {
    assert.deepEqual([...AT_VAT_RATES], [20, 13, 10, 4.9])
    assert.ok(!AT_VAT_RATES.includes(0))
    assert.ok(!AT_VAT_RATES.includes(19))
  })
})

describe('allowedRates — the rates bookamat takes on a tax account (tax_values)', () => {
  test('bookamat 2026’s lists: strings to numbers, highest first', () => {
    assert.deepEqual(allowedRates({ tax_values: ['20.00', '10.00', '13.00', '4.90'] }), [20, 13, 10, 4.9])   // Vorsteuer Inland
    assert.deepEqual(allowedRates({ tax_values: ['20.00', '10.00', '13.00'] }), [20, 13, 10])                 // IG/Drittland Erwerb von Leistungen
    assert.deepEqual(allowedRates({ tax_values: ['0.00'] }), [0])                                             // Keine Vorsteuer
  })
  test('not known: "" alone (Vorsteuer Rückforderung: any rate), an empty list, none, no account', () => {
    assert.equal(allowedRates({ tax_values: [''] }), null)
    assert.equal(allowedRates({ tax_values: [] }), null)
    assert.equal(allowedRates({ tax_values: null }), null)
    assert.equal(allowedRates({}), null)
    assert.equal(allowedRates(null), null)
    assert.equal(allowedRates(undefined), null)
  })
  test('numbers count as they are; "" and values that are no number are left out; each rate once', () => {
    assert.deepEqual(allowedRates({ tax_values: [20, 4.9] }), [20, 4.9])
    assert.deepEqual(allowedRates({ tax_values: ['20.00', 'abc', null, '', ' 13.00 ', '4,90', '20 %', -5, Number.NaN, {}] }), [20, 13, 4.9])
    assert.deepEqual(allowedRates({ tax_values: ['20.00', '20', 20] }), [20])
    assert.equal(allowedRates({ tax_values: ['x', ''] }), null)
  })
  test('a value that is not a list is not known', () => {
    assert.equal(allowedRates({ tax_values: '20.00' } as unknown as { tax_values: string[] }), null)
  })
  test('the line’s rate as the payload sends it („4.90“) is found among them', () => {
    assert.ok(allowedRates({ tax_values: ['20.00', '4.90'] })!.includes(Number('4.90')))
  })
})

describe('normalizeCountry — moved from lib/bookamat.ts', () => {
  test('UK/uk/EN → GB, EL → GR, trimmed and upper-cased, empty stays empty', () => {
    assert.equal(normalizeCountry('UK'), 'GB')
    assert.equal(normalizeCountry('uk'), 'GB')
    assert.equal(normalizeCountry('EN'), 'GB')
    assert.equal(normalizeCountry('EL'), 'GR')
    assert.equal(normalizeCountry(' de '), 'DE')
    assert.equal(normalizeCountry('Austria'), 'AUSTRIA')
    assert.equal(normalizeCountry(''), '')
    assert.equal(normalizeCountry(null), '')
    assert.equal(normalizeCountry(undefined), '')
  })
})

describe('isoCountry — a two-letter code as bookamat takes it, else none', () => {
  test('codes, normalised', () => {
    assert.equal(isoCountry('at'), 'AT')
    assert.equal(isoCountry('UK'), 'GB')
    assert.equal(isoCountry('el'), 'GR')
    assert.equal(isoCountry(' de '), 'DE')
  })
  test('a name, a three-letter code, one letter, nothing, a non-string: none', () => {
    for (const v of ['Austria', 'AUT', 'D', '', '  ', 'D1', null, undefined, 12, {}]) assert.equal(isoCountry(v), '', String(v))
  })
})

describe('EU_COUNTRY_CODES — moved from lib/ai-classifier.ts', () => {
  test('the 26 member states other than Austria; Greece as GR', () => {
    assert.equal(EU_COUNTRY_CODES.size, 26)
    for (const c of ['DE', 'GR', 'PL', 'IT', 'LU', 'IE', 'NL', 'FR', 'SE']) assert.ok(EU_COUNTRY_CODES.has(c), c)
    for (const c of ['AT', 'EL', 'GB', 'UK', 'CH', 'NO', 'XI', 'US', '']) assert.ok(!EU_COUNTRY_CODES.has(c), c)
  })
})

describe('isForeignCurrency — moved from lib/ai-extractor.ts', () => {
  test('a recognised foreign currency', () => {
    for (const c of ['USD', 'gbp', 'CHF', '$', '£', 'US$']) assert.equal(isForeignCurrency(c), true, c)
  })
  test('euros, and anything unrecognised, as before the field existed', () => {
    for (const c of ['EUR', 'eur', '€', 'Euro', 'EURO', 'N/A', 'unknown', '', null, undefined]) assert.equal(isForeignCurrency(c), false, String(c))
  })
})

describe('countryFromVatin — the country a complete UID names', () => {
  test('an Austrian UID: ATU and 8 digits, however it is written', () => {
    assert.equal(countryFromVatin(AMAZON_ATU), 'AT')
    assert.equal(countryFromVatin('atu 735 692 48'), 'AT')
    assert.equal(countryFromVatin('ATU-735.692.48'), 'AT')
  })
  test('an EU state’s UID: its country; EL is Greece', () => {
    assert.equal(countryFromVatin('DE123456789'), 'DE')
    assert.equal(countryFromVatin('DE 123 456 789'), 'DE')
    assert.equal(countryFromVatin('PL1234567890'), 'PL')
    assert.equal(countryFromVatin('IT12345678901'), 'IT')
    assert.equal(countryFromVatin('EL123456789'), 'GR')
    assert.equal(countryFromVatin('GR123456789'), 'GR')
    assert.equal(countryFromVatin('LU12345678'), 'LU')
    assert.equal(countryFromVatin('IE1234567WA'), 'IE')
    assert.equal(countryFromVatin('FR12345678901'), 'FR')
    assert.equal(countryFromVatin('ESX1234567X'), 'ES')
    assert.equal(countryFromVatin('NL123456789B01'), 'NL')
    assert.equal(countryFromVatin('SE123456789001'), 'SE')
  })
  test('GB with 9 or 12 digits, CHE (MWST/TVA/IVA), NO (MVA)', () => {
    assert.equal(countryFromVatin('GB219334568'), 'GB')
    assert.equal(countryFromVatin('GB 123 4567 89 012'), 'GB')
    assert.equal(countryFromVatin('CHE-123.456.789 MWST'), 'CH')
    assert.equal(countryFromVatin('CHE-123.456.789 TVA'), 'CH')
    assert.equal(countryFromVatin('CHE123456789'), 'CH')
    assert.equal(countryFromVatin('NO123456789MVA'), 'NO')
    assert.equal(countryFromVatin('NO 123 456 789'), 'NO')
  })
  test('the owner’s own UID is never the supplier’s', () => {
    assert.equal(countryFromVatin(OWN), '')
    assert.equal(countryFromVatin('atu 123 456 75'), '')
  })
  test('half-typed or a bare prefix: nothing yet (L3)', () => {
    for (const v of ['ATU', 'ATU7', 'ATU7356924', 'ATU735692481', 'DE', 'DE1234567', 'PL123', 'GB12345678', 'GB1234567890', 'CHE-123.456', 'NO12345678']) {
      assert.equal(countryFromVatin(v), '', v)
    }
  })
  test('no country: AT without the U, the non-Union OSS number, a US tax number, unknown prefixes', () => {
    for (const v of ['AT12345678', 'EU372000041', '12-3456789', 'US123456789', 'XX123456789', 'CN91110000']) {
      assert.equal(countryFromVatin(v), '', v)
    }
  })
  test('XI (Northern Ireland): EU for goods, not for services — no country derived (L1)', () => {
    assert.equal(countryFromVatin('XI123456789'), '')
    assert.equal(countryFromVatin('XI 123 4567 89 012'), '')
  })
  test('nothing: none', () => {
    assert.equal(countryFromVatin(''), '')
    assert.equal(countryFromVatin(null), '')
    assert.equal(countryFromVatin(undefined), '')
  })
})

describe('vatOrigin — whose VAT a supplier charges', () => {
  test('an Austrian UID wins over any address (Amazon EU S.à r.l.: LU, ATU73569248)', () => {
    assert.deepEqual(vatOrigin('LU', AMAZON_ATU), { origin: 'AT', country: 'AT', uidCountry: 'AT', basis: 'atu-uid' })
    assert.deepEqual(vatOrigin('', AMAZON_ATU), { origin: 'AT', country: 'AT', uidCountry: 'AT', basis: 'atu-uid' })
    assert.deepEqual(vatOrigin('Austria', AMAZON_ATU), { origin: 'AT', country: 'AT', uidCountry: 'AT', basis: 'atu-uid' })
  })
  test('an Austrian address beats a foreign UID (NUKI: Graz, with a German UID)', () => {
    assert.deepEqual(vatOrigin('AT', 'DE123456789'), { origin: 'AT', country: 'AT', uidCountry: 'DE', basis: 'country' })
    assert.deepEqual(vatOrigin('at', null), { origin: 'AT', country: 'AT', uidCountry: '', basis: 'country' })
  })
  test('an EU state’s UID beats a different foreign address (L2: a CN address, a PL UID → PL)', () => {
    assert.deepEqual(vatOrigin('CN', 'PL1234567890'), { origin: 'foreign', country: 'PL', uidCountry: 'PL', basis: 'uid' })
    assert.deepEqual(vatOrigin('DE', 'IT12345678901'), { origin: 'foreign', country: 'IT', uidCountry: 'IT', basis: 'uid' })
  })
  test('the same country from address and UID: by the country', () => {
    assert.deepEqual(vatOrigin('DE', 'DE123456789'), { origin: 'foreign', country: 'DE', uidCountry: 'DE', basis: 'country' })
  })
  test('a foreign country without UID; a GB or CH UID does not move a foreign address', () => {
    assert.deepEqual(vatOrigin('DE', ''), { origin: 'foreign', country: 'DE', uidCountry: '', basis: 'country' })
    assert.deepEqual(vatOrigin('UK', null), { origin: 'foreign', country: 'GB', uidCountry: '', basis: 'country' })
    assert.deepEqual(vatOrigin('IE', 'GB219334568'), { origin: 'foreign', country: 'IE', uidCountry: 'GB', basis: 'country' })
  })
  test('no country: the UID’s prefix decides', () => {
    assert.deepEqual(vatOrigin('', 'PL1234567890'), { origin: 'foreign', country: 'PL', uidCountry: 'PL', basis: 'uid' })
    assert.deepEqual(vatOrigin(null, 'GB219334568'), { origin: 'foreign', country: 'GB', uidCountry: 'GB', basis: 'uid' })
    assert.deepEqual(vatOrigin(undefined, 'CHE-123.456.789 MWST'), { origin: 'foreign', country: 'CH', uidCountry: 'CH', basis: 'uid' })
  })
  test('unknown: no country and no UID, the owner’s own UID, a half-typed or XI UID, a country name', () => {
    const unknown = { origin: 'unknown', country: '', uidCountry: '', basis: 'none' }
    assert.deepEqual(vatOrigin('', ''), unknown)
    assert.deepEqual(vatOrigin(null, undefined), unknown)
    assert.deepEqual(vatOrigin('', OWN), unknown)
    assert.deepEqual(vatOrigin('', 'ATU7'), unknown)
    assert.deepEqual(vatOrigin('', 'XI123456789'), unknown)
    assert.deepEqual(vatOrigin('Austria', ''), unknown)
  })
  test('the owner’s own UID never counts: a LU address with it is foreign', () => {
    assert.deepEqual(vatOrigin('LU', OWN), { origin: 'foreign', country: 'LU', uidCountry: '', basis: 'country' })
  })
})

describe('regionOfCountry — the supplier_region of a country', () => {
  test('none and AT are Austria', () => {
    for (const c of ['', null, undefined, 'AT', 'at', ' AT ']) assert.equal(regionOfCountry(c), 'AT', String(c))
  })
  test('an EU state is EU, EL included', () => {
    for (const c of ['DE', 'EL', 'GR', 'pl', 'LU']) assert.equal(regionOfCountry(c), 'EU', c)
  })
  test('anything else is a third country, UK included', () => {
    for (const c of ['GB', 'UK', 'CH', 'US', 'CN', 'NO']) assert.equal(regionOfCountry(c), 'third_country', c)
  })
})

describe('looksOss — Austrian VAT charged under an EU state’s UID (one test for both jobs)', () => {
  test('Austrian rates that are not the UID state’s own: OSS — a PL seller at 20 %, an IT seller at 20 % (IT: 22 %), 4,9 % from anywhere', () => {
    assert.equal(looksOss('PL', [20]), true)
    assert.equal(looksOss('IT', [20]), true)
    assert.equal(looksOss('DE', [10, 20]), true)
    assert.equal(looksOss('FR', [4.9]), true)
  })
  test('a rate of the UID state’s own: its own VAT — FR 10 and 20, IT 10, HR 13, GR (EL…) 13, BG 20, ES and FI 10, PT and EE 13', () => {
    for (const [country, rates] of [['FR', [10]], ['FR', [20]], ['FR', [10, 20]], ['IT', [10]], ['HR', [13]], ['BG', [20]], ['ES', [10]], ['FI', [10]], ['PT', [13]], ['EE', [13]]] as const) {
      assert.equal(looksOss(country, rates), false, `${country} ${rates.join('/')}`)
    }
    assert.equal(looksOss(countryFromVatin('EL123456789'), [13]), false)
  })
  test('not OSS: a foreign rate, no rate, a country outside the EU or Austria, no UID country', () => {
    assert.equal(looksOss('PL', [23]), false)
    assert.equal(looksOss('PL', [20, 23]), false)
    assert.equal(looksOss('PL', []), false)
    for (const c of ['GB', 'CH', 'AT', '']) assert.equal(looksOss(c, [20]), false, c)
  })
  test('the year’s Austrian rates when given (a „Vorsteuer Inland“ that takes only 20 %)', () => {
    assert.equal(looksOss('PL', [10], [20]), false)
    assert.equal(looksOss('PL', [20], [20]), true)
  })
  test('EU_OWN_RATES: the 2026 rates of the states whose rates meet an Austrian one, keyed as countryFromVatin names them (GR, never EL)', () => {
    assert.deepEqual(Object.keys(EU_OWN_RATES).sort(), ['BG', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IT', 'PT'])
    for (const c of Object.keys(EU_OWN_RATES)) {
      assert.ok(EU_COUNTRY_CODES.has(c), c)
      assert.ok(EU_OWN_RATES[c].some(r => AT_VAT_RATES.includes(r)), `${c} shares a rate with Austria`)
    }
    assert.deepEqual(EU_OWN_RATES.FR, [20, 10, 5.5, 2.1])
    assert.deepEqual(EU_OWN_RATES.IT, [22, 10, 5, 4])
  })
})

describe('supplierAtuInText — the supplier’s Austrian UID in a receipt’s text', () => {
  test('the one ATU number that is not the owner’s', () => {
    const text = `Amazon EU S.à r.l.\nUSt-IdNr.: ${AMAZON_ATU}\nRechnung an: Muster\nIhre UID: ${OWN}\nUSt 20 % 6,56 €`
    assert.equal(supplierAtuInText(text), AMAZON_ATU)
  })
  test('single spaces between the digits, lower case, the same number twice', () => {
    assert.equal(supplierAtuInText('UID ATU 7356 9248'), AMAZON_ATU)
    assert.equal(supplierAtuInText('uid atu73569248'), AMAZON_ATU)
    assert.equal(supplierAtuInText(`${AMAZON_ATU} … ATU 73569248`), AMAZON_ATU)
  })
  test('the word „ATU-Nummer“ is no number', () => {
    assert.equal(supplierAtuInText(`ATU-Nummer: ${AMAZON_ATU}`), AMAZON_ATU)
  })
  test('only the owner’s own, or none: none', () => {
    assert.equal(supplierAtuInText(`Ihre UID: ${OWN}`), '')
    assert.equal(supplierAtuInText('Rechnung ohne UID, DE123456789'), '')
    assert.equal(supplierAtuInText(''), '')
    assert.equal(supplierAtuInText(null), '')
    assert.equal(supplierAtuInText(undefined), '')
  })
  test('two different supplier numbers: none — whose is whose is not ours to guess', () => {
    assert.equal(supplierAtuInText(`${AMAZON_ATU} und ATU12345678`), '')
  })
  test('not part of a longer number, not a half-typed one', () => {
    assert.equal(supplierAtuInText('ATU735692481'), '')
    assert.equal(supplierAtuInText('ATU7356924'), '')
  })
})

describe('client-safe', () => {
  test('lib/vat-origin.ts imports only lib/vatin.ts and reads no env variable of its own', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'vat-origin.ts'), 'utf8')
    const imports = Array.from(src.matchAll(/(?:\bfrom|\bimport|\brequire\()\s*['"]([^'"]+)['"]/g)).map(m => m[1])
    assert.deepEqual(imports, ['./vatin'])
    assert.doesNotMatch(src, /process\.env/)
  })
})
