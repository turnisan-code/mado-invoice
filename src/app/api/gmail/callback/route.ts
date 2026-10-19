import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient, OAUTH_STATE_COOKIE } from '@/lib/google/client'

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
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return clearState(NextResponse.redirect(`${appUrl}/settings?gmail=error`))

  const oauth2 = getOAuthClient()
  const { tokens } = await oauth2.getToken(code)
  oauth2.setCredentials(tokens)

  // Fetch the Gmail address for display
  const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 })
  const { data: userInfo } = await oauth2api.userinfo.get()

  const { data: settings } = await supabase.from('settings').select('id').single()
  if (!settings) return clearState(NextResponse.redirect(`${appUrl}/settings?gmail=error`))

  await supabase.from('settings').update({
    gmail_email: userInfo.email,
    gmail_access_token: tokens.access_token,
    gmail_refresh_token: tokens.refresh_token,
    gmail_token_expiry: tokens.expiry_date,
  }).eq('id', settings.id)

  return clearState(NextResponse.redirect(`${appUrl}/settings?gmail=connected`))
}
