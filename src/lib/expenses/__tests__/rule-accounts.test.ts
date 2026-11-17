import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  RULE_FIELD_LABEL, checkRules, missingAccountsText, missingRuleAccounts, normName, ptAfterCostPick, resolveExampleAccount,
  ruleCheckSummary, staleRuleAccounts, type MissingRuleAccount, type RuleLite, type YearAccount, type YearLists,
} from '../rule-accounts'

// Synthetic only. The 2026 ids are bookamat's, as in booking-validation.test.ts; the 2027
// lists are made up, every id shifted by 100000.
const ids = (...n: number[]) => n.map(id => ({ id }))
const L26 = { cost_accounts: ids(28213, 28209, 28215), purchasetax_accounts: ids(6589, 6594, 6601), bank_accounts: ids(3219, 3224) }
const L27 = {
  cost_accounts: ids(128213, 128209, 128215), purchasetax_accounts: ids(106589, 106594, 106601), bank_accounts: ids(103219, 103224),
}
const RULE = { cost_account_id: 28213, purchasetax_account_id: 6589, bank_account_id: 3224 }
// An id read as text (a hand-made row, an old export)
const text = (n: number) => String(n) as unknown as number

describe('RULE_FIELD_LABEL', () => {
  test('the rule editor’s labels', () => {
    assert.deepEqual(RULE_FIELD_LABEL, {
      cost_account_id: 'Steuerkonto', purchasetax_account_id: 'Umsatzsteuerkonto', bank_account_id: 'Zahlungsmittelkonto',
    })
  })
})

describe('missingRuleAccounts', () => {
  test('all present → []', () => {
    assert.deepEqual(missingRuleAccounts(RULE, L26), [])
    assert.deepEqual(missingRuleAccounts({ cost_account_id: 128213, purchasetax_account_id: 106589, bank_account_id: 103224 }, L27), [])
  })
  test('each field missing alone', () => {
    assert.deepEqual(missingRuleAccounts({ ...RULE, cost_account_id: 128213 }, L26), [{ field: 'cost_account_id', id: 128213 }])
    assert.deepEqual(missingRuleAccounts({ ...RULE, purchasetax_account_id: 106589 }, L26), [{ field: 'purchasetax_account_id', id: 106589 }])
    assert.deepEqual(missingRuleAccounts({ ...RULE, bank_account_id: 103224 }, L26), [{ field: 'bank_account_id', id: 103224 }])
  })
  test('a 2026 rule against the 2027 lists: all three, in field order', () => {
    assert.deepEqual(missingRuleAccounts(RULE, L27), [
      { field: 'cost_account_id', id: 28213 },
      { field: 'purchasetax_account_id', id: 6589 },
      { field: 'bank_account_id', id: 3224 },
    ])
  })
  test('Vorsteuerkonto 0 (a 0 % rule) and bank 0 (the form’s default) are not missing', () => {
    assert.deepEqual(missingRuleAccounts({ ...RULE, purchasetax_account_id: 0, bank_account_id: 0 }, L26), [])
    assert.deepEqual(missingRuleAccounts({ cost_account_id: 28213, purchasetax_account_id: 0, bank_account_id: 0 }, L27),
      [{ field: 'cost_account_id', id: 28213 }])
  })
  test('null or absent fields are none', () => {
    assert.deepEqual(missingRuleAccounts({ cost_account_id: 28213, purchasetax_account_id: null }, L26), [])
    assert.deepEqual(missingRuleAccounts({}, L27), [])
  })
  test('the Vorsteuerkonto is looked up among all Umsatzsteuerkonten, not only the Steuerkonto’s', () => {
    // 6594 is not linked to 28209 (Internet) in bookamat; validatePayload says that
    assert.deepEqual(missingRuleAccounts({ cost_account_id: 28209, purchasetax_account_id: 6594, bank_account_id: 3219 }, L26), [])
  })
  test('ids read as text are compared as numbers', () => {
    assert.deepEqual(missingRuleAccounts({ cost_account_id: text(28213), purchasetax_account_id: text(6589), bank_account_id: text(3224) }, L26), [])
    assert.deepEqual(missingRuleAccounts({ cost_account_id: text(28213) }, L27), [{ field: 'cost_account_id', id: 28213 }])
    const textLists = { cost_accounts: [{ id: text(28213) }], purchasetax_accounts: [{ id: text(6589) }], bank_accounts: [{ id: text(3224) }] }
    assert.deepEqual(missingRuleAccounts(RULE, textLists), [])
  })
  test('a list null or empty: not known, null', () => {
    assert.equal(missingRuleAccounts(RULE, null), null)
    assert.equal(missingRuleAccounts(RULE, undefined), null)
    for (const list of ['cost_accounts', 'purchasetax_accounts', 'bank_accounts'] as const) {
      assert.equal(missingRuleAccounts(RULE, { ...L26, [list]: null }), null, `${list} null`)
      assert.equal(missingRuleAccounts(RULE, { ...L26, [list]: [] }), null, `${list} empty`)
      assert.equal(missingRuleAccounts(RULE, { ...L26, [list]: undefined }), null, `${list} absent`)
    }
  })
})

