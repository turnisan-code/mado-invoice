import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: quote } = await supabase
    .from('documents')
    .select('*, document_items(*)')
    .eq('id', id)
    .single()

  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: 'invoice' })
  if (numErr) return NextResponse.json({ error: numErr.message }, { status: 500 })

  const { data: invoice, error } = await supabase.from('documents').insert({
    type: 'invoice',
    number: numData,
    client_id: quote.client_id,
    date: new Date().toISOString().split('T')[0],
    service_date: quote.service_date,
    due_date: null,
    status: 'draft',
    language: quote.language,
    currency: quote.currency,
    tax_treatment: quote.tax_treatment,
    exchange_rate: quote.exchange_rate,
    notes: quote.notes,
    notes_internal: quote.notes_internal,
    converted_from_id: quote.id,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabase.from('document_items').insert(
    (quote.document_items ?? []).map((item: { sort_order: number; description: string; quantity: number; unit: string; unit_price: number; vat_rate: number; catalogue_item_id: string | null }) => ({
      document_id: invoice.id,
      sort_order: item.sort_order,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      vat_rate: item.vat_rate,
      catalogue_item_id: item.catalogue_item_id,
    }))
  )

  await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id)

  return NextResponse.json({ invoiceId: invoice.id })
}
