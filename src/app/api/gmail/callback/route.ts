import { google, type Auth } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient, googleErrorMessage, OAUTH_STATE_COOKIE } from '@/lib/google/client'

function clearState(res: NextResponse) {
  res.cookies.set(OAUTH_STATE_COOKIE.name, '', { maxAge: 0, path: OAUTH_STATE_COOKIE.path })
  return res
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const state = req.nextUrl.searchParams.get('state')
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE.name)?.value
  if (!state || !expectedState || state !== expectedState) {
    return clearState(NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 }))
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  const failed = () => clearState(NextResponse.redirect(`${appUrl}/settings?gmail=error`))

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

  const { data: settings } = await supabase.from('settings').select('id').single()
  if (!settings) return failed()

  const { error } = await supabase.from('settings').update({
    gmail_email: email,
    gmail_access_token: tokens.access_token,
    gmail_refresh_token: tokens.refresh_token,
    gmail_token_expiry: tokens.expiry_date,
    gmail_connected_at: new Date().toISOString(),
    gmail_scopes: tokens.scope ?? null,
  }).eq('id', settings.id)
  if (error) {
    console.error('[gmail/callback] could not store tokens:', error.message)
    return failed()
  }

  return clearState(NextResponse.redirect(`${appUrl}/settings?gmail=connected`))
}
