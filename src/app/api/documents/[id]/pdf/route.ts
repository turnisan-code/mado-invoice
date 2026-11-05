import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { ArchiveError, getIssuedPdf } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError } from '@/lib/pdf/render'

export const maxDuration = 60

// Every outgoing copy of a numbered document (download, email, reminder, Drive, Bookamat) is this
// stored PDF. A document issued before archive copies existed gets one on first request. The
// payments and the open balance a reminder asks for are on the Mahnung, never on this copy.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const { buffer, filename } = await getIssuedPdf(supabase, id, 'on_demand')
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
    if (err instanceof ArchiveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_issued' ? 404 : 500 })
    }
    console.error('[documents/pdf]', err)
    return apiError(500, 'pdf_failed', err instanceof Error ? err.message : 'PDF unavailable')
  }
}
