import { calcTotals } from '@/lib/utils/document'

export type TotalsDoc = {
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0]
}

export type VatBuckets = {
  vat: Record<number, { base: number; vat: number }>
  rcBase: number
  nonEuBase: number
}

function docTotals(d: TotalsDoc) {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
}

// Ist-Besteuerung: turnover counts when money moves, split like the document it belongs to.
//  - received: money paid on an invoice (kind 'payment'), in the period it arrived;
//  - refunded: money paid back on a credit note (kind 'refund'), deducted when it was paid;
//  - applied: a credit note applied to its invoice (kind 'credit'). It settles part of the invoice
//    without money: counted at the invoice's rates and taken off at the credit note's rates in its
//    period. It adds nothing in total, but once the invoice is settled the turnover per rate is
//    what was really paid for (a credited 10 % line no longer shows up as 10 % turnover through
//    the payments for the 20 % lines).
// Skonto and write-offs never reach this function: they close a balance without turnover.
export function istTurnover(input: {
  received: { amount: number; invoice: TotalsDoc }[]
  applied: { amount: number; invoice: TotalsDoc; creditNote: TotalsDoc }[]
  refunded: { amount: number; creditNote: TotalsDoc }[]
}): VatBuckets {
  const out: VatBuckets = { vat: {}, rcBase: 0, nonEuBase: 0 }

  function add(d: TotalsDoc, gross: number) {
    const t = docTotals(d)
    if (!t.total) return
    const share = gross / t.total
    if (d.tax_treatment === 'eu_reverse_charge') out.rcBase += (t.subtotal - t.discount_amount) * share
    else if (d.tax_treatment === 'non_eu') out.nonEuBase += (t.subtotal - t.discount_amount) * share
    else {
      for (const g of t.vat_groups) {
        out.vat[g.rate] = out.vat[g.rate] ?? { base: 0, vat: 0 }
        out.vat[g.rate].base += g.base * share
        out.vat[g.rate].vat += g.amount * share
      }
    }
  }

  for (const r of input.received) add(r.invoice, r.amount)
  for (const a of input.applied) {
    add(a.invoice, a.amount)
    add(a.creditNote, -a.amount)
  }
  for (const r of input.refunded) add(r.creditNote, -r.amount)
  return out
}
