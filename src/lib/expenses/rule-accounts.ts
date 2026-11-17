// A Buchungsregel's bookamat accounts against the lists of the year set (PR 4b). bookamat
// keeps its account lists per year, so a rule saved in one year may name an id that the
// next year's books lack. Such an id is said, never replaced unseen, and every message
// names the field the owner fixes in the rule editor, by the editor's own labels.
//
// Pure and client-safe: the receipt page, the rule editor, the Regel-Check of the Settings
// actions, the classifiers' few-shot examples and the tests share it.
import { taxAccountSide } from './tax-accounts'

export type RuleField = 'cost_account_id' | 'purchasetax_account_id' | 'bank_account_id'

// The rule editor's labels (app/(app)/vendors/page.tsx)
export const RULE_FIELD_LABEL: Record<RuleField, string> = {
  cost_account_id: 'Steuerkonto',
  purchasetax_account_id: 'Umsatzsteuerkonto',
  bank_account_id: 'Zahlungsmittelkonto',
}

export type MissingRuleAccount = { field: RuleField; id: number }

type IdList = { id: number }[] | null | undefined
export type RuleAccountLists = {
  cost_accounts?: IdList
  purchasetax_accounts?: IdList
  bank_accounts?: IdList
} | null | undefined

const FIELDS: RuleField[] = ['cost_account_id', 'purchasetax_account_id', 'bank_account_id']
const LIST_OF: Record<RuleField, 'cost_accounts' | 'purchasetax_accounts' | 'bank_accounts'> = {
  cost_account_id: 'cost_accounts',
  purchasetax_account_id: 'purchasetax_accounts',
  bank_account_id: 'bank_accounts',
}

// The rule's non-zero ids that their list lacks, in field order. 0 is „none“: a
// Vorsteuerkonto of 0 is a 0 % rule, a bank of 0 takes the form's default. The
// Vorsteuerkonto is looked up among all Umsatzsteuerkonten; its link to the Steuerkonto
// is left to validatePayload. null when a list is not known (null or empty): then no id
// can be called missing.
export function missingRuleAccounts(
  rule: Partial<Record<RuleField, number | null>>, lists: RuleAccountLists,
): MissingRuleAccount[] | null {
  if (!lists || FIELDS.some(f => !lists[LIST_OF[f]]?.length)) return null
  const out: MissingRuleAccount[] = []
  for (const field of FIELDS) {
    // Compared as numbers: an id read as text is the same account
    const id = Number(rule[field] ?? 0)
    if (id === 0) continue
    if (!lists[LIST_OF[field]]!.some(a => Number(a.id) === id)) out.push({ field, id })
  }
  return out
}

const yearText = (year: number | null | undefined) =>
  typeof year === 'number' && Number.isInteger(year) ? String(year) : 'bookamat'

