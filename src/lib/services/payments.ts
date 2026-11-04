// Money on invoices and credit notes as the payment panel, the credit-note settlement, the bank
// import, the invoice list's "Mark paid" and the Claude connector record it: the rows, their
// 'payment_added'/'payment_removed' history and the move to 'paid' once an invoice is settled.
// Browser-safe (supabase-js and pure helpers only).
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/events'
import { canTransition, DOCUMENT_STATUSES, paymentDateIssue } from '@/lib/status'
import { roundCents, settlesBalance, skontoAmount, skontoDeadline } from '@/lib/utils/document'
import type { Payment, PaymentKind, PaymentMethod } from '@/types'

// Statuses a settled invoice moves to 'paid' from.
export const PAYABLE: readonly string[] = DOCUMENT_STATUSES.invoice.filter(s => canTransition('invoice', s, 'paid'))

// What has settled an invoice: every kind but 'fee' (dunning fees and interest paid on top).
export const settledSum = (rows: { amount: number; kind?: string | null }[]) => roundCents(rows.filter(settlesBalance).reduce((s, p) => s + p.amount, 0))

export interface NewPayment {
  date: string
  amount: number
  note: string | null
  kind: PaymentKind
  method: PaymentMethod
  reference?: string | null
  // A bank statement's transaction (unique): a second import of it is refused with 23505.
  import_ref?: string | null
}

export type DocumentPayment = NewPayment & { document_id: string }

// More than is open: the open balance is the payment, the rest dunning fees and interest
// ('fee', not turnover) when `excess` says so, otherwise all of it is a payment (an overpayment).
export function splitOverpayment(amount: number, open: number, excess: 'fee' | 'payment' | undefined): { paid: number; fee: number } {
  const due = Math.max(0, open)
  if (excess !== 'fee' || amount <= due + 0.005) return { paid: amount, fee: 0 }
  return { paid: due, fee: roundCents(amount - due) }
}

// The rows a payment of `amount` on an invoice with `balance` open becomes: one payment, or the
// open part plus the rest as a fee. In cents the same split as splitOverpayment.
export function paymentRows(amount: number, balance: number, excess: 'fee' | 'payment' | undefined, row: (amount: number, kind?: PaymentKind) => NewPayment): NewPayment[] {
  const open = Math.max(0, balance)
  const fee = roundCents(amount - open)
  return excess !== 'fee' || fee <= 0.005 ? [row(amount)] : [...(open > 0.005 ? [row(open)] : []), row(fee, 'fee')]
}

// Why an invoice cannot take a payment dated `date`; null when it can. Payments belong to issued,
// live invoices: a draft has no legal number yet and a cancelled one was replaced by its Storno.
export function paymentRefusal(
  doc: { type: string; number: string | null; status: string } | null | undefined,
  date: string,
  today: string,
): 'not_found' | 'not_issued' | 'cancelled' | 'date_required' | 'date_future' | null {
  if (!doc || doc.type !== 'invoice') return 'not_found'
  if (!doc.number || doc.status === 'draft') return 'not_issued'
  if (doc.status === 'cancelled') return 'cancelled'
  const issue = paymentDateIssue(date, today)
  return issue ? (issue === 'required' ? 'date_required' : 'date_future') : null
}

// Skonto may be taken when the money arrived within the Skonto window and covers the total less
// the Skonto.
export function skontoOffered(inv: {
  total: number
  date: string
  skontoPercent: number | null | undefined
  skontoDays: number | null | undefined
  payments: { amount: number; kind?: string | null; date: string }[]
}): boolean {
  const balance = roundCents(inv.total - settledSum(inv.payments))
  const skonto = skontoAmount(inv.total, inv.skontoPercent)
  const due = inv.skontoDays != null ? skontoDeadline(inv.date, inv.skontoDays) : null
  const lastReceived = inv.payments.filter(p => p.kind === 'payment').map(p => p.date).sort().at(-1) ?? null
  return skonto > 0 && !!due && !!lastReceived && lastReceived <= due && balance <= skonto + 0.01
}

// The row that closes the rest of an invoice without money: the Skonto taken, or a write-off.
export function settlementRow(kind: 'skonto' | 'writeoff', balance: number, date: string, opts: { skontoPercent?: number | null; reason?: string | null }): NewPayment {
  return { date, amount: balance, note: kind === 'skonto' ? `Skonto ${opts.skontoPercent} %` : opts.reason ?? null, kind, method: 'bank' }
}

function addedDetail(row: NewPayment, imported: boolean): Record<string, unknown> {
  return imported
    ? { amount: row.amount, date: row.date, kind: row.kind, method: 'bank', imported: true }
    : { amount: row.amount, date: row.date, kind: row.kind, method: row.method, reference: row.reference ?? undefined }
}

