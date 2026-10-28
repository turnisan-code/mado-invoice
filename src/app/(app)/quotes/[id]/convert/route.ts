import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { today } from '@/lib/utils/document'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: quote } = await supabase
    .from('documents')
    .select('*, document_items(*)')
    .eq('id', id)
    .eq('type', 'quote')
    .single()

  if (!quote) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The invoice starts as an unnumbered draft; its number is assigned when it is issued.
  const { data: invoice, error } = await supabase.from('documents').insert({
    type: 'invoice',
    number: null,
    client_id: quote.client_id,
    date: today(),
    service_date: quote.service_date,
    service_date_end: quote.service_date_end,
    due_date: null,
    status: 'draft',
    language: quote.language,
    currency: quote.currency,
    tax_treatment: quote.tax_treatment,
    exchange_rate: quote.exchange_rate,
    notes: quote.notes,
    notes_internal: quote.notes_internal,
    discount_type: quote.discount_type,
    discount_value: quote.discount_value,
    converted_from_id: quote.id,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = (quote.document_items ?? []).map((item: Record<string, unknown>) => ({
    document_id: invoice.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'item',
    description: item.description,
    service_date: item.service_date ?? null,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate,
    catalogue_item_id: item.catalogue_item_id ?? null,
    discount_type: item.discount_type ?? null,
    discount_value: item.discount_value ?? null,
  }))
  const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: invoice.id, p_items: items })
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })

  await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id)

  return NextResponse.json({ invoiceId: invoice.id })
}
