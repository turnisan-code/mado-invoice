// Each Claude connection runs on its own Supabase session at aal2, created when the owner
// approves with a fresh authenticator code and kept on the server only. Every MCP query uses
// that session's JWT, so RLS (is_app_user(), mfa_satisfied()) decides as it does for the browser.
import { createClient, isAuthApiError, type SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret } from '../crypto'
import { SESSION_REFRESH_LEASE, SESSION_REFRESH_MARGIN } from '../config'
import {
  acquireSessionLease, endSupabaseSession, readStoredSession, releaseSessionLease, saveSession,
  type ServiceClient, type SessionTokens, type StoredSession,
} from './store'

const NO_PERSISTENCE = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const

// A throwaway client: its session lives in memory for this one sign-in or refresh.
export function anonAuthClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: NO_PERSISTENCE })
}

// Acts as the owner through the grant's session JWT; never refreshes or stores anything.
export function grantSupabaseClient(accessToken: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: NO_PERSISTENCE,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : null
  } catch {
    return null
  }
}

function sessionId(jwt: string): string | null {
  const id = jwtClaims(jwt)?.session_id
  return typeof id === 'string' ? id : null
}

export type GrantSessionResult = { ok: true; session: SessionTokens } | { ok: false; reason: 'code' | 'failed' }

// A magic link minted server-side (no email is sent) signs in a fresh client at aal1; the code
// the owner just typed lifts that session to aal2. Nothing is kept unless the result is an aal2
// session of the owner; a session left half-way is ended.
export async function createGrantSession(
  service: ServiceClient,
  owner: { userId: string; email: string; factorId: string },
  code: string,
): Promise<GrantSessionResult> {
  const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: 'magiclink', email: owner.email })
  const tokenHash = link?.properties?.hashed_token
  if (linkError || !tokenHash || link.user?.id !== owner.userId) {
    console.error('[mcp] consent: sign-in link not created:', linkError?.code ?? 'no token')
    return { ok: false, reason: 'failed' }
  }

  const client = anonAuthClient()
  const { data: verified, error: verifyError } = await client.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
  const stray = verified?.session ? sessionId(verified.session.access_token) : null
  if (verifyError || !verified?.session || !stray) {
    console.error('[mcp] consent: sign-in link not accepted:', verifyError?.code ?? 'no session')
    await endSupabaseSession(service, stray)
    return { ok: false, reason: 'failed' }
  }

  const { data: upgraded, error: mfaError } = await client.auth.mfa.challengeAndVerify({ factorId: owner.factorId, code })
  if (mfaError || !upgraded) {
    await endSupabaseSession(service, stray)
    const wrongCode = mfaError?.code === 'mfa_verification_failed' || mfaError?.code === 'mfa_challenge_expired' || mfaError?.code === 'invalid_credentials'
    if (!wrongCode) console.error('[mcp] consent: second factor failed:', mfaError?.code ?? 'no session')
    return { ok: false, reason: wrongCode ? 'code' : 'failed' }
  }

  const claims = jwtClaims(upgraded.access_token)
  const id = typeof claims?.session_id === 'string' ? claims.session_id : null
  const exp = typeof claims?.exp === 'number' ? claims.exp : null
  if (claims?.aal !== 'aal2' || claims.sub !== owner.userId || !id || !exp || !upgraded.refresh_token) {
    console.error('[mcp] consent: the session is not the owner\'s at aal2')
    await endSupabaseSession(service, id)
    if (id !== stray) await endSupabaseSession(service, stray)
    return { ok: false, reason: 'failed' }
  }
  if (id !== stray) await endSupabaseSession(service, stray)
  return { ok: true, session: { accessToken: upgraded.access_token, refreshToken: upgraded.refresh_token, expiresAt: exp, sessionId: id } }
}

export type SessionAccess =
  | { ok: true; accessToken: string }
  // The session is gone for good (signed out everywhere, password changed, reuse detected): the
  // grant has to be revoked.
  | { ok: false; reason: 'ended' }
  // Supabase could not be reached or another request is still refreshing: try again shortly.
  | { ok: false; reason: 'unavailable' }

const expiresAtMs = (stored: Pick<StoredSession, 'sb_access_expires_at'>) =>
  stored.sb_access_expires_at ? Date.parse(stored.sb_access_expires_at) : 0

function decryptAccess(grantId: string, stored: StoredSession): string | null {
  try {
    return stored.sb_access_enc ? decryptSecret(stored.sb_access_enc, grantId) : null
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The grant's current Supabase access token, refreshed by one request under the lease when fewer
// than SESSION_REFRESH_MARGIN seconds remain. A request that finds the lease taken keeps using the
// old token while it is still valid, else waits for the refreshed one.
export async function grantAccessToken(service: ServiceClient, grantId: string, stored: StoredSession, now = Date.now()): Promise<SessionAccess> {
  const current = decryptAccess(grantId, stored)
  if (current && expiresAtMs(stored) - now > SESSION_REFRESH_MARGIN * 1000) return { ok: true, accessToken: current }

  const leased = await acquireSessionLease(service, grantId, now)
  if (!leased) {
    if (current && expiresAtMs(stored) - now > 10_000) return { ok: true, accessToken: current }
    for (let waited = 0; waited < SESSION_REFRESH_LEASE * 1000; waited += 250) {
      await sleep(250)
      const fresh = await readStoredSession(service, grantId)
      if (!fresh) return { ok: false, reason: 'ended' }
      const token = decryptAccess(grantId, fresh)
      if (token && expiresAtMs(fresh) - Date.now() > 10_000) return { ok: true, accessToken: token }
    }
    return { ok: false, reason: 'unavailable' }
  }

  let refreshToken: string
  try {
    refreshToken = decryptSecret(leased.sb_refresh_enc ?? '', grantId)
  } catch {
    await releaseSessionLease(service, grantId)
    return { ok: false, reason: 'ended' }
  }
  // Another request may have refreshed between our read and the lease.
  const leasedToken = decryptAccess(grantId, leased)
  if (leasedToken && expiresAtMs(leased) - now > SESSION_REFRESH_MARGIN * 1000) {
    await releaseSessionLease(service, grantId)
    return { ok: true, accessToken: leasedToken }
  }

  try {
    const { data, error } = await anonAuthClient().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) {
      await releaseSessionLease(service, grantId)
      // An answer from Supabase Auth refusing the token ends the grant; anything else is transient.
      if (error && !(isAuthApiError(error) && error.status >= 400 && error.status < 500)) return { ok: false, reason: 'unavailable' }
      return { ok: false, reason: 'ended' }
    }
    const exp = jwtClaims(data.session.access_token)?.exp
    const expiresAt = typeof exp === 'number' ? exp : Math.floor(Date.now() / 1000) + (data.session.expires_in ?? 0)
    await saveSession(service, grantId, { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt })
    return { ok: true, accessToken: data.session.access_token }
  } catch (err) {
    console.error('[mcp] session refresh failed:', err instanceof Error ? err.name : typeof err)
    await releaseSessionLease(service, grantId)
    return { ok: false, reason: 'unavailable' }
  }
}
