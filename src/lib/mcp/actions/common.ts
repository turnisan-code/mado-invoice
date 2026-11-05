// What the irreversible action kinds share: the long-run rule, refusals worded for Claude, the
// email fields and the state rows their fingerprints hash.
import { z } from 'zod'
import type { DictKey, TFn, TranslateVars } from '@/lib/i18n'
import { clientAddresses } from '@/lib/services/email-compose'
import { PRINTED_CLIENT_COLUMNS } from '@/lib/services/issue'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { orderItems } from '@/lib/utils/document'
import type { Settings } from '@/types'
import { clientUrl, LONG_ACTION_DOCUMENTS, TOOL_DEADLINE_MS } from '../config'
import { McpToolError, toToolError, type McpErrorCode } from '../errors'
import { cents } from '../fingerprint'
import type { ServiceContext, ToolContext } from '../types'
import { isWorded, type StoredError, type Worded } from './words'

// Claude Code gives up when no byte arrives within 60 s: what may take longer is approved and run
// in Mado for such grants, whatever the policy says.
export function mayOutlastClient(ctx: ToolContext, { documents = 1, bookamat = false }: { documents?: number; bookamat?: boolean }): boolean {
  return TOOL_DEADLINE_MS[ctx.grant.clientKind] < 60_000 && (bookamat || documents > LONG_ACTION_DOCUMENTS)
}

// The refusal keeps its dictionary key (`worded`), so a failure stored with an action reads in the
// owner's language on the approval page; Claude gets the English message.
export function refuse(ctx: ServiceContext, key: DictKey, vars?: TranslateVars, code: McpErrorCode = 'invalid_input', details?: Record<string, unknown>): McpToolError {
  return Object.assign(new McpToolError(code, { message: ctx.t(key, vars), ...(details ? { details } : {}) }), { worded: notice(key, vars) })
}

export const notice = (key: DictKey, vars?: Worded['vars']): Worded => ({ key, ...(vars ? { vars } : {}) })

// A failure as it is stored with an action (its result or its error): the English ToolError, plus
// the dictionary key of a refusal.
export function storedError(err: unknown, t: TFn): StoredError {
  const worded = err && typeof err === 'object' ? (err as { worded?: unknown }).worded : undefined
  return { ...toToolError(err, t), ...(isWorded(worded) ? { worded } : {}) }
}

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

// ─── Recipients ──────────────────────────────────────────────────────────────

// Enough history for any client; an address emailed only before it counts as new (approved in Mado).
const EMAILED_HISTORY_ROWS = 1000

// Every address the owner emailed this client's documents to from Mado: the browser's own emails
// and reminders and the actions approved there (actor null). Not what a Claude session sent, the
// reminder cron, or a reminder only recorded as sent another way.
export async function ownerEmailed(ctx: ServiceContext, clientId: string): Promise<Set<string>> {
  const { data, error } = await ctx.supabase.from('document_events')
    .select('detail, documents!inner(client_id)')
    .eq('documents.client_id', clientId)
    .in('type', ['emailed', 'reminder_sent'])
    .is('actor', null)
    .order('created_at', { ascending: false })
    .limit(EMAILED_HISTORY_ROWS)
  if (error) throw error
  const out = new Set<string>()
  for (const row of (data ?? []) as { detail: Record<string, unknown> | null }[]) {
    const d = row.detail ?? {}
    if (d.automatic === true || d.manual === true) continue
    const parts = [d.to, d.cc, d.bcc].flatMap(v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : []))
    for (const address of parseEmailList(parts).emails) out.add(address.toLowerCase())
  }
  return out
}

// The recipients the owner approves in Mado whatever the policy: `foreign` is not on the client
// record, `unconfirmed` is on it but was never emailed from Mado by the owner. Claude can write
// the client record (update_client, create_client), so being on it alone does not make an
// address known.
export async function newRecipients(
  ctx: ServiceContext,
  addresses: readonly string[],
  client: { id: string; email?: string | null; cc_emails?: readonly string[] | null } | null | undefined,
): Promise<{ foreign: string[]; unconfirmed: string[] }> {
  const onRecord = clientAddresses(client)
  const foreign = addresses.filter(a => !onRecord.has(a.trim().toLowerCase()))
  const listed = addresses.filter(a => onRecord.has(a.trim().toLowerCase()))
  if (!client || !listed.length) return { foreign, unconfirmed: [] }
  const emailed = await ownerEmailed(ctx, client.id)
  return { foreign, unconfirmed: listed.filter(a => !emailed.has(a.trim().toLowerCase())) }
}

// ─── Clients Claude wrote ────────────────────────────────────────────────────

// The client as documents print it (PRINTED_CLIENT_COLUMNS: the recipient block, the UID, the
// e-invoice data), for a fingerprint.
export function printedClient(client: object | null | undefined): Record<string, unknown> | null {
  if (!client) return null
  const row = client as Record<string, unknown>
  return Object.fromEntries(PRINTED_CLIENT_COLUMNS.split(', ').map(k => [k, row[k] ?? null]))
}

// When a Claude session last created or changed the client, until the owner saves it in Mado
// (clients.mcp_written_at, 20261105_mcp_drafts.sql). Read from the whole row (clients(*)), never
// named: a database without the column has nothing from Claude.
export function claudeWrittenAt(client: object | null | undefined): string | null {
  return (client as { mcp_written_at?: string | null } | null | undefined)?.mcp_written_at ?? null
}

// A reminder, a Storno or a Bookamat sync prints or books the client as it is when it runs, and
// the approval page shows only its name. Like the crons (the reminders, the Bookamat step, the
// archive copy), they wait while a client Claude created or changed is not saved in Mado: refused
// when prepared, and a Claude write to the client after that is refused again when the state is
// compared before the run (the approval page then says it changed).
export function refuseClaudeClient(ctx: ServiceContext, client: { id?: string | null } | null | undefined, key: DictKey): void {
  if (!claudeWrittenAt(client)) return
  throw refuse(ctx, key, undefined, 'invalid_input', client?.id ? { client_id: client.id, client_url: clientUrl(client.id) } : undefined)
}

// ─── Fingerprint rows ────────────────────────────────────────────────────────

type ItemRow = Record<string, unknown> & { sort_order?: number | null }

// The line columns itemsState hashes, as a documents embed (the same columns issue.ts reads).
export const ITEMS_STATE_EMBED = 'document_items(id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate, discount_type, discount_value, service_date, service_date_end, catalogue_item_id)'

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
