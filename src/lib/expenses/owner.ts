// The owner as the expense engine knows him, from Mado's Einstellungen: his name (an own
// transfer is one to an account he holds), his UID (never a supplier's or a client's) and
// his business accounts (the IBAN on his invoices and any other, „Eigene Geschäftskonten“:
// a transfer between them is no Privatentnahme). Bookmatic kept these as constants.
//
// Pure and client-safe. The server sets the owner per request before it runs the engine;
// the page sets it from the settings it was given, so both read the same.
import { setOwnVatin } from './vatin'
import { setOwner } from './own-transfer'

export type ExpenseOwner = { name: string; vatin: string; businessIbans: string[] }

export type OwnerSettings = {
  owner_name?: string | null
  uid_number?: string | null
  iban?: string | null
  own_ibans?: readonly string[] | null
}

export function expenseOwnerOf(settings: OwnerSettings): ExpenseOwner {
  return {
    name: (settings.owner_name ?? '').trim(),
    vatin: (settings.uid_number ?? '').trim(),
    businessIbans: [settings.iban ?? '', ...(settings.own_ibans ?? [])].filter(v => v.trim() !== ''),
  }
}

export function setExpenseOwner(owner: ExpenseOwner): void {
  setOwnVatin(owner.vatin)
  setOwner({ name: owner.name, businessIbans: owner.businessIbans })
}