describe('missingAccountsText', () => {
  const cost: MissingRuleAccount = { field: 'cost_account_id', id: 28213 }
  const pt: MissingRuleAccount = { field: 'purchasetax_account_id', id: 6589 }
  const bank: MissingRuleAccount = { field: 'bank_account_id', id: 3224 }
  test('one field', () => {
    assert.equal(missingAccountsText([cost], 2027), 'Steuerkonto #28213 gibt es in 2027 nicht')
    assert.equal(missingAccountsText([bank], 2027), 'Zahlungsmittelkonto #3224 gibt es in 2027 nicht')
  })
  test('two fields: joined by „und“', () => {
    assert.equal(missingAccountsText([cost, bank], 2027), 'Steuerkonto #28213 und Zahlungsmittelkonto #3224 gibt es in 2027 nicht')
  })
  test('three fields: „a, b und c“', () => {
    assert.equal(missingAccountsText([cost, pt, bank], 2027),
      'Steuerkonto #28213, Umsatzsteuerkonto #6589 und Zahlungsmittelkonto #3224 gibt es in 2027 nicht')
  })
  test('year unknown: „in bookamat“', () => {
    for (const y of [null, undefined, NaN]) {
      assert.equal(missingAccountsText([pt], y), 'Umsatzsteuerkonto #6589 gibt es in bookamat nicht', String(y))
    }
  })
  test('nothing missing: empty', () => {
    assert.equal(missingAccountsText([], 2027), '')
  })
})

describe('staleRuleAccounts', () => {
  test('all present → []', () => {
    assert.deepEqual(staleRuleAccounts(RULE, L26, 2026), [])
  })
  test('each stale field with its own line, named by field', () => {
    assert.deepEqual(staleRuleAccounts(RULE, L27, 2027), [
      { field: 'cost_account_id', message: 'Steuerkonto #28213 gibt es in 2027 nicht — neu wählen' },
      { field: 'purchasetax_account_id', message: 'Umsatzsteuerkonto #6589 gibt es in 2027 nicht — neu wählen' },
      { field: 'bank_account_id', message: 'Zahlungsmittelkonto #3224 gibt es in 2027 nicht — neu wählen' },
    ])
  })
  test('Vorsteuerkonto 0 and bank 0 are not stale', () => {
    assert.deepEqual(staleRuleAccounts({ cost_account_id: 128213, purchasetax_account_id: 0, bank_account_id: 0 }, L27, 2027), [])
  })
  test('lists not known: []', () => {
    assert.deepEqual(staleRuleAccounts(RULE, null, 2027), [])
    assert.deepEqual(staleRuleAccounts(RULE, { ...L27, bank_accounts: [] }, 2027), [])
  })
  test('year unknown: „in bookamat“', () => {
    assert.deepEqual(staleRuleAccounts({ ...RULE, cost_account_id: 128213 }, L26, null),
      [{ field: 'cost_account_id', message: 'Steuerkonto #128213 gibt es in bookamat nicht — neu wählen' }])
  })
})

