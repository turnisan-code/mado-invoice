// The connector's bookkeeping, the only place besides ../auth.ts that uses the service role:
// grants, authorization codes, Claude's tokens (stored as SHA-256 only), the grant's encrypted
// Supabase session and the call audit. Business data is never read or written here.
import { randomUUID } from 'node:crypto'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  ACCESS_TOKEN_PREFIX, ACCESS_TOKEN_TTL, CODE_TTL, GRANT_TTL, REFRESH_IDLE_TTL, REFRESH_TOKEN_PREFIX, RESOURCE,
  SESSION_REFRESH_LEASE, type McpScope,
} from '../config'
import { encryptSecret, randomToken, sha256Hex } from '../crypto'
import type { McpClientKind } from '@/types'

export type ServiceClient = SupabaseClient

export function mcpServiceClient(): ServiceClient {
  return createServiceClient()
}

const AUTH_CODE_PREFIX = 'mado_ac_'

const iso = (ms: number) => new Date(ms).toISOString()

function check(error: PostgrestError | null) {
  if (error) throw error
}

export interface SessionTokens {
  accessToken: string
  refreshToken: string
  // Epoch seconds.
  expiresAt: number
  sessionId: string
}

export type RevokeReason =
  | 'owner' | 'sign_out_everywhere' | 'reconnected' | 'client_revoked' | 'code_replay' | 'code_rejected'
  | 'refresh_reuse' | 'session_ended' | 'expired'

// ─── Grants ──────────────────────────────────────────────────────────────────

export interface NewGrant {
  userId: string
  clientId: string
  clientName: string
  clientKind: McpClientKind
  redirectUri: string
  scopes: readonly McpScope[]
  session: SessionTokens
}

export async function createGrant(service: ServiceClient, grant: NewGrant, now = Date.now()): Promise<string> {
  const id = randomUUID()
  const { error } = await service.from('mcp_grants').insert({
    id,
    user_id: grant.userId,
    client_id: grant.clientId,
    client_name: grant.clientName,
    client_kind: grant.clientKind,
    redirect_uri: grant.redirectUri,
    scopes: [...grant.scopes],
    resource: RESOURCE,
    sb_session_id: grant.session.sessionId,
    sb_access_enc: encryptSecret(grant.session.accessToken, id),
    sb_access_expires_at: iso(grant.session.expiresAt * 1000),
    sb_refresh_enc: encryptSecret(grant.session.refreshToken, id),
    idle_expires_at: iso(now + REFRESH_IDLE_TTL * 1000),
    expires_at: iso(now + GRANT_TTL * 1000),
  })
  check(error)
  return id
}

export async function endSupabaseSession(service: ServiceClient, sessionId: string | null | undefined) {
  if (!sessionId) return
  const { error } = await service.rpc('mcp_end_session', { p_session_id: sessionId })
  if (error) console.error('[mcp] session not ended:', error.code, error.message)
}

// Marks the grant revoked, forgets its Supabase tokens, deletes Claude's tokens and ends the
// grant's Supabase session. Safe to repeat.
export async function revokeGrant(service: ServiceClient, grantId: string, reason: RevokeReason) {
  const { data, error } = await service
    .from('mcp_grants')
    .update({ revoked_at: iso(Date.now()), revoked_reason: reason, sb_access_enc: null, sb_refresh_enc: null, sb_access_expires_at: null, sb_lease_until: null })
    .eq('id', grantId)
    .is('revoked_at', null)
    .select('id, sb_session_id')
  check(error)
  const { error: tokenError } = await service.from('mcp_tokens').delete().eq('grant_id', grantId)
  check(tokenError)
  for (const row of (data ?? []) as { sb_session_id: string | null }[]) await endSupabaseSession(service, row.sb_session_id)
}

// The owner's live grants, optionally one client's, optionally all but one.
export async function revokeGrants(
  service: ServiceClient,
  filter: { userId: string; clientId?: string; exceptId?: string },
  reason: RevokeReason,
): Promise<number> {
  let query = service.from('mcp_grants').select('id').eq('user_id', filter.userId).is('revoked_at', null)
  if (filter.clientId) query = query.eq('client_id', filter.clientId)
  const { data, error } = await query
  check(error)
  const ids = ((data ?? []) as { id: string }[]).map(g => g.id).filter(id => id !== filter.exceptId)
  for (const id of ids) await revokeGrant(service, id, reason)
  return ids.length
}

export interface GrantRow {
  id: string
  user_id: string
  client_id: string
  scopes: string[]
  resource: string
  expires_at: string
  idle_expires_at: string
  revoked_at: string | null
}

const GRANT_COLUMNS = 'id, user_id, client_id, scopes, resource, expires_at, idle_expires_at, revoked_at'

