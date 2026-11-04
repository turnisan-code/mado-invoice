// Payment reminders for overdue invoices: which invoice can be reminded, the text the template
// gives it, and sending (or only recording) the reminder, which raises its level for good. Server
// only (googleapis, the PDF renderer).
import 'server-only'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { sendGmail, reminderFigures, reminderVariables, reminderTemplates, nextReminderLevel, ensurePortalLink } from '@/lib/utils/reminder'
import { today } from '@/lib/utils/document'
import { canRemind } from '@/lib/status'
import { getAuthorizedGoogle, googleFailure, type GoogleFailure } from '@/lib/google/client'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import type { PdfDocument } from '@/lib/pdf/render'
import { invoiceTotals, renderReminderPdf } from '@/lib/pdf/reminder'
import { fillSubject, fillTemplate, templateLang, usesVariable } from '@/lib/templates'
import { logEvent } from '@/lib/events'
import type { Settings } from '@/types'
import { fillPortalLink, hasPortalLinkToken, PORTAL_LINK_TOKEN } from './email-compose'

export type ReminderMode = 'gmail' | 'manual'

// Only an issued invoice past its due date with money still open is dunned (P0 #44); credits,
// Skonto and write-offs count towards the balance.
export function remindable(invoice: PdfDocument): 'nothing_outstanding' | 'not_remindable' | null {
  const balance = invoiceTotals(invoice).balance_due
  if (balance <= 0.005) return 'nothing_outstanding'
  if (!canRemind(invoice, balance, today())) return 'not_remindable'
  return null
}

export type LoadedReminder = { ok: true; settings: Settings; invoice: PdfDocument }
export type ReminderLoadFailure =
  | { ok: false; reason: 'settings'; error: PostgrestError | null }
  | { ok: false; reason: 'database'; error: PostgrestError }
  | { ok: false; reason: 'not_found' | 'nothing_outstanding' | 'not_remindable' }

// The invoice and the settings, or why there is no reminder to write.
export async function loadReminderInvoice(supabase: SupabaseClient, id: string): Promise<LoadedReminder | ReminderLoadFailure> {
  const [settingsRes, invoiceRes] = await Promise.all([
    supabase.from('settings').select('*').single(),
    supabase.from('documents').select('*, document_items(*), payments(*), clients(*)').eq('id', id).eq('type', 'invoice').maybeSingle(),
  ])
  if (settingsRes.error || !settingsRes.data) return { ok: false, reason: 'settings', error: settingsRes.error }
  if (invoiceRes.error) return { ok: false, reason: 'database', error: invoiceRes.error }
  if (!invoiceRes.data) return { ok: false, reason: 'not_found' }
  const invoice = invoiceRes.data as PdfDocument
  const refusal = remindable(invoice)
  return refusal ? { ok: false, reason: refusal } : { ok: true, settings: settingsRes.data as Settings, invoice }
}

export function reminderLevel(invoice: PdfDocument, settings: Settings): number {
  return nextReminderLevel(invoice.reminder_level, settings.reminder_max_level)
}

// Subject and body as the template renders them for this invoice, in the invoice's language.
// With a `portalOrigin` a {{portal_link}} gets the invoice's client-portal link (created on first
// use, a failure leaves it out); with null the token stays in the text, to be filled when sent.
export async function composeReminder(
  supabase: SupabaseClient,
  invoice: PdfDocument,
  settings: Settings,
  level: number,
  { portalOrigin }: { portalOrigin: string | null },
) {
  const lang = templateLang(invoice.language)
  const tpl = reminderTemplates(settings, lang, level)
  let portalLink = portalOrigin === null ? PORTAL_LINK_TOKEN : ''
  if (portalOrigin !== null && (usesVariable(tpl.subject, 'portal_link') || usesVariable(tpl.body, 'portal_link'))) {
    try {
      portalLink = await ensurePortalLink(supabase, invoice, portalOrigin)
    } catch (err) {
      console.warn('[invoices/reminder] portal link unavailable:', err)
    }
  }
  const totals = invoiceTotals(invoice)
  const figures = reminderFigures({ dueDate: invoice.due_date, balance: totals.balance_due, issuer: settings, level, lang })
  const vars = reminderVariables({ doc: invoice, client: invoice.clients, issuer: settings, totals, figures, portalLink })
  return { subject: fillSubject(tpl.subject, vars), body: fillTemplate(tpl.body, vars), figures }
}

