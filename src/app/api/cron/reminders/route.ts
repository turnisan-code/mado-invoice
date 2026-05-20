import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  fillTemplate, sendReminderEmail,
  DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE,
  DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN,
} from '@/lib/utils/reminder'
import { formatMoney } from '@/lib/utils/document'

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
      ? Math.floor((today.getTime() - new Date(dueDate).getTime()) / 86400000)
      : 0

    const total = (invoice.document_items ?? []).reduce((s: number, i: { quantity: number | null; unit_price: number | null; vat_rate: number | null }) => {
      if (i.quantity == null || i.unit_price == null) return s
      return s + i.quantity * i.unit_price * (1 + (i.vat_rate ?? 0) / 100)
    }, 0)

    const ctx = {
      invoiceNumber: invoice.number ?? 'Draft',
      clientName: client.company ?? client.name,
      amount: formatMoney(total, invoice.currency ?? 'EUR'),
      dueDate,
      daysOverdue,
      iban: settings.iban ?? '',
      sender: settings.company_name ?? settings.owner_name ?? '',
    }

    const subjectTpl = lang === 'en'
      ? (settings.email_subject_reminder_en || DEFAULT_SUBJECT_EN)
      : (settings.email_subject_reminder_de || DEFAULT_SUBJECT_DE)
    const bodyTpl = lang === 'en'
      ? (settings.email_body_reminder_en || DEFAULT_BODY_EN)
      : (settings.email_body_reminder_de || DEFAULT_BODY_DE)

    try {
      await sendReminderEmail({
        accessToken: settings.gmail_access_token!,
        refreshToken: settings.gmail_refresh_token!,
        tokenExpiry: settings.gmail_token_expiry,
        from: settings.gmail_email!,
        to: client.email,
        subject: fillTemplate(subjectTpl, ctx),
        body: fillTemplate(bodyTpl, ctx),
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