export async function loadGrant(service: ServiceClient, grantId: string): Promise<GrantRow | null> {
  const { data, error } = await service.from('mcp_grants').select(GRANT_COLUMNS).eq('id', grantId).maybeSingle()
  check(error)
  return (data as GrantRow | null) ?? null
}

export function grantIsLive(grant: GrantRow, now = Date.now()): boolean {
  return !grant.revoked_at && Date.parse(grant.expires_at) > now && Date.parse(grant.idle_expires_at) > now
}

// ─── Authorization codes ─────────────────────────────────────────────────────

export interface CodeBinding {
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource: string
  scopes: readonly McpScope[]
}

export async function issueCode(service: ServiceClient, binding: CodeBinding, now = Date.now()): Promise<string> {
  const code = randomToken(AUTH_CODE_PREFIX)
  const { error } = await service.from('mcp_codes').insert({
    code_hash: sha256Hex(code),
    grant_id: binding.grantId,
    client_id: binding.clientId,
    redirect_uri: binding.redirectUri,
    code_challenge: binding.codeChallenge,
    resource: binding.resource,
    scopes: [...binding.scopes],
    expires_at: iso(now + CODE_TTL * 1000),
  })
  check(error)
  return code
}

export interface CodeRow {
  grant_id: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  resource: string
  scopes: string[]
  expires_at: string
}

export type ConsumedCode = { status: 'ok'; row: CodeRow } | { status: 'replayed'; grantId: string } | { status: 'unknown' }

// Marks the code used in the same statement that finds it, so two exchanges cannot both win.
export async function consumeCode(service: ServiceClient, code: string): Promise<ConsumedCode> {
  const hash = sha256Hex(code)
  const { data, error } = await service
    .from('mcp_codes')
    .update({ used_at: iso(Date.now()) })
    .eq('code_hash', hash)
    .is('used_at', null)
    .select('grant_id, client_id, redirect_uri, code_challenge, resource, scopes, expires_at')
  check(error)
  const row = (data as CodeRow[] | null)?.[0]
  if (row) return { status: 'ok', row }
  const { data: used, error: usedError } = await service.from('mcp_codes').select('grant_id').eq('code_hash', hash).maybeSingle()
  check(usedError)
  return used ? { status: 'replayed', grantId: (used as { grant_id: string }).grant_id } : { status: 'unknown' }
}

// ─── Claude's tokens ─────────────────────────────────────────────────────────

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

// A new access/refresh pair; neither outlives the grant. Each issue moves the grant's idle
// deadline to the refresh token's.
export async function issueTokens(service: ServiceClient, grant: Pick<GrantRow, 'id' | 'expires_at'>, parentHash: string | null = null, now = Date.now()): Promise<IssuedTokens> {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX)
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX)
  const grantEnd = Date.parse(grant.expires_at)
  const accessEnd = Math.min(now + ACCESS_TOKEN_TTL * 1000, grantEnd)
  const refreshEnd = Math.min(now + REFRESH_IDLE_TTL * 1000, grantEnd)
  const { error } = await service.from('mcp_tokens').insert([
    { token_hash: sha256Hex(accessToken), grant_id: grant.id, kind: 'access', expires_at: iso(accessEnd), parent_hash: parentHash },
    { token_hash: sha256Hex(refreshToken), grant_id: grant.id, kind: 'refresh', expires_at: iso(refreshEnd), parent_hash: parentHash },
  ])
  check(error)
  const { error: grantError } = await service.from('mcp_grants').update({ idle_expires_at: iso(refreshEnd) }).eq('id', grant.id).is('revoked_at', null)
  check(grantError)
  return { accessToken, refreshToken, expiresIn: Math.max(0, Math.floor((accessEnd - now) / 1000)) }
}

export type RotatedRefresh =
  | { status: 'ok'; grantId: string; hash: string }
  | { status: 'reused'; grantId: string }
  | { status: 'invalid' }

// Retires a refresh token for good. One already retired is theft (the caller revokes the grant).
export async function rotateRefreshToken(service: ServiceClient, token: string, now = Date.now()): Promise<RotatedRefresh> {
  const hash = sha256Hex(token)
  const { data, error } = await service
    .from('mcp_tokens')
    .update({ rotated_at: iso(now) })
    .eq('token_hash', hash)
    .eq('kind', 'refresh')
    .is('rotated_at', null)
    .gt('expires_at', iso(now))
    .select('grant_id')
  check(error)
  const row = (data as { grant_id: string }[] | null)?.[0]
  if (row) return { status: 'ok', grantId: row.grant_id, hash }
  const { data: seen, error: seenError } = await service
    .from('mcp_tokens')
    .select('grant_id, rotated_at')
    .eq('token_hash', hash)
    .eq('kind', 'refresh')
    .maybeSingle()
  check(seenError)
  const prior = seen as { grant_id: string; rotated_at: string | null } | null
  return prior?.rotated_at ? { status: 'reused', grantId: prior.grant_id } : { status: 'invalid' }
}

