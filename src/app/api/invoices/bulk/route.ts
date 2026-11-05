import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { NextResponse } from 'next/server'
import { calcTotals, today } from '@/lib/utils/document'

// Issuing renders, stores and archives each draft's PDF in turn.
export const maxDuration = 60

// Which current statuses may move to the requested one. Paid/cancelled invoices are left alone;
// cancelling an issued invoice needs a Storno (per-document flow), so it is not offered here.
const SOURCE: Record<string, string[]> = {
  sent: ['draft'],
  paid: ['draft', 'sent', 'overdue'],
}
const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'ids and status required' }, { status: 400 })
  }
  const sources = SOURCE[body.status]
  if (!sources) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select(`id, number, status, tax_treatment, discount_type, discount_value, ${ITEM_COLS}, payments(amount)`)
    .in('id', body.ids)
    .eq('type', 'invoice')
    .in('status', sources)
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const invoices = docs ?? []

  // Drafts get a number assigned (sequentially) first, plus their archive copy; issuing also sets them to 'sent'.
  for (const d of invoices.filter(d => !d.number)) {
    try { await issueDocument(supabase, d.id) } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (body.status === 'paid') {
    // "Paid" means money arrived: record the open balance as a payment dated today.
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
    const { error } = await supabase
      .from('documents')
      .update({ status: 'paid' })
      .in('id', invoices.map(d => d.id))
      .in('status', ['draft', 'sent', 'overdue'])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ updated: invoices.length, skipped: body.ids.length - invoices.length })
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
