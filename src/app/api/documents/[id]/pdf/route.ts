import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { ArchiveError, getIssuedPdf, getReminderPdf } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError, loadPdfDocument, loadSettings, pdfFilename } from '@/lib/pdf/render'

export const maxDuration = 60

async function reminderPdf(supabase: SupabaseClient, id: string) {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, id), loadSettings(supabase)])
  if (!doc.number) throw new ArchiveError('not_issued', 'Only issued documents can be reminded')
  return { buffer: await getReminderPdf(supabase, doc, settings), filename: pdfFilename(doc.number) }
}

// Every outgoing copy of a numbered document (download, email, Drive, Bookamat) is this stored
// PDF. A document issued before archive copies existed gets one on first request.
// ?for=reminder (ReminderButton, for the email app) serves the invoice copy a reminder attaches:
// the stored copy while nothing is paid, otherwise a render with the payments and the open
// balance that is not stored.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const { buffer, filename } = req.nextUrl.searchParams.get('for') === 'reminder'
      ? await reminderPdf(supabase, id)
      : await getIssuedPdf(supabase, id, 'on_demand')
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
