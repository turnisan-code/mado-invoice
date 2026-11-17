import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  accountTaxRegion,
  keineVorsteuerOf,
  linkedTaxAccounts,
  purchasePool,
  taxAccountForRate,
  vorsteuerInlandOf,
  type TaxAccountLike,
} from '../tax-accounts'
import { payloadContext } from '../booking-payload'

// bookamat's Umsatzsteuer/Vorsteuer accounts as the 2026 books list them: group "1" is the
// sales side, "2" the purchase side (made-up ids, as the other fixtures use them)
const UST_INLAND = { id: 6588, name: 'Umsatzsteuer Inland', group: '1' }
const VST_INLAND = { id: 6589, name: 'Vorsteuer Inland', group: '2' }
const IG_LEISTUNGEN = { id: 6592, name: 'IG Leistungen', group: '1' }
const IG_ERWERB_LIEF = { id: 6593, name: 'IG Erwerb von Lieferungen', group: '2' }
const IG_ERWERB_LEIST = { id: 6594, name: 'IG Erwerb von Leistungen', group: '2' }
const DL_LEISTUNGEN = { id: 6596, name: 'Drittland Leistungen', group: '1' }
const DL_ERWERB = { id: 6597, name: 'Drittland Erwerb von Leistungen', group: '2' }
const EINFUHR = { id: 6598, name: 'Einfuhr-UST (Zollbehörde)', group: '2' }
const KEINE_UST = { id: 6600, name: 'Keine Umsatzsteuer', group: '1' }
const KEINE_VST = { id: 6601, name: 'Keine Vorsteuer', group: '2' }
const RUECK_EU = { id: 6603, name: 'Vorsteuer Rückforderung EU', group: '2' }
const PARA19 = { id: 6605, name: 'Umsätze §19', group: '1' }

const ALL: TaxAccountLike[] = [
  UST_INLAND, VST_INLAND, IG_LEISTUNGEN, IG_ERWERB_LIEF, IG_ERWERB_LEIST, DL_LEISTUNGEN, DL_ERWERB,
  EINFUHR, KEINE_UST, KEINE_VST, RUECK_EU, PARA19,
]
const PURCHASE_SIDE = [VST_INLAND, IG_ERWERB_LIEF, IG_ERWERB_LEIST, DL_ERWERB, EINFUHR, KEINE_VST, RUECK_EU]
const SALES_SIDE = [UST_INLAND, IG_LEISTUNGEN, DL_LEISTUNGEN, KEINE_UST, PARA19]

// A Steuerkonto's links as bookamat lists them: {id, name}, no group
const link = (...as: TaxAccountLike[]) => as.map(({ id, name }) => ({ id, name }))
// The same accounts in another year's books: every id differs
const nextYear = (a: TaxAccountLike) => ({ ...a, id: a.id + 100000 })

describe('accountTaxRegion — moved from lib/ai-classifier.ts', () => {
  test('by bookamat’s group first, then the name', () => {
    assert.equal(accountTaxRegion(VST_INLAND), 'domestic')
    assert.equal(accountTaxRegion(IG_ERWERB_LEIST), 'EU')
    assert.equal(accountTaxRegion(DL_ERWERB), 'third')
    assert.equal(accountTaxRegion(KEINE_VST), 'none')
    assert.equal(accountTaxRegion(RUECK_EU), 'refund')
    assert.equal(accountTaxRegion(EINFUHR), 'other')
    for (const a of SALES_SIDE) assert.equal(accountTaxRegion(a), 'outbound', a.name)
    // a bare name: the name decides
    assert.equal(accountTaxRegion('Vorsteuer 20%'), 'domestic')
    assert.equal(accountTaxRegion('Drittland Leistungen'), 'outbound')
  })
})

describe('linkedTaxAccounts — what a Steuer- or Ertragskonto allows on one side', () => {
  test('the linked ones, in the link order, with bookamat’s group from the full list', () => {
    const allowed = linkedTaxAccounts(ALL, link(VST_INLAND, IG_ERWERB_LEIST, DL_ERWERB, KEINE_VST), 'purchase')
    assert.deepEqual(allowed, [VST_INLAND, IG_ERWERB_LEIST, DL_ERWERB, KEINE_VST])
  })
  test('only the side asked for: an Ertragskonto’s sales accounts, never a Vorsteuer account on income', () => {
    const links = link(UST_INLAND, IG_LEISTUNGEN, KEINE_UST, VST_INLAND)
    assert.deepEqual(linkedTaxAccounts(ALL, links, 'sales'), [UST_INLAND, IG_LEISTUNGEN, KEINE_UST])
    assert.deepEqual(linkedTaxAccounts(ALL, links, 'purchase'), [VST_INLAND])
  })
  test('links none: that whole side of the list', () => {
    assert.deepEqual(linkedTaxAccounts(ALL, [], 'purchase'), PURCHASE_SIDE)
    assert.deepEqual(linkedTaxAccounts(ALL, undefined, 'purchase'), PURCHASE_SIDE)
    assert.deepEqual(linkedTaxAccounts(ALL, null, 'sales'), SALES_SIDE)
  })
  test('a link the list lacks stays, its side read from its name; no list at all: the links by name', () => {
    const unknown = { id: 9999, name: 'Vorsteuer Inland' }
    assert.deepEqual(linkedTaxAccounts(ALL, [unknown], 'purchase'), [unknown])
    assert.deepEqual(linkedTaxAccounts(undefined, link(VST_INLAND, UST_INLAND), 'purchase'), [{ id: 6589, name: 'Vorsteuer Inland' }])
    assert.deepEqual(linkedTaxAccounts(undefined, undefined, 'purchase'), [])
  })
})

