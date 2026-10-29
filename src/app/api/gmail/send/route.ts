import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { sendGmail, type MailAttachment } from '@/lib/utils/reminder'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { logEvent } from '@/lib/events'
import { DocumentNotFoundError } from '@/lib/pdf/render'
import { EInvoiceError } from '@/lib/einvoice/common'
import { exportEInvoice } from '@/lib/einvoice/export'

// Building a Peppol e-invoice embeds the issued PDF, which may first have to be rendered.
export const maxDuration = 60

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

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('*').single()
  if (settingsErr || !settings) return NextResponse.json({ error: settingsErr?.message ?? 'Settings not found' }, { status: 500 })
  if (!settings.gmail_refresh_token) return googleNotConnected(settings)

  let payload: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; pdfBase64?: unknown; filename?: unknown; documentId?: unknown; einvoice?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { to, subject, body, pdfBase64, filename, documentId, einvoice } = payload ?? {}
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
  if (einvoice != null && ((einvoice !== 'ebinterface' && einvoice !== 'ubl') || !documentId)) {
    return NextResponse.json({ error: 'einvoice must be ebinterface or ubl, with a documentId' }, { status: 400 })
  }

  const attachment = pdfBase64 && filename ? { filename, content: Buffer.from(pdfBase64, 'base64') } : null
  // The client's e-invoice goes along, built from the stored document as the download is. Nothing
  // is sent when it cannot be built; the dialog says why (einvoice.errors.*).
  let xml: (MailAttachment & { format: 'ebinterface' | 'ubl'; number: string; pdfEmbedded: boolean }) | null = null
  if (einvoice === 'ebinterface' || einvoice === 'ubl') {
    try {
      const built = await exportEInvoice(supabase, documentId as string, einvoice)
      xml = { filename: built.filename, content: Buffer.from(built.xml, 'utf8'), contentType: 'application/xml', format: einvoice, number: built.number, pdfEmbedded: built.attached }
    } catch (err) {
      if (err instanceof EInvoiceError) return NextResponse.json({ error: err.message, code: err.code, einvoice: true }, { status: 422 })
      if (err instanceof DocumentNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
      console.error('[gmail/send] e-invoice failed:', err)
      return NextResponse.json({ error: err instanceof Error ? err.message : 'E-invoice unavailable', einvoice: true }, { status: 500 })
    }
  }

  try {
    await sendGmail(getAuthorizedGoogle(settings, supabase), {
      from: settings.gmail_email,
      to: to.trim(),
      cc: cc.emails,
      bcc: bcc.emails,
      subject,
      body,
      attachments: [attachment, xml].filter(a => a !== null),
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
      ...(xml ? { einvoice: xml.filename } : {}),
    })
    if (xml) await logEvent(supabase, documentId, 'einvoice_exported', { format: xml.format, number: xml.number, pdf: xml.pdfEmbedded, emailed: to.trim() })
  }

  return NextResponse.json({ ok: true })
}
