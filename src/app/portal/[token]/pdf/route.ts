import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, renderDocumentPdf } from '@/lib/pdf/render'

export const maxDuration = 60

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: doc } = await supabase.from('documents').select('id, number').eq('share_token', token).maybeSingle()
  if (!doc?.number) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The client downloads the frozen issued copy; rendering without storing is only the fallback
  // when the archive is unreachable.
  let buffer: Buffer
  try {
    buffer = (await getIssuedPdf(supabase, doc.id, 'on_demand')).buffer
  } catch (err) {
    console.error('[portal/pdf] archive copy unavailable, rendering instead:', err)
    buffer = (await renderDocumentPdf(supabase, doc.id)).buffer
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFilename(doc.number)}"`,
    },
  })
}
