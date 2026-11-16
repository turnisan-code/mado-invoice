// What the expense routes accept (PR 9a): the statement's lines, a line's review as the page
// saves it, a Buchungsregel. Anything else is refused. (The routes' error answers:
// lib/expenses/api.ts.)
import { BOOKAMAT_SETTINGS_COLUMNS } from '@/lib/bookamat'
import type { BankLineReview, BankLineSplit, BookingRule } from '@/types'
import { MAX_LINES, type LineInput } from './statement'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

export const LINE_SETTINGS_COLUMNS = `${BOOKAMAT_SETTINGS_COLUMNS}, owner_name, uid_number, iban, own_ibans, expenses_from`

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

export function parseLineInputs(value: unknown): LineInput[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LINES) return null
  const out: LineInput[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const { key, cells } = v as Record<string, unknown>
    if (!str(key, 200) || !key) return null
    if (!Array.isArray(cells) || cells.length < 5 || cells.length > 12 || !cells.every(c => str(c, 4000))) return null
    out.push({ key, cells: cells as string[] })
  }
  return out
}

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

// A Beleg's storage path: the line's own folder, one file
export const receiptPathOk = (lineId: string, path: unknown): path is string =>
  typeof path === 'string' && path.startsWith(`${lineId}/`) && /^[0-9a-f-]{36}\/[^/\\]{1,150}$/i.test(path)

const TEXTS = 200
const textList = (v: unknown, max = 20) => Array.isArray(v) && v.length <= max && v.every(s => str(s, TEXTS))

export type RuleInput = Omit<BookingRule, 'id' | 'created_at' | 'updated_at'>

export function parseRule(value: unknown): RuleInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  const amount = (v: unknown) => v === null || v === undefined || v === '' ? null : num(v, 0, 1e8) ? v : undefined
  const min = amount(o.amount_min), max = amount(o.amount_max)
  if (!str(o.name, TEXTS) || !o.name.trim() || typeof o.active !== 'boolean') return null
  for (const k of ['category', 'email_sender', 'cost_account', 'tax_account', 'bank_account', 'country', 'vatin', 'title_template', 'notes_template', 'invoice_address_match']) {
    if (!str(o[k] ?? '', TEXTS)) return null
  }
  if (!textList(o.match_strings) || !textList(o.email_body_keywords ?? [])) return null
  if (!num(o.tax_percent, 0, 100) || !num(o.ba_amount, 0, 100) || !num(o.ba_tax, 0, 100) || typeof o.skip_receipt !== 'boolean') return null
  if (min === undefined || max === undefined || (min !== null && max !== null && min > max)) return null
  const text = (k: string) => String(o[k] ?? '').trim()
  return {
    name: text('name'), active: o.active, category: text('category'),
    match_strings: (o.match_strings as string[]).map(s => s.trim()).filter(Boolean),
    email_sender: text('email_sender'),
    email_body_keywords: ((o.email_body_keywords ?? []) as string[]).map(s => s.trim()).filter(Boolean),
    cost_account: text('cost_account'), tax_account: text('tax_account'), bank_account: text('bank_account'),
    tax_percent: o.tax_percent, ba_amount: o.ba_amount, ba_tax: o.ba_tax,
    country: text('country').toUpperCase(), vatin: text('vatin'), title_template: text('title_template'), notes_template: text('notes_template'),
    amount_min: min, amount_max: max, invoice_address_match: text('invoice_address_match'), skip_receipt: o.skip_receipt,
  }
}


// The lines a booking takes ({ id, fingerprint }): the fingerprint of the booking the page showed
// for each (lib/expenses/fingerprint.ts). At most 25 per request: the page sends them in turns.
export const MAX_BOOK = 25

export function parseBookEntries(value: unknown): { id: string; fingerprint: string | null }[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BOOK) return null
  const out: { id: string; fingerprint: string | null }[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const { id, fingerprint } = v as Record<string, unknown>
    if (!isUuid(id)) return null
    if (fingerprint !== undefined && fingerprint !== null && !(typeof fingerprint === 'string' && /^[0-9a-f]{8}$/.test(fingerprint))) return null
    out.push({ id, fingerprint: typeof fingerprint === 'string' ? fingerprint : null })
  }
  return out
}
