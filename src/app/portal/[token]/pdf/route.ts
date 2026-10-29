import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { readStoredPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, renderDocumentPdf } from '@/lib/pdf/render'
import { isShareExpired } from '@/lib/share'
import { documentLanguage, documentT } from '@/lib/document-labels'

export const maxDuration = 60

// Opened from the portal's download link, so a refusal is for the client to read: in the
// document's language, or in German and English when the token matches no document.
function notice(status: number, text: string) {
  return new NextResponse(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: doc } = await supabase.from('documents').select('id, number, pdf_path, share_expires_at, language').eq('share_token', token).maybeSingle()
  if (!doc?.number) return notice(404, `${documentT('de')('pdfPortal.portal.notFoundTitle')} / ${documentT('en')('pdfPortal.portal.notFoundTitle')}`)
  if (isShareExpired(doc.share_expires_at)) return notice(410, documentT(documentLanguage(doc.language))('pdfPortal.portal.expiredTitle'))

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
