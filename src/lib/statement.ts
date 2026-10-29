// A client statement (Kontoauszug / offene Posten): every issued invoice and credit note with what
// it amounts to, what settled it and what is still open. Amounts are signed from the client's side:
// positive is owed to the studio, negative (credit notes, overpayments) is owed to the client.
import { calcTotals, roundCents } from '@/lib/utils/document'
import { creditNoteOpen } from '@/lib/status'

export type StatementDoc = {
  id: string
  type: string
  number: string
  date: string
  due_date: string | null
  status: string
  currency: string | null
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  cancels_document_id?: string | null
  document_items: Parameters<typeof calcTotals>[0] | null
  payments: { amount: number; kind?: string | null }[] | null
}

export type StatementKind = 'invoice' | 'credit_note' | 'storno'

export interface StatementRow {
  id: string
  kind: StatementKind
  number: string
  date: string
  due_date: string | null
  currency: string
  cancelled: boolean
  total: number
  // Payments, applied credit notes, Skonto and write-offs on an invoice; what a credit note has
  // been applied or paid back with. total − settled = open.
  settled: number
  open: number
}

export interface StatementSum {
  currency: string
  total: number
  settled: number
  open: number
}

// `applied` maps a credit note id to the sum of its 'credit' rows on the invoice it corrects
// (those rows live on the invoice, so the credit note's own payments only hold its refunds).
// Dunning fees paid on top never count: calcTotals settles with settlesBalance.
export function statementRows(docs: readonly StatementDoc[], applied: ReadonlyMap<string, number>): StatementRow[] {
  return docs
    .filter(d => d.type === 'invoice' || d.type === 'credit_note')
    .map(d => {
      const discount = d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null
      const totals = calcTotals(d.document_items ?? [], d.payments ?? [], discount, d.tax_treatment)
      const base = { id: d.id, number: d.number, date: d.date, due_date: d.due_date, currency: d.currency || 'EUR', cancelled: d.status === 'cancelled' }
      if (d.type === 'invoice') {
        return { ...base, kind: 'invoice' as const, total: totals.total, settled: totals.total_paid, open: totals.balance_due }
      }
      const open = creditNoteOpen(totals.total, applied.get(d.id) ?? 0, totals.total_paid)
      return {
        ...base,
        kind: d.cancels_document_id ? 'storno' as const : 'credit_note' as const,
        due_date: null,
        // roundCents also turns -0 into 0, which would print as "-0,00".
        total: roundCents(-totals.total),
        settled: roundCents(open - totals.total),
        open: roundCents(-open),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
}

// One sum per currency (legacy documents may be in another currency than EUR), EUR first.
export function statementSums(rows: readonly StatementRow[]): StatementSum[] {
  const sums = new Map<string, StatementSum>()
  for (const r of rows) {
    const s = sums.get(r.currency) ?? { currency: r.currency, total: 0, settled: 0, open: 0 }
    s.total += r.total
    s.settled += r.settled
    s.open += r.open
    sums.set(r.currency, s)
  }
  return [...sums.values()]
    .map(s => ({ currency: s.currency, total: roundCents(s.total), settled: roundCents(s.settled), open: roundCents(s.open) }))
    .sort((a, b) => (a.currency === 'EUR' ? -1 : b.currency === 'EUR' ? 1 : a.currency.localeCompare(b.currency)))
}

export const hasOpenAmount = (row: Pick<StatementRow, 'open'>) => Math.abs(row.open) >= 0.005
