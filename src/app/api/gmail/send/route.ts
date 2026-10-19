import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient } from '@/lib/google/client'
import { buildMime } from '@/lib/utils/reminder'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 })
  }

  let payload: { to?: unknown; subject?: unknown; body?: unknown; pdfBase64?: unknown; filename?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { to, subject, body, pdfBase64, filename } = payload ?? {}
  if (typeof to !== 'string' || !EMAIL_RE.test(to)) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  if (typeof subject !== 'string' || typeof body !== 'string') {
    return NextResponse.json({ error: 'subject and body are required' }, { status: 400 })
  }
  if ((pdfBase64 !== undefined && typeof pdfBase64 !== 'string') || (filename !== undefined && typeof filename !== 'string')) {
    return NextResponse.json({ error: 'Invalid attachment' }, { status: 400 })
  }

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
    }).eq('id', settings.id)
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const raw = buildMime({
    from: settings.gmail_email,
    to,
    subject: subject.replace(/[\r\n]+/g, ' '),
    body,
    pdfBase64,
    filename: filename?.replace(/[\r\n"]+/g, ''),
  })

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })

  return NextResponse.json({ ok: true })
}
