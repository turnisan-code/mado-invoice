import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`,
  )
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token) {
    return NextResponse.json({ error: 'Google not connected' }, { status: 400 })
  }
  if (!settings.drive_folder_id) {
    return NextResponse.json({ error: 'No Drive folder configured' }, { status: 400 })
  }

  const { pdfBase64, filename } = await req.json()

  const oauth2 = getOAuthClient()
  oauth2.setCredentials({
    access_token: settings.gmail_access_token,
    refresh_token: settings.gmail_refresh_token,
    expiry_date: settings.gmail_token_expiry,
  })

  oauth2.on('tokens', async (tokens) => {
    await supabase.from('settings').update({
      gmail_access_token: tokens.access_token,
      ...(tokens.refresh_token ? { gmail_refresh_token: tokens.refresh_token } : {}),
      gmail_token_expiry: tokens.expiry_date,
    }).eq('user_id', user.id)
  })

  const drive = google.drive({ version: 'v3', auth: oauth2 })

  const buffer = Buffer.from(pdfBase64, 'base64')
  const { Readable } = await import('stream')
  const stream = Readable.from(buffer)

  const { data: file } = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [settings.drive_folder_id],
    },
    media: {
      mimeType: 'application/pdf',
      body: stream,
    },
    fields: 'id,webViewLink',
  })

  return NextResponse.json({ fileId: file.id, webViewLink: file.webViewLink })
}
