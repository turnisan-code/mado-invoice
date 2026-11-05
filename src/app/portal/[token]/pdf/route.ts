import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import { pdfFilename } from '@/lib/pdf/render'
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

  const { data: doc } = await supabase.from('documents').select('id, number, share_expires_at, language').eq('share_token', token).maybeSingle()
  if (!doc?.number) return notice(404, `${documentT('de')('pdfPortal.portal.notFoundTitle')} / ${documentT('en')('pdfPortal.portal.notFoundTitle')}`)
  const t = documentT(documentLanguage(doc.language))
  if (isShareExpired(doc.share_expires_at)) return notice(410, t('pdfPortal.portal.expiredTitle'))

  // Only ever the frozen copy, the PDF every other copy is: a document issued before archive
  // copies existed gets it stored now. A stored copy that cannot be read right now is not
  // replaced by a render of today's data.
  let buffer: Buffer
  try {
    buffer = (await getIssuedPdf(supabase, doc.id, 'on_demand')).buffer
  } catch (err) {
    console.error('[portal/pdf] issued PDF unavailable:', err)
    return notice(503, t('messages.portalPdfUnavailable'))
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFilename(doc.number)}"`,
    },
  })
}
