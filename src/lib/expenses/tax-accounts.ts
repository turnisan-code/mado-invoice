// Which Umsatzsteuer/Vorsteuer accounts belong where. bookamat groups them itself:
// "1" = sales side (Umsatzsteuer Inland, Umsatzsteuerfrei Inland, IG Lieferungen/
// Leistungen, Drittland Lieferungen/Leistungen, Keine Umsatzsteuer, Eigenverbrauch,
// Umsätze §19), "2" = purchase side (Vorsteuer Inland, IG Erwerb von Lieferungen/
// Leistungen, Drittland Erwerb von Leistungen, Einfuhr-UST, Keine Vorsteuer,
// Vorsteuer Rückforderung EU/Drittland). Checked live on the 2026 books.
//
// An expense on a sales-side account is wrong: the AI chose „Drittland Leistungen“
// (an outbound account) for Anthropic and Hertz UK, and bookamat refused it (audit P1-3).
export type TaxAccountLike = { id: number; name: string; group?: string | number | null }

// Only when bookamat's group is unknown (an older cached list): by name. „Keine
// Vorsteuer“, the Erwerb and the Einfuhr accounts are purchase side.
const SALES_BY_NAME = /^(?!.*(erwerb|keine vorsteuer|vorsteuer inland|rückforderung|einfuhr)).*(umsatzsteuer|umsätze|§\s*19|eigenverbrauch|lieferungen$|leistungen$)/i

export function taxAccountSide(a: TaxAccountLike | null | undefined): 'sales' | 'purchase' | null {
  if (!a) return null
  const g = a.group == null ? '' : String(a.group)
  if (g === '1') return 'sales'
  if (g === '2') return 'purchase'
  return SALES_BY_NAME.test(a.name.trim()) ? 'sales' : 'purchase'
}

export const isSalesTaxAccount = (a: TaxAccountLike | null | undefined) => taxAccountSide(a) === 'sales'
export const isPurchaseTaxAccount = (a: TaxAccountLike | null | undefined) => taxAccountSide(a) === 'purchase'

export type TaxRegion = 'outbound' | 'EU' | 'third' | 'domestic' | 'refund' | 'none' | 'other'

// Which tax situation a Vorsteuerkonto implies (moved from lib/ai-classifier.ts, which
// re-exports it). Pass the account itself where there is one: bookamat's group decides
// the side; a bare name falls back to the name.
// 'outbound' → sales side („Umsatzsteuer Inland“, „IG/Drittland Lieferungen/Leistungen“,
//              „Keine Umsatzsteuer“, „Umsätze §19“ …): never right on an expense
// 'EU'       → intra-community reverse charge ("IG Erwerb …", "innergemeinschaftlich")
// 'third'    → third-country reverse charge ("Drittland Erwerb …")
// 'domestic' → ordinary Austrian input VAT ("Vorsteuer 20%", "Vorsteuer Inland")
// 'refund'   → foreign VAT reclaimed abroad ("Vorsteuer Rückforderung EU/Drittland"):
//              no reverse charge, so no reverse-charge checks
// 'none'     → explicit no-VAT account ("Keine Vorsteuer")
// 'other'    → can't tell from the name (Einfuhr-USt …) — don't judge it
export function accountTaxRegion(account: string | TaxAccountLike): TaxRegion {
  const a = typeof account === 'string' ? { id: 0, name: account } : account
  if (isSalesTaxAccount(a)) return 'outbound'
  const name = a.name
  if (/keine\s*vorsteuer/i.test(name)) return 'none'
  if (/r(ü|ue|u)ckforderung/i.test(name)) return 'refund'
  if (/\bIG[\s.-]?Erwerb|innergemeinschaftl/i.test(name)) return 'EU'
  if (/drittland/i.test(name)) return 'third'
  if (/vorsteuer/i.test(name)) return 'domestic'
  return 'other'
}

// One set of finders for the tax accounts of a booking (PR „Vorsteuer“): the classifier's
// guards, the Belege form, the booking payload and the import page ask the same question
// the same way. Every account is found by name or bookamat's group, never by id: every id
// differs per year.

// The tax accounts a Steuer- or Ertragskonto allows on one side: the ones bookamat links
// to it (`links`, its purchasetaxaccounts), each resolved against the year's full list
// (`all`, which carries bookamat's group), and only those of `side` — never an
// Umsatzsteuer account on an expense or a Vorsteuer account on income (audit P1-3). An
// account that links none (or none known): that whole side of the list.
export function linkedTaxAccounts<T extends TaxAccountLike>(
  all: readonly T[] | null | undefined,
  links: readonly T[] | null | undefined,
  side: 'purchase' | 'sales',
): T[] {
  const list = all ?? []
  const linked = (links ?? []).map(l => list.find(a => a.id === l.id) ?? l)
  return (linked.length ? linked : list).filter(a => taxAccountSide(a) === side)
}

// An expense's Vorsteuerkonten: the purchase side of what its Steuerkonto links
export const purchasePool = <T extends TaxAccountLike>(
  ptAccounts: readonly T[] | null | undefined,
  links: readonly T[] | null | undefined,
): T[] => linkedTaxAccounts(ptAccounts, links, 'purchase')

// „Keine Vorsteuer“ in a pool of Vorsteuerkonten, by name, or undefined. The pool says
// the side (purchasePool).
export const keineVorsteuerOf = <T extends { name: string }>(pool: readonly T[] | null | undefined): T | undefined =>
  (pool ?? []).find(a => /keine\s*vorsteuer/i.test(a.name))

// „Vorsteuer Inland“ in a pool of Vorsteuerkonten: among its domestic ones
// (accountTaxRegion), the one named „… Inland“, else the first of them (an older chart's
// „Vorsteuer 20%“); undefined when it has none.
export function vorsteuerInlandOf<T extends TaxAccountLike>(pool: readonly T[] | null | undefined): T | undefined {
  const domestic = (pool ?? []).filter(a => accountTaxRegion(a) === 'domestic')
  return domestic.find(a => /inland/i.test(a.name)) ?? domestic[0]
}

const FOR_RATE = {
  purchase: { taxed: /^vorsteuer\s*inland/i, zero: /^keine\s*vorsteuer/i },
  sales: { taxed: /^umsatzsteuer\s*inland/i, zero: /^keine\s*umsatzsteuer/i },
} as const

// The tax account to take for a rate among the ones allowed (linkedTaxAccounts):
// „Vorsteuer Inland“ / „Umsatzsteuer Inland“ above 0 %, „Keine Vorsteuer“ / „Keine
// Umsatzsteuer“ at 0 %. Strict: undefined when none of them has that name. `fallback`
// takes the first allowed instead — the import page, for a newly picked Steuer- or
// Ertragskonto that does not allow the current tax account.
export function taxAccountForRate<T extends { name: string }>(
  allowed: readonly T[] | null | undefined,
  rate: number,
  side: 'purchase' | 'sales',
  opts: { fallback?: boolean } = {},
): T | undefined {
  const list = allowed ?? []
  const re = rate > 0 ? FOR_RATE[side].taxed : FOR_RATE[side].zero
  return list.find(a => re.test(a.name.trim())) ?? (opts.fallback ? list[0] : undefined)
}
