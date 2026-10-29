import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { databaseError, requireUser, settingsUnavailable } from '@/lib/auth'
import { getOAuthClient, OAUTH_STATE_COOKIE } from '@/lib/google/client'

export async function GET() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response

  const state = randomUUID()
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive',
    ],
    state,
  })

  const res = NextResponse.redirect(url)
  res.cookies.set(OAUTH_STATE_COOKIE.name, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
    path: OAUTH_STATE_COOKIE.path,
  })
  return res
}

export async function DELETE() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('id, gmail_access_token, gmail_refresh_token').single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)

  // Revoking either token invalidates the whole grant; a failure here only means Google
  // already forgot it (or is unreachable), so the local disconnect proceeds regardless. The Drive
  // folder belongs to that account and goes with it.
  const token = settings.gmail_refresh_token ?? settings.gmail_access_token
  if (token) await getOAuthClient().revokeToken(token).catch(() => undefined)

  const { error } = await supabase.from('settings').update({
    gmail_email: null,
    gmail_access_token: null,
    gmail_refresh_token: null,
    gmail_token_expiry: null,
    gmail_connected_at: null,
    gmail_scopes: null,
    drive_folder_id: null,
    drive_folder_name: null,
    google_last_error: null,
    google_last_error_at: null,
  }).eq('id', settings.id)
  if (error) return databaseError(error)

  return NextResponse.json({ ok: true })
}
