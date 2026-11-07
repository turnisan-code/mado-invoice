import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { googleNotConnected } from '@/lib/google/client'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { DocumentNotFoundError } from '@/lib/pdf/render'
import { ArchiveError } from '@/lib/pdf/snapshot'
import { EInvoiceError } from '@/lib/einvoice/common'
import { MAX_COPIES, sendDocumentEmail } from '@/lib/services/email'

// The attached PDF, and the one a Peppol e-invoice embeds, may first have to be rendered.
export const maxDuration = 60

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

  // The attachment is the document's frozen copy, loaded (or made, when it is missing) by the
  // service: the browser sends no PDF, and any other field in the body is ignored. The editor
  // issues a draft before it can be emailed. The client's e-invoice goes along; nothing is sent
  // when it cannot be built, and the dialog says why (einvoice.errors.*).
  const result = await sendDocumentEmail(supabase, settings, {
    documentId: (documentId as string | undefined) ?? null,
    to: [to],
    cc: cc.emails,
    bcc: bcc.emails,
    subject,
    body,
    einvoice: einvoice === 'ebinterface' || einvoice === 'ubl' ? einvoice : null,
  })
  if (result.ok) return NextResponse.json({ ok: true })

  if (result.stage === 'send') {
    const { status, error, code } = result.failure
    return NextResponse.json({ error, code }, { status })
  }
  const err = result.error
  if (result.stage === 'pdf') {
    if (err instanceof ArchiveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_issued' ? 400 : 500 })
    }
    if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
    console.error('[gmail/send] issued PDF failed:', err)
    return apiError(500, 'pdf_failed', err instanceof Error ? err.message : 'PDF unavailable')
  }
  if (err instanceof EInvoiceError) return NextResponse.json({ error: err.message, code: err.code, einvoice: true }, { status: 422 })
  if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
  console.error('[gmail/send] e-invoice failed:', err)
  return apiError(500, 'server_error', err instanceof Error ? err.message : 'E-invoice unavailable', { einvoice: true })
}
