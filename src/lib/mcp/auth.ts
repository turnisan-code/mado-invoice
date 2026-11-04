// Bearer authentication for /api/mcp. Claude's opaque token is only hashed and looked up
// (mcp_authenticate, which also counts the grant's rate limit); the grant's own Supabase session
// then acts for the owner. Claude's token never goes upstream and the Supabase JWT never leaves
// the server.
import { ACCESS_TOKEN_PREFIX, MCP_SCOPES, RESOURCE, RESOURCE_METADATA_URL, isMcpScope } from './config'
import { sha256Hex } from './crypto'
import { grantAccessToken } from './oauth/grant-session'
import { mcpServiceClient, revokeGrant } from './oauth/store'
import type { McpGrantInfo } from './types'
import type { McpClientKind } from '@/types'

export interface McpAuth {
  grant: McpGrantInfo
  // The grant's Supabase access token (aal2). Server-side only.
  sbAccessToken: string
  // Epoch seconds when Claude's access token expires.
  tokenExpiresAt: number
}

export type AuthOutcome = { ok: true; auth: McpAuth } | { ok: false; response: Response }

const CLIENT_KINDS: readonly McpClientKind[] = ['claude_ai', 'claude_code', 'static']

type AuthRow = {
  grant_id: string
  user_id: string
  client_id: string
  client_name: string
  client_kind: string
  scopes: string[]
  resource: string
  token_expires_at: string
  sb_access_enc: string | null
  sb_access_expires_at: string | null
  sb_refresh_enc: string | null
}

const quote = (s: string) => s.replace(/["\\]/g, '')

// RFC 6750 / RFC 9728: where to find the metadata and which scopes to ask for; with an error
// when a token was sent but is not (or no longer) valid.
export function bearerChallenge(error?: 'invalid_token', description?: string): Response {
  let header = `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="${MCP_SCOPES.join(' ')}"`
  if (error) header += `, error="${error}"${description ? `, error_description="${quote(description)}"` : ''}`
  return Response.json(
    { error: error ?? 'unauthorized', error_description: description ?? 'Sign in to Mado Invoice to use this connector.' },
    { status: 401, headers: { 'WWW-Authenticate': header, 'Cache-Control': 'no-store' } },
  )
}

function unavailable(seconds: number): Response {
  return Response.json(
    { error: 'temporarily_unavailable', error_description: 'Mado Invoice could not be reached. Try again shortly.' },
    { status: 503, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } },
  )
}

// The bearer token from the Authorization header only (never the query string or a cookie).
export function bearerToken(req: Request): string | null {
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.get('authorization') ?? '')
  return match ? match[1] : null
}

export async function authenticateRequest(req: Request): Promise<AuthOutcome> {
  const token = bearerToken(req)
  if (!token) return { ok: false, response: bearerChallenge() }
  const invalid = (description: string): AuthOutcome => ({ ok: false, response: bearerChallenge('invalid_token', description) })
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return invalid('Unknown access token')

  const service = mcpServiceClient()
  const { data, error } = await service.rpc('mcp_authenticate', { p_token_hash: sha256Hex(token) })
  if (error) {
    if (error.message === 'rate_limited') {
      const seconds = Math.max(1, Math.ceil(Number(error.hint) || 60))
      const window = error.details === 'day' ? 'day' : 'minute'
      return {
        ok: false,
        response: Response.json(
          { error: 'rate_limited', error_description: window === 'day' ? 'Daily request limit reached' : 'Too many requests', retry_after: seconds },
          { status: 429, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } },
        ),
      }
    }
    console.error('[mcp] authenticate failed:', error.code, error.message)
    return { ok: false, response: unavailable(5) }
  }
  const row = (data as AuthRow[] | null)?.[0]
  if (!row) return invalid('The access token is unknown, expired or revoked')
  if (row.resource !== RESOURCE) return invalid('The access token is for another resource')
  const clientKind = CLIENT_KINDS.find(k => k === row.client_kind)
  if (!clientKind) return invalid('Unknown client')

  const access = await grantAccessToken(service, row.grant_id, row)
  if (!access.ok) {
    if (access.reason === 'unavailable') return { ok: false, response: unavailable(5) }
    await revokeGrant(service, row.grant_id, 'session_ended')
    return invalid('The connection has ended; connect Claude again')
  }

  return {
    ok: true,
    auth: {
      grant: {
        id: row.grant_id,
        userId: row.user_id,
        clientId: row.client_id,
        clientName: row.client_name,
        clientKind,
        scopes: row.scopes.filter(isMcpScope),
      },
      sbAccessToken: access.accessToken,
      tokenExpiresAt: Math.floor(Date.parse(row.token_expires_at) / 1000),
    },
  }
}
