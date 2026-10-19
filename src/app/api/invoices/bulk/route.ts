import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { calcTotals, today } from '@/lib/utils/document'

const ALLOWED = ['sent', 'paid', 'overdue', 'cancelled']
const ISSUED = ['sent', 'paid', 'overdue']
const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length || !body.status) {
    return NextResponse.json({ error: 'ids and status required' }, { status: 400 })
  }
  if (!ALLOWED.includes(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select(`id, number, tax_treatment, discount_type, discount_value, ${ITEM_COLS}, payments(amount)`)
    .in('id', body.ids)
    .eq('type', 'invoice')
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const invoices = docs ?? []

  // Issued statuses require a number; drafts get one assigned (sequentially) first.
  if (ISSUED.includes(body.status)) {
    for (const d of invoices.filter(d => !d.number)) {
      const { error: issueErr } = await supabase.rpc('issue_document', { p_document_id: d.id })
      if (issueErr) return NextResponse.json({ error: issueErr.message }, { status: 500 })
    }
  }

  // "Paid" means money arrived: record the open balance as a payment dated today.
  if (body.status === 'paid') {
    const rows = invoices
      .map(d => ({
        document_id: d.id,
        date: today(),
        amount: calcTotals(
          d.document_items ?? [],
          d.payments ?? [],
          d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
          d.tax_treatment,
        ).balance_due,
        note: null,
      }))
      .filter(r => r.amount > 0)
    if (rows.length) {
      const { error: payErr } = await supabase.from('payments').insert(rows)
      if (payErr) return NextResponse.json({ error: payErr.message }, { status: 500 })
    }
  }

  const { error } = await supabase
    .from('documents')
    .update({ status: body.status })
    .in('id', invoices.map(d => d.id))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ updated: invoices.length })
}

// Only drafts can be deleted; issued invoices must be kept and are skipped.
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  const { data: deleted, error } = await supabase
    .from('documents')
    .delete()
    .in('id', body.ids)
    .eq('type', 'invoice')
    .is('number', null)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const count = deleted?.length ?? 0
  return NextResponse.json({ deleted: count, skipped: body.ids.length - count })
}
