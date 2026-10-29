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
  payments: { amount: number; kind?: string | null; credit_note_id?: string | null }[] | null
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

type Totals = ReturnType<typeof calcTotals>

function totalsOf(d: StatementDoc): Totals {
  const discount = d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null
  return calcTotals(d.document_items ?? [], d.payments ?? [], discount, d.tax_treatment)
}

// A cancelled invoice owes nothing. Its Storno is normally applied as a 'credit' row on it
// (applyCreditNote), but a Storno issued before credits were recorded, or whose apply failed, has
// no such row, and an invoice cancelled before Stornos existed has no Storno at all. What such a
// row would have applied is settled here on both sides (as applyCreditNote would: what is open on
// both), so the pair never shows an amount open, whichever of the two the period holds.
function impliedStornoCredits(docs: readonly StatementDoc[], totals: ReadonlyMap<string, Totals>, applied: ReadonlyMap<string, number>) {
  const implied = new Map<string, number>()
  for (const inv of docs) {
    if (inv.type !== 'invoice' || inv.status !== 'cancelled') continue
    const invoiceOpen = totals.get(inv.id)!.balance_due
    const storno = docs.find(d => d.type === 'credit_note' && d.cancels_document_id === inv.id)
    if (!storno) {
      if (invoiceOpen > 0) implied.set(inv.id, invoiceOpen)
      continue
    }
    if ((inv.payments ?? []).some(p => p.kind === 'credit' && p.credit_note_id === storno.id)) continue
    const st = totals.get(storno.id)!
    const amount = roundCents(Math.min(creditNoteOpen(st.total, applied.get(storno.id) ?? 0, st.total_paid), invoiceOpen))
    if (amount > 0) {
      implied.set(inv.id, amount)
      implied.set(storno.id, amount)
    }
  }
  return implied
}

// `applied` maps a credit note id to the sum of its 'credit' rows on the invoice it corrects
// (those rows live on the invoice, so the credit note's own payments only hold its refunds).
// `docs` must also hold the counterpart of every cancelled invoice and Storno, even outside the
// period. Dunning fees paid on top never count: calcTotals settles with settlesBalance.
export function statementRows(docs: readonly StatementDoc[], applied: ReadonlyMap<string, number>): StatementRow[] {
  const relevant = docs.filter(d => d.type === 'invoice' || d.type === 'credit_note')
  const totals = new Map(relevant.map(d => [d.id, totalsOf(d)]))
  const implied = impliedStornoCredits(relevant, totals, applied)
  return relevant
    .map(d => {
      const t = totals.get(d.id)!
      const extra = implied.get(d.id) ?? 0
      const base = { id: d.id, number: d.number, date: d.date, due_date: d.due_date, currency: d.currency || 'EUR', cancelled: d.status === 'cancelled' }
      if (d.type === 'invoice') {
        const settled = roundCents(t.total_paid + extra)
        return { ...base, kind: 'invoice' as const, total: t.total, settled, open: roundCents(t.total - settled) }
      }
      const open = creditNoteOpen(t.total, (applied.get(d.id) ?? 0) + extra, t.total_paid)
      return {
        ...base,
        kind: d.cancels_document_id ? 'storno' as const : 'credit_note' as const,
        due_date: null,
        // roundCents also turns -0 into 0, which would print as "-0,00".
        total: roundCents(-t.total),
        settled: roundCents(open - t.total),
        open: roundCents(-open),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
}

// What a statement for from…to lists: every document dated in the period plus older ones still
// open, so its balance is what the client really owes; with openOnly every open document up to `to`.
export function selectStatementRows(rows: readonly StatementRow[], period: { from: string; to: string; openOnly: boolean }): StatementRow[] {
  return rows.filter(r => r.date <= period.to && (hasOpenAmount(r) || (!period.openOnly && r.date >= period.from)))
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
