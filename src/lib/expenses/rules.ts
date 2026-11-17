// Mado's Buchungsregeln (booking_rules) as the engine reads them: Bookmatic's Vendor, its
// accounts looked up by title in the year's books (decision D7: a rule names its accounts,
// so nothing is picked again in January). A title the year's books do not have, or have
// twice, gives no account (0): the row shows the field empty and the booking is refused.
import type { BookingRule } from '@/types'
import type { BookamatAccount, BookamatAccounts, Vendor } from './types'
import { normName } from './rule-accounts'

export type RuleAccountField = 'cost_account' | 'tax_account' | 'bank_account'
export type RuleAccountIssue = { field: RuleAccountField; title: string; issue: 'missing' | 'ambiguous' }

const LISTS: Record<RuleAccountField, 'cost_accounts' | 'purchasetax_accounts' | 'bank_accounts'> = {
  cost_account: 'cost_accounts', tax_account: 'purchasetax_accounts', bank_account: 'bank_accounts',
}

// The account of this title: its id, 0 for none ('' — the field is not set, or the title is
// missing or ambiguous: `issue` says which)
export function accountByTitle(list: readonly BookamatAccount[] | null | undefined, title: string | null | undefined): { id: number; issue?: 'missing' | 'ambiguous' } {
  const want = normName(title)
  if (!want) return { id: 0 }
  const hits = (list ?? []).filter(a => normName(a.name) === want)
  if (hits.length === 1) return { id: hits[0].id }
  return { id: 0, issue: hits.length ? 'ambiguous' : 'missing' }
}

// What a rule names that the year's books lack or have twice
export function ruleAccountIssues(rule: Pick<BookingRule, RuleAccountField>, lists: BookamatAccounts | null | undefined): RuleAccountIssue[] {
  if (!lists) return []
  return (Object.keys(LISTS) as RuleAccountField[]).flatMap(field => {
    const r = accountByTitle(lists[LISTS[field]], rule[field])
    return r.issue ? [{ field, title: rule[field].trim(), issue: r.issue }] : []
  })
}

const num = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? n : fallback }
const numOrNull = (v: unknown) => (v == null || v === '' ? null : num(v, 0))

// A rule as Bookmatic's engine (lib/expenses/rule-match.ts, row-defaults.ts) reads it, with the
// ids of `lists`' year. A rule's bank account left empty is the statement's own (row-defaults
// books that one first anyway).
export function vendorOf(rule: BookingRule, lists: BookamatAccounts | null | undefined): Vendor {
  const id = (field: RuleAccountField) => accountByTitle(lists?.[LISTS[field]], rule[field]).id
  return {
    id: rule.id,
    name: rule.name,
    match_strings: rule.match_strings ?? [],
    email_sender: rule.email_sender ?? '',
    cost_account_id: id('cost_account'),
    purchasetax_account_id: id('tax_account'),
    bank_account_id: id('bank_account'),
    tax_percent: num(rule.tax_percent, 20),
    deductibility_tax_percent: num(rule.ba_tax, 100),
    deductibility_amount_percent: num(rule.ba_amount, 100),
    country: rule.country ?? '',
    vatin: rule.vatin ?? '',
    title_template: rule.title_template ?? '',
    category: rule.category ?? '',
    active: rule.active,
    amount_min: numOrNull(rule.amount_min),
    amount_max: numOrNull(rule.amount_max),
    invoice_address_match: rule.invoice_address_match ?? '',
    email_body_keywords: rule.email_body_keywords ?? [],
    notes_template: rule.notes_template ?? '',
    skip_invoice_search: rule.skip_receipt,
  }
}

// The rules with the ids of `lists`' year, in the order given: read them by name, then id, as
// every read of Bookmatic's rules does (RULES_ORDER), so a tie is decided the same everywhere
export function vendorsOf(rules: readonly BookingRule[], lists: BookamatAccounts | null | undefined): Vendor[] {
  return rules.map(r => vendorOf(r, lists))
}

// The one order of a read of the rules (Supabase: .order('name').order('id'))
export const RULES_ORDER = ['name', 'id'] as const
