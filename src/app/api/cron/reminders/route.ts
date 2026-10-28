import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { authorizeCron } from '@/lib/utils/cron'
import {
  fillTemplate, sendReminderEmail, buildReminderContext, reminderTemplates, daysBetween,
} from '@/lib/utils/reminder'
import { calcTotals, today, addDays, viennaDate } from '@/lib/utils/document'
import { markOverdueInvoices } from '@/lib/utils/overdue'
import { readStoredPdf } from '@/lib/pdf/snapshot'
import { pdfFilename, renderLoadedPdf, type PdfDocument } from '@/lib/pdf/render'
import { logEvent } from '@/lib/events'
import type { Settings } from '@/types'
import { clearGoogleTokens, getAuthorizedGoogle, isGoogleAuthError } from '@/lib/google/client'
import { GOOGLE_REAUTH_CODE, GOOGLE_REAUTH_MESSAGE } from '@/lib/google/reauth'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req)
  if (denied) return denied

  const supabase = createServiceClient()

  // Flip past-due invoices to 'overdue' first; reminders below only see that status.
  await markOverdueInvoices(supabase)

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token || !settings?.gmail_email) {
    return NextResponse.json({ skipped: 'Gmail not configured', overdueMarked: true })
  }
  if (!settings.reminders_enabled) return NextResponse.json({ skipped: 'Reminders disabled', overdueMarked: true })

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!invoices?.length) return NextResponse.json({ sent: 0, message: 'No overdue invoices to remind' })

  const auth = getAuthorizedGoogle(settings, supabase)
  let sent = 0
  let reauth = false
  const errors: string[] = []

  for (const invoice of invoices) {
    const client = invoice.clients
    if (!client?.email || client.reminders_opt_out || !invoice.number || !invoice.due_date) continue

    // First reminder only once the grace period after the due date has passed; every further
    // level only once the interval since the previous reminder has passed.
    const level = (invoice.reminder_level ?? 0) + 1
    if (level === 1) {
      if (now < addDays(invoice.due_date, graceDays)) continue
    } else if (invoice.reminder_sent_at && daysBetween(viennaDate(new Date(invoice.reminder_sent_at)), now) < intervalDays) {
      continue
    }

    const lang = client.language === 'en' ? 'en' : 'de'
    const docDiscount = invoice.discount_type && invoice.discount_value
      ? { type: invoice.discount_type as 'percent' | 'fixed', value: invoice.discount_value }
      : null
    const emailTotals = calcTotals(invoice.document_items ?? [], invoice.payments ?? [], docDiscount, invoice.tax_treatment)
    if (emailTotals.balance_due <= 0.005) continue

    const ctx = buildReminderContext({ invoice, client, settings, totals: emailTotals, level, lang })
    const tpl = reminderTemplates(settings, lang)
    const subject = fillTemplate(tpl.subject, ctx)

    // Attach the stored issued copy the client received; without one, render it from the stored
    // data with payments, section discounts and the QR (not archived: an archive copy made today
    // would carry today's payments).
    const filename = pdfFilename(invoice.number)
    let pdf = invoice.pdf_path ? await readStoredPdf(supabase, invoice.pdf_path) : null
    if (!pdf) {
      try {
        pdf = await renderLoadedPdf(supabase, invoice as PdfDocument, settings as Settings)
      } catch (pdfErr) {
        // Send without attachment rather than skipping entirely
        console.warn(`[cron/reminders] PDF generation failed for ${invoice.number}:`, pdfErr)
      }
    }
    const pdfBase64 = pdf?.toString('base64')

    try {
      await sendReminderEmail({
        auth,
        from: settings.gmail_email,
        to: client.email,
        subject,
        body: fillTemplate(tpl.body, ctx),
        pdfBase64,
        filename,
      })

      const sentAt = new Date().toISOString()
      const [{ error: markErr }, { error: logErr }] = await Promise.all([
        supabase.from('documents').update({ reminder_sent_at: sentAt, reminder_level: level }).eq('id', invoice.id),
        supabase.from('reminder_log').insert({ document_id: invoice.id, level, sent_at: sentAt, to_email: client.email, subject }),
      ])
      if (markErr) errors.push(`${invoice.number}: sent but reminder level not recorded (${markErr.message})`)
      if (logErr) errors.push(`${invoice.number}: sent but reminder_log not written (${logErr.message})`)
      await logEvent(supabase, invoice.id, 'reminder_sent', { level, to: client.email, subject, automatic: true })

      sent++
    } catch (err) {
      if (isGoogleAuthError(err)) {
        // Every further send would fail the same way; stop and leave Settings showing the expired state.
        await clearGoogleTokens(supabase, settings.id)
        errors.push(`${invoice.number}: ${GOOGLE_REAUTH_MESSAGE}`)
        reauth = true
        break
      }
      errors.push(`${invoice.number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length) console.error(`[cron/reminders] sent=${sent} errors=${errors.length}`, errors)
  else console.log(`[cron/reminders] sent=${sent}`)
  return NextResponse.json({ sent, errors, ...(reauth ? { code: GOOGLE_REAUTH_CODE } : {}) })
}
