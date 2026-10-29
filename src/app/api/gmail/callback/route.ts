import { google, type Auth } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getOAuthClient, googleErrorMessage, OAUTH_STATE_COOKIE } from '@/lib/google/client'

function clearState(res: NextResponse) {
  res.cookies.set(OAUTH_STATE_COOKIE.name, '', { maxAge: 0, path: OAUTH_STATE_COOKIE.path })
  return res
}

export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  // A browser navigation, so every failure lands back in Settings, which says it in the UI language.
  const failed = () => clearState(NextResponse.redirect(`${appUrl}/settings?gmail=error`))

  const state = req.nextUrl.searchParams.get('state')
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE.name)?.value
  if (!state || !expectedState || state !== expectedState) {
    console.error('[gmail/callback] OAuth state missing or not matching')
    return failed()
  }

  const code = req.nextUrl.searchParams.get('code')
  if (!code) return failed()

  const oauth2 = getOAuthClient()
  let tokens: Auth.Credentials
  let email: string | null | undefined
  try {
    tokens = (await oauth2.getToken(code)).tokens
    oauth2.setCredentials(tokens)
    const { data: userInfo } = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get()
    email = userInfo.email
  } catch (err) {
    console.error('[gmail/callback]', googleErrorMessage(err))
    return failed()
  }
  if (!tokens.refresh_token) {
    console.error('[gmail/callback] Google returned no refresh token')
    return failed()
  }

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('id').single()
  if (settingsErr || !settings) {
    console.error('[gmail/callback] settings not loaded:', settingsErr?.message)
    return failed()
  }

  const { error } = await supabase.from('settings').update({
    gmail_email: email,
    gmail_access_token: tokens.access_token,
    gmail_refresh_token: tokens.refresh_token,
    gmail_token_expiry: tokens.expiry_date,
    gmail_connected_at: new Date().toISOString(),
    gmail_scopes: tokens.scope ?? null,
    google_last_error: null,
    google_last_error_at: null,
  }).eq('id', settings.id)
  if (error) {
    console.error('[gmail/callback] could not store tokens:', error.message)
    return failed()
  }

  return clearState(NextResponse.redirect(`${appUrl}/settings?gmail=connected`))
}
