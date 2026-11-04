// What the irreversible action kinds share: the long-run rule, refusals worded for Claude, the
// email fields and the state rows their fingerprints hash.
import { z } from 'zod'
import type { DictKey, TranslateVars } from '@/lib/i18n'
import { isPlainAddress } from '@/lib/templates'
import { orderItems } from '@/lib/utils/document'
import type { Settings } from '@/types'
import { LONG_ACTION_DOCUMENTS, TOOL_DEADLINE_MS } from '../config'
import { McpToolError, type McpErrorCode } from '../errors'
import { cents } from '../fingerprint'
import type { ServiceContext, ToolContext } from '../types'
import type { Worded } from './words'

// Claude Code gives up when no byte arrives within 60 s: what may take longer is approved and run
// in Mado for such grants, whatever the policy says.
export function mayOutlastClient(ctx: ToolContext, { documents = 1, bookamat = false }: { documents?: number; bookamat?: boolean }): boolean {
  return TOOL_DEADLINE_MS[ctx.grant.clientKind] < 60_000 && (bookamat || documents > LONG_ACTION_DOCUMENTS)
}

export function refuse(ctx: ServiceContext, key: DictKey, vars?: TranslateVars, code: McpErrorCode = 'invalid_input', details?: Record<string, unknown>): McpToolError {
  return new McpToolError(code, { message: ctx.t(key, vars), ...(details ? { details } : {}) })
}

export const notice = (key: DictKey, vars?: Worded['vars']): Worded => ({ key, ...(vars ? { vars } : {}) })

// A refusal with a code errors.ts already words: an API code (src/lib/api-errors.ts, e.g.
// 'nothing_outstanding', 'google_reauth') or a lifecycle code (MI012 an issued invoice needs a
// Storno, MI013, MI015, MI017, MI018, MI020, MI033) the database would raise for the same step.
export function codedError(code: string, message = code, details?: string): Error {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) })
}

// ─── Email fields ────────────────────────────────────────────────────────────

export const MAX_RECIPIENTS = 10
export const MAX_COPIES = 20
export const MAX_SUBJECT = 300
export const MAX_BODY = 20_000

export const addressList = (max: number) => z.array(z.string().trim().min(1).max(254)).max(max)
export const emailArgs = {
  to: addressList(MAX_RECIPIENTS).min(1),
  cc: addressList(MAX_COPIES),
  bcc: addressList(MAX_COPIES),
  subject: z.string().max(MAX_SUBJECT).transform(s => s.replace(/[\r\n]+/g, ' ').trim()),
  body: z.string().max(MAX_BODY),
}

// Bare addresses only (no display names or separators that could end a header line), each once,
// at most 20 copies.
export function checkAddresses(ctx: ServiceContext, mail: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] }) {
  for (const address of [...mail.to, ...mail.cc, ...mail.bcc]) {
    if (!isPlainAddress(address)) throw refuse(ctx, 'mcp.approve.refusals.invalidAddress', { address })
  }
  if (mail.cc.length + mail.bcc.length > MAX_COPIES) throw refuse(ctx, 'mcp.approve.refusals.tooManyCopies', { max: MAX_COPIES })
}

export function uniqueAddresses(list: readonly string[]): string[] {
  const seen = new Set<string>()
  return list.map(a => a.trim()).filter(a => a && !seen.has(a.toLowerCase()) && !!seen.add(a.toLowerCase()))
}

export function gmailConnected(settings: Pick<Settings, 'gmail_refresh_token' | 'gmail_email'>): boolean {
  return !!settings.gmail_refresh_token && !!settings.gmail_email
}

// ─── Fingerprint rows ────────────────────────────────────────────────────────

type ItemRow = Record<string, unknown> & { sort_order?: number | null }

// A document's lines as they print: every content column, in their order, amounts in cents.
export function itemsState(items: readonly ItemRow[] | null | undefined) {
  return orderItems([...(items ?? [])]).map(i => ({
    id: i.id ?? null,
    line_type: i.line_type ?? 'item',
    description: i.description ?? null,
    quantity: cents(i.quantity),
    unit: i.unit ?? null,
    unit_price: cents(i.unit_price),
    vat_rate: cents(i.vat_rate),
    discount_type: i.discount_type ?? null,
    discount_value: cents(i.discount_value),
    service_date: i.service_date ?? null,
    service_date_end: i.service_date_end ?? null,
    catalogue_item_id: i.catalogue_item_id ?? null,
  }))
}

// Money rows in a fixed order, amounts in cents.
export function paymentsState(payments: readonly Record<string, unknown>[] | null | undefined) {
  return [...(payments ?? [])]
    .map(p => ({ id: p.id ?? null, date: p.date ?? null, amount: cents(p.amount), kind: p.kind ?? 'payment', method: p.method ?? null }))
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')) || String(a.date).localeCompare(String(b.date)) || (a.amount ?? 0) - (b.amount ?? 0))
}
