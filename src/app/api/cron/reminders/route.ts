import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  fillTemplate, sendReminderEmail,
  DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE,
  DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN,
} from '@/lib/utils/reminder'
import { formatMoney, calcTotals, getTaxNote } from '@/lib/utils/document'
import { pdf } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import React from 'react'
import type { Settings, Client, TaxTreatment, Language, Currency } from '@/types'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token || !settings?.gmail_email) {
    return NextResponse.json({ skipped: 'Gmail not configured' })
  }

  // Find overdue invoices that haven't had a reminder sent, with client email
  const { data: invoices, error } = await supabase
    .from('documents')
    .select('*, document_items(*), clients(*)')
    .eq('type', 'invoice')
    .eq('status', 'overdue')
    .is('reminder_sent_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!invoices?.length) return NextResponse.json({ sent: 0, message: 'No overdue invoices to remind' })

  const today = new Date()
  let sent = 0
  const errors: string[] = []

  for (const invoice of invoices) {
    const client = invoice.clients
    if (!client?.email) continue

    const lang = client.language === 'en' ? 'en' : 'de'
    const dueDate = invoice.due_date ?? ''
    const daysOverdue = dueDate
      ? Math.max(0, Math.floor((today.getTime() - new Date(dueDate).getTime()) / 86400000))
      : 0

    const emailTotals = calcTotals(invoice.document_items ?? [], [])

    const ctx = {
      invoiceNumber: invoice.number ?? 'Draft',
      clientName: client.company ?? client.name,
      amount: formatMoney(emailTotals.total, invoice.currency ?? 'EUR'),
      dueDate,
      date: invoice.date ?? '',
      daysOverdue,
      iban: settings.iban ?? '',
      sender: settings.company_name ?? settings.owner_name ?? '',
      company: settings.company_name ?? '',
      owner: settings.owner_name ?? '',
    }

    const subjectTpl = lang === 'en'
      ? (settings.email_subject_reminder_en || DEFAULT_SUBJECT_EN)
      : (settings.email_subject_reminder_de || DEFAULT_SUBJECT_DE)
    const bodyTpl = lang === 'en'
      ? (settings.email_body_reminder_en || DEFAULT_BODY_EN)
      : (settings.email_body_reminder_de || DEFAULT_BODY_DE)

    // Generate PDF server-side
    let pdfBase64: string | undefined
    let filename: string | undefined
    try {
      const items = (invoice.document_items ?? [])
      const totals = calcTotals(items, [])
      const taxTreatment = (invoice.tax_treatment ?? 'at_vat') as TaxTreatment
      const invLang = (invoice.language ?? 'de') as Language
      const taxNote = getTaxNote(taxTreatment, invLang, settings as Settings)
      const docData = {
        number: invoice.number ?? 'DRAFT',
        date: invoice.date ?? '',
        service_date: invoice.service_date ?? null,
        due_date: invoice.due_date ?? null,
        type: invoice.type,
        language: invLang,
        currency: (invoice.currency ?? 'EUR') as Currency,
        tax_treatment: taxTreatment,
        notes: invoice.notes ?? null,
        tax_note: taxNote,
        discount_type: invoice.discount_type ?? null,
        discount_value: invoice.discount_value ?? null,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await pdf(React.createElement(InvoiceDocument, {
        settings: settings as unknown as Settings,
        client: client as unknown as Client,
        document: docData,
        qrCodeDataUri: null,
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
        accessToken: settings.gmail_access_token!,
        refreshToken: settings.gmail_refresh_token!,
        tokenExpiry: settings.gmail_token_expiry,
        from: settings.gmail_email!,
        to: client.email,
        subject: fillTemplate(subjectTpl, ctx),
        body: fillTemplate(bodyTpl, ctx),
        pdfBase64,
        filename,
        onTokenRefresh: async (tokens) => {
          await supabase.from('settings').update({
            gmail_access_token: tokens.access_token,
            ...(tokens.refresh_token ? { gmail_refresh_token: tokens.refresh_token } : {}),
            gmail_token_expiry: tokens.expiry_date,
          }).eq('id', settings.id)
        },
      })

      await supabase.from('documents')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', invoice.id)

      sent++
    } catch (err) {
      errors.push(`${invoice.number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`[cron/reminders] sent=${sent} errors=${errors.length}`, errors)
  return NextResponse.json({ sent, errors })
}
