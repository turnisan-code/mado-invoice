import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  fillTemplate, sendReminderEmail,
  DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE,
  DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN,
} from '@/lib/utils/reminder'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const body = await req.json().catch(() => ({}))
  const pdfBase64: string | undefined = body.pdfBase64
  const filename: string | undefined = body.filename
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token || !settings?.gmail_email) return googleNotConnected()

  const { data: invoice } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('id', id)
    .eq('type', 'invoice')
    .single()

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (!invoice.number || !['sent', 'overdue'].includes(invoice.status)) {
    return NextResponse.json({ error: 'Only issued, unpaid invoices can be reminded' }, { status: 400 })
  }
  if (!invoice.clients?.email) return NextResponse.json({ error: 'Client has no email' }, { status: 400 })

  const client = invoice.clients
  const lang = client.language === 'en' ? 'en' : 'de'
  const dueDate = invoice.due_date ?? ''
  const daysOverdue = dueDate
    ? Math.max(0, Math.floor((new Date(today()).getTime() - new Date(dueDate).getTime()) / 86400000))
    : 0

  const docDiscount = invoice.discount_type && invoice.discount_value
    ? { type: invoice.discount_type as 'percent' | 'fixed', value: invoice.discount_value }
    : null
  const totals = calcTotals(invoice.document_items ?? [], invoice.payments ?? [], docDiscount, invoice.tax_treatment)
  if (totals.balance_due <= 0.005) {
    return NextResponse.json({ error: 'Nothing outstanding on this invoice' }, { status: 400 })
  }

  const currency = invoice.currency ?? 'EUR'
  const ctx = {
    invoiceNumber: invoice.number,
    clientName: client.company ?? client.name,
    amount: formatMoney(totals.balance_due, currency),
    total: formatMoney(totals.total, currency),
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

  try {
    await sendReminderEmail({
      auth: getAuthorizedGoogle(settings, supabase),
      from: settings.gmail_email,
      to: client.email,
      subject: fillTemplate(subjectTpl, ctx),
      body: fillTemplate(bodyTpl, ctx),
      pdfBase64,
      filename,
    })
  } catch (err) {
    return googleErrorResponse(err, supabase, settings.id, 'invoices/reminder')
  }

  const now = new Date().toISOString()
  const { error } = await supabase.from('documents').update({ reminder_sent_at: now }).eq('id', id)
  if (error) console.error('[invoices/reminder] reminder_sent_at not recorded:', error.message)

  return NextResponse.json({ ok: true, sentAt: now })
}
