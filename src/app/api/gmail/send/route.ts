import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
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
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('*').single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)
  if (!settings.gmail_refresh_token) return googleNotConnected(settings)

  const payload = await readJsonObject(req)
  if (!payload) return invalidJson()

  const { to, subject, body, pdfBase64, filename, documentId } = payload
  if (typeof to !== 'string' || !isPlainAddress(to.trim())) {
    return apiError(400, 'invalid_address', 'Invalid recipient address')
  }
  const cc = addressList(payload.cc)
  const bcc = addressList(payload.bcc)
  if (!cc || !bcc || cc.invalid.length || bcc.invalid.length || cc.emails.length + bcc.emails.length > MAX_COPIES) {
    return apiError(400, 'invalid_address', 'Invalid CC or BCC address')
  }
  if (typeof subject !== 'string' || typeof body !== 'string') {
    return apiError(400, 'invalid_request', 'subject and body are required')
  }
  if ((pdfBase64 !== undefined && typeof pdfBase64 !== 'string') || (filename !== undefined && typeof filename !== 'string')) {
    return apiError(400, 'invalid_request', 'Invalid attachment')
  }
  if (documentId !== undefined && !isUuid(documentId)) {
    return apiError(400, 'invalid_request', 'Invalid documentId')
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
