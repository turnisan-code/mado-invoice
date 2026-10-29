import { NextRequest, NextResponse } from 'next/server'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { DocumentNotFoundError, loadPdfDocument, loadSettings } from '@/lib/pdf/render'
import { invoiceTotals, renderReminderPdf } from '@/lib/pdf/reminder'
import { today } from '@/lib/utils/document'
import { canRemind } from '@/lib/status'
import { dispositionFilename, nextReminderLevel } from '@/lib/utils/reminder'

export const maxDuration = 60

// The Mahnung as of today for ?level=N (default: the level the next reminder carries), for
// downloading, printing or attaching in the owner's own email app.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const [doc, settings] = await Promise.all([loadPdfDocument(supabase, id), loadSettings(supabase)])
    const balance = invoiceTotals(doc).balance_due
    if (doc.type === 'invoice' && doc.number && balance <= 0.005) {
      return apiError(400, 'nothing_outstanding', 'Nothing outstanding on this invoice')
    }
    if (!canRemind(doc, balance, today())) {
      return apiError(400, 'not_remindable', 'Only overdue invoices with an open balance can be reminded')
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
        'Content-Disposition': `inline; ${dispositionFilename(filename)}`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return apiError(404, 'not_found', err.message)
    console.error('[invoices/reminder/pdf]', err)
    return apiError(500, 'pdf_failed', err instanceof Error ? err.message : 'PDF unavailable')
  }
}
