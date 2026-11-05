import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { appOrigin } from '@/lib/utils/reminder'
import { googleNotConnected } from '@/lib/google/client'
import { ArchiveError } from '@/lib/pdf/snapshot'
import { pdfFilename } from '@/lib/pdf/render'
import { reminderFilename } from '@/lib/pdf/reminder'
import { isPlainAddress, parseEmailList } from '@/lib/templates'
import { composeReminder, loadReminderInvoice, reminderLevel, sendReminder, type LoadedReminder } from '@/lib/services/reminders'
import type { ReminderDraft } from '@/types'

export const maxDuration = 60

// The invoice and the settings, or the answer that says why there is no reminder to write.
async function loadInvoice(supabase: SupabaseClient, id: string): Promise<{ response: NextResponse } | LoadedReminder> {
  if (!isUuid(id)) return { response: apiError(404, 'not_found', 'Invoice not found') }
  const loaded = await loadReminderInvoice(supabase, id)
  if (loaded.ok) return loaded
  switch (loaded.reason) {
    case 'settings': return { response: settingsUnavailable(loaded.error) }
    case 'database': return { response: databaseError(loaded.error) }
    case 'not_found': return { response: apiError(404, 'not_found', 'Invoice not found') }
    case 'nothing_outstanding': return { response: apiError(400, 'nothing_outstanding', 'Nothing outstanding on this invoice') }
    case 'not_remindable': return { response: apiError(400, 'not_remindable', 'Only overdue invoices with an open balance can be reminded') }
  }
}

// The draft the reminder dialog edits: recipients, text and the attachments that will go out.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const loaded = await loadInvoice(supabase, id)
  if ('response' in loaded) return loaded.response
  const { settings, invoice } = loaded
  const number = invoice.number as string

  const level = reminderLevel(invoice, settings)
  const { subject, body, figures } = await composeReminder(supabase, invoice, settings, level, { portalOrigin: appOrigin(req.nextUrl.origin) })
  const draft: ReminderDraft = {
    level,
    title: figures.title,
    number,
    to: invoice.clients?.email ?? '',
    cc: parseEmailList(invoice.clients?.cc_emails ?? []).emails,
    subject,
    body,
    attachments: [reminderFilename(figures.title, number), pdfFilename(number)],
    gmail: !!(settings.gmail_refresh_token && settings.gmail_email),
  }
  return NextResponse.json(draft)
}

// mode 'gmail' sends the reviewed email with the Mahnung and the frozen invoice attached; mode
// 'manual' only records a reminder sent another way (src/lib/services/reminders.ts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const payload = await readJsonObject(req)
  if (!payload) return invalidJson()

  const loaded = await loadInvoice(supabase, id)
  if ('response' in loaded) return loaded.response
  const { invoice } = loaded

  const mode = payload.mode === 'manual' ? 'manual' : 'gmail'
  const to = typeof payload.to === 'string' ? payload.to.trim() : (mode === 'gmail' ? invoice.clients?.email ?? '' : '')
  const cc = parseEmailList(Array.isArray(payload.cc) || typeof payload.cc === 'string' ? payload.cc as string | string[] : [])
  const bcc = parseEmailList(Array.isArray(payload.bcc) || typeof payload.bcc === 'string' ? payload.bcc as string | string[] : [])
  if ((to && !isPlainAddress(to)) || cc.invalid.length || bcc.invalid.length || cc.emails.length + bcc.emails.length > 20) {
    return apiError(400, 'invalid_address', 'Invalid email address')
  }

  const result = await sendReminder(supabase, loaded, {
    mode,
    to: to ? [to] : [],
    cc: cc.emails,
    bcc: bcc.emails,
    subject: typeof payload.subject === 'string' ? payload.subject.replace(/[\r\n]+/g, ' ').trim() : '',
    body: mode === 'gmail' && typeof payload.body === 'string' ? payload.body : '',
    portalOrigin: appOrigin(req.nextUrl.origin),
  })
  if (result.ok) return NextResponse.json({ ok: true, sentAt: result.sentAt, level: result.level })
  switch (result.stage) {
    case 'google_not_connected': return googleNotConnected()
    case 'no_email': return apiError(400, 'no_email', 'Client has no email')
    case 'send': return NextResponse.json({ error: result.failure.error, code: result.failure.code }, { status: result.failure.status })
    default: {
      const err = result.error
      if (err instanceof ArchiveError) return NextResponse.json({ error: err.message, code: err.code }, { status: 500 })
      return apiError(500, 'pdf_failed', 'The reminder PDF could not be created')
    }
  }
}
