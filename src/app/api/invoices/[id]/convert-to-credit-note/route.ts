import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { today } from '@/lib/utils/document'

// Creates a credit note from an invoice. With { cancel: true } it is a Storno: the invoice
// is marked cancelled and the credit note references it (number + date on the PDF).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const cancel = body?.cancel === true

  const { data: invoice } = await supabase
    .from('documents')
    .select('*, document_items(*)')
    .eq('id', id)
    .eq('type', 'invoice')
    .single()

  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (cancel) {
    if (!invoice.number) return NextResponse.json({ error: 'A draft has no number to cancel — delete it instead' }, { status: 400 })
    if (invoice.status === 'cancelled') return NextResponse.json({ error: 'Invoice is already cancelled' }, { status: 409 })
  }

  const { data: creditNote, error } = await supabase.from('documents').insert({
    type: 'credit_note',
    number: null,
    client_id: invoice.client_id,
    date: today(),
    service_date: invoice.service_date,
    service_date_end: invoice.service_date_end,
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
    cancels_document_id: cancel ? invoice.id : null,
  }).select('id').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = (invoice.document_items ?? []).map((item: Record<string, unknown>) => ({
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
  const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: creditNote.id, p_items: items })
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })

  if (cancel) {
    // Conditional update: if a concurrent request already cancelled the invoice, this Storno loses and is removed.
    const { data: cancelled, error: cancelErr } = await supabase
      .from('documents')
      .update({ status: 'cancelled' })
      .eq('id', invoice.id)
      .neq('status', 'cancelled')
      .select('id')
    if (cancelErr) return NextResponse.json({ error: cancelErr.message }, { status: 500 })
    if (!cancelled?.length) {
      await supabase.from('documents').delete().eq('id', creditNote.id)
      return NextResponse.json({ error: 'Invoice is already cancelled' }, { status: 409 })
    }
  }

  return NextResponse.json({ creditNoteId: creditNote.id })
}
