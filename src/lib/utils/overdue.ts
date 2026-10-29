import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, today } from '@/lib/utils/document'
import { logEvent } from '@/lib/events'

type Candidate = {
  id: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0] | null
  payments: { amount: number; kind: string | null }[] | null
}

type Step = { from: 'sent' | 'overdue'; to: 'sent' | 'overdue' }

// Each update repeats the date condition, so a due date edited meanwhile is never flipped on stale
// data. .in() filters travel in the URL, so long id lists go in slices. The history records every
// change as automatic.
async function flip(supabase: SupabaseClient, ids: string[], { from, to }: Step, now: string): Promise<{ changed: number; error: string | null }> {
  let changed = 0
  for (let i = 0; i < ids.length; i += 100) {
    const base = supabase.from('documents').update({ status: to }).in('id', ids.slice(i, i + 100)).eq('status', from)
    const { data, error } = await (to === 'overdue' ? base.lt('due_date', now) : base.or(`due_date.is.null,due_date.gte.${now}`)).select('id')
    if (error) {
      console.error(`[overdue] ${from} → ${to} not written:`, error.message)
      return { changed, error: error.message }
    }
    for (const { id } of data ?? []) await logEvent(supabase, id, 'status_changed', { from, to, automatic: true })
    changed += data?.length ?? 0
  }
  return { changed, error: null }
}

// Sent invoices past their due date become 'overdue' — only when something is actually owed: an
// invoice with a zero total, or settled by payments, Skonto, a write-off or a credit note, never is.
// An 'overdue' invoice whose due date now lies today or later (an extension, or marked by hand too
// early) goes back to 'sent', so no reminder counts days from a date not reached yet.
export async function markOverdueInvoices(supabase: SupabaseClient): Promise<{ marked: number; reopened: number; error: string | null }> {
  const now = today()
  const [candidates, extended] = await Promise.all([
    supabase
      .from('documents')
      .select('id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
      .eq('type', 'invoice')
      .eq('status', 'sent')
      .not('due_date', 'is', null)
      .lt('due_date', now),
    supabase
      .from('documents')
      .select('id')
      .eq('type', 'invoice')
      .eq('status', 'overdue')
      .or(`due_date.is.null,due_date.gte.${now}`),
  ])

  let reopened = 0
  let error: string | null = null
  if (extended.error) {
    console.error('[overdue] extended invoices not loaded:', extended.error.message)
    error = extended.error.message
  } else {
    const result = await flip(supabase, (extended.data ?? []).map(d => d.id as string), { from: 'overdue', to: 'sent' }, now)
    reopened = result.changed
    error = result.error
  }

  if (candidates.error) {
    console.error('[overdue] candidates not loaded:', candidates.error.message)
    return { marked: 0, reopened, error: error ?? candidates.error.message }
  }
  const ids = ((candidates.data ?? []) as Candidate[]).filter(d => {
    const totals = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    return totals.total > 0.005 && totals.balance_due > 0.005
  }).map(d => d.id)

  const marked = await flip(supabase, ids, { from: 'sent', to: 'overdue' }, now)
  return { marked: marked.changed, reopened, error: error ?? marked.error }
}
