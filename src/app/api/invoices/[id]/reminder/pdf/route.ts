import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { DocumentNotFoundError, loadPdfDocument, loadSettings } from '@/lib/pdf/render'
import { renderReminderPdf } from '@/lib/pdf/reminder'
import { nextReminderLevel } from '@/lib/utils/reminder-templates'

export const maxDuration = 60

// The Mahnung as of today for ?level=N (default: the level the next reminder carries), for
// downloading, printing or attaching in the owner's own email app.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const [doc, settings] = await Promise.all([loadPdfDocument(supabase, id), loadSettings(supabase)])
    if (doc.type !== 'invoice' || !doc.number) {
      return NextResponse.json({ error: 'Only issued invoices can be reminded', code: 'not_remindable' }, { status: 400 })
    }
    const maxLevel = Math.max(1, settings.reminder_max_level ?? 3)
    const requested = Number(req.nextUrl.searchParams.get('level'))
    const level = Number.isInteger(requested) && requested >= 1
      ? Math.min(requested, maxLevel)
      : nextReminderLevel(doc.reminder_level, maxLevel)
    const { buffer, filename } = await renderReminderPdf(doc, settings, level)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    console.error('[invoices/reminder/pdf]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF unavailable', code: 'pdf_failed' }, { status: 500 })
  }
}
