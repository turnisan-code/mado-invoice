import { google } from 'googleapis'
import { after, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Settings } from '@/types'
import { GOOGLE_NOT_CONNECTED_MESSAGE, GOOGLE_REAUTH_CODE, GOOGLE_REAUTH_MESSAGE, GOOGLE_SCOPE_MESSAGE } from './reauth'

export const OAUTH_STATE_COOKIE = { name: 'gmail_oauth_state', path: '/api/gmail' } as const

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`,
  )
}

export type GoogleAuth = ReturnType<typeof getOAuthClient>
export type GoogleTokenSettings = Pick<Settings, 'id' | 'gmail_access_token' | 'gmail_refresh_token' | 'gmail_token_expiry'>

export function getAuthorizedGoogle(settings: GoogleTokenSettings, supabase: SupabaseClient): GoogleAuth {
  const oauth2 = getOAuthClient()
  oauth2.setCredentials({
    access_token: settings.gmail_access_token,
    refresh_token: settings.gmail_refresh_token,
    expiry_date: settings.gmail_token_expiry,
  })
  // A refreshed token is written back after the response at the latest: on serverless a write
  // left dangling would be cut off, and every later call would refresh again.
  oauth2.on('tokens', tokens => {
    const write = Promise.resolve(supabase.from('settings').update({
      gmail_access_token: tokens.access_token,
      ...(tokens.refresh_token ? { gmail_refresh_token: tokens.refresh_token } : {}),
      gmail_token_expiry: tokens.expiry_date,
    }).eq('id', settings.id)).then(({ error }) => {
      if (error) console.error('[google] token write-back failed:', error.message)
    })
    try {
      after(write)
    } catch {
      // Outside a request (scripts): the write still runs, nothing waits for it.
    }
  })
  return oauth2
}

// The last Google failure, shown in Settings until a test or a reconnect succeeds.
export async function recordGoogleError(supabase: SupabaseClient, settingsId: string, message: string | null) {
  const { error } = await supabase.from('settings')
    .update({ google_last_error: message, google_last_error_at: message ? new Date().toISOString() : null })
    .eq('id', settingsId)
  if (error) console.error('[google] last error not recorded:', error.message)
}

// The grant is gone (revoked, invalid_grant): the tokens are cleared so every page shows the
// reconnect state; the account email stays for that message.
export async function clearGoogleTokens(supabase: SupabaseClient, settingsId: string, reason = GOOGLE_REAUTH_MESSAGE) {
  const { error } = await supabase.from('settings')
    .update({ gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null })
    .eq('id', settingsId)
  if (error) console.error('[google] could not clear tokens:', error.message)
  await recordGoogleError(supabase, settingsId, reason)
}

type GoogleErrorShape = {
  message?: unknown
  code?: unknown
  status?: unknown
  response?: { status?: unknown; data?: { error?: unknown; error_description?: unknown } }
}

function describe(err: unknown): { status: number; text: string } {
  if (!err || typeof err !== 'object') return { status: 0, text: String(err ?? '') }
  const e = err as GoogleErrorShape
  const status = [e.response?.status, e.status, e.code].map(Number).find(n => Number.isInteger(n) && n > 0) ?? 0
  const data = e.response?.data
  const nested = data?.error && typeof data.error === 'object' ? (data.error as { message?: unknown }).message : undefined
  const text = [e.message, data?.error, data?.error_description, nested]
    .filter((p): p is string => typeof p === 'string')
    .join(' ')
  return { status, text }
}

export function isGoogleAuthError(err: unknown): boolean {
  const { status, text } = describe(err)
  return status === 401 || /invalid_grant|Token has been expired or revoked|invalid_token/i.test(text)
}

export function isGoogleScopeError(err: unknown): boolean {
  const { status, text } = describe(err)
  return status === 403 && /insufficient/i.test(text)
}

export function isGoogleNotFound(err: unknown): boolean {
  return describe(err).status === 404
}

export function googleErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Google request failed'
}

// No tokens: never connected, or the connection expired (the account email is still on record).
export function googleNotConnected(settings?: Pick<Settings, 'gmail_email'> | null) {
  const expired = !!settings?.gmail_email
  return NextResponse.json({ error: expired ? GOOGLE_REAUTH_MESSAGE : GOOGLE_NOT_CONNECTED_MESSAGE, code: GOOGLE_REAUTH_CODE }, { status: expired ? 401 : 400 })
}

export async function googleErrorResponse(err: unknown, supabase: SupabaseClient, settingsId: string, context: string) {
  if (isGoogleAuthError(err)) {
    await clearGoogleTokens(supabase, settingsId)
    return NextResponse.json({ error: GOOGLE_REAUTH_MESSAGE, code: GOOGLE_REAUTH_CODE }, { status: 401 })
  }
  if (isGoogleScopeError(err)) {
    await recordGoogleError(supabase, settingsId, GOOGLE_SCOPE_MESSAGE)
    return NextResponse.json({ error: GOOGLE_SCOPE_MESSAGE, code: GOOGLE_REAUTH_CODE }, { status: 403 })
  }
  const message = googleErrorMessage(err)
  console.error(`[${context}]`, message)
  await recordGoogleError(supabase, settingsId, message)
  return NextResponse.json({ error: message }, { status: 502 })
}
