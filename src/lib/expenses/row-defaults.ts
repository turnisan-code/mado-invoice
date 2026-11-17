import type { AiSuggestion, AiIncomeSuggestion, Vendor } from '@/lib/expenses/types'
import { counterpartyVatin } from './vatin'
import { locksOf, NO_LOCKS, type Lockable, type Locks } from './account-locks'

// The bookamat account behind an id, for the BA values it locks (lib/account-locks.ts).
// undefined = not known; nothing is locked then.
export type AccountLookup = (id: number) => Lockable | undefined
const noAccount: AccountLookup = () => undefined

// Bewirtung is recognised by its Steuerkonto, not only by the AI's category. A
// business meal booked on „Besprechungskosten“ with the AI category „Reise“ used
// to get BA USt = BA Betrag (50/50) and lost half of its Vorsteuer.
export const isBewirtungAccount = (name?: string | null): boolean =>
  /bewirtung|besprechung|repräsentation/i.test(name ?? '')

// BA USt % when nothing decides it explicitly. Bewirtung keeps the full Vorsteuer
// (50 / 100) as long as any part of the meal is deductible; a meal that is not
// deductible at all (BA Betrag 0) carries no Vorsteuer either. Any other partial
// share follows BA Betrag, so a partly private expense never claims 100 %.
export const defaultDeductTaxPercent = (bewirtung: boolean, deductAmountPercent: number): number =>
  bewirtung && deductAmountPercent > 0 ? 100 : deductAmountPercent

export type ExpenseRow = { vendor: Vendor | null; ai_suggested?: AiSuggestion }
type Overrides = Record<string, string | undefined> | undefined

