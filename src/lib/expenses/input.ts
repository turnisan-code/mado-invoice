// What the expense routes accept (PR 9a): the statement's lines, a line's review as the page
// saves it, a Buchungsregel. Anything else is refused. (The routes' error answers:
// lib/expenses/api.ts.)
import { BOOKAMAT_SETTINGS_COLUMNS } from '@/lib/bookamat'
import type { BookingRule } from '@/types'
import { type LineInput } from './statement'
import { MAX_LINES } from './limits'

export { parseReview } from './review'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

export const LINE_SETTINGS_COLUMNS = `${BOOKAMAT_SETTINGS_COLUMNS}, owner_name, uid_number, iban, own_ibans, expenses_from`

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

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
// for each (lib/expenses/fingerprint.ts), required. At most 25 per request: the page sends them in turns.
export const MAX_BOOK = 25

export function parseBookEntries(value: unknown): { id: string; fingerprint: string }[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BOOK) return null
  const out: { id: string; fingerprint: string }[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const { id, fingerprint } = v as Record<string, unknown>
    // Every line comes with the fingerprint of the booking the page showed: nothing else is booked
    if (!isUuid(id) || !(typeof fingerprint === 'string' && /^[0-9a-f]{8}$/.test(fingerprint))) return null
    out.push({ id, fingerprint })
  }
  return out
}
