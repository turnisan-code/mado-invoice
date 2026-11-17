// The year's account lists as the expense classifier and its guards read them, built from
// bookamat's answers (lib/bookamat.ts getCostAccounts, getBankAccounts,
// getPurchaseTaxAccounts). The enrich and reclassify routes each built them by hand and
// dropped the fields the PR „Vorsteuer“ guards need; this is the one mapping.
//
// Pure: the routes call it, the tests read it.
import type { BookamatAccounts } from '@/lib/expenses/types'

type CostRow = {
  id: number
  name: string
  purchasetaxaccounts?: { id: number; name: string }[]
  deductibility_tax_percent?: string | number | null
  deductibility_amount_percent?: string | number | null
  inventory?: boolean | null
}
type BankRow = { id: number; name: string }
type TaxRow = { id: number; name: string; group?: string | number | null; tax_values?: (string | number)[] | null }

// What each list keeps:
// - Steuerkonten: the Vorsteuerkonten bookamat links to each (lib/tax-accounts.ts), the
//   BA values it locks (lib/account-locks.ts; null = free) and whether it is an asset
//   account (`inventory`, isAssetAccount; null = not said);
// - Zahlungsmittelkonten: id and name;
// - Vorsteuer-/Umsatzsteuerkonten: bookamat's group (the side: "1" sales, "2" purchase)
//   and the rates each takes (`tax_values`, lib/vat-origin.ts allowedRates).
// A field bookamat leaves out is null, never a guess. Nothing else is copied.
export function classifierLists(
  cost: readonly CostRow[],
  bank: readonly BankRow[],
  pt: readonly TaxRow[],
): BookamatAccounts {
  return {
    cost_accounts: cost.map(a => ({
      id: a.id,
      name: a.name,
      purchasetaxaccounts: a.purchasetaxaccounts,
      deductibility_tax_percent: a.deductibility_tax_percent ?? null,
      deductibility_amount_percent: a.deductibility_amount_percent ?? null,
      inventory: a.inventory ?? null,
    })),
    bank_accounts: bank.map(a => ({ id: a.id, name: a.name })),
    purchasetax_accounts: pt.map(a => ({
      id: a.id,
      name: a.name,
      group: a.group ?? null,
      tax_values: a.tax_values ?? null,
    })),
  }
}