// „Steuerkonto #28213 gibt es in 2027 nicht“; two joined by „und“, three as „a, b und c“.
// Without a known year: „… gibt es in bookamat nicht“.
export function missingAccountsText(missing: MissingRuleAccount[], year: number | null | undefined): string {
  const names = missing.map(m => `${RULE_FIELD_LABEL[m.field]} #${m.id}`)
  if (!names.length) return ''
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`
  return `${list} gibt es in ${yearText(year)} nicht`
}

// The rule editor's line under each field whose id the year's lists lack; [] when the
// lists are not known
export function staleRuleAccounts(
  form: Partial<Record<RuleField, number | null>>, lists: RuleAccountLists, year: number | null | undefined,
): { field: RuleField; message: string }[] {
  return (missingRuleAccounts(form, lists) ?? []).map(m => ({
    field: m.field,
    message: `${missingAccountsText([m], year)} — neu wählen`,
  }))
}

// The rule editor's Umsatzsteuerkonto once a Steuerkonto is picked. A stale one (another
// year's id) is kept, so its line and the Save block stay until one of this year is
// picked; one linked to the new Steuerkonto is kept; any other is cleared (0), as before.
export function ptAfterCostPick(
  pt: number | null | undefined,
  cost: { purchasetaxaccounts?: { id: number }[] } | undefined,
  lists: RuleAccountLists,
): number {
  const id = Number(pt) || 0
  if (!id) return 0
  const known = lists?.purchasetax_accounts
  // stale: its red line and the Save block stay
  if (known?.length && !known.some(a => Number(a.id) === id)) return id
  return (cost?.purchasetaxaccounts ?? []).some(a => Number(a.id) === id) ? id : 0
}

// ─── Regel-Check (Einstellungen) ────────────────────────────────────────────────
// Every rule against another year's lists, before or after a switch. Reads nothing and
// writes nothing: the owner re-picks the accounts in the rule editor.

// An account as bookamat's lists give it. A Steuerkonto carries the Vorsteuerkonten it
// allows; a tax account its side (group „1“ sales, „2“ purchase).
export type YearAccount = { id: number; name: string; group?: string | number | null; purchasetaxaccounts?: { id: number; name: string }[] }
export type YearLists = { year: number; cost_accounts: YearAccount[]; purchasetax_accounts: YearAccount[]; bank_accounts: YearAccount[] }
export type RuleLite = {
  id: string; name: string; active?: boolean | null
  cost_account_id: number; purchasetax_account_id: number; bank_account_id: number
}
export type RuleIssue = {
  rule_id: string
  rule_name: string
  active: boolean
  field: RuleField
  id: number
  kind: 'missing' | 'renamed' | 'unknown'
  source_name: string | null
  candidates: { id: number; name: string; linked: boolean | null }[]
  text: string
}

// Account names compared as the owner reads them: Unicode-normalised, any case, runs of
// whitespace as one space
export const normName = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

const groupOf = (a: YearAccount) => (a.group == null ? null : String(a.group))
// A same-named account of the same kind: a Vorsteuerkonto only on its own side, a
// Steuerkonto only in its own group, any bank account
function sameKind(field: RuleField, a: YearAccount, b: YearAccount): boolean {
  if (field === 'bank_account_id') return true
  if (field === 'purchasetax_account_id') return taxAccountSide(a) === taxAccountSide(b)
  const ga = groupOf(a), gb = groupOf(b)
  return ga == null || gb == null || ga === gb
}

// For each rule, active or not: every account id that `target` lacks, with the
// same-named accounts of `target` as candidates (none is picked), and every id that
// `target` has under another name than `source` (an id reused for another account).
// A Vorsteuerkonto or bank of 0 is „none“ and never an issue.
export function checkRules(rules: RuleLite[], source: YearLists, target: YearLists): RuleIssue[] {
  const out: RuleIssue[] = []
  const T = target.year, S = source.year
  const find = (list: YearAccount[], id: number) => list.find(a => Number(a.id) === id)
  for (const rule of rules) {
    const active = rule.active !== false
    // The rule's Steuerkonto in `target`, for the link of a Vorsteuer candidate
    const costId = Number(rule.cost_account_id) || 0
    const costInTarget = find(target.cost_accounts, costId) ?? (() => {
      const src = find(source.cost_accounts, costId)
      const same = src ? target.cost_accounts.filter(a => normName(a.name) === normName(src.name)) : []
      return same.length === 1 ? same[0] : undefined
    })()
    for (const field of FIELDS) {
      const id = Number(rule[field]) || 0
      if (!id) continue
      const label = RULE_FIELD_LABEL[field]
      const inTarget = find(target[LIST_OF[field]], id)
      const inSource = find(source[LIST_OF[field]], id)
      const base = { rule_id: rule.id, rule_name: rule.name, active, field, id }
      if (inTarget) {
        if (S !== T && inSource && normName(inSource.name) !== normName(inTarget.name)) {
          out.push({
            ...base, kind: 'renamed', source_name: inSource.name, candidates: [],
            text: `${label} #${id} heißt in ${T} „${inTarget.name}“, in ${S} „${inSource.name}“ — prüfen`,
          })
        }
        continue
      }
      if (!inSource) {
        out.push({ ...base, kind: 'unknown', source_name: null, candidates: [], text: `${label} #${id} gibt es weder in ${S} noch in ${T} — neu wählen` })
        continue
      }
      // null = not known (the Steuerkonto or its links are not in `target`)
      const linked = (c: YearAccount): boolean | null => {
        if (field !== 'purchasetax_account_id') return null
        const links = costInTarget?.purchasetaxaccounts ?? []
        return links.length ? links.some(l => Number(l.id) === Number(c.id)) : null
      }
      const candidates = target[LIST_OF[field]]
        .filter(a => normName(a.name) === normName(inSource.name) && sameKind(field, inSource, a))
        .map(a => ({ id: Number(a.id), name: a.name, linked: linked(a) }))
      const head = `${label} „${inSource.name}“ (#${id}) gibt es in ${T} nicht`
      const text = candidates.length === 0
        ? `${head} — kein gleichnamiges Konto, von Hand wählen`
        : candidates.length === 1
          ? `${head} — gleichnamig in ${T}: #${candidates[0].id}${candidates[0].linked === false ? ' (nicht mit dem Steuerkonto verknüpft)' : ''}`
          : `${head} — ${candidates.length} gleichnamige Konten in ${T}: ${candidates.map(c => `#${c.id}`).join(', ')} — von Hand wählen`
      out.push({ ...base, kind: 'missing', source_name: inSource.name, candidates, text })
    }
  }
  return out
}

// The Regel-Check's summary: `n` rules checked against `T`'s lists, `k` of them with an
// issue. With issues it ends in a colon: one line per issue follows.
export function ruleCheckSummary(n: number, k: number, T: number): string {
  if (n === 0) return 'Keine Buchungsregeln vorhanden — nichts zu prüfen.'
  if (k === 0) return n === 1 ? `Die Regel passt zu ${T}.` : `Alle ${n} Regeln passen zu ${T}.`
  if (k === 1) return n === 1 ? `Die Regel braucht in ${T} andere Konten:` : `1 von ${n} Regeln braucht in ${T} andere Konten:`
  return `${k} von ${n} Regeln brauchen in ${T} andere Konten:`
}

// ─── Few-shot examples across years ─────────────────────────────────────────────
// A past booking names its own year's accounts. Taught to the classifier, it may name
// only accounts of the year set: the same id under the same name stays; else the one
// account of that name in `list` gives its id; else the name alone (id null), so an id
// another year reused for another account is never copied. Without a list (null or
// empty: not known) the account is as given. The name is always the booking's own.
export function resolveExampleAccount(
  a: { id?: number; name?: string } | null | undefined,
  list?: { id: number; name: string }[] | null,
): { id: number | null; name: string } {
  const id = a?.id != null && Number.isFinite(Number(a.id)) ? Number(a.id) : null
  const name = a?.name ?? ''
  if (!list?.length) return { id, name }
  const byId = id == null ? undefined : list.find(x => Number(x.id) === id)
  // No name to check it by: the id when the year has it
  if (!normName(name)) return { id: byId ? id : null, name }
  if (byId && normName(byId.name) === normName(name)) return { id, name }
  const same = list.filter(x => normName(x.name) === normName(name))
  return { id: same.length === 1 ? Number(same[0].id) : null, name }
}
