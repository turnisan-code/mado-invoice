// The authorization request between /oauth/authorize and the consent page: validated once,
// then carried as an HMAC-signed blob that expires after AUTH_REQUEST_TTL, so nothing is stored
// before the owner is signed in and no hidden form field is trusted.
import { AUTH_REQUEST_TTL, ISSUER, MCP_SCOPES, OFFLINE_ACCESS, RESOURCE, isMcpScope, type McpScope } from '../config'
import { signPayload, verifyPayload } from '../crypto'
import { clientAllowsRedirect, clientKindFor, isAllowedRedirect, resolveClient } from './clients'
import type { McpClientKind } from '@/types'

export interface AuthRequest {
  clientId: string
  clientName: string
  clientKind: McpClientKind
  redirectUri: string
  codeChallenge: string
  scopes: McpScope[]
  resource: string
  state: string
}

// A client or redirect that cannot be trusted is answered on our own page; everything after
// that goes back to the client as an RFC 6749 error.
export type AuthorizeResult =
  | { ok: true; request: AuthRequest }
  | { ok: false; page: 'client' | 'redirect' }
  | { ok: false; redirectTo: string }

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const MAX_STATE = 1024

// Every requested scope must be known; offline_access is accepted and implied (refresh tokens
// are always issued). Nothing requested means everything.
export function parseScopes(raw: string | null): McpScope[] | null {
  const parts = (raw ?? '').split(' ').filter(Boolean)
  if (!parts.length) return [...MCP_SCOPES]
  if (parts.some(p => p !== OFFLINE_ACCESS && !isMcpScope(p))) return null
  const scopes = MCP_SCOPES.filter(s => parts.includes(s))
  return scopes.length ? scopes : null
}

export function authorizeErrorUrl(redirectUri: string, error: string, state: string | null, description?: string): string {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (description) url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)
  url.searchParams.set('iss', ISSUER)
  return url.toString()
}

export function authorizeSuccessUrl(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', state)
  url.searchParams.set('iss', ISSUER)
  return url.toString()
}

export async function parseAuthorizeRequest(params: URLSearchParams): Promise<AuthorizeResult> {
  const single = (name: string) => (params.getAll(name).length > 1 ? null : params.get(name))
  const clientId = single('client_id')
  const client = clientId ? await resolveClient(clientId) : null
  if (!client) return { ok: false, page: 'client' }
  const redirectUri = single('redirect_uri')
  if (!redirectUri || !clientAllowsRedirect(client, redirectUri)) return { ok: false, page: 'redirect' }

  const state = single('state')
  const fail = (error: string, description: string): AuthorizeResult =>
    ({ ok: false, redirectTo: authorizeErrorUrl(redirectUri, error, state && state.length <= MAX_STATE ? state : null, description) })

  if (!state || state.length > MAX_STATE) return fail('invalid_request', 'state is required')
  if (single('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code')
  const responseMode = single('response_mode')
  if (responseMode !== null && responseMode !== 'query') return fail('invalid_request', 'response_mode must be query')
  if (single('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256')
  const codeChallenge = single('code_challenge')
  if (!codeChallenge || !CODE_CHALLENGE.test(codeChallenge)) return fail('invalid_request', 'code_challenge is missing or malformed')
  if (single('resource') !== RESOURCE) return fail('invalid_target', `resource must be ${RESOURCE}`)
  const scopes = parseScopes(single('scope'))
  if (!scopes) return fail('invalid_scope', `scope must be among ${[...MCP_SCOPES, OFFLINE_ACCESS].join(' ')}`)

  return {
    ok: true,
    request: {
      clientId: client.clientId,
      clientName: client.name,
      clientKind: clientKindFor(client, redirectUri),
      redirectUri,
      codeChallenge,
      scopes,
      resource: RESOURCE,
      state,
    },
  }
}

export function signAuthRequest(request: AuthRequest, key?: Buffer, now?: number): string {
  return signPayload(request, AUTH_REQUEST_TTL, key, now)
}

// The request as authorize validated it, or null when the blob was altered or has expired. The
// redirect is checked again, so even a leaked signing key cannot send a code anywhere else.
export function readAuthRequest(blob: string | null | undefined, key?: Buffer, now?: number): AuthRequest | null {
  if (!blob) return null
  const request = verifyPayload<AuthRequest>(blob, key, now)
  if (!request || typeof request.redirectUri !== 'string' || !Array.isArray(request.scopes)) return null
  if (!isAllowedRedirect(request.redirectUri)) return null
  return request
}