// The rule editor's Steuerkonto pick in January (YEAR-1): a stale Umsatzsteuerkonto used to
// be reset to 0, which hid its line and let Save through with none
describe('ptAfterCostPick', () => {
  const cost27 = { id: 128213, purchasetaxaccounts: [{ id: 106589 }, { id: 106594 }] }
  test('a stale one (another year’s id) is kept: its line stays and Save stays blocked', () => {
    assert.equal(ptAfterCostPick(6589, cost27, L27), 6589)
    assert.deepEqual(staleRuleAccounts({ cost_account_id: 128213, purchasetax_account_id: 6589, bank_account_id: 103224 }, L27, 2027),
      [{ field: 'purchasetax_account_id', message: 'Umsatzsteuerkonto #6589 gibt es in 2027 nicht — neu wählen' }])
  })
  test('one linked to the new Steuerkonto is kept (also when picked first)', () => {
    assert.equal(ptAfterCostPick(106594, cost27, L27), 106594)
    assert.equal(ptAfterCostPick(106589, cost27, L27), 106589)
  })
  test('a valid one not linked to the new Steuerkonto is cleared, as before', () => {
    assert.equal(ptAfterCostPick(106601, cost27, L27), 0)
  })
  test('none stays none', () => {
    assert.equal(ptAfterCostPick(0, cost27, L27), 0)
    assert.equal(ptAfterCostPick(null, cost27, L27), 0)
    assert.equal(ptAfterCostPick(undefined, cost27, L27), 0)
  })
  test('ids read as text are compared as numbers', () => {
    assert.equal(ptAfterCostPick(text(106594), cost27, L27), 106594)
    assert.equal(ptAfterCostPick(text(6589), cost27, L27), 6589)
  })
  test('a Steuerkonto without links, or the Umsatzsteuerkonten not known: cleared unless linked', () => {
    assert.equal(ptAfterCostPick(106594, { purchasetaxaccounts: [] }, L27), 0)
    assert.equal(ptAfterCostPick(106594, {}, L27), 0)
    assert.equal(ptAfterCostPick(106594, undefined, L27), 0)
    assert.equal(ptAfterCostPick(6589, cost27, null), 0)
    assert.equal(ptAfterCostPick(106594, cost27, { ...L27, purchasetax_accounts: [] }), 106594)
  })
})

describe('normName', () => {
  test('NFKC, lower case, whitespace collapsed and trimmed', () => {
    assert.equal(normName('  Geschäftskonto  -\tEasybank '), 'geschäftskonto - easybank')
    assert.equal(normName('ＩＮＴＥＲＮＥＴ'), 'internet')
    assert.equal(normName('Lizenzgebühren'), normName('Lizenzgebühren'))
    assert.equal(normName('Vorsteuer Inland'), 'vorsteuer inland')
  })
  test('nothing: empty', () => {
    assert.equal(normName(null), '')
    assert.equal(normName(undefined), '')
  })
})

// ── checkRules (Regel-Check) ──────────────────────────────────────────────────
// 2026 as booking-validation.test.ts has bookamat's lists; 2027 is made up: Steuerkonten
// and a bank renumbered (+100000), 28215 reused for another account, Vorsteuerkonten kept.
const pt = (id: number, name: string, group: '1' | '2'): YearAccount => ({ id, name, group })
const TAX = {
  vst: pt(6589, 'Vorsteuer Inland', '2'), igE: pt(6594, 'IG Erwerb von Leistungen', '2'),
  keineVst: pt(6601, 'Keine Vorsteuer', '2'), ust: pt(6588, 'Umsatzsteuer Inland', '1'),
}
const cost = (id: number, name: string, links: YearAccount[]): YearAccount =>
  ({ id, name, group: '2', purchasetaxaccounts: links.map(({ id, name }) => ({ id, name })) })
