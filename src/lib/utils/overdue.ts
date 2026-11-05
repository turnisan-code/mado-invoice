import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, today } from '@/lib/utils/document'

type Candidate = {
  id: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0] | null
  payments: { amount: number; kind: string | null }[] | null
}

// Sent invoices past their due date become 'overdue' — only when something is actually owed: an
// invoice with a zero total, or settled by payments, Skonto, a write-off or a credit note, never is.
export async function markOverdueInvoices(supabase: SupabaseClient): Promise<{ marked: number; error: string | null }> {
  const now = today()
  const { data, error } = await supabase
    .from('documents')
    .select('id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
    .eq('type', 'invoice')
    .eq('status', 'sent')
    .not('due_date', 'is', null)
    .lt('due_date', now)
  if (error) {
    console.error('[overdue] candidates not loaded:', error.message)
    return { marked: 0, error: error.message }
  }

  const ids = ((data ?? []) as Candidate[]).filter(d => {
    const totals = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    return totals.total > 0.005 && totals.balance_due > 0.005
  }).map(d => d.id)

  let marked = 0
  // .in() filters travel in the URL, so long id lists go in slices.
  for (let i = 0; i < ids.length; i += 100) {
    const { data: updated, error: updateErr } = await supabase
      .from('documents')
      .update({ status: 'overdue' })
      .in('id', ids.slice(i, i + 100))
      .eq('status', 'sent')
      .lt('due_date', now)
      .select('id')
    if (updateErr) {
      console.error('[overdue] not marked:', updateErr.message)
      return { marked, error: updateErr.message }
    }
    marked += updated?.length ?? 0
  }
  return { marked, error: null }
}
