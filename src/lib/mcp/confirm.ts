// The confirmation core: an irreversible action is prepared by Claude (stored with its arguments,
// the server's label and preview, and a fingerprint of the state it depends on), approved by the
// owner in Mado or, where the owner allowed it, confirmed in Claude's own prompt, and run exactly
// once after the fingerprint was checked again. The database decides the channel, keeps the
// handle single-use and refuses a Claude session the approval (20261105_mcp.sql); this module
// never trusts what Claude sends back beyond the handle, the kind and the label.
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeT, type TFn } from '@/lib/i18n'
import type { McpAction, McpActionKind } from '@/types'
import { actionKind } from './actions'
import { storedError } from './actions/common'
import { isWorded, word, type StoredError } from './actions/words'
import { ACTION_HANDLE_PREFIX, approveUrl } from './config'
import { randomToken, sha256Hex } from './crypto'
import { McpToolError, toToolError, type ToolError } from './errors'
import { canonicalJson } from './fingerprint'
import type { ActionOutcome, ServiceContext, ToolContext, ToolResult } from './types'

// A run that has not finished after this long most likely died with its function (a timeout):
// its outcome is unknown and the document has to be checked.
export const STALE_RUN_MS = 10 * 60_000

export type ActionState = 'pending' | 'expired' | 'running' | 'unknown' | 'done' | 'failed' | 'rejected'

export function actionState(row: Pick<McpAction, 'status' | 'expires_at' | 'claimed_at'>, now = Date.now()): ActionState {
  if (row.status === 'pending') return Date.parse(row.expires_at) <= now ? 'expired' : 'pending'
  if (row.status === 'running') return row.claimed_at && now - Date.parse(row.claimed_at) > STALE_RUN_MS ? 'unknown' : 'running'
  return row.status
}

// 128 bits; only the SHA-256 is stored, so the handle in the chat is the only way to name it.
export function newActionHandle(): { handle: string; hash: string } {
  const handle = randomToken(ACTION_HANDLE_PREFIX, 16)
  return { handle, hash: sha256Hex(handle) }
}

export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args))
}

// The longest label an action can have (an email to 30 addresses of 254 characters): confirm_action
// must accept every label exactly.
export const MAX_LABEL_CHARS = 10_000

// Worded parts of a stored preview, in English for Claude. A stored error's dictionary key
// (`worded`) only serves the approval page; its message is the English text.
export function englishPreview(value: unknown, t: TFn = makeT('en')): unknown {
  if (isWorded(value)) return word(t, 'en', value)
  if (Array.isArray(value)) return value.map(v => englishPreview(v, t))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'worded').map(([k, v]) => [k, englishPreview(v, t)]))
  return value
}

const ACTION_COLUMNS = 'id, handle_hash, grant_id, kind, args, args_hash, fingerprint, label, preview, approval, status, created_at, expires_at, claimed_at, claimed_via, claimed_session, finished_at, result, error'