describe('purchasePool — an expense’s Vorsteuerkonten', () => {
  test('the purchase side of what the Steuerkonto links; a sales account linked by mistake is left out', () => {
    assert.deepEqual(purchasePool(ALL, link(VST_INLAND, IG_ERWERB_LIEF, KEINE_VST, UST_INLAND)), [VST_INLAND, IG_ERWERB_LIEF, KEINE_VST])
  })
  test('links none: the whole purchase side', () => {
    assert.deepEqual(purchasePool(ALL, []), PURCHASE_SIDE)
  })
})

describe('keineVorsteuerOf — „Keine Vorsteuer“ in a pool, by name', () => {
  test('found in the pool, in any year’s books', () => {
    assert.equal(keineVorsteuerOf(purchasePool(ALL, link(VST_INLAND, KEINE_VST))), KEINE_VST)
    const all2027 = ALL.map(nextYear)
    assert.equal(keineVorsteuerOf(purchasePool(all2027, link(...[VST_INLAND, KEINE_VST].map(nextYear))))?.id, 106601)
  })
  test('none in the pool: undefined — „Keine Umsatzsteuer“ is not it', () => {
    assert.equal(keineVorsteuerOf([VST_INLAND, IG_ERWERB_LEIST]), undefined)
    assert.equal(keineVorsteuerOf([KEINE_UST]), undefined)
    assert.equal(keineVorsteuerOf([]), undefined)
    assert.equal(keineVorsteuerOf(null), undefined)
    assert.equal(keineVorsteuerOf(undefined), undefined)
  })
  test('the booking payload’s „Keine Vorsteuer“ for 0 % lines is the same one (the flat list of both sides)', () => {
    assert.equal(payloadContext({ purchasetax_accounts: ALL }).keineVorsteuerId, 6601)
    assert.equal(payloadContext({ purchasetax_accounts: [VST_INLAND] }).keineVorsteuerId, undefined)
  })
})

describe('vorsteuerInlandOf — „Vorsteuer Inland“ in a pool', () => {
  test('the domestic account named „… Inland“', () => {
    assert.equal(vorsteuerInlandOf(purchasePool(ALL, [])), VST_INLAND)
    assert.equal(vorsteuerInlandOf([{ id: 1, name: 'Vorsteuer 20%' }, VST_INLAND]), VST_INLAND)
  })
  test('an older chart without „Inland“: the first domestic one', () => {
    const v20 = { id: 1, name: 'Vorsteuer 20%' }
    assert.equal(vorsteuerInlandOf([KEINE_VST, v20, { id: 2, name: 'Vorsteuer 10%' }]), v20)
  })
  test('none domestic: undefined — never reverse charge, a refund, „Keine Vorsteuer“ or a sales account', () => {
    assert.equal(vorsteuerInlandOf([IG_ERWERB_LEIST, DL_ERWERB, RUECK_EU, KEINE_VST, EINFUHR, UST_INLAND]), undefined)
    assert.equal(vorsteuerInlandOf([]), undefined)
    assert.equal(vorsteuerInlandOf(null), undefined)
  })
})

describe('taxAccountForRate — the tax account for a rate among the allowed ones', () => {
  const purchase = [IG_ERWERB_LEIST, VST_INLAND, DL_ERWERB, KEINE_VST]
  const sales = [IG_LEISTUNGEN, UST_INLAND, KEINE_UST]
  test('purchase side: „Vorsteuer Inland“ above 0 % (4.9 % too), „Keine Vorsteuer“ at 0 %', () => {
    assert.equal(taxAccountForRate(purchase, 20, 'purchase'), VST_INLAND)
    assert.equal(taxAccountForRate(purchase, 4.9, 'purchase'), VST_INLAND)
    assert.equal(taxAccountForRate(purchase, 0, 'purchase'), KEINE_VST)
  })
  test('sales side: „Umsatzsteuer Inland“ above 0 %, „Keine Umsatzsteuer“ at 0 %', () => {
    assert.equal(taxAccountForRate(sales, 20, 'sales'), UST_INLAND)
    assert.equal(taxAccountForRate(sales, 0, 'sales'), KEINE_UST)
  })
  test('strict: none of that name → undefined; with fallback the first allowed', () => {
    const reverseCharge = [IG_ERWERB_LEIST, DL_ERWERB]
    assert.equal(taxAccountForRate(reverseCharge, 20, 'purchase'), undefined)
    assert.equal(taxAccountForRate(reverseCharge, 0, 'purchase'), undefined)
    assert.equal(taxAccountForRate(reverseCharge, 20, 'purchase', { fallback: true }), IG_ERWERB_LEIST)
    assert.equal(taxAccountForRate(reverseCharge, 0, 'purchase', { fallback: false }), undefined)
  })
  test('the name must start with it: „Vorsteuer Rückforderung EU“ is not „Vorsteuer Inland“', () => {
    assert.equal(taxAccountForRate([RUECK_EU], 20, 'purchase'), undefined)
  })
  test('spaces and case in the name do not matter', () => {
    const odd = { id: 7, name: '  vorsteuer   INLAND ' }
    assert.equal(taxAccountForRate([odd], 13, 'purchase'), odd)
  })
  test('nothing allowed: undefined, also with fallback', () => {
    assert.equal(taxAccountForRate([], 20, 'purchase', { fallback: true }), undefined)
    assert.equal(taxAccountForRate(null, 0, 'sales', { fallback: true }), undefined)
    assert.equal(taxAccountForRate(undefined, 0, 'purchase'), undefined)
  })
})

describe('client-safe', () => {
  test('lib/tax-accounts.ts imports nothing and reads no env variable', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'tax-accounts.ts'), 'utf8')
    assert.doesNotMatch(src, /(?:\bfrom|\bimport|\brequire\()\s*['"]/)
    assert.doesNotMatch(src, /process\.env/)
  })
})
