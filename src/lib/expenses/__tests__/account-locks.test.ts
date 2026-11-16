import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GWG_LIMIT_NET, gwgExpenseAccount, isAssetAccount } from '../account-locks'

// bookamat 2026's Steuerkonten as facts.md read them (made-up ids): three asset accounts
// („Anlagen“, inventory true, BA Betrag locked 0) and the immediate-expense GWG account
const BGA = { id: 28229, name: 'Betriebs- und Geschäftsausstattung', inventory: true, deductibility_amount_percent: '0.00' }
const GWG_AFA = { id: 28230, name: 'Geringwertige WG (Abschreibung)', inventory: true, deductibility_amount_percent: '0.00' }
const SOFTWARE_AFA = { id: 28231, name: 'Software (Abschreibung)', inventory: true, deductibility_amount_percent: '0.00' }
const GWG = { id: 28212, name: 'Geringwertige WG (Betriebsausgabe)', inventory: false, deductibility_amount_percent: null }
const PRIVAT = { id: 28234, name: 'Privatentnahmen (allgemein)', inventory: false, deductibility_amount_percent: '0.00' }
const LIZENZ = { id: 28207, name: 'Lizenzgebühren', inventory: false, deductibility_amount_percent: null }
const COST_2026 = [BGA, GWG_AFA, SOFTWARE_AFA, GWG, PRIVAT, LIZENZ]

describe('isAssetAccount — bookamat’s „Anlagen“ by its inventory flag', () => {
  test('inventory true only', () => {
    for (const a of [BGA, GWG_AFA, SOFTWARE_AFA]) assert.equal(isAssetAccount(a), true, a.name)
  })
  test('false, null, absent, no account: not an asset', () => {
    assert.equal(isAssetAccount(GWG), false)
    assert.equal(isAssetAccount({ inventory: null }), false)
    assert.equal(isAssetAccount({}), false)
    assert.equal(isAssetAccount(null), false)
    assert.equal(isAssetAccount(undefined), false)
  })
  test('a BA Betrag lock of 0 alone is no asset (Privatentnahmen); nor a flag that is not true', () => {
    assert.equal(isAssetAccount(PRIVAT), false)
    assert.equal(isAssetAccount({ inventory: 'true' } as unknown as { inventory: boolean }), false)
  })
})

describe('GWG_LIMIT_NET — the GWG limit', () => {
  test('1.000 € (§ 13 EStG: not more than)', () => {
    assert.equal(GWG_LIMIT_NET, 1000)
  })
})

describe('gwgExpenseAccount — „Geringwertige WG (Betriebsausgabe)“, by name', () => {
  test('found among the year’s Steuerkonten, never the asset account „Geringwertige WG (Abschreibung)“', () => {
    assert.equal(gwgExpenseAccount(COST_2026), GWG)
    assert.equal(gwgExpenseAccount([GWG_AFA, BGA]), undefined)
  })
  test('in another year’s books (every id differs), spaces and case aside', () => {
    const next = COST_2026.map(a => ({ ...a, id: a.id + 100000 }))
    assert.equal(gwgExpenseAccount(next)?.id, 128212)
    const odd = { id: 1, name: '  geringwertige  WG (Betriebsausgabe) ', inventory: false }
    assert.equal(gwgExpenseAccount([odd]), odd)
  })
  test('one named so but flagged as an asset is never the target; a list without the flag still finds it', () => {
    assert.equal(gwgExpenseAccount([{ ...GWG, inventory: true }]), undefined)
    assert.equal(gwgExpenseAccount([{ id: 28212, name: 'Geringwertige WG (Betriebsausgabe)' }])?.id, 28212)
  })
  test('none in the books: undefined', () => {
    assert.equal(gwgExpenseAccount([BGA, LIZENZ, PRIVAT]), undefined)
    assert.equal(gwgExpenseAccount([]), undefined)
    assert.equal(gwgExpenseAccount(null), undefined)
    assert.equal(gwgExpenseAccount(undefined), undefined)
  })
})

describe('client-safe', () => {
  test('lib/account-locks.ts imports nothing and reads no env variable', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'account-locks.ts'), 'utf8')
    assert.doesNotMatch(src, /(?:\bfrom|\bimport|\brequire\()\s*['"]/)
    assert.doesNotMatch(src, /process\.env/)
  })
})
