import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
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

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    if (err instanceof DocumentNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof EInvoiceError) return NextResponse.json({ error: err.message, code: err.code }, { status: 422 })
    console.error('[documents/einvoice]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'E-invoice unavailable' }, { status: 500 })
  }
}
