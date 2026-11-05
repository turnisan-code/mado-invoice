// The Claude connector's fixed values. Issuer and resource come from NEXT_PUBLIC_APP_URL only,
// never from request headers, so a forwarded Host cannot change what Claude's tokens are bound to.
// No secrets here: MCP_SECRET is read by crypto.ts, on the server.
import type { DocumentType, McpClientKind } from '@/types'

export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '')
export const APP_HOST = new URL(APP_URL).host

export const ISSUER = APP_URL
// The exact URL the owner enters in Claude; the protected-resource metadata, the authorize and
// token checks and every grant use this string.
export const RESOURCE = `${APP_URL}/api/mcp`
export const RESOURCE_METADATA_URL = `${APP_URL}/.well-known/oauth-protected-resource/api/mcp`
export const AUTHORIZE_URL = `${APP_URL}/oauth/authorize`
export const TOKEN_URL = `${APP_URL}/api/oauth/token`
export const REVOCATION_URL = `${APP_URL}/api/oauth/revoke`
export const CONSENT_PATH = '/oauth/consent'
export const APPROVE_PATH = '/mcp/approve'

export const MCP_SCOPES = ['mado:read', 'mado:write', 'mado:irreversible'] as const
export type McpScope = (typeof MCP_SCOPES)[number]
export const OFFLINE_ACCESS = 'offline_access'

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value)
}

// Opaque values handed to Claude; only their SHA-256 is stored.
export const ACCESS_TOKEN_PREFIX = 'mado_at_'
export const REFRESH_TOKEN_PREFIX = 'mado_rt_'
export const ACTION_HANDLE_PREFIX = 'mca_'

// Lifetimes in seconds. The prepared-action lifetime, the approval code's age and the rate limits
// are enforced in SQL (20261105_mcp.sql); they are repeated here for wording and checks.
export const AUTH_REQUEST_TTL = 10 * 60
export const CODE_TTL = 120
export const ACCESS_TOKEN_TTL = 60 * 60
export const REFRESH_IDLE_TTL = 30 * 24 * 60 * 60
// A refresh token presented again within this many seconds of its rotation is a concurrent or
// retried refresh (several Claude Code sessions sharing a credential, a lost response) and gets a
// fresh pair; later it is theft and revokes the grant. Supabase's own reuse interval is 10 s too.
export const REFRESH_REUSE_WINDOW = 10
export const GRANT_TTL = 90 * 24 * 60 * 60
export const ACTION_TTL = 15 * 60
export const APPROVAL_CODE_MAX_AGE = 5 * 60
// The grant's Supabase access token is refreshed when fewer than this many seconds remain,
// by one request at a time (the lease).
export const SESSION_REFRESH_MARGIN = 5 * 60
export const SESSION_REFRESH_LEASE = 20
// While another request refreshes, the old token is used only if it stays valid this long past
// the request's tool deadline (TOOL_DEADLINE_MS); otherwise the request waits for the new one.
export const SESSION_DEADLINE_MARGIN = 30

export const RATE_LIMIT_PER_MINUTE = 120
export const RATE_LIMIT_PER_DAY = 3000
export const MAX_PENDING_ACTIONS = 20

// How long a tool may work before it has to answer. Claude Code gives up when no byte arrives
// within 60 s; claude.ai waits 240 s. The static client may be either, so it gets the shorter one.
export const TOOL_DEADLINE_MS: Record<McpClientKind, number> = {
  claude_code: 50_000,
  claude_ai: 200_000,
  static: 50_000,
}
// More documents than this in one action, or a Bookamat sync, may outlast a 50 s deadline: for
// such grants the action is approved and run in Mado.
export const LONG_ACTION_DOCUMENTS = 3

export const MAX_RESULT_CHARS = 60_000
export const MAX_REQUEST_BYTES = 1024 * 1024

// Browsers never call /api/mcp for Claude (Anthropic's servers do); an Origin, when sent, must be one of these.
export const ALLOWED_ORIGINS: readonly string[] = [APP_URL, 'https://claude.ai', 'https://claude.com']

// OAuth clients: Claude's client ID metadata documents (CIMD) on these hosts, the static client
// for “Use your own OAuth client”, and the redirect URIs either may use. Loopback redirects
// (Claude Code) match on any port, with exactly this path.
export const CIMD_HOSTS: readonly string[] = ['claude.ai', 'claude.com']
export const KNOWN_CIMD_URLS: readonly string[] = [
  'https://claude.ai/oauth/claude-code-client-metadata',
  'https://claude.ai/oauth/mcp-oauth-client-metadata',
]
export const CIMD_FETCH_TIMEOUT_MS = 3_000
export const CIMD_MAX_BYTES = 16 * 1024
export const CIMD_CACHE_TTL = 60 * 60
export const STATIC_CLIENT_ID = 'mado-claude'
export const CLAUDE_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1']
export const LOOPBACK_CALLBACK_PATH = '/callback'

// ─── Links handed to Claude (they open in the owner's signed-in browser) ─────

const DOCUMENT_PATHS: Record<DocumentType, string> = {
  invoice: '/invoices',
  quote: '/quotes',
  credit_note: '/credit-notes',
}

export function appUrl(path: string): string {
  return `${APP_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export function documentUrl(type: DocumentType, id: string): string {
  return appUrl(`${DOCUMENT_PATHS[type]}/${id}`)
}

// The stored PDF of an issued document (a draft has none); needs the owner's session.
export function documentPdfUrl(id: string): string {
  return appUrl(`/api/documents/${id}/pdf`)
}

export function clientUrl(id: string): string {
  return appUrl(`/clients/${id}`)
}

export function projectUrl(id: string): string {
  return appUrl(`/projects/${id}`)
}

export function approveUrl(actionId: string): string {
  return appUrl(`${APPROVE_PATH}/${actionId}`)
}
