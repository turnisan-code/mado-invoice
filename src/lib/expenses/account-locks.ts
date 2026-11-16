// bookamat locks BA USt % and BA Betrag % for some accounts and books the locked value
// whatever is sent (Sozialversicherung 0 / 100, Einkommensteuer 0 / 0, Privatentnahmen
// 0 / 0, Einnahmen 100 / 100, Privateinlagen 0 / 0, asset accounts BA Betrag 0 …). The
// account list says so: `deductibility_tax_percent` / `deductibility_amount_percent`,
// null = free. Applying the lock up front makes the row show what bookamat books,
// instead of a correction after the fact. Checked live on the 2026 books.
export type Lockable = {
  deductibility_tax_percent?: string | number | null
  deductibility_amount_percent?: string | number | null
}

export type Locks = { tax: number | null; amount: number | null }

// null/undefined/'' = free. Never Number(null), which is 0 — a free account would
// read as locked at 0.
const lockValue = (v: string | number | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const locksOf = (a: Lockable | null | undefined): Locks => ({
  tax: lockValue(a?.deductibility_tax_percent),
  amount: lockValue(a?.deductibility_amount_percent),
})

export const NO_LOCKS: Locks = { tax: null, amount: null }

// bookamat's „Anlagen“ (`inventory: true`: „Betriebs- und Geschäftsausstattung“,
// „Geringwertige WG (Abschreibung)“, „Software (Abschreibung)“): booked as an asset, BA
// Betrag locked 0, written off in bookamat over the years. Only the flag says so: a BA
// Betrag lock of 0 alone is also Privatentnahmen, Einkommensteuer, Einfuhrumsatzsteuer.
export const isAssetAccount = (a?: { inventory?: boolean | null } | null): boolean => a?.inventory === true

// An Anlage of at most this much (Anschaffungskosten, net when its Vorsteuer is
// deductible) is a geringwertiges Wirtschaftsgut and goes off at once (§ 13 EStG: „nicht
// übersteigen“, so 1.000,00 € still is one)
export const GWG_LIMIT_NET = 1000

// The Steuerkonto that books a geringwertiges Wirtschaftsgut at once: „Geringwertige WG
// (Betriebsausgabe)“, by name since every id differs per year, never an asset account
// itself („Geringwertige WG (Abschreibung)“). undefined when the year's books have none.
export function gwgExpenseAccount<T extends { name: string; inventory?: boolean | null }>(
  costAccounts: readonly T[] | null | undefined,
): T | undefined {
  return (costAccounts ?? []).find(a => /^geringwertige\s*wg\b.*betriebsausgabe/i.test(a.name.trim()) && !isAssetAccount(a))
}
