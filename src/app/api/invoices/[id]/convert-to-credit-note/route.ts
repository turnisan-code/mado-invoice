import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: invoice } = await supabase
    .from('documents')
    .select('*, document_items(*)')
    .eq('id', id)
    .eq('type', 'invoice')
    .single()

  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: creditNote, error } = await supabase.from('documents').insert({
    type: 'credit_note',
    number: null,
    client_id: invoice.client_id,
    date: new Date().toISOString().split('T')[0],
    service_date: invoice.service_date,
    due_date: null,
    status: 'draft',
    language: invoice.language,
    currency: invoice.currency,
    tax_treatment: invoice.tax_treatment,
    exchange_rate: invoice.exchange_rate,
    notes: invoice.notes,
    notes_internal: invoice.notes_internal,
    discount_type: invoice.discount_type,
    discount_value: invoice.discount_value,
    converted_from_id: invoice.id,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = invoice.document_items ?? []
  if (items.length) {
    await supabase.from('document_items').insert(
      items.map((item: Record<string, unknown>) => ({
        document_id: creditNote.id,
        sort_order: item.sort_order,
        line_type: item.line_type,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        vat_rate: item.vat_rate,
        catalogue_item_id: item.catalogue_item_id,
        discount_type: item.discount_type,
        discount_value: item.discount_value,
      }))
    )
  }

  return NextResponse.json({ creditNoteId: creditNote.id })
}