const Y26: YearLists = {
  year: 2026,
  cost_accounts: [
    cost(28213, 'Lizenzgebühren', [TAX.vst, TAX.igE, TAX.keineVst]), cost(28209, 'Internet', [TAX.vst, TAX.keineVst]),
    cost(28184, 'Sozialversicherung', [TAX.keineVst]), cost(28215, 'Bewirtungskosten', [TAX.vst, TAX.keineVst]),
  ],
  purchasetax_accounts: Object.values(TAX),
  bank_accounts: [{ id: 3219, name: 'Geschäftskonto - Musterbank' }, { id: 3224, name: 'Geschäftskonto - Easybank' }],
}
const Y27: YearLists = {
  year: 2027,
  cost_accounts: [
    cost(128213, 'Lizenzgebühren', [TAX.vst, TAX.igE, TAX.keineVst]), cost(128209, 'internet ', [TAX.vst, TAX.keineVst]),
    cost(28184, 'Sozialversicherung', [TAX.keineVst]), cost(28215, 'Werbung', [TAX.vst]),
    cost(128215, 'Bewirtungskosten', [TAX.keineVst]), cost(128216, 'Bewirtungskosten', [TAX.keineVst]),
  ],
  purchasetax_accounts: Object.values(TAX),
  bank_accounts: [{ id: 3219, name: 'Geschäftskonto - Musterbank' }, { id: 103224, name: 'Geschäftskonto  -  Easybank' }],
}
const rule = (name: string, costId: number, ptId: number, bank: number, active = true): RuleLite =>
  ({ id: `rule-${name}`, name, active, cost_account_id: costId, purchasetax_account_id: ptId, bank_account_id: bank })

