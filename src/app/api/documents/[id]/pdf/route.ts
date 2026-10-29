import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ArchiveError, getIssuedPdf, getReminderPdf } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError, loadPdfDocument, loadSettings, pdfFilename } from '@/lib/pdf/render'

export const maxDuration = 60

async function reminderPdf(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    if (err instanceof DocumentNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof ArchiveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_issued' ? 404 : 500 })
    }
    console.error('[documents/pdf]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF unavailable' }, { status: 500 })
  }
}