export async function findToken(service: ServiceClient, token: string): Promise<{ hash: string; grantId: string; kind: 'access' | 'refresh' } | null> {
  const hash = sha256Hex(token)
  const { data, error } = await service.from('mcp_tokens').select('grant_id, kind').eq('token_hash', hash).maybeSingle()
  check(error)
  const row = data as { grant_id: string; kind: 'access' | 'refresh' } | null
  return row ? { hash, grantId: row.grant_id, kind: row.kind } : null
}

export async function deleteToken(service: ServiceClient, hash: string) {
  const { error } = await service.from('mcp_tokens').delete().eq('token_hash', hash)
  check(error)
}

// Lazy housekeeping (there is no cron to spare): expired tokens and old codes go, and a grant
// that is past its lifetime or never got a token within the code's lifetime is revoked, so its
// Supabase session does not linger.
export async function pruneExpired(service: ServiceClient, now = Date.now()) {
  const { error: tokenError } = await service.from('mcp_tokens').delete().lt('expires_at', iso(now))
  check(tokenError)
  const { error: codeError } = await service.from('mcp_codes').delete().lt('expires_at', iso(now - 60 * 60 * 1000))
  check(codeError)
  const { data, error } = await service
    .from('mcp_grants')
    .select('id, expires_at, idle_expires_at')
    .is('revoked_at', null)
    .lt('created_at', iso(now - (CODE_TTL + 60) * 1000))
  check(error)
  const grants = (data ?? []) as { id: string; expires_at: string; idle_expires_at: string }[]
  if (!grants.length) return
  const { data: live, error: liveError } = await service
    .from('mcp_tokens')
    .select('grant_id')
    .in('grant_id', grants.map(g => g.id))
    .gt('expires_at', iso(now))
  check(liveError)
  const withTokens = new Set(((live ?? []) as { grant_id: string }[]).map(t => t.grant_id))
  for (const g of grants) {
    if (Date.parse(g.expires_at) <= now || Date.parse(g.idle_expires_at) <= now || !withTokens.has(g.id)) {
      await revokeGrant(service, g.id, 'expired')
    }
  }
}

// ─── The grant's Supabase session ────────────────────────────────────────────

export interface StoredSession {
  sb_access_enc: string | null
  sb_access_expires_at: string | null
  sb_refresh_enc: string | null
}

const SESSION_COLUMNS = 'sb_access_enc, sb_access_expires_at, sb_refresh_enc'

// One request at a time may refresh: the lease is taken in the same statement that checks it.
export async function acquireSessionLease(service: ServiceClient, grantId: string, now = Date.now()): Promise<StoredSession | null> {
  const { data, error } = await service
    .from('mcp_grants')
    .update({ sb_lease_until: iso(now + SESSION_REFRESH_LEASE * 1000) })
    .eq('id', grantId)
    .is('revoked_at', null)
    // PostgREST needs the timestamp quoted: '.' and ':' are reserved in or().
    .or(`sb_lease_until.is.null,sb_lease_until.lt."${iso(now)}"`)
    .select(SESSION_COLUMNS)
  check(error)
  return (data as StoredSession[] | null)?.[0] ?? null
}

export async function readStoredSession(service: ServiceClient, grantId: string): Promise<StoredSession | null> {
  const { data, error } = await service.from('mcp_grants').select(SESSION_COLUMNS).eq('id', grantId).is('revoked_at', null).maybeSingle()
  check(error)
  return (data as StoredSession | null) ?? null
}

export async function saveSession(service: ServiceClient, grantId: string, tokens: Pick<SessionTokens, 'accessToken' | 'refreshToken' | 'expiresAt'>) {
  const { error } = await service
    .from('mcp_grants')
    .update({
      sb_access_enc: encryptSecret(tokens.accessToken, grantId),
      sb_refresh_enc: encryptSecret(tokens.refreshToken, grantId),
      sb_access_expires_at: iso(tokens.expiresAt * 1000),
      sb_lease_until: null,
    })
    .eq('id', grantId)
    .is('revoked_at', null)
  check(error)
}

export async function releaseSessionLease(service: ServiceClient, grantId: string) {
  const { error } = await service.from('mcp_grants').update({ sb_lease_until: null }).eq('id', grantId)
  if (error) console.error('[mcp] lease not released:', error.code, error.message)
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export async function recordCall(service: ServiceClient, call: { grantId: string; tool: string; ok: boolean; errorCode: string | null; ms: number }) {
  const { error } = await service.from('mcp_calls').insert({
    grant_id: call.grantId, tool: call.tool, ok: call.ok, error_code: call.errorCode, ms: call.ms,
  })
  if (error) console.error('[mcp] call not recorded:', error.code, error.message)
}
