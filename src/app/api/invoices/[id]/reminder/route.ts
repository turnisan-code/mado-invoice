import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  fillTemplate, sendReminderEmail,
  DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE,
  DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN,
} from '@/lib/utils/reminder'
import { formatMoney, calcTotals } from '@/lib/utils/document'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const body = await req.json().catch(() => ({}))
  const pdfBase64: string | undefined = body.pdfBase64
  const filename: string | undefined = body.filename
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token || !settings?.gmail_email) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 })
  }

  const { data: invoice } = await supabase
    .from('documents')
    .select('*, document_items(*), clients(*)')
    .eq('id', id)
    .single()

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (!invoice.clients?.email) return NextResponse.json({ error: 'Client has no email' }, { status: 400 })

  const client = invoice.clients
  const lang = client.language === 'en' ? 'en' : 'de'
  const dueDate = invoice.due_date ?? ''
  const today = new Date()
  const daysOverdue = dueDate
    ? Math.max(0, Math.floor((today.getTime() - new Date(dueDate).getTime()) / 86400000))
    : 0

  const totals = calcTotals(invoice.document_items ?? [], [])

  const ctx = {
    invoiceNumber: invoice.number ?? 'Draft',
    clientName: client.company ?? client.name,
    amount: formatMoney(totals.total, invoice.currency ?? 'EUR'),
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

  const now = new Date().toISOString()
  await supabase.from('documents').update({ reminder_sent_at: now }).eq('id', id)

  return NextResponse.json({ ok: true, sentAt: now })
}
