import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { logEvent } from '@/lib/events'
import { DocumentNotFoundError } from '@/lib/pdf/render'
import { EInvoiceError } from '@/lib/einvoice/common'
import { exportEInvoice } from '@/lib/einvoice/export'

export const maxDuration = 60

// ?format=ebinterface|ubl — the structured e-invoice of an issued invoice or credit note as a
// download. Refusals answer 422 with a code the dialog words (einvoice.errors.*).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const format = req.nextUrl.searchParams.get('format')
  if (format !== 'ebinterface' && format !== 'ubl') {
    return NextResponse.json({ error: 'format must be ebinterface or ubl', code: 'format' }, { status: 400 })
  }

  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const { xml, filename, number, attached } = await exportEInvoice(supabase, id, format)
    await logEvent(supabase, id, 'einvoice_exported', { format, number, pdf: attached })
    return new NextResponse(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
    if (err instanceof EInvoiceError) return NextResponse.json({ error: err.message, code: err.code }, { status: 422 })
    console.error('[documents/einvoice]', err)
    return apiError(500, 'server_error', err instanceof Error ? err.message : 'E-invoice unavailable')
  }
}