export interface ReminderRequest {
  mode: ReminderMode
  // Validated addresses; `to` may be empty in manual mode.
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  // One line; empty = composed from the template (gmail mode).
  subject: string
  body: string
  // Where a composed {{portal_link}} points (the template fallback).
  portalOrigin: string
  // Also fill a {{portal_link}} token left in the given subject and body.
  fillPortalLink?: boolean
}

export type SentReminder = { ok: true; sentAt: string; level: number; attachments: string[]; to: string; subject: string }
export type ReminderSendFailure =
  | { ok: false; stage: 'google_not_connected' | 'no_email' }
  | { ok: false; stage: 'pdf' | 'portal_link'; error: unknown }
  | { ok: false; stage: 'send'; failure: GoogleFailure }

// mode 'gmail' sends the email with the Mahnung (the open balance as of today) and the invoice as
// issued (its frozen copy, as every outgoing copy) attached; mode 'manual' only records a reminder
// the owner sent from their own email app or by post. Either way the reminder is logged and the
// invoice moves up one level.
export async function sendReminder(supabase: SupabaseClient, { settings, invoice }: LoadedReminder, req: ReminderRequest): Promise<SentReminder | ReminderSendFailure> {
  const totals = invoiceTotals(invoice)
  const level = reminderLevel(invoice, settings)
  const to = req.to.join(', ')
  let subject = req.subject
  let attachments: string[] = []

  if (req.mode === 'gmail') {
    if (!settings.gmail_refresh_token || !settings.gmail_email) return { ok: false, stage: 'google_not_connected' }
    if (!to) return { ok: false, stage: 'no_email' }

    let body = req.body
    if (!subject || !body) {
      const composed = await composeReminder(supabase, invoice, settings, level, { portalOrigin: req.portalOrigin })
      subject ||= composed.subject
      body ||= composed.body
    }
    if (req.fillPortalLink && (hasPortalLinkToken(subject) || hasPortalLinkToken(body))) {
      try {
        const link = await ensurePortalLink(supabase, invoice, req.portalOrigin)
        subject = fillPortalLink(subject, link)
        body = fillPortalLink(body, link)
      } catch (error) {
        return { ok: false, stage: 'portal_link', error }
      }
    }

    let files
    try {
      const [mahnung, issued] = await Promise.all([
        renderReminderPdf(invoice, settings, level, totals),
        getIssuedPdf(supabase, invoice.id, 'on_demand'),
      ])
      files = [
        { filename: mahnung.filename, content: mahnung.buffer },
        { filename: issued.filename, content: issued.buffer },
      ]
    } catch (error) {
      console.error('[invoices/reminder] PDF failed:', error)
      return { ok: false, stage: 'pdf', error }
    }

    try {
      await sendGmail(getAuthorizedGoogle(settings, supabase), {
        from: settings.gmail_email, to, cc: req.cc, bcc: req.bcc, subject, body, attachments: files,
      })
    } catch (err) {
      return { ok: false, stage: 'send', failure: await googleFailure(err, supabase, settings.id, 'invoices/reminder') }
    }
    attachments = files.map(f => f.filename)
  }

  const now = new Date().toISOString()
  const [{ error: docErr }, { error: logErr }] = await Promise.all([
    supabase.from('documents').update({ reminder_sent_at: now, reminder_level: level }).eq('id', invoice.id),
    supabase.from('reminder_log').insert({ document_id: invoice.id, level, sent_at: now, to_email: to || null, subject: subject || null }),
  ])
  if (docErr) console.error('[invoices/reminder] reminder level not recorded:', docErr.message)
  if (logErr) console.error('[invoices/reminder] reminder_log not written:', logErr.message)
  await logEvent(supabase, invoice.id, 'reminder_sent', {
    level,
    ...(to ? { to } : {}),
    ...(req.cc.length ? { cc: req.cc } : {}),
    ...(req.bcc.length ? { bcc: req.bcc } : {}),
    ...(subject ? { subject } : {}),
    ...(req.mode === 'manual' ? { manual: true } : { attachments }),
  })

  return { ok: true, sentAt: now, level, attachments, to, subject }
}
