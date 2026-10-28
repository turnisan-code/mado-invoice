import type { TFn } from '@/lib/i18n'
import { roundCents } from '@/lib/utils/document'
import type { PaymentSummaryLine } from '@/types'

export type SummaryPayment = { amount: number; kind?: string | null; note?: string | null }

// What an invoice, its portal page and a Mahnung list between the total and the balance due.
// Only money received is "paid"; every applied credit note is its own row (a credit row carries
// the credit note's number in note, see applyCreditNote), Skonto and write-offs are named. The
// rows add up to totals.total_paid.
export function summarizePayments(payments: readonly SummaryPayment[]): PaymentSummaryLine[] {
  const credits: PaymentSummaryLine[] = []
  let paid = 0
  let skonto = 0
  let writeoff = 0
  for (const p of payments) {
    if (p.kind === 'credit') credits.push({ kind: 'credit', amount: roundCents(p.amount), creditNoteNumber: p.note?.trim() || null })
    else if (p.kind === 'skonto') skonto += p.amount
    else if (p.kind === 'writeoff') writeoff += p.amount
    else paid += p.amount
  }
  credits.sort((a, b) => (a.creditNoteNumber ?? '').localeCompare(b.creditNoteNumber ?? ''))
  const rest: PaymentSummaryLine[] = [
    { kind: 'paid', amount: roundCents(paid), creditNoteNumber: null },
    { kind: 'skonto', amount: roundCents(skonto), creditNoteNumber: null },
    { kind: 'writeoff', amount: roundCents(writeoff), creditNoteNumber: null },
  ]
  return [...credits, ...rest].filter(line => line.amount !== 0)
}

// t in the document's language.
export function paymentLineLabel(t: TFn, line: PaymentSummaryLine): string {
  switch (line.kind) {
    case 'credit':
      return line.creditNoteNumber ? t('docs.payments.creditNote', { number: line.creditNoteNumber }) : t('docs.payments.creditNotePlain')
    case 'skonto':
      return t('docs.payments.skonto')
    case 'writeoff':
      return t('docs.payments.writeoff')
    default:
      return t('pdfPortal.totals.paid')
  }
}
