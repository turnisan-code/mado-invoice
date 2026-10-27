import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { authorizeCron } from '@/lib/utils/cron'
import {
  fillTemplate, sendReminderEmail, buildReminderContext, reminderTemplates, daysBetween,
} from '@/lib/utils/reminder'
import { calcTotals, getTaxNote, today, addDays, viennaDate } from '@/lib/utils/document'
import { markOverdueInvoices } from '@/lib/utils/overdue'
import { generateEpcQr } from '@/lib/utils/epc-qr'
import { pdf } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import React from 'react'
import type { Settings, Client, TaxTreatment, Language, Currency } from '@/types'
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

    // Generate PDF server-side
    let pdfBase64: string | undefined
    let filename: string | undefined
    try {
      const items = (invoice.document_items ?? [])
      const totals = emailTotals
      const taxTreatment = (invoice.tax_treatment ?? 'at_vat') as TaxTreatment
      const invLang = (invoice.language ?? 'de') as Language
      const taxNote = getTaxNote(taxTreatment, invLang, settings as Settings)
      const docData = {
        number: invoice.number ?? 'DRAFT',
        date: invoice.date ?? '',
        service_date: invoice.service_date ?? null,
        service_date_end: invoice.service_date_end ?? null,
        due_date: invoice.due_date ?? null,
        type: invoice.type,
        language: invLang,
        currency: (invoice.currency ?? 'EUR') as Currency,
        tax_treatment: taxTreatment,
        notes: invoice.notes ?? null,
        tax_note: taxNote,
        discount_type: invoice.discount_type ?? null,
        discount_value: invoice.discount_value ?? null,
        skonto_percent: invoice.skonto_percent ?? null,
        skonto_days: invoice.skonto_days ?? null,
        items: items.map((i: Record<string, unknown>) => ({
          line_type: i.line_type,
          description: i.description as string,
          service_date: (i.service_date as string | null) ?? null,
          quantity: i.quantity as number | null,
          unit: i.unit as string | null,
          unit_price: i.unit_price as number | null,
          vat_rate: i.vat_rate as number | null,
        })),
        totals,
      }
      let qrCodeDataUri: string | null = null
      if (settings.iban && totals.balance_due > 0) {
        try {
          qrCodeDataUri = await generateEpcQr({
            iban: settings.iban,
            bic: settings.bic ?? '',
            name: settings.company_name,
            amountEur: invoice.currency === 'EUR' ? totals.balance_due : undefined,
            reference: invoice.number,
          })
        } catch {
          // QR generation is best-effort
        }
      }
      const stream = await pdf(React.createElement(InvoiceDocument, {
        settings: settings as unknown as Settings,
        client: client as unknown as Client,
        document: docData,
        qrCodeDataUri,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any).toBuffer()
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        stream.on('end', resolve)
        stream.on('error', reject)
      })
      pdfBase64 = Buffer.concat(chunks).toString('base64')
      filename = `${invoice.number}.pdf`
    } catch (pdfErr) {
      console.warn(`[cron/reminders] PDF generation failed for ${invoice.number}:`, pdfErr)
      // Send without attachment rather than skipping entirely
    }

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
