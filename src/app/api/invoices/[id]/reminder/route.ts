import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fillTemplate, sendReminderEmail, buildReminderContext, reminderTemplates, nextReminderLevel } from '@/lib/utils/reminder'
import { calcTotals } from '@/lib/utils/document'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { logEvent } from '@/lib/events'

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

  const docDiscount = invoice.discount_type && invoice.discount_value
    ? { type: invoice.discount_type as 'percent' | 'fixed', value: invoice.discount_value }
    : null
  const totals = calcTotals(invoice.document_items ?? [], invoice.payments ?? [], docDiscount, invoice.tax_treatment)
  if (totals.balance_due <= 0.005) {
    return NextResponse.json({ error: 'Nothing outstanding on this invoice' }, { status: 400 })
  }

  const level = nextReminderLevel(invoice.reminder_level, settings.reminder_max_level)
  const ctx = buildReminderContext({ invoice, client, settings, totals, level, lang })
  const tpl = reminderTemplates(settings, lang)
  const subject = fillTemplate(tpl.subject, ctx)

  try {
    await sendReminderEmail({
      auth: getAuthorizedGoogle(settings, supabase),
      from: settings.gmail_email,
      to: client.email,
      subject,
      body: fillTemplate(tpl.body, ctx),
      pdfBase64,
      filename,
    })
  } catch (err) {
    return googleErrorResponse(err, supabase, settings.id, 'invoices/reminder')
  }

  const now = new Date().toISOString()
  const [{ error: docErr }, { error: logErr }] = await Promise.all([
    supabase.from('documents').update({ reminder_sent_at: now, reminder_level: level }).eq('id', id),
    supabase.from('reminder_log').insert({ document_id: id, level, sent_at: now, to_email: client.email, subject }),
  ])
  if (docErr) console.error('[invoices/reminder] reminder level not recorded:', docErr.message)
  if (logErr) console.error('[invoices/reminder] reminder_log not written:', logErr.message)
  await logEvent(supabase, id, 'reminder_sent', { level, to: client.email, subject })

  return NextResponse.json({ ok: true, sentAt: now, level })
}
