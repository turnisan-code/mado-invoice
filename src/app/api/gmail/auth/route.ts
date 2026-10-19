import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient, OAUTH_STATE_COOKIE } from '@/lib/google/client'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('id, gmail_access_token, gmail_refresh_token').single()
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  // Revoking either token invalidates the whole grant; a failure here only means Google
  // already forgot it (or is unreachable), so the local disconnect proceeds regardless.
  const token = settings.gmail_refresh_token ?? settings.gmail_access_token
  if (token) await getOAuthClient().revokeToken(token).catch(() => undefined)

  const { error } = await supabase.from('settings').update({
    gmail_email: null,
    gmail_access_token: null,
    gmail_refresh_token: null,
    gmail_token_expiry: null,
    gmail_connected_at: null,
    gmail_scopes: null,
  }).eq('id', settings.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