describe('checkRules', () => {
  test('an id 2027 lacks gets its one same-named candidate', () => {
    const out = checkRules([rule('Adobe', 28213, 6594, 3219)], Y26, Y27)
    assert.deepEqual(out, [{
      rule_id: 'rule-Adobe', rule_name: 'Adobe', active: true, field: 'cost_account_id', id: 28213, kind: 'missing',
      source_name: 'Lizenzgebühren', candidates: [{ id: 128213, name: 'Lizenzgebühren', linked: null }],
      text: 'Steuerkonto „Lizenzgebühren“ (#28213) gibt es in 2027 nicht — gleichnamig in 2027: #128213',
    }])
  })
  test('case and spaces do not matter', () => {
    const out = checkRules([rule('Magenta', 28209, 6589, 3224)], Y26, Y27)
    assert.deepEqual(out.map(i => [i.field, i.candidates.map(c => c.id)]), [['cost_account_id', [128209]], ['bank_account_id', [103224]]])
    assert.equal(out[1].text, 'Zahlungsmittelkonto „Geschäftskonto - Easybank“ (#3224) gibt es in 2027 nicht — gleichnamig in 2027: #103224')
  })
  test('an id reused for another account is reported, never kept silently', () => {
    const out = checkRules([rule('Restaurant', 28215, 6589, 3219)], Y26, Y27)
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'renamed')
    assert.equal(out[0].text, 'Steuerkonto #28215 heißt in 2027 „Werbung“, in 2026 „Bewirtungskosten“ — prüfen')
  })
  test('two same-named accounts: both listed, none picked', () => {
    const y27 = { ...Y27, cost_accounts: Y27.cost_accounts.filter(a => a.id !== 28215) }
    const out = checkRules([rule('Restaurant', 28215, 6589, 3219)], Y26, y27)
    assert.equal(out[0].text, 'Steuerkonto „Bewirtungskosten“ (#28215) gibt es in 2027 nicht — 2 gleichnamige Konten in 2027: #128215, #128216 — von Hand wählen')
    assert.deepEqual(out[0].candidates.map(c => c.id), [128215, 128216])
  })
  test('the same id under the same name is fine; a Vorsteuerkonto of 0 is none', () => {
    assert.deepEqual(checkRules([rule('SVS', 28184, 0, 3219)], Y26, Y27), [])
    assert.deepEqual(checkRules([rule('SVS', 28184, 6601, 3219)], Y26, Y27), [])
  })
  test('an unlinked Vorsteuer candidate is marked', () => {
    const y27 = { ...Y27, purchasetax_accounts: [...Y27.purchasetax_accounts.filter(a => a.id !== 6589), pt(106589, 'Vorsteuer Inland', '2')] }
    const out = checkRules([rule('Adobe', 28213, 6589, 3219)], Y26, y27)
    const v = out.find(i => i.field === 'purchasetax_account_id')!
    assert.equal(v.text, 'Umsatzsteuerkonto „Vorsteuer Inland“ (#6589) gibt es in 2027 nicht — gleichnamig in 2027: #106589 (nicht mit dem Steuerkonto verknüpft)')
    assert.deepEqual(v.candidates, [{ id: 106589, name: 'Vorsteuer Inland', linked: false }])
    // Linked to the rule's Steuerkonto in 2027 (found by its name): no mark
    const linked = { ...y27, cost_accounts: [cost(128213, 'Lizenzgebühren', [pt(106589, 'Vorsteuer Inland', '2')])] }
    assert.equal(checkRules([rule('Adobe', 28213, 6589, 3219)], Y26, linked).find(i => i.field === 'purchasetax_account_id')!.text,
      'Umsatzsteuerkonto „Vorsteuer Inland“ (#6589) gibt es in 2027 nicht — gleichnamig in 2027: #106589')
  })
  test('a candidate on the other side is no candidate', () => {
    const y27 = { ...Y27, purchasetax_accounts: [pt(106589, 'Vorsteuer Inland', '1')] }
    const v = checkRules([rule('Adobe', 28213, 6589, 3219)], Y26, y27).find(i => i.field === 'purchasetax_account_id')!
    assert.equal(v.text, 'Umsatzsteuerkonto „Vorsteuer Inland“ (#6589) gibt es in 2027 nicht — kein gleichnamiges Konto, von Hand wählen')
    assert.deepEqual(v.candidates, [])
  })
  test('an id in neither year; inactive rules are checked and marked', () => {
    const out = checkRules([rule('Alt', 11111, 6589, 3219, false)], Y26, Y27)
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'unknown')
    assert.equal(out[0].active, false)
    assert.equal(out[0].text, 'Steuerkonto #11111 gibt es weder in 2026 noch in 2027 — neu wählen')
  })
  test('ids read as text are compared as numbers', () => {
    const textRule = { ...rule('SVS', 28184, 6601, 3219), cost_account_id: '28184' as unknown as number }
    assert.deepEqual(checkRules([textRule], Y26, Y27), [])
  })
  test('2026 against 2026 finds nothing to change; every rule in order', () => {
    const rules = [rule('Adobe', 28213, 6594, 3219), rule('Magenta', 28209, 6589, 3224), rule('Restaurant', 28215, 6589, 3219)]
    assert.deepEqual(checkRules(rules, Y26, Y26), [])
    assert.deepEqual(checkRules(rules, Y26, Y27).map(i => `${i.rule_name} ${i.field}`), [
      'Adobe cost_account_id', 'Magenta cost_account_id', 'Magenta bank_account_id', 'Restaurant cost_account_id',
    ])
  })
})

// The Regel-Check's summary line (UI-03): n rules checked, k of them with an issue
describe('ruleCheckSummary', () => {
  test('no rules: nothing to check', () => {
    assert.equal(ruleCheckSummary(0, 0, 2027), 'Keine Buchungsregeln vorhanden — nichts zu prüfen.')
  })
  test('none with an issue: „Die Regel passt“ for one, „Alle {n} Regeln passen“ for more', () => {
    assert.equal(ruleCheckSummary(1, 0, 2027), 'Die Regel passt zu 2027.')
    assert.equal(ruleCheckSummary(2, 0, 2027), 'Alle 2 Regeln passen zu 2027.')
    assert.equal(ruleCheckSummary(8, 0, 2026), 'Alle 8 Regeln passen zu 2026.')
  })
  test('one with an issue: „braucht“', () => {
    assert.equal(ruleCheckSummary(1, 1, 2027), 'Die Regel braucht in 2027 andere Konten:')
    assert.equal(ruleCheckSummary(8, 1, 2027), '1 von 8 Regeln braucht in 2027 andere Konten:')
  })
  test('more with issues: „brauchen“', () => {
    assert.equal(ruleCheckSummary(8, 2, 2027), '2 von 8 Regeln brauchen in 2027 andere Konten:')
    assert.equal(ruleCheckSummary(8, 8, 2027), '8 von 8 Regeln brauchen in 2027 andere Konten:')
  })
})

