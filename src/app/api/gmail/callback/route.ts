import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient } from '@/lib/google/client'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?gmail=error`)

  const oauth2 = getOAuthClient()
  const { tokens } = await oauth2.getToken(code)
  oauth2.setCredentials(tokens)

  // Fetch the Gmail address for display
  const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 })
  const { data: userInfo } = await oauth2api.userinfo.get()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login`)

  const { data: settings } = await supabase.from('settings').select('id').single()
  if (!settings) return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?gmail=error`)

  await supabase.from('settings').update({
    gmail_email: userInfo.email,
    gmail_access_token: tokens.access_token,
    gmail_refresh_token: tokens.refresh_token,
    gmail_token_expiry: tokens.expiry_date,
  }).eq('id', settings.id)

  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/settings?gmail=connected`)
}
