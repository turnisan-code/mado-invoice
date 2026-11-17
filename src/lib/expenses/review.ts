// A line's review as it is saved (PR 9a): only the editor's fields, each in its form, trimmed
// where trimming changes nothing the owner meant. The page builds its preview from what this
// makes of its edits — the review the server will store — so the preview's fingerprint is the
// server's. Pure and client-safe.
import type { BankLineReview, BankLineSplit } from '@/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

// The fields the row editor sets (lib/expenses/row-defaults.ts reads them): a value, or '' for
// a field cleared on purpose
const OVERRIDE_KEYS = new Set([
  'cost_account_id', 'purchasetax_account_id', 'bank_account_id', 'tax_percent', 'deductibility_amount_percent',
  'deductibility_tax_percent', 'vatin', 'country', 'title', 'date', 'date_invoice', 'date_delivery', 'description',
  'revenue_account_id', 'vat_account_id', 'vat_percent',
])
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^\d{1,12}$/
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/
const DATE_KEYS = new Set(['date', 'date_invoice', 'date_delivery'])
const ID_KEYS = new Set(['cost_account_id', 'purchasetax_account_id', 'bank_account_id', 'revenue_account_id', 'vat_account_id'])
const PERCENT_KEYS = new Set(['tax_percent', 'deductibility_amount_percent', 'deductibility_tax_percent', 'vat_percent'])

function parseOverride(v: unknown): Record<string, string> | null {
  if (v === undefined) return {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, string> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!OVERRIDE_KEYS.has(k) || !str(raw, 500)) return null
    const val = raw.trim()
    if (val && DATE_KEYS.has(k) && !DATE.test(val)) return null
    if (val && ID_KEYS.has(k) && !ID.test(val)) return null
    if (val && PERCENT_KEYS.has(k) && (!PERCENT.test(val) || Number(val) > 100)) return null
    out[k] = k === 'description' ? raw : val
  }
  return out
}

const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const optId = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v > 0)
const optPercent = (v: unknown) => v === undefined || num(v, 0, 100)

// Split lines: none, or two and more (one line would book its own amount instead of the bank's)
function parseSplits(v: unknown): BankLineSplit[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length === 1 || v.length > 12) return null
  const out: BankLineSplit[] = []
  for (const s of v) {
    if (!s || typeof s !== 'object') return null
    const o = s as Record<string, unknown>
    if (!str(o.label, 100) || !num(o.amount_gross, -1e8, 1e8) || !num(o.vat_percent, 0, 100)) return null
    if (!optPercent(o.deductibility_amount_percent) || !optPercent(o.deductibility_tax_percent)) return null
    if (!optId(o.cost_account_id) || !optId(o.purchasetax_account_id) || !optId(o.bank_account_id)) return null
    out.push({
      label: o.label, amount_gross: o.amount_gross, vat_percent: o.vat_percent,
      ...(o.deductibility_amount_percent !== undefined ? { deductibility_amount_percent: o.deductibility_amount_percent as number } : {}),
      ...(o.deductibility_tax_percent !== undefined ? { deductibility_tax_percent: o.deductibility_tax_percent as number } : {}),
      ...(o.cost_account_id !== undefined ? { cost_account_id: o.cost_account_id as number } : {}),
      ...(o.purchasetax_account_id !== undefined ? { purchasetax_account_id: o.purchasetax_account_id as number } : {}),
      ...(o.bank_account_id !== undefined ? { bank_account_id: o.bank_account_id as number } : {}),
    })
  }
  return out
}

export function parseReview(value: unknown): BankLineReview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (Object.keys(o).some(k => !['rule_id', 'override', 'lines', 'ack_duplicate_ids'].includes(k))) return null
  if (o.rule_id !== undefined && o.rule_id !== null && !isUuid(o.rule_id)) return null
  const override = parseOverride(o.override)
  const lines = parseSplits(o.lines)
  const ack = o.ack_duplicate_ids
  if (!override || !lines) return null
  if (ack !== undefined && (!Array.isArray(ack) || ack.length > 50 || !ack.every(a => typeof a === 'number' && Number.isInteger(a) && a > 0))) return null
  return {
    ...(o.rule_id ? { rule_id: o.rule_id as string } : {}),
    ...(Object.keys(override).length ? { override } : {}),
    ...(lines.length ? { lines } : {}),
    ...(Array.isArray(ack) && ack.length ? { ack_duplicate_ids: ack as number[] } : {}),
  }
}

