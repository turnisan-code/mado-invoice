import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser, settingsUnavailable } from '@/lib/auth'
import { gmailReadRefusal, previewDeps, recordGmailError, RECEIPT_SETTINGS_COLUMNS, type ReceiptSettings } from '@/lib/expenses/receipt-deps'
import { isGmailAuthError } from '@/lib/expenses/gmail-parts'
import { GMAIL_PREVIEW_MAX_BYTES, gmailPreviewable } from '@/lib/expenses/receipt-match'
import type { BankLineReceiptSearch } from '@/types'

export const maxDuration = 60

// „Vorschau“ (PR 9b): a PDF the line's Gmail search found, from Gmail, up to 3 MB — only one its
// list names. Gmail is only read.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const messageId = req.nextUrl.searchParams.get('message_id') ?? ''
  const partId = req.nextUrl.searchParams.get('part_id') || null
  const { data: line, error: lineErr } = await supabase.from('bank_lines').select('receipt_search').eq('id', id).maybeSingle()
  if (lineErr) return apiError(500, 'database', lineErr.message)
  const search = (line as { receipt_search: BankLineReceiptSearch | null } | null)?.receipt_search
  const c = (search?.candidates ?? []).find(x => x.message_id === messageId && (x.part_id ?? null) === partId)
  if (!c) return apiError(404, 'not_found', 'This PDF is not in the line’s list')
  if (!gmailPreviewable(c)) return apiError(400, 'invalid_request', 'This PDF is too large for the preview')

  const { data: settings, error } = await supabase.from('settings').select(RECEIPT_SETTINGS_COLUMNS).single()
  if (error || !settings) return settingsUnavailable(error)
  const s = settings as unknown as ReceiptSettings
  const refusal = gmailReadRefusal(s)
  if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status })
  try {
    const pdf = await previewDeps(s, supabase).getPdfAttachment(messageId, partId)
    if (!pdf) return apiError(404, 'not_found', 'The PDF is no longer in Gmail')
    const bytes = Buffer.from(pdf.base64, 'base64')
    if (bytes.length > GMAIL_PREVIEW_MAX_BYTES) return apiError(400, 'invalid_request', 'This PDF is too large for the preview')
    return new NextResponse(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store' },
    })
  } catch (err) {
    if (isGmailAuthError(err)) await recordGmailError(err, supabase, s.id)
    return apiError(502, 'google_failed', err instanceof Error ? err.message : 'Gmail failed')
  }
}
