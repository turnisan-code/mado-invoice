import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'
import type { Client, Settings, VatRate } from '@/types'

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
  const authHeader = `ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}`

  const client = doc.clients as Client | null
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
  const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`

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

  console.log('[bookamat/sync] payload:', JSON.stringify(payload))

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
    console.log('[bookamat/sync] error response:', text)
    return NextResponse.json({ error: text }, { status: 500 })
  }

  const booking = await bookingRes.json()
  console.log('[bookamat/sync] created booking:', JSON.stringify(booking))
  const bookingId = booking.id

  await supabase
    .from('documents')
    .update({ bookamat_booking_id: String(bookingId) })
    .eq('id', documentId)

  // Attach PDF to the booking
  try {
    const { renderToBuffer } = await import('@react-pdf/renderer')
    const React = (await import('react')).default
    const { default: InvoiceDocument } = await import('@/components/pdf/InvoiceDocument')

    const docData = {
      number: doc.number ?? '',
      date: doc.date,
      service_date: doc.service_date,
      due_date: doc.due_date,
      type: doc.type,
      language: doc.language,
      currency: doc.currency,
      tax_treatment: doc.tax_treatment,
      notes: doc.notes,
      tax_note: null,
      discount_type: doc.discount_type,
      discount_value: doc.discount_value,
      items: (doc.document_items ?? []).map((i: Record<string, unknown>) => ({
        line_type: i.line_type,
        description: i.description,
        service_date: i.service_date,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unit_price,
        vat_rate: i.vat_rate as VatRate,
      })),
      totals,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfBuffer = await renderToBuffer(
      React.createElement(InvoiceDocument, {
        settings: settings as unknown as Settings,
        client: client as Client,
        document: docData,
      }) as any
    )

    const formData = new FormData()
    formData.append('file', new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }), `${doc.number}.pdf`)

    const uploadRes = await fetch(`${baseUrl}bookings/${bookingId}/documents/`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: formData,
    })

    const uploadBody = await uploadRes.text()
    if (!uploadRes.ok) {
      console.log(`[bookamat/sync] PDF upload ${uploadRes.status}:`, uploadBody)
      return NextResponse.json({ ok: true, bookingId, pdfError: `${uploadRes.status}: ${uploadBody}` })
    }
    console.log('[bookamat/sync] PDF attached:', uploadBody.slice(0, 200))
  } catch (pdfErr) {
    const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr)
    console.log('[bookamat/sync] PDF error:', msg)
    return NextResponse.json({ ok: true, bookingId, pdfError: msg })
  }

  return NextResponse.json({ ok: true, bookingId, pdfStatus: 'attached' })
}
