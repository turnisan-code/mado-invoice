import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { readStoredPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, renderDocumentPdf } from '@/lib/pdf/render'
import { isShareExpired } from '@/lib/share'

export const maxDuration = 60

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: doc } = await supabase.from('documents').select('id, number, pdf_path, share_expires_at').eq('share_token', token).maybeSingle()
  if (!doc?.number) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (isShareExpired(doc.share_expires_at)) return NextResponse.json({ error: 'This link has expired' }, { status: 410 })

  // The frozen copy stored at issuance is what the client received; a document issued before
  // archive copies existed is rendered from the stored data (this public route never writes).
  const buffer = (doc.pdf_path ? await readStoredPdf(supabase, doc.pdf_path) : null)
    ?? (await renderDocumentPdf(supabase, doc.id)).buffer

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFilename(doc.number)}"`,
    },
  })
}
