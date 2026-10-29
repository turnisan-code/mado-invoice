import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { authorizeCron } from '@/lib/utils/cron'
import {
  sendGmail, reminderFigures, reminderVariables, reminderTemplates, daysBetween, appOrigin, ensurePortalLink, type MailAttachment,
} from '@/lib/utils/reminder'
import { today, addDays, viennaDate } from '@/lib/utils/document'
import { markOverdueInvoices } from '@/lib/utils/overdue'
import { getIssuedPdf, getReminderPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, type PdfDocument } from '@/lib/pdf/render'
import { invoiceTotals, renderReminderPdf } from '@/lib/pdf/reminder'
import { fillSubject, fillTemplate, parseEmailList, templateLang, usesVariable } from '@/lib/templates'
import { logEvent } from '@/lib/events'
import type { Settings } from '@/types'
import { clearGoogleTokens, getAuthorizedGoogle, isGoogleAuthError } from '@/lib/google/client'
import { GOOGLE_REAUTH_CODE, GOOGLE_REAUTH_MESSAGE } from '@/lib/google/reauth'
import { isBookamatConfigured, isGoogleExpired } from '@/lib/public-settings'
import { autoSyncBookamat, type AutoSyncResult } from '@/lib/bookamat'

export const maxDuration = 60

type Skipped = { number: string; reason: string }