export async function readAction(supabase: SupabaseClient, id: string): Promise<McpAction | null> {
  const { data, error } = await supabase.from('mcp_actions').select(ACTION_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  return data as McpAction | null
}

// This grant's action behind a handle; another grant's handle is not found.
async function ownAction(ctx: ToolContext, handle: string): Promise<McpAction> {
  const { data, error } = await ctx.supabase.from('mcp_actions').select(ACTION_COLUMNS)
    .eq('handle_hash', sha256Hex(handle)).eq('grant_id', ctx.grant.id).maybeSingle()
  if (error) throw error
  if (!data) throw new McpToolError('not_found')
  return data as McpAction
}

// What Claude learns about an action: its state, where to approve it, and what came of it.
export function describeAction(row: McpAction, t: TFn, handle?: string): ToolResult {
  const state = actionState(row)
  const url = approveUrl(row.id)
  const result = row.result as (ActionOutcome & Record<string, unknown>) | null
  const summary = state === 'done' && result?.summary ? String(result.summary)
    : state === 'failed' ? t('mcp.approve.status.failedSummary', { label: row.label, error: String(row.error?.message ?? '') })
    : state === 'pending' && row.approval === 'app' ? t('mcp.approve.prepared.app', { label: row.label, url })
    : t(`mcp.approve.status.${state}Summary`, { label: row.label })
  return {
    summary,
    data: {
      ...(handle ? { confirmation_id: handle } : {}),
      action: row.kind,
      label: row.label,
      status: state,
      approval: row.approval,
      ...(state === 'pending' && row.approval === 'app' ? { approve_url: url } : {}),
      created_at: row.created_at,
      expires_at: row.expires_at,
      ...(row.finished_at ? { finished_at: row.finished_at } : {}),
      ...(state === 'done' && result ? { result: { summary: result.summary, ...(englishPreview(result.data ?? {}, t) as Record<string, unknown>), ...(result.warnings?.length ? { warnings: result.warnings } : {}) } } : {}),
      ...(state === 'failed' && row.error ? { error: englishPreview(row.error, t) } : {}),
    },
  }
}

// ─── Prepare ─────────────────────────────────────────────────────────────────

export async function prepareAction(ctx: ToolContext, kind: McpActionKind, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const def = actionKind(kind)
  if (!def) throw new McpToolError('internal')
  const args = def.argsSchema.parse(rawArgs)
  const prep = await def.prepare(ctx, args)
  if (prep.label.length > MAX_LABEL_CHARS) throw new McpToolError('internal')
  const { handle, hash } = newActionHandle()
  const { data, error } = await ctx.supabase.rpc('mcp_create_action', {
    p_handle_hash: hash,
    p_kind: kind,
    p_args: JSON.parse(canonicalJson(args)),
    p_args_hash: argsHash(args),
    p_fingerprint: prep.fingerprint,
    p_label: prep.label,
    p_preview: prep.preview,
    p_force_app: prep.forceApp,
  })
  if (error) throw error
  const created = (Array.isArray(data) ? data[0] : data) as { id: string; approval: 'app' | 'chat'; expires_at: string } | undefined
  if (!created) throw new McpToolError('internal')
  const url = approveUrl(created.id)
  return {
    summary: created.approval === 'app'
      ? ctx.t('mcp.approve.prepared.app', { label: prep.label, url })
      : ctx.t('mcp.approve.prepared.chat', { label: prep.label }),
    data: {
      confirmation_id: handle,
      action: kind,
      label: prep.label,
      approval: created.approval,
      ...(created.approval === 'app' ? { approve_url: url } : {}),
      expires_at: created.expires_at,
      preview: englishPreview(prep.preview, ctx.t),
      warnings: prep.warnings,
    },
  }
}

// ─── Run (both channels) ─────────────────────────────────────────────────────

export type RunResult = { ok: true; outcome: ActionOutcome } | { ok: false; error: ToolError; thrown: unknown }

async function finish(supabase: SupabaseClient, id: string, ok: boolean, result: ActionOutcome | null, error: StoredError | null) {
  const { error: finishErr } = await supabase.rpc('mcp_finish_action', { p_id: id, p_ok: ok, p_result: result, p_error: error })
  if (finishErr) console.error(`[mcp] outcome of action ${id} not recorded:`, finishErr.code, finishErr.message)
}

// A claimed action (status 'running', this session's claim): arguments and fingerprint checked
// again, then run, and the outcome recorded. Whatever happens, the row is finished.
export async function runClaimed(ctx: ServiceContext, row: McpAction): Promise<RunResult> {
  try {
    const def = actionKind(row.kind)
    if (!def) throw new McpToolError('internal')
    const args = def.argsSchema.parse(row.args)
    if (argsHash(args) !== row.args_hash) throw new McpToolError('state_changed')
    if (await def.fingerprint(ctx, args) !== row.fingerprint) throw new McpToolError('state_changed')
    const outcome = await def.execute(ctx, args)
    await finish(ctx.supabase, row.id, true, { summary: outcome.summary, data: outcome.data, ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}) }, null)
    return { ok: true, outcome }
  } catch (thrown) {
    const error = storedError(thrown, ctx.t)
    await finish(ctx.supabase, row.id, false, null, error)
    return { ok: false, error, thrown }
  }
}

// ─── Chat channel: confirm_action ────────────────────────────────────────────

