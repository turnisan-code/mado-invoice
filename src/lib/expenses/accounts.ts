// The year's Bookamat accounts as the expense engine reads them (lib/expenses/types.ts
// BookamatAccounts): the Steuerkonten with the Vorsteuerkonten each links, the BA values it
// locks and whether it is an asset account; the Ertragskonten; the Umsatzsteuer/Vorsteuer
// accounts with their side and rates; the Zahlungsmittelkonten with their IBAN. Ported from
// Bookmatic's lib/bookamat.ts (getCostAccounts …, listAll) onto Mado's bookamatFetch, which
// reads per year: a line is checked against its own year's books (no global year).
import { bookamatFetch, type BookamatCredentials } from '@/lib/bookamat'
import type { BookamatAccount, BookamatAccounts } from './types'

type Raw = Record<string, unknown>
type Page = { results?: unknown[]; next?: string | null } | unknown[] | null

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const numberOrNull = (v: unknown): string | number | null => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? v : null)

function account(o: Raw): BookamatAccount | null {
  const id = Number(o.id)
  if (!Number.isInteger(id) || id <= 0) return null
  return { id, name: text(o.name ?? o.title ?? id) }
}

export function costAccountOf(o: Raw): BookamatAccount | null {
  const a = account(o)
  if (!a) return null
  const links = Array.isArray(o.purchasetaxaccounts)
    ? (o.purchasetaxaccounts as Raw[]).map(account).filter((x): x is BookamatAccount => !!x)
    : undefined
  return {
    ...a,
    purchasetaxaccounts: links,
    group: o.group == null ? null : text(o.group),
    section: o.section == null ? null : text(o.section),
    deductibility_tax_percent: numberOrNull(o.deductibility_tax_percent),
    deductibility_amount_percent: numberOrNull(o.deductibility_amount_percent),
    inventory: typeof o.inventory === 'boolean' ? o.inventory : null,
  }
}

export function taxAccountOf(o: Raw): BookamatAccount | null {
  const a = account(o)
  if (!a) return null
  return {
    ...a,
    group: o.group == null ? null : text(o.group),
    tax_values: Array.isArray(o.tax_values) ? (o.tax_values as (string | number)[]) : null,
  }
}

export function bankAccountOf(o: Raw): BookamatAccount | null {
  const a = account(o)
  return a ? { ...a, iban: typeof o.iban === 'string' ? o.iban : null } : null
}

// Every page of a list (at most 20 of 100)
async function listAll(creds: BookamatCredentials, year: number, path: string, deadline?: number): Promise<Raw[]> {
  const out: Raw[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= 20; page++) {
    const res = await bookamatFetch<Page>(creds, year, `${path}${sep}format=json&limit=100${page > 1 ? `&page=${page}` : ''}`, { deadline })
    const results = Array.isArray(res) ? res : (res?.results ?? [])
    out.push(...results.filter((r): r is Raw => !!r && typeof r === 'object'))
    if (Array.isArray(res) || !res?.next || !results.length) break
  }
  return out
}

export async function readExpenseAccounts(creds: BookamatCredentials, year: number, deadline?: number): Promise<BookamatAccounts> {
  const [cost, revenue, tax, bank] = await Promise.all([
    listAll(creds, year, 'preferences/costaccounts/?group=2', deadline),
    listAll(creds, year, 'preferences/costaccounts/?group=1', deadline),
    listAll(creds, year, 'preferences/purchasetaxaccounts/', deadline),
    listAll(creds, year, 'preferences/bankaccounts/', deadline),
  ])
  const keep = <T>(list: (T | null)[]) => list.filter((x): x is T => !!x)
  return {
    year,
    cost_accounts: keep(cost.map(costAccountOf)),
    revenue_accounts: keep(revenue.map(costAccountOf)),
    purchasetax_accounts: keep(tax.map(taxAccountOf)),
    bank_accounts: keep(bank.map(bankAccountOf)),
  }
}

// The year's Zahlungsmittelkonten alone, with their IBAN (a receipt search's account check, PR 9b)
export async function readBankAccounts(creds: BookamatCredentials, year: number, deadline?: number): Promise<BookamatAccount[]> {
  return (await listAll(creds, year, 'preferences/bankaccounts/', deadline)).map(bankAccountOf).filter((x): x is BookamatAccount => !!x)
}
