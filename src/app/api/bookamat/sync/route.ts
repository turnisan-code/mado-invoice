import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { documentId: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { documentId } = body
  if (!documentId) return NextResponse.json({ error: 'documentId is required' }, { status: 400 })

  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('*, document_items(*), payments(*), clients(*)')
    .eq('id', documentId)
    .single()

  if (docErr || !doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  if (doc.type !== 'invoice' || !doc.number) {
    return NextResponse.json({ error: 'Only issued invoices can be synced to Bookamat' }, { status: 400 })
  }
  // Bookamat records income on receipt (Ist-Besteuerung): one booking per fully paid invoice
  if (doc.status !== 'paid') {
    return NextResponse.json({ error: 'Only fully paid invoices can be synced — record the payment first' }, { status: 400 })
  }

  const { data: settings, error: settingsErr } = await supabase
    .from('settings')
    .select('*')
    .single()

  if (settingsErr || !settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  if (
    !settings.bookamat_username ||
    !settings.bookamat_api_key ||
    !settings.bookamat_bank_account_id ||
    !settings.bookamat_cost_account_id
  ) {
    return NextResponse.json({ error: 'Bookamat is not fully configured. Please fill in settings.' }, { status: 400 })
  }

  if (doc.bookamat_booking_id) {
    return NextResponse.json({ error: 'Already synced', bookingId: doc.bookamat_booking_id }, { status: 409 })
  }

  const totals = calcTotals(
    doc.document_items ?? [],
    doc.payments ?? [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )

  const country = settings.bookamat_country ?? 'at'
  if (!/^[a-z]{2}$/.test(country)) {
    return NextResponse.json({ error: 'Invalid Bookamat country in settings' }, { status: 400 })
  }
  const authHeader = `ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}`

  const client = doc.clients as { name: string; company: string | null; uid_number: string | null } | null
  const clientName = (client?.company ?? client?.name ?? '').slice(0, 30)
  const title = `${doc.number ?? 'Draft'} – ${clientName}`.slice(0, 50)

  const vatAccountMap: Record<number, number | null> = {
    0: settings.bookamat_vat_account_0,
    10: settings.bookamat_vat_account_10,
    13: settings.bookamat_vat_account_13,
    20: settings.bookamat_vat_account_20,
  }

  const lastPayment = ((doc.payments ?? []) as { date: string; amount: number }[])
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  const paymentDate = lastPayment?.date ?? doc.date

  // Use payment date year for the fiscal year URL (not invoice date)
  const year = new Date(paymentDate).getFullYear()
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return NextResponse.json({ error: 'Invalid payment date' }, { status: 400 })
  }
  const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`

  if (totals.vat_groups.length === 0) {
    return NextResponse.json({ error: 'Invoice has no line items to book' }, { status: 400 })
  }
  // Reverse-charge / non-EU invoices arrive as a single 0 % group and book on the 0 % account.
  const missing = totals.vat_groups.find(g => vatAccountMap[g.rate] == null)
  if (missing) {
    return NextResponse.json({ error: `No Bookamat VAT account configured for ${missing.rate} % — set it in Settings → Bookamat` }, { status: 400 })
  }

  const amounts = totals.vat_groups.map(g => ({
    bankaccount: settings.bookamat_bank_account_id,
    costaccount: settings.bookamat_cost_account_id,
    purchasetaxaccount: vatAccountMap[g.rate]!,
    amount: (g.base + g.amount).toFixed(2),
    tax_percent: g.rate.toFixed(2),
    deductibility_tax_percent: '100.00',
    deductibility_amount_percent: '100.00',
  }))

  const payload = {
    title,
    date: paymentDate,
    date_invoice: doc.date,
    vatin: client?.uid_number ?? undefined,
    description: `Invoice ${doc.number ?? ''} | ${client?.company ?? client?.name ?? ''}`,
    amounts,
  }

  const bookingRes = await fetch(`${baseUrl}bookings/`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!bookingRes.ok) {
    const text = await bookingRes.text()
    return NextResponse.json({ error: text }, { status: 500 })
  }

  const booking = await bookingRes.json()
  const bookingId = booking.id

  await supabase
    .from('documents')
    .update({ bookamat_booking_id: String(bookingId) })
    .eq('id', documentId)

  return NextResponse.json({ ok: true, bookingId, country, year })
}