// Runs a 'chat' action after Claude's own prompt was answered. An 'app' action is never run here,
// only described (with its approval link), and so is a 'chat' action whose kind the owner set back
// to approval in Mado since (the database moves it there); a repeated call returns what the first
// one stored.
export async function confirmAction(ctx: ToolContext, input: { confirmation_id: string; action: McpActionKind; label: string }): Promise<ToolResult> {
  const row = await ownAction(ctx, input.confirmation_id)
  if (row.kind !== input.action || row.label !== input.label) throw new McpToolError('label_mismatch')
  if (row.approval !== 'chat' || actionState(row) !== 'pending') return describeAction(row, ctx.t, input.confirmation_id)

  const { data, error } = await ctx.supabase.rpc('mcp_claim_action', { p_handle_hash: row.handle_hash })
  if (error) {
    // Claimed by a parallel call, expired or rejected since it was read.
    if (error.code !== 'MI041') throw error
    return describeAction(await ownAction(ctx, input.confirmation_id), ctx.t, input.confirmation_id)
  }
  const claimed = (Array.isArray(data) ? data[0] : data) as McpAction | null | undefined
  // No row: the owner set this kind back to approval in Mado since it was prepared, and
  // mcp_claim_action moved the action there instead of claiming it. It is described as it is now
  // (pending, with its approval link).
  if (!claimed) return describeAction(await ownAction(ctx, input.confirmation_id), ctx.t, input.confirmation_id)
  const run = await runClaimed(ctx, claimed)
  if (!run.ok) throw run.thrown
  const done = await readAction(ctx.supabase, claimed.id)
  return done ? describeAction(done, ctx.t, input.confirmation_id) : { summary: run.outcome.summary, data: run.outcome.data }
}

export async function actionStatus(ctx: ToolContext, handle: string): Promise<ToolResult> {
  return describeAction(await ownAction(ctx, handle), ctx.t, handle)
}

// ─── App channel: the approval page ──────────────────────────────────────────

export type CodeCheck = 'ok' | 'invalid' | 'no_factor'

export type ApproveResult =
  | { ok: true; row: McpAction }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'expired' | 'revoked' | 'state_changed' | 'invalid_code' | 'no_factor' | 'fresh_code' }

// The owner approved in Mado (cookie session, never a Claude one: the database refuses those).
// The state is compared first, so a changed document is reported before a code is asked for;
// then the authenticator code, the atomic claim, and the run with the owner's session.
export async function approveAction(
  ctx: ServiceContext,
  id: string,
  { requireCode, checkCode }: { requireCode: boolean; checkCode: () => Promise<CodeCheck> },
): Promise<ApproveResult> {
  const row = await readAction(ctx.supabase, id)
  if (!row) return { ok: false, reason: 'not_found' }
  const state = actionState(row)
  if (state === 'expired') return { ok: false, reason: 'expired' }
  if (state !== 'pending') return { ok: false, reason: 'not_pending' }

  const def = actionKind(row.kind)
  if (!def) return { ok: false, reason: 'not_found' }
  const args = def.argsSchema.parse(row.args)
  let fingerprint: string
  try {
    fingerprint = await def.fingerprint(ctx, args)
  } catch (err) {
    // Refused now (issued, billed, gone since): it changed. A failed read is an error.
    const { code } = toToolError(err, ctx.t)
    if (code === 'database' || code === 'internal') throw err
    return { ok: false, reason: 'state_changed' }
  }
  if (fingerprint !== row.fingerprint) return { ok: false, reason: 'state_changed' }

  if (requireCode) {
    const check = await checkCode()
    if (check !== 'ok') return { ok: false, reason: check === 'no_factor' ? 'no_factor' : 'invalid_code' }
  }

  const { data, error } = await ctx.supabase.rpc('mcp_approve_action', { p_id: id })
  if (error) {
    if (error.code === 'MI043') return { ok: false, reason: 'fresh_code' }
    if (error.code !== 'MI041') throw error
    const now = await readAction(ctx.supabase, id)
    if (!now) return { ok: false, reason: 'not_found' }
    const nowState = actionState(now)
    return { ok: false, reason: nowState === 'expired' ? 'expired' : nowState === 'pending' ? 'revoked' : 'not_pending' }
  }
  const claimed = (Array.isArray(data) ? data[0] : data) as McpAction | undefined
  if (!claimed) throw new McpToolError('internal')
  await runClaimed(ctx, claimed)
  return { ok: true, row: (await readAction(ctx.supabase, id)) ?? claimed }
}

export async function rejectAction(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { error } = await supabase.rpc('mcp_reject_action', { p_id: id })
  if (!error) return true
  if (error.code === 'MI041') return false
  throw error
}
