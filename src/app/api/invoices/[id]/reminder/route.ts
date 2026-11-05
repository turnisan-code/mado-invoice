import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import {
  sendGmail, reminderFigures, reminderVariables, reminderTemplates, nextReminderLevel, appOrigin, ensurePortalLink,
} from '@/lib/utils/reminder'
import { today } from '@/lib/utils/document'
import { canRemind } from '@/lib/status'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { getReminderPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, type PdfDocument } from '@/lib/pdf/render'
import { invoiceTotals, reminderFilename, renderReminderPdf } from '@/lib/pdf/reminder'
import { fillSubject, fillTemplate, isPlainAddress, parseEmailList, templateLang, usesVariable } from '@/lib/templates'
import { logEvent } from '@/lib/events'
import type { ReminderDraft, Settings } from '@/types'

export const maxDuration = 60

type Mode = 'gmail' | 'manual'

function fail(error: string, code: string, status = 400) {
  return NextResponse.json({ error, code }, { status })
}

// Only an issued invoice past its due date with money still open is dunned (P0 #44); credits,
// Skonto and write-offs count towards the balance. Shared by the draft (GET) and both POST modes.
function remindable(invoice: PdfDocument) {
  const balance = invoiceTotals(invoice).balance_due
  if (balance <= 0.005) return fail('Nothing outstanding on this invoice', 'nothing_outstanding')
  if (!canRemind(invoice, balance, today())) {
    return fail('Only overdue invoices with an open balance can be reminded', 'not_remindable')
  }
  return null
}

async function loadInvoice(supabase: SupabaseClient, id: string) {
  const [{ data: settings }, { data: invoice }] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('documents').select('*, document_items(*), payments(*), clients(*)').eq('id', id).eq('type', 'invoice').maybeSingle(),
  ])
  return { settings: settings as Settings | null, invoice: invoice as PdfDocument | null }
}

// Subject and body as the template renders them for this invoice, in the invoice's language.
async function composeReminder(supabase: SupabaseClient, invoice: PdfDocument, settings: Settings, level: number, origin: string) {
  const lang = templateLang(invoice.language)
  const tpl = reminderTemplates(settings, lang, level)
  let portalLink = ''
  if (usesVariable(tpl.subject, 'portal_link') || usesVariable(tpl.body, 'portal_link')) {
    try {
      portalLink = await ensurePortalLink(supabase, invoice, origin)
    } catch (err) {
      console.warn('[invoices/reminder] portal link unavailable:', err)
    }
  }
  const totals = invoiceTotals(invoice)
  const figures = reminderFigures({ dueDate: invoice.due_date, balance: totals.balance_due, issuer: settings, level, lang })
  const vars = reminderVariables({ doc: invoice, client: invoice.clients, issuer: settings, totals, figures, portalLink })
  return { subject: fillSubject(tpl.subject, vars), body: fillTemplate(tpl.body, vars), figures }
}

// The draft the reminder dialog edits: recipients, text and the attachments that will go out.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { settings, invoice } = await loadInvoice(supabase, id)
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 500 })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  const guard = remindable(invoice)
  if (guard) return guard
  const number = invoice.number as string

  const level = nextReminderLevel(invoice.reminder_level, settings.reminder_max_level)
  const { subject, body, figures } = await composeReminder(supabase, invoice, settings, level, appOrigin(req.nextUrl.origin))
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

// mode 'gmail' sends the reviewed email with the Mahnung and the invoice copy attached;
// mode 'manual' only records a reminder the owner sent from their own email app or by post.
// Either way the reminder is logged and the invoice moves up one level.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const payload = await req.json().catch(() => ({})) as Record<string, unknown>
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { settings, invoice } = await loadInvoice(supabase, id)
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 500 })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  const guard = remindable(invoice)
  if (guard) return guard
  const number = invoice.number as string
  const totals = invoiceTotals(invoice)

  const mode: Mode = payload.mode === 'manual' ? 'manual' : 'gmail'
  const level = nextReminderLevel(invoice.reminder_level, settings.reminder_max_level)
  const to = typeof payload.to === 'string' ? payload.to.trim() : (mode === 'gmail' ? invoice.clients?.email ?? '' : '')
  const cc = parseEmailList(Array.isArray(payload.cc) || typeof payload.cc === 'string' ? payload.cc as string | string[] : [])
  const bcc = parseEmailList(Array.isArray(payload.bcc) || typeof payload.bcc === 'string' ? payload.bcc as string | string[] : [])
  if ((to && !isPlainAddress(to)) || cc.invalid.length || bcc.invalid.length || cc.emails.length + bcc.emails.length > 20) {
    return fail('Invalid email address', 'invalid_address')
  }

  let subject = typeof payload.subject === 'string' ? payload.subject.replace(/[\r\n]+/g, ' ').trim() : ''
  let attachments: string[] = []

  if (mode === 'gmail') {
    if (!settings.gmail_refresh_token || !settings.gmail_email) return googleNotConnected()
    if (!to) return fail('Client has no email', 'no_email')

    let body = typeof payload.body === 'string' ? payload.body : ''
    if (!subject || !body) {
      const composed = await composeReminder(supabase, invoice, settings, level, appOrigin(req.nextUrl.origin))
      subject ||= composed.subject
      body ||= composed.body
    }

    let files
    try {
      const mahnung = await renderReminderPdf(invoice, settings, level, totals)
      files = [
        { filename: mahnung.filename, content: mahnung.buffer },
        { filename: pdfFilename(number), content: await getReminderPdf(supabase, invoice, settings) },
      ]
    } catch (err) {
      console.error('[invoices/reminder] PDF failed:', err)
      return fail('The reminder PDF could not be created', 'pdf_failed', 500)
    }

    try {
      await sendGmail(getAuthorizedGoogle(settings, supabase), {
        from: settings.gmail_email, to, cc: cc.emails, bcc: bcc.emails, subject, body, attachments: files,
      })
    } catch (err) {
      return googleErrorResponse(err, supabase, settings.id, 'invoices/reminder')
    }
    attachments = files.map(f => f.filename)
  }

  const now = new Date().toISOString()
  const [{ error: docErr }, { error: logErr }] = await Promise.all([
    supabase.from('documents').update({ reminder_sent_at: now, reminder_level: level }).eq('id', id),
    supabase.from('reminder_log').insert({ document_id: id, level, sent_at: now, to_email: to || null, subject: subject || null }),
  ])
  if (docErr) console.error('[invoices/reminder] reminder level not recorded:', docErr.message)
  if (logErr) console.error('[invoices/reminder] reminder_log not written:', logErr.message)
  await logEvent(supabase, id, 'reminder_sent', {
    level,
    ...(to ? { to } : {}),
    ...(cc.emails.length ? { cc: cc.emails } : {}),
    ...(bcc.emails.length ? { bcc: bcc.emails } : {}),
    ...(subject ? { subject } : {}),
    ...(mode === 'manual' ? { manual: true } : { attachments }),
  })

  return NextResponse.json({ ok: true, sentAt: now, level })
}