// ── resolveExampleAccount (few-shot examples across years) ─────────────────────────
// A 2026 booking's accounts taught while 2027 is set (Y27 above: Steuerkonten renumbered,
// 28215 reused for „Werbung“, two „Bewirtungskosten“, 28184 kept)
describe('resolveExampleAccount', () => {
  test('this year’s account: unchanged', () => {
    assert.deepEqual(resolveExampleAccount({ id: 28213, name: 'Lizenzgebühren' }, Y26.cost_accounts), { id: 28213, name: 'Lizenzgebühren' })
    assert.deepEqual(resolveExampleAccount({ id: 28184, name: 'Sozialversicherung' }, Y27.cost_accounts), { id: 28184, name: 'Sozialversicherung' })
    assert.deepEqual(resolveExampleAccount({ id: 6589, name: 'Vorsteuer Inland' }, Y27.purchasetax_accounts), { id: 6589, name: 'Vorsteuer Inland' })
  })
  test('last year’s account: its id in this year, found by name (case and spaces do not matter)', () => {
    assert.deepEqual(resolveExampleAccount({ id: 28213, name: 'Lizenzgebühren' }, Y27.cost_accounts), { id: 128213, name: 'Lizenzgebühren' })
    assert.deepEqual(resolveExampleAccount({ id: 28209, name: 'Internet' }, Y27.cost_accounts), { id: 128209, name: 'Internet' })
    assert.deepEqual(resolveExampleAccount({ id: 3224, name: 'Geschäftskonto - Easybank' }, Y27.bank_accounts), { id: 103224, name: 'Geschäftskonto - Easybank' })
  })
  test('an id reused for another account is never copied: the one of that name, else the name alone', () => {
    // 28215 is „Werbung“ in 2027, and two accounts there are called „Bewirtungskosten“
    assert.deepEqual(resolveExampleAccount({ id: 28215, name: 'Bewirtungskosten' }, Y27.cost_accounts), { id: null, name: 'Bewirtungskosten' })
    const one = Y27.cost_accounts.filter(a => a.id !== 128216)
    assert.deepEqual(resolveExampleAccount({ id: 28215, name: 'Bewirtungskosten' }, one), { id: 128215, name: 'Bewirtungskosten' })
    // no account of that name at all
    assert.deepEqual(resolveExampleAccount({ id: 11111, name: 'Fortbildung' }, Y27.cost_accounts), { id: null, name: 'Fortbildung' })
  })
  test('no lists (not known): as given', () => {
    const a = { id: 28215, name: 'Bewirtungskosten' }
    assert.deepEqual(resolveExampleAccount(a, null), a)
    assert.deepEqual(resolveExampleAccount(a, undefined), a)
    assert.deepEqual(resolveExampleAccount(a, []), a)
    assert.deepEqual(resolveExampleAccount(null, null), { id: null, name: '' })
  })
  test('no name: the id when the list has it', () => {
    assert.deepEqual(resolveExampleAccount({ id: 28184 }, Y27.cost_accounts), { id: 28184, name: '' })
    assert.deepEqual(resolveExampleAccount({ id: 28213 }, Y27.cost_accounts), { id: null, name: '' })
    assert.deepEqual(resolveExampleAccount(undefined, Y27.cost_accounts), { id: null, name: '' })
  })
  test('ids read as text are compared as numbers', () => {
    assert.deepEqual(resolveExampleAccount({ id: text(28184), name: 'Sozialversicherung' }, Y27.cost_accounts), { id: 28184, name: 'Sozialversicherung' })
  })
})
