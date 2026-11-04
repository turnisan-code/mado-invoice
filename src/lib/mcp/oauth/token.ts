// The token and revocation endpoints (RFC 6749, RFC 7009) for public clients with PKCE: an
// authorization code is exchanged once, refresh tokens rotate on every use, and a code or refresh
// token presented a second time revokes the whole grant.
import { RESOURCE } from '../config'
import { verifyPkce } from '../crypto'
import {
  consumeCode, deleteToken, findToken, grantIsLive, issueTokens, loadGrant, revokeGrant, rotateRefreshToken,
  type ServiceClient,
} from './store'

export const MAX_FORM_BYTES = 16 * 1024

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

export function oauthJson(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

export function oauthError(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status)
}

// The form body, or null when it is not form-encoded, too large or repeats a parameter.
export async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get('content-type') ?? '')) return null
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_FORM_BYTES) return null
  const text = await req.text()
  if (text.length > MAX_FORM_BYTES) return null
  const params = new URLSearchParams(text)
  const names = [...params.keys()]
  return new Set(names).size === names.length ? params : null
}

function tokenResponse(tokens: { accessToken: string; refreshToken: string; expiresIn: number }, scopes: readonly string[]): Response {
  return oauthJson({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: scopes.join(' '),
  })
}

const invalidGrant = (description: string) => oauthError('invalid_grant', description)

export async function exchangeCode(service: ServiceClient, form: URLSearchParams): Promise<Response> {
  const code = form.get('code')
  const clientId = form.get('client_id')
  const redirectUri = form.get('redirect_uri')
  const verifier = form.get('code_verifier')
  if (!code || !clientId || !redirectUri || !verifier) return oauthError('invalid_request', 'code, client_id, redirect_uri and code_verifier are required')
  if (form.get('resource') !== RESOURCE) return oauthError('invalid_target', `resource must be ${RESOURCE}`)

  const consumed = await consumeCode(service, code)
  if (consumed.status === 'replayed') {
    await revokeGrant(service, consumed.grantId, 'code_replay')
    return invalidGrant('The authorization code was already used')
  }
  if (consumed.status === 'unknown') return invalidGrant('Unknown authorization code')

  const row = consumed.row
  const problem =
    Date.parse(row.expires_at) <= Date.now() ? 'The authorization code has expired'
    : row.client_id !== clientId ? 'The authorization code was issued to another client'
    : row.redirect_uri !== redirectUri ? 'redirect_uri does not match the authorization request'
    : row.resource !== RESOURCE ? 'The authorization code is for another resource'
    : !verifyPkce(verifier, row.code_challenge) ? 'code_verifier does not match the code challenge'
    : null
  const grant = problem ? null : await loadGrant(service, row.grant_id)
  if (problem || !grant || !grantIsLive(grant)) {
    // The grant was made for this code alone; with the code spent it can never be used.
    await revokeGrant(service, row.grant_id, 'code_rejected')
    return invalidGrant(problem ?? 'The grant is no longer valid')
  }
  return tokenResponse(await issueTokens(service, grant), grant.scopes)
}

export async function refreshTokens(service: ServiceClient, form: URLSearchParams): Promise<Response> {
  const token = form.get('refresh_token')
  const clientId = form.get('client_id')
  if (!token || !clientId) return oauthError('invalid_request', 'refresh_token and client_id are required')
  const resource = form.get('resource')
  if (resource !== null && resource !== RESOURCE) return oauthError('invalid_target', `resource must be ${RESOURCE}`)

  const rotated = await rotateRefreshToken(service, token)
  if (rotated.status === 'reused') {
    await revokeGrant(service, rotated.grantId, 'refresh_reuse')
    return invalidGrant('The refresh token was already used; the connection has been revoked')
  }
  if (rotated.status === 'invalid') return invalidGrant('Unknown, expired or revoked refresh token')

  const grant = await loadGrant(service, rotated.grantId)
  if (!grant || !grantIsLive(grant)) return invalidGrant('The connection has expired or was revoked')
  if (grant.client_id !== clientId) return invalidGrant('The refresh token was issued to another client')
  const requested = (form.get('scope') ?? '').split(' ').filter(Boolean)
  if (requested.some(s => s !== 'offline_access' && !grant.scopes.includes(s))) return oauthError('invalid_scope', 'scope exceeds the connection')
  return tokenResponse(await issueTokens(service, grant, rotated.hash), grant.scopes)
}

// RFC 7009: the answer is 200 whether or not the token was known. A refresh token ends the
// whole connection; an access token only itself.
export async function revokeToken(service: ServiceClient, form: URLSearchParams): Promise<Response> {
  const token = form.get('token')
  const clientId = form.get('client_id')
  if (!token) return oauthError('invalid_request', 'token is required')
  const found = await findToken(service, token)
  if (found) {
    const grant = await loadGrant(service, found.grantId)
    if (grant && (!clientId || grant.client_id === clientId)) {
      if (found.kind === 'refresh') await revokeGrant(service, found.grantId, 'client_revoked')
      else await deleteToken(service, found.hash)
    }
  }
  return new Response(null, { status: 200, headers: NO_STORE })
}