export interface ExpenseDefaults {
  costAccountId: number        // 0 = none
  purchasetaxAccountId: number // 0 = none
  bankAccountId: number        // 0 = none
  taxPercent: number
  deductAmountPercent: number  // BA Betrag %
  deductTaxPercent: number     // BA USt %
  vatin: string
  country: string
  // What the Steuerkonto locks (null = free). A locked value is the one booked and
  // shown; the row shows the field as fixed instead of an editable choice.
  locks: Locks
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// What an expense row books when the owner has not changed a field: one resolver
// for the review row and for the bookamat payload, so the row shows what gets
// booked. They used to disagree: the row read the AI first, the payload the
// Buchungsregel first, so a rule row with a receipt attached showed the AI's
// accounts and booked the rule's.
//
// Precedence per field: the owner's override, then the Buchungsregel, then the AI
// (the bank account: the override, then the CSV's own account).
// An override of '' on an account or UID/country field is a cleared field and
// means "none" — it no longer quietly falls back to the default.
//
// BA USt % is decided on its own (it is independent of BA Betrag %): a
// Buchungsregel carries its own value; otherwise Bewirtung (by AI category or by
// the Steuerkonto's name) is 100, and any other partial share follows BA Betrag.
export function resolveExpenseDefaults(
  t: ExpenseRow,
  ov: Overrides,
  costAccountName: (id: number) => string | undefined = () => undefined,
  csvBankId = 0,
  costAccount: AccountLookup = noAccount,
): ExpenseDefaults {
  const o = ov || {}
  const vendor = t.vendor
  const ai = t.ai_suggested
  const has = (k: string) => o[k] !== undefined
  const set = (k: string) => o[k] !== undefined && o[k] !== ''

  const costAccountId = has('cost_account_id')
    ? num(o.cost_account_id)
    : num(vendor ? vendor.cost_account_id : ai?.cost_account_id)
  const purchasetaxAccountId = has('purchasetax_account_id')
    ? num(o.purchasetax_account_id)
    : num(vendor ? vendor.purchasetax_account_id : ai?.purchasetax_account_id)
  // Every CSV row is a movement on the CSV's own bank account, so that account wins
  // over a rule's or the AI's (lib/bank-account.ts); they are used only when no
  // account in the list is the CSV's.
  const bankAccountId = has('bank_account_id')
    ? num(o.bank_account_id)
    : (csvBankId || num(vendor ? vendor.bank_account_id : ai?.bank_account_id))

  const taxPercent = set('tax_percent')
    ? num(o.tax_percent)
    : num(vendor ? vendor.tax_percent : (ai?.tax_percent ?? 20))
  // The business share as decided for this row. A Steuerkonto that locks BA Betrag
  // (an asset account books 0, the Anlage is written off instead) does not make the
  // purchase private, so BA USt still follows this share, not the lock.
  const businessShare = set('deductibility_amount_percent')
    ? num(o.deductibility_amount_percent)
    : num(vendor ? vendor.deductibility_amount_percent : (ai?.deductibility_amount_percent ?? 100))
  const bewirtung = ai?.category === 'Bewirtung' || isBewirtungAccount(costAccountName(costAccountId))
  const freeDeductTax = set('deductibility_tax_percent')
    ? num(o.deductibility_tax_percent)
    : vendor
      ? num(vendor.deductibility_tax_percent ?? 100)
      : defaultDeductTaxPercent(bewirtung, businessShare)
  // bookamat books a locked value whatever is sent (Sozialversicherung 0 / 100,
  // Privatentnahmen 0 / 0 …): the lock wins over the override, the rule and the AI,
  // so the row shows what is booked instead of a correction after the fact.
  const locks = costAccountId ? locksOf(costAccount(costAccountId)) : NO_LOCKS
  const deductAmountPercent = locks.amount ?? businessShare
  const deductTaxPercent = locks.tax ?? freeDeductTax

  // A stored default (a rule imported from an old booking, a draft from before the
  // classifier's guard) never books the owner's own UID or a bare „ATU“. What the
  // owner types is booked as typed.
  const vatin = has('vatin') ? (o.vatin ?? '') : counterpartyVatin(vendor ? vendor.vatin : ai?.vatin)
  const country = has('country') ? (o.country ?? '') : ((vendor ? vendor.country : ai?.country) ?? '')

  return { costAccountId, purchasetaxAccountId, bankAccountId, taxPercent, deductAmountPercent, deductTaxPercent, vatin, country, locks }
}

// BA USt % for a split line that carries none of its own. A line on the row's
// Steuerkonto takes the row's value (a rule's own BA USt applies there); a line
// moved to another Steuerkonto is decided by that account and the line's own
// BA Betrag. The review card and the booking route both call this.
export function lineDeductTaxDefault(
  line: { cost_account_id?: number; deductibility_amount_percent?: number },
  row: { costAccountId: number; deductTaxPercent: number },
  costAccountName: (id: number) => string | undefined = () => undefined,
): number {
  if (!line.cost_account_id || line.cost_account_id === row.costAccountId) return row.deductTaxPercent
  return defaultDeductTaxPercent(
    isBewirtungAccount(costAccountName(line.cost_account_id)),
    line.deductibility_amount_percent ?? 100,
  )
}

export type SplitLine = {
  cost_account_id?: number
  deductibility_amount_percent?: number
  deductibility_tax_percent?: number
}

// Both BA values a split line books, as the review card shows them and the payload
// sends them: the line's own value, else its default (BA Betrag 100, BA USt as
// lineDeductTaxDefault), and over both whatever the line's Steuerkonto locks.
export function lineDefaults(
  line: SplitLine,
  row: { costAccountId: number; deductTaxPercent: number },
  costAccountName: (id: number) => string | undefined = () => undefined,
  costAccount: AccountLookup = noAccount,
): { deductAmountPercent: number; deductTaxPercent: number; locks: Locks } {
  const costId = line.cost_account_id ?? row.costAccountId
  const locks = costId ? locksOf(costAccount(costId)) : NO_LOCKS
  const own = (v: unknown) => (v == null || v === '' ? null : num(v))
  return {
    deductAmountPercent: locks.amount ?? own(line.deductibility_amount_percent) ?? 100,
    deductTaxPercent: locks.tax ?? own(line.deductibility_tax_percent) ?? lineDeductTaxDefault(line, row, costAccountName),
    locks,
  }
}

export type IncomeRow = { ai_suggested?: AiIncomeSuggestion | null }

export interface IncomeDefaults {
  revenueAccountId: number // 0 = none
  vatAccountId: number     // 0 = none
  bankAccountId: number    // 0 = none
  vatPercent: number
  vatin: string
  country: string
  deductAmountPercent: number // BA Betrag %
  deductTaxPercent: number    // BA USt %
  // What the Ertragskonto locks (Privateinlagen 0 / 0, Einnahmen 100 / 100 …), null = free
  locks: Locks
}

// The same for an income row: the owner's override, then the AI; the bank account
// is the CSV's own. A cleared field stays cleared — the payload used to refill a
// cleared UID, country or USt-Konto from the AI while the row showed it empty.
// BA values: 100 / 100 unless the Ertragskonto locks them (Privateinlagen books
// 0 / 0); they used to be sent as 100 and changed by bookamat.
export function resolveIncomeDefaults(
  t: IncomeRow,
  ov: Overrides,
  csvBankId = 0,
  revenueAccount: AccountLookup = noAccount,
): IncomeDefaults {
  const o = ov || {}
  const ai = t.ai_suggested
  const has = (k: string) => o[k] !== undefined
  const set = (k: string) => o[k] !== undefined && o[k] !== ''
  const revenueAccountId = has('revenue_account_id') ? num(o.revenue_account_id) : num(ai?.revenue_account_id)
  const locks = revenueAccountId ? locksOf(revenueAccount(revenueAccountId)) : NO_LOCKS
  return {
    revenueAccountId,
    vatAccountId: has('vat_account_id') ? num(o.vat_account_id) : num(ai?.vat_account_id),
    bankAccountId: set('bank_account_id') ? num(o.bank_account_id) : (csvBankId || num(ai?.bank_account_id)),
    vatPercent: set('vat_percent') ? num(o.vat_percent) : num(ai?.vat_percent ?? 20),
    vatin: has('vatin') ? (o.vatin ?? '') : counterpartyVatin(ai?.vatin),
    country: has('country') ? (o.country ?? '') : (ai?.country ?? ''),
    deductAmountPercent: locks.amount ?? (set('deductibility_amount_percent') ? num(o.deductibility_amount_percent) : 100),
    deductTaxPercent: locks.tax ?? (set('deductibility_tax_percent') ? num(o.deductibility_tax_percent) : 100),
    locks,
  }
}
