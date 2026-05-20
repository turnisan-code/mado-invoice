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

  const totals = calcTotals(doc.document_items ?? [], doc.payments ?? [])

  const country = settings.bookamat_country ?? 'at'
  const year = new Date(doc.date).getFullYear()
  const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`
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

  const amounts = totals.vat_groups.map(g => {
    const vatAccId = vatAccountMap[g.rate]
    return {
      bankaccount: settings.bookamat_bank_account_id,
      costaccount: settings.bookamat_cost_account_id,
      purchasetaxaccount: vatAccId ?? settings.bookamat_vat_account_0,
      amount: (g.base + g.amount).toFixed(2),
      tax_percent: g.rate.toFixed(2),
      deductibility_tax_percent: '100.00',
      deductibility_amount_percent: '100.00',
      foreign_business_base: null,
      country_dep: '',
      country_rec: '',
    }
  })

  if (amounts.length === 0) {
    amounts.push({
      bankaccount: settings.bookamat_bank_account_id,
      costaccount: settings.bookamat_cost_account_id,
      purchasetaxaccount: settings.bookamat_vat_account_0 ?? settings.bookamat_bank_account_id,
      amount: totals.total.toFixed(2),
      tax_percent: '0.00',
      deductibility_tax_percent: '100.00',
      deductibility_amount_percent: '100.00',
      foreign_business_base: null,
      country_dep: '',
      country_rec: '',
    })
  }

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

  return NextResponse.json({ ok: true, bookingId })
}