// Inserts the rows in one statement and records each in its document's history. `imported` rows
// come from a bank statement.
export async function insertPayments(
  supabase: SupabaseClient,
  rows: DocumentPayment[],
  opts: { imported?: boolean; onInserted?: (added: Payment[]) => void } = {},
): Promise<{ added: Payment[]; error: PostgrestError | null }> {
  const { data, error } = await supabase.from('payments').insert(rows).select()
  if (error) return { added: [], error }
  const added = (data ?? []) as Payment[]
  opts.onInserted?.(added)
  for (const row of rows) await logEvent(supabase, row.document_id, 'payment_added', addedDetail(row, !!opts.imported))
  return { added, error: null }
}

// Moves the invoices that are still sent or overdue to 'paid', with their history; `updated` are
// the ones that moved.
export async function markPaid(
  supabase: SupabaseClient,
  invoices: { id: string; status: string }[],
): Promise<{ updated: string[]; error: PostgrestError | null }> {
  if (!invoices.length) return { updated: [], error: null }
  const { data, error } = await supabase.from('documents').update({ status: 'paid' })
    .in('id', invoices.map(d => d.id)).in('status', PAYABLE).select('id')
  if (error) return { updated: [], error }
  const from = new Map(invoices.map(d => [d.id, d.status]))
  const updated = (data ?? []).map(r => r.id as string)
  for (const id of updated) await logEvent(supabase, id, 'status_changed', { from: from.get(id), to: 'paid' })
  return { updated, error: null }
}

export interface PayableInvoice {
  id: string
  status: string
  total: number
  payments: { amount: number; kind?: string | null }[]
}

export interface RecordedPayments {
  added: Payment[]
  error: PostgrestError | null
  // The rows settle the invoice and it was sent or overdue: it was moved to 'paid' unless
  // `statusError` says otherwise (the payments stay recorded either way).
  settled: boolean
  statusError: PostgrestError | null
}

// Records payment rows on an issued invoice (`invoice` as the caller last saw it) and marks it paid
// once they settle it.
export async function recordInvoicePayments(
  supabase: SupabaseClient,
  invoice: PayableInvoice,
  rows: NewPayment[],
  opts: { onInserted?: (added: Payment[]) => void } = {},
): Promise<RecordedPayments> {
  const { added, error } = await insertPayments(supabase, rows.map(row => ({ document_id: invoice.id, ...row })), opts)
  if (error) return { added, error, settled: false, statusError: null }
  const settled = settledSum([...invoice.payments, ...added]) >= invoice.total - 0.005 && PAYABLE.includes(invoice.status)
  if (!settled) return { added, error: null, settled, statusError: null }
  const { error: statusError } = await markPaid(supabase, [invoice])
  return { added, error: null, settled, statusError }
}

export interface RemovedPayment {
  amount: number
  date: string
  kind: PaymentKind
  method: PaymentMethod
}

// Deletes a payment, refund or write-off row in one transaction with reopening a paid invoice
// that is no longer settled (the only way the lifecycle trigger lets paid go back). `reopened`
// is the status it went back to.
export async function removePayment(
  supabase: SupabaseClient,
  documentId: string,
  paymentId: string,
  opts: { reopen: boolean; removed?: RemovedPayment },
): Promise<{ reopened: string | null; error: PostgrestError | null }> {
  const { data, error } = await supabase.rpc('remove_payment', { p_payment_id: paymentId, p_reopen: opts.reopen })
  if (error) return { reopened: null, error }
  const reopened = (data as string | null) ?? null
  if (opts.removed) {
    const { amount, date, kind, method } = opts.removed
    await logEvent(supabase, documentId, 'payment_removed', { amount, date, kind, method })
  }
  if (reopened) await logEvent(supabase, documentId, 'status_changed', { from: 'paid', to: reopened })
  return { reopened, error: null }
}

// Whether removing a payment reopens the invoice: it was paid and the rest no longer settles it.
export function reopensOnRemoval(status: string, total: number, remaining: { amount: number; kind?: string | null }[]): boolean {
  return status === 'paid' && settledSum(remaining) < total - 0.005
}

// Money paid back to the client on an issued credit note.
export async function recordRefund(
  supabase: SupabaseClient,
  creditNoteId: string,
  row: { date: string; amount: number; method: PaymentMethod; reference: string | null; note: string | null },
): Promise<{ refund: Payment | null; error: PostgrestError | null }> {
  const { data, error } = await supabase.from('payments').insert({ document_id: creditNoteId, kind: 'refund', ...row }).select()
  if (error) return { refund: null, error }
  await logEvent(supabase, creditNoteId, 'payment_added', { ...row, kind: 'refund', reference: row.reference ?? undefined })
  return { refund: ((data ?? [])[0] as Payment | undefined) ?? null, error: null }
}
