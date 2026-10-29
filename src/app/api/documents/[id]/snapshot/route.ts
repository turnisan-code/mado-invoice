import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { ArchiveError, getIssuedPdf } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError } from '@/lib/pdf/render'

export const maxDuration = 60

// Manual "Create archive copy" for a document issued before archive copies existed: renders
// it server-side from the stored data. An existing copy is kept as it is.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const { path, created } = await getIssuedPdf(auth.supabase, id, 'manual')
    return NextResponse.json({ path, created })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
    if (err instanceof ArchiveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_issued' ? 400 : 500 })
    }
    console.error('[documents/snapshot]', err)
    return apiError(500, 'archive_failed', err instanceof Error ? err.message : 'Archive copy failed')
  }
}
