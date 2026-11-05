import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { sendGmail, type MailAttachment } from '@/lib/utils/reminder'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { logEvent } from '@/lib/events'
import { DocumentNotFoundError } from '@/lib/pdf/render'
import { ArchiveError, getIssuedPdf } from '@/lib/pdf/snapshot'
import { EInvoiceError } from '@/lib/einvoice/common'
import { exportEInvoice } from '@/lib/einvoice/export'

// The attached PDF, and the one a Peppol e-invoice embeds, may first have to be rendered.
export const maxDuration = 60

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

  const { to, subject, body, documentId, einvoice } = payload
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
  if (documentId !== undefined && !isUuid(documentId)) {
    return apiError(400, 'invalid_request', 'Invalid documentId')
  }
  if (einvoice != null && ((einvoice !== 'ebinterface' && einvoice !== 'ubl') || !documentId)) {
    return apiError(400, 'invalid_request', 'einvoice must be ebinterface or ubl, with a documentId')
  }

  // The attachment is the document's frozen copy, loaded here: never a PDF the browser sends
  // (pdfBase64 is ignored). The editor issues a draft before it can be emailed.
  let attachment: MailAttachment | null = null
  if (documentId) {
    try {
      const issued = await getIssuedPdf(supabase, documentId as string, 'on_demand')
      attachment = { filename: issued.filename, content: issued.buffer }
    } catch (err) {
      if (err instanceof ArchiveError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_issued' ? 400 : 500 })
      }
      if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
      console.error('[gmail/send] issued PDF failed:', err)
      return apiError(500, 'pdf_failed', err instanceof Error ? err.message : 'PDF unavailable')
    }
  }
  // The client's e-invoice goes along, built from the stored document as the download is. Nothing
  // is sent when it cannot be built; the dialog says why (einvoice.errors.*).
  let xml: (MailAttachment & { format: 'ebinterface' | 'ubl'; number: string; pdfEmbedded: boolean }) | null = null
  if (einvoice === 'ebinterface' || einvoice === 'ubl') {
    try {
      const built = await exportEInvoice(supabase, documentId as string, einvoice)
      xml = { filename: built.filename, content: Buffer.from(built.xml, 'utf8'), contentType: 'application/xml', format: einvoice, number: built.number, pdfEmbedded: built.attached }
    } catch (err) {
      if (err instanceof EInvoiceError) return NextResponse.json({ error: err.message, code: err.code, einvoice: true }, { status: 422 })
      if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
      console.error('[gmail/send] e-invoice failed:', err)
      return apiError(500, 'server_error', err instanceof Error ? err.message : 'E-invoice unavailable', { einvoice: true })
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
