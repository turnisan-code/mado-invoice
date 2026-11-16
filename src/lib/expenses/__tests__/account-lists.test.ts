import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifierLists } from '../account-lists'
import { isAssetAccount, locksOf } from '../account-locks'
import { allowedRates } from '../vat-origin'
import { taxAccountSide } from '../tax-accounts'

// bookamat's answers as lib/bookamat.ts gets them (made-up ids; the 2026 names and
// fields as facts.md read them through /api/bookamat-accounts)
const KEINE_VST_LINK = { id: 6601, name: 'Keine Vorsteuer' }
const VST_INLAND_LINK = { id: 6589, name: 'Vorsteuer Inland' }
const costRows = [
  {
    id: 28229, name: 'Betriebs- und Geschäftsausstattung', group: '2', section: 'Anlagen',
    purchasetaxaccounts: [VST_INLAND_LINK, KEINE_VST_LINK],
    deductibility_tax_percent: null, deductibility_amount_percent: '0.00', inventory: true,
    description: 'über EUR 1000 Netto',
  },
  {
    id: 28212, name: 'Geringwertige WG (Betriebsausgabe)', group: '2', section: 'Aufwand',
    purchasetaxaccounts: [VST_INLAND_LINK, KEINE_VST_LINK],
    deductibility_tax_percent: null, deductibility_amount_percent: null, inventory: false,
  },
  // An older cached answer without the newer fields
  { id: 28209, name: 'Internet', group: '2', section: 'Aufwand', purchasetaxaccounts: [VST_INLAND_LINK] },
]
const bankRows = [{ id: 3224, name: 'Easybank', iban: 'AT611904300234573201', position: 1 }]
const ptRows = [
  { id: 6589, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00', '13.00', '4.90'] },
  { id: 6601, name: 'Keine Vorsteuer', group: '2', tax_values: ['0.00'] },
  { id: 6603, name: 'Vorsteuer Rückforderung EU', group: '2', tax_values: [''] },
  { id: 6588, name: 'Umsatzsteuer Inland', group: '1', tax_values: ['20.00', '10.00', '13.00', '4.90'] },
  { id: 6700, name: 'Einfuhr-UST (Zollbehörde)' },   // no group, no tax_values
]

describe('classifierLists — the year’s lists as the expense classifier reads them', () => {
  const lists = classifierLists(costRows, bankRows, ptRows)

  test('Steuerkonten: links, the BA locks and the asset flag; null where bookamat says nothing', () => {
    assert.deepEqual(lists.cost_accounts, [
      {
        id: 28229, name: 'Betriebs- und Geschäftsausstattung', purchasetaxaccounts: [VST_INLAND_LINK, KEINE_VST_LINK],
        deductibility_tax_percent: null, deductibility_amount_percent: '0.00', inventory: true,
      },
      {
        id: 28212, name: 'Geringwertige WG (Betriebsausgabe)', purchasetaxaccounts: [VST_INLAND_LINK, KEINE_VST_LINK],
        deductibility_tax_percent: null, deductibility_amount_percent: null, inventory: false,
      },
      {
        id: 28209, name: 'Internet', purchasetaxaccounts: [VST_INLAND_LINK],
        deductibility_tax_percent: null, deductibility_amount_percent: null, inventory: null,
      },
    ])
  })
  test('Zahlungsmittelkonten: id and name only', () => {
    assert.deepEqual(lists.bank_accounts, [{ id: 3224, name: 'Easybank' }])
  })
  test('Vorsteuer-/Umsatzsteuerkonten: bookamat’s group (the side) and the rates each takes', () => {
    assert.deepEqual(lists.purchasetax_accounts, [
      { id: 6589, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00', '13.00', '4.90'] },
      { id: 6601, name: 'Keine Vorsteuer', group: '2', tax_values: ['0.00'] },
      { id: 6603, name: 'Vorsteuer Rückforderung EU', group: '2', tax_values: [''] },
      { id: 6588, name: 'Umsatzsteuer Inland', group: '1', tax_values: ['20.00', '10.00', '13.00', '4.90'] },
      { id: 6700, name: 'Einfuhr-UST (Zollbehörde)', group: null, tax_values: null },
    ])
  })
  test('what the guards read comes through: the asset flag, the locks, the side, the rates', () => {
    const [bga, gwg, internet] = lists.cost_accounts
    assert.equal(isAssetAccount(bga), true)
    assert.equal(isAssetAccount(gwg), false)
    assert.equal(isAssetAccount(internet), false)
    assert.deepEqual(locksOf(bga), { tax: null, amount: 0 })
    assert.deepEqual(locksOf(internet), { tax: null, amount: null })
    const [vst, keine, rueck, ust] = lists.purchasetax_accounts
    assert.equal(taxAccountSide(ust), 'sales')
    assert.equal(taxAccountSide(vst), 'purchase')
    assert.deepEqual(allowedRates(vst), [20, 13, 10, 4.9])
    assert.deepEqual(allowedRates(keine), [0])
    assert.equal(allowedRates(rueck), null)
  })
  test('nothing else is copied (section, description, a bank’s IBAN)', () => {
    assert.ok(lists.cost_accounts.every(a => !('section' in a) && !('description' in a) && !('group' in a)))
    assert.ok(lists.bank_accounts.every(a => !('iban' in a)))
  })
  test('empty answers give empty lists', () => {
    assert.deepEqual(classifierLists([], [], []), { cost_accounts: [], bank_accounts: [], purchasetax_accounts: [] })
  })
})

describe('client-safe', () => {
  test('lib/account-lists.ts imports only types and reads no env variable', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'account-lists.ts'), 'utf8')
    const imports = Array.from(src.matchAll(/^import\b.*$/gm)).map(m => m[0])
    assert.deepEqual(imports, ["import type { BookamatAccounts } from '@/lib/expenses/types'"])
    assert.doesNotMatch(src, /process\.env|\brequire\(/)
  })
})
