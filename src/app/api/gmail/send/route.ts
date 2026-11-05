import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { sendGmail } from '@/lib/utils/reminder'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { logEvent } from '@/lib/events'

const MAX_COPIES = 20

function addressList(value: unknown): { emails: string[]; invalid: string[] } | null {
  if (value === undefined || value === null) return { emails: [], invalid: [] }
  if (typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'))) return parseEmailList(value)
  return null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token) return googleNotConnected()

  let payload: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; pdfBase64?: unknown; filename?: unknown; documentId?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { to, subject, body, pdfBase64, filename, documentId } = payload ?? {}
  if (typeof to !== 'string' || !isPlainAddress(to.trim())) {
    return NextResponse.json({ error: 'Invalid recipient address', code: 'invalid_address' }, { status: 400 })
  }
  const cc = addressList(payload?.cc)
  const bcc = addressList(payload?.bcc)
  if (!cc || !bcc || cc.invalid.length || bcc.invalid.length || cc.emails.length + bcc.emails.length > MAX_COPIES) {
    return NextResponse.json({ error: 'Invalid CC or BCC address', code: 'invalid_address' }, { status: 400 })
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

  const attachment = pdfBase64 && filename ? { filename, content: Buffer.from(pdfBase64, 'base64') } : null
  try {
    await sendGmail(getAuthorizedGoogle(settings, supabase), {
      from: settings.gmail_email,
      to: to.trim(),
      cc: cc.emails,
      bcc: bcc.emails,
      subject,
      body,
      attachments: attachment ? [attachment] : [],
    })
  } catch (err) {
    return googleErrorResponse(err, supabase, settings.id, 'gmail/send')
  }

  if (documentId) {
    const { error } = await supabase.from('documents')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', documentId)
      .is('sent_at', null)
    if (error) console.error('[gmail/send] sent_at not recorded:', error.message)
    await logEvent(supabase, documentId, 'emailed', {
      to: to.trim(),
      ...(cc.emails.length ? { cc: cc.emails } : {}),
      ...(bcc.emails.length ? { bcc: bcc.emails } : {}),
      subject,
      attachment: attachment?.filename ?? null,
    })
  }

  return NextResponse.json({ ok: true })
}
