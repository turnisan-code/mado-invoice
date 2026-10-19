import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { buildMime } from '@/lib/utils/reminder'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token) return googleNotConnected()

  let payload: { to?: unknown; subject?: unknown; body?: unknown; pdfBase64?: unknown; filename?: unknown; documentId?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { to, subject, body, pdfBase64, filename, documentId } = payload ?? {}
  if (typeof to !== 'string' || !EMAIL_RE.test(to)) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  if (typeof subject !== 'string' || typeof body !== 'string') {
    return NextResponse.json({ error: 'subject and body are required' }, { status: 400 })
  }
  if ((pdfBase64 !== undefined && typeof pdfBase64 !== 'string') || (filename !== undefined && typeof filename !== 'string')) {
    return NextResponse.json({ error: 'Invalid attachment' }, { status: 400 })
  }
  if (documentId !== undefined && typeof documentId !== 'string') {
    return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 })
  }

  const gmail = google.gmail({ version: 'v1', auth: getAuthorizedGoogle(settings, supabase) })
  const raw = buildMime({
    from: settings.gmail_email,
    to,
    subject: subject.replace(/[\r\n]+/g, ' '),
    body,
    pdfBase64,
    filename: filename?.replace(/[\r\n"]+/g, ''),
  })

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  } catch (err) {
    return googleErrorResponse(err, supabase, settings.id, 'gmail/send')
  }

  if (documentId) {
    const { error } = await supabase.from('documents')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', documentId)
      .is('sent_at', null)
    if (error) console.error('[gmail/send] sent_at not recorded:', error.message)
  }

  return NextResponse.json({ ok: true })
}
