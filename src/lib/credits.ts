import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents, today } from '@/lib/utils/document'
import { logEvent } from '@/lib/events'
import { canTransition, creditNoteOpen, creditNoteSettled, DOCUMENT_STATUSES } from '@/lib/status'
import type { Payment } from '@/types'

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
// a no-op (payments_credit_note_key). The credit is dated today unless `date` says when it took
// effect (catching up on a credit note issued earlier).
export async function applyCreditNote(supabase: SupabaseClient, creditNoteId: string, opts: { date?: string } = {}): Promise<CreditApplication> {
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

  const now = today()
  const date = opts.date && opts.date < now ? opts.date : now
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

// .in() filters travel in the URL, so long id lists are fetched in slices.
async function inSlices<T>(ids: string[], fetch: (slice: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await fetch(ids.slice(i, i + 100))
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
  }
  return out
}

export type UnappliedCredit = { id: string; number: string; date: string; invoiceId: string; invoiceNumber: string; amount: number }

// Issued credit notes that could still take something off the open balance of the invoice they
// correct: issued before credits were recorded, or their automatic apply failed.
export async function unappliedCreditNotes(supabase: SupabaseClient): Promise<UnappliedCredit[]> {
  const [{ data: cns, error }, { data: credited, error: creditErr }] = await Promise.all([
    supabase
      .from('documents')
      .select(`id, number, date, converted_from_id, ${TOTAL_COLS}, payments(amount, kind)`)
      .eq('type', 'credit_note')
      .eq('status', 'sent')
      .not('number', 'is', null)
      .not('converted_from_id', 'is', null),
    supabase.from('payments').select('credit_note_id').eq('kind', 'credit'),
  ])
  if (error) throw new Error(error.message)
  if (creditErr) throw new Error(creditErr.message)
  const done = new Set((credited ?? []).map(r => r.credit_note_id as string))
  const candidates = (cns ?? []).filter(c => !done.has(c.id))
  if (!candidates.length) return []

  type Inv = TotalsDoc & { id: string; number: string; payments: { amount: number }[] | null }
  const invoices = await inSlices<Inv>([...new Set(candidates.map(c => c.converted_from_id as string))], slice =>
    supabase.from('documents').select(`id, number, ${TOTAL_COLS}, payments(amount)`).in('id', slice).eq('type', 'invoice').not('number', 'is', null),
  )
  const byId = new Map(invoices.map(i => [i.id, i]))
  return candidates.flatMap(c => {
    const inv = byId.get(c.converted_from_id as string)
    if (!inv) return []
    const refunded = sum(((c.payments ?? []) as { amount: number; kind: string }[]).filter(p => p.kind === 'refund'))
    const amount = roundCents(Math.min(creditNoteOpen(documentTotal(c), 0, refunded), documentTotal(inv) - sum(inv.payments ?? [])))
    return amount > 0.005 ? [{ id: c.id as string, number: c.number as string, date: c.date as string, invoiceId: inv.id, invoiceNumber: inv.number, amount }] : []
  })
}

export type CreditNoteSettlementData = {
  total: number
  // The invoice the credit note corrects and what is still open on it.
  invoice: { id: string; number: string | null; open: number } | null
  // 'credit' rows on that invoice that apply this credit note.
  applied: { id: string; date: string; amount: number }[]
  refunds: Payment[]
  settled: boolean
}

type CreditNoteDoc = TotalsDoc & { id: string; number: string | null; status: string; converted_from_id: string | null; payments?: Payment[] | null }

export async function loadCreditNoteSettlement(supabase: SupabaseClient, doc: CreditNoteDoc): Promise<CreditNoteSettlementData> {
  const [{ data: appliedRows }, { data: source }] = await Promise.all([
    supabase.from('payments').select('id, date, amount').eq('kind', 'credit').eq('credit_note_id', doc.id),
    doc.converted_from_id
      ? supabase.from('documents').select(`id, type, number, ${TOTAL_COLS}, payments(amount)`).eq('id', doc.converted_from_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const total = documentTotal(doc)
  const applied = (appliedRows ?? []) as CreditNoteSettlementData['applied']
  const refunds = (doc.payments ?? []).filter(p => p.kind === 'refund')
  const invoice = source?.type === 'invoice'
    ? { id: source.id as string, number: source.number as string | null, open: roundCents(documentTotal(source) - sum(source.payments ?? [])) }
    : null
  const settled = !!doc.number && doc.status === 'sent' && creditNoteSettled(total, sum(applied), sum(refunds))
  return { total, invoice, applied, refunds, settled }
}
