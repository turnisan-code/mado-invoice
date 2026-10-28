import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents, today } from '@/lib/utils/document'
import { logEvent } from '@/lib/events'
import { canTransition, creditNoteOpen, DOCUMENT_STATUSES } from '@/lib/status'

const TOTAL_COLS = 'tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

type TotalsDoc = {
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0] | null
}

export function documentTotal(d: TotalsDoc): number {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  ).total
}

const sum = (rows: { amount: number }[]) => roundCents(rows.reduce((s, p) => s + p.amount, 0))
const PAYABLE: readonly string[] = DOCUMENT_STATUSES.invoice.filter(s => canTransition('invoice', s, 'paid'))

export type CreditApplication = { applied: number; invoiceId: string | null; invoiceNumber: string | null }

// Applies an issued credit note to the open balance of the invoice it was created from: one
// 'credit' row on the invoice (never money: reports, dashboard and Bookamat skip the kind) that
// links the credit note, so reminders stop asking for the credited amount. Only what is open on
// both sides is applied; the rest of the credit note is paid back and recorded as a refund on it.
// An invoice the credit settles becomes paid; a cancelled one stays cancelled. Applying twice is
// a no-op (payments_credit_note_key).
export async function applyCreditNote(supabase: SupabaseClient, creditNoteId: string): Promise<CreditApplication> {
  const { data: cn, error } = await supabase
    .from('documents')
    .select(`id, type, number, status, converted_from_id, ${TOTAL_COLS}, payments(amount, kind)`)
    .eq('id', creditNoteId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!cn || cn.type !== 'credit_note' || !cn.number || cn.status === 'cancelled' || !cn.converted_from_id) {
    return { applied: 0, invoiceId: null, invoiceNumber: null }
  }

  const { data: inv, error: invErr } = await supabase
    .from('documents')
    .select(`id, type, number, status, ${TOTAL_COLS}, payments(amount, kind, credit_note_id)`)
    .eq('id', cn.converted_from_id)
    .maybeSingle()
  if (invErr) throw new Error(invErr.message)
  if (!inv || inv.type !== 'invoice' || !inv.number) return { applied: 0, invoiceId: null, invoiceNumber: null }
  const none = { applied: 0, invoiceId: inv.id as string, invoiceNumber: inv.number as string }

  const invPayments = (inv.payments ?? []) as { amount: number; kind: string; credit_note_id: string | null }[]
  if (invPayments.some(p => p.kind === 'credit' && p.credit_note_id === cn.id)) return none

  const refunded = sum(((cn.payments ?? []) as { amount: number; kind: string }[]).filter(p => p.kind === 'refund'))
  const invoiceOpen = roundCents(documentTotal(inv) - sum(invPayments))
  const amount = roundCents(Math.min(creditNoteOpen(documentTotal(cn), 0, refunded), invoiceOpen))
  if (amount <= 0) return none

  const date = today()
  const { error: insErr } = await supabase.from('payments').insert({
    document_id: inv.id, date, amount, kind: 'credit', method: 'bank', note: cn.number, credit_note_id: cn.id,
  })
  if (insErr?.code === '23505') return none
  if (insErr) throw new Error(insErr.message)
  await logEvent(supabase, inv.id, 'payment_added', { amount, date, kind: 'credit', credit_note_id: cn.id, credit_note_number: cn.number })

  if (amount >= invoiceOpen - 0.005 && PAYABLE.includes(inv.status)) {
    const { data: updated, error: statusErr } = await supabase
      .from('documents')
      .update({ status: 'paid' })
      .eq('id', inv.id)
      .in('status', PAYABLE)
      .select('id')
    if (statusErr) console.error(`[credits] ${inv.number} not marked paid:`, statusErr.message)
    else if (updated?.length) await logEvent(supabase, inv.id, 'status_changed', { from: inv.status, to: 'paid' })
  }
  return { applied: amount, invoiceId: inv.id, invoiceNumber: inv.number }
}