// Settings → Bookamat → sync automatically: paid invoices and refunds not in Bookamat yet, each
// result in the log. Runs before the reminders, whatever their settings, and every Bookamat call
// ends by the step's deadline, so the reminders keep more than half of the function's time.
async function bookamatStep(supabase: ReturnType<typeof createServiceClient>, settings: Settings): Promise<AutoSyncResult[] | { error: string }> {
  if (!isBookamatConfigured(settings)) {
    console.warn('[cron/bookamat] skipped: automatic sync is on, but Bookamat is not fully configured')
    return { error: 'not_configured' }
  }
  try {
    const results = await autoSyncBookamat(supabase, settings, async id => getIssuedPdf(supabase, id, 'on_demand'), { limit: 8, deadline: Date.now() + 25_000 })
    if (!results.length) console.log('[cron/bookamat] nothing to sync')
    for (const r of results) {
      if (r.ok) console.log(`[cron/bookamat] ${r.number}: ${r.bookings?.length ? `booked ${r.bookings.join(', ')}` : 'already in Bookamat'}`)
      else console.error(`[cron/bookamat] ${r.number} failed: ${r.error}`)
    }
    return results
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[cron/bookamat] skipped:', error)
    return { error }
  }
}

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req)
  if (denied) return denied

  const supabase = createServiceClient()

  // Flip past-due invoices to 'overdue' first; reminders below only see that status.
  await markOverdueInvoices(supabase)

  const { data: settingsRow } = await supabase.from('settings').select('*').single()
  const settings = settingsRow as Settings | null
  if (!settings) {
    console.error('[cron/reminders] skipped: settings row missing')
    return NextResponse.json({ skipped: 'settings_missing', overdueMarked: true })
  }
  const bookamat = settings.bookamat_auto_sync ? { bookamat: await bookamatStep(supabase, settings) } : {}

  if (!settings.reminders_enabled) {
    console.log('[cron/reminders] skipped: automatic reminders are turned off in Settings')
    return NextResponse.json({ skipped: 'reminders_disabled', overdueMarked: true, ...bookamat })
  }

  const maxLevel = Math.max(1, settings.reminder_max_level ?? 3)
  const graceDays = settings.reminder_grace_days ?? 7
  const intervalDays = settings.reminder_interval_days ?? 14
  const now = today()

  // Overdue invoices that have not reached the last dunning level yet, with their client.
  const { data: invoices, error } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('type', 'invoice')
    .eq('status', 'overdue')
    .lt('reminder_level', maxLevel)

  if (error) return NextResponse.json({ error: error.message, ...bookamat }, { status: 500 })

  const skipped: Skipped[] = []
  const due: { invoice: PdfDocument; level: number }[] = []
  for (const invoice of (invoices ?? []) as PdfDocument[]) {
    if (!invoice.number || !invoice.due_date) continue

    // First reminder only once the grace period after the due date has passed; every further
    // level only once the interval since the previous reminder has passed.
    const level = (invoice.reminder_level ?? 0) + 1
    if (level === 1) {
      if (now < addDays(invoice.due_date, graceDays)) continue
    } else if (invoice.reminder_sent_at && daysBetween(viennaDate(new Date(invoice.reminder_sent_at)), now) < intervalDays) {
      continue
    }

    const client = invoice.clients
    if (!client) { skipped.push({ number: invoice.number, reason: 'no client' }); continue }
    if (client.reminders_opt_out) { skipped.push({ number: invoice.number, reason: 'client is excluded from automatic reminders' }); continue }
    if (!client.email) { skipped.push({ number: invoice.number, reason: 'client has no email address' }); continue }
    if (invoiceTotals(invoice).balance_due <= 0.005) { skipped.push({ number: invoice.number, reason: 'nothing outstanding' }); continue }
    due.push({ invoice, level })
  }

  for (const s of skipped) console.log(`[cron/reminders] ${s.number} skipped: ${s.reason}`)

  if (!due.length) {
    console.log(`[cron/reminders] no reminder due (${skipped.length} skipped)`)
    return NextResponse.json({ sent: 0, skipped, ...bookamat })
  }

  // Without Gmail nothing can go out; say so in the log, with what is waiting, instead of
  // returning quietly. The owner sends these from the invoice page (PDF + own email app).
  if (!settings.gmail_refresh_token || !settings.gmail_email) {
    const waiting = due.map(d => `${d.invoice.number} (level ${d.level})`)
    const expired = isGoogleExpired(settings)
    const reason = expired
      ? `the Google connection for ${settings.gmail_email} expired or was revoked (invalid_grant) — reconnect in Settings`
      : 'Gmail is not connected'
    console.warn(`[cron/reminders] skipped: ${reason}; ${due.length} reminder(s) due and not sent: ${waiting.join(', ')}`)
    return NextResponse.json({
      sent: 0, skipped: expired ? 'gmail_expired' : 'gmail_not_connected', due: waiting, skippedInvoices: skipped,
      ...(expired ? { code: GOOGLE_REAUTH_CODE } : {}), ...bookamat,
    })
  }

  const auth = getAuthorizedGoogle(settings, supabase)
  const origin = appOrigin(req.nextUrl.origin)
  let sent = 0
  let reauth = false
  const errors: string[] = []

  for (const { invoice, level } of due) {
    const client = invoice.clients!
    const number = invoice.number!
    const lang = templateLang(invoice.language)
    const tpl = reminderTemplates(settings, lang, level)

    let portalLink = ''
    if (usesVariable(tpl.subject, 'portal_link') || usesVariable(tpl.body, 'portal_link')) {
      try {
        portalLink = await ensurePortalLink(supabase, invoice, origin)
      } catch (linkErr) {
        console.warn(`[cron/reminders] portal link unavailable for ${number}:`, linkErr)
      }
    }

    // The Mahnung asks for the open balance plus fee and interest; the invoice copy goes along:
    // the issued copy while nothing is paid, otherwise a render with the payments.
    const totals = invoiceTotals(invoice)
    const attachments: MailAttachment[] = []
    try {
      const mahnung = await renderReminderPdf(invoice, settings, level, totals)
      attachments.push({ filename: mahnung.filename, content: mahnung.buffer })
    } catch (pdfErr) {
      console.warn(`[cron/reminders] Mahnung PDF failed for ${number}:`, pdfErr)
    }
    try {
      attachments.push({ filename: pdfFilename(number), content: await getReminderPdf(supabase, invoice, settings) })
    } catch (pdfErr) {
      console.warn(`[cron/reminders] invoice PDF failed for ${number}:`, pdfErr)
    }

    const figures = reminderFigures({ dueDate: invoice.due_date, balance: totals.balance_due, issuer: settings, level, lang })
    const vars = reminderVariables({ doc: invoice, client, issuer: settings, totals, figures, portalLink })
    const subject = fillSubject(tpl.subject, vars)
    const cc = parseEmailList(client.cc_emails ?? []).emails

    try {
      await sendGmail(auth, {
        from: settings.gmail_email,
        to: client.email,
        cc,
        subject,
        body: fillTemplate(tpl.body, vars),
        attachments,
      })

      const sentAt = new Date().toISOString()
      const [{ error: markErr }, { error: logErr }] = await Promise.all([
        supabase.from('documents').update({ reminder_sent_at: sentAt, reminder_level: level }).eq('id', invoice.id),
        supabase.from('reminder_log').insert({ document_id: invoice.id, level, sent_at: sentAt, to_email: client.email, subject }),
      ])
      if (markErr) errors.push(`${number}: sent but reminder level not recorded (${markErr.message})`)
      if (logErr) errors.push(`${number}: sent but reminder_log not written (${logErr.message})`)
      await logEvent(supabase, invoice.id, 'reminder_sent', {
        level, to: client.email, ...(cc.length ? { cc } : {}), subject, automatic: true,
        attachments: attachments.map(a => a.filename),
      })

      sent++
    } catch (err) {
      if (isGoogleAuthError(err)) {
        // Every further send would fail the same way; stop and leave Settings showing the expired state.
        console.error(`[cron/reminders] stopped: the Google connection for ${settings.gmail_email} expired or was revoked (invalid_grant)`)
        await clearGoogleTokens(supabase, settings.id)
        errors.push(`${number}: ${GOOGLE_REAUTH_MESSAGE}`)
        reauth = true
        break
      }
      errors.push(`${number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length) console.error(`[cron/reminders] sent=${sent} errors=${errors.length}`, errors)
  else console.log(`[cron/reminders] sent=${sent}`)
  return NextResponse.json({ sent, errors, skipped, ...(reauth ? { code: GOOGLE_REAUTH_CODE } : {}), ...bookamat })
}
