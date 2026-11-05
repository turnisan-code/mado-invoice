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

// Everything that settled an invoice up to the period end: money received (kind 'payment') and
// credit notes applied to it (kind 'credit'). Payments before the period are only needed when the
// invoice has credits, because a credit re-splits the money received before it.
export type InvoiceHistory = {
  invoice: TotalsDoc
  payments: { date: string; amount: number }[]
  credits: { date: string; amount: number; creditNote: TotalsDoc }[]
}

function docTotals(d: TotalsDoc) {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
}

const empty = (): VatBuckets => ({ vat: {}, rcBase: 0, nonEuBase: 0 })

function addTo(out: VatBuckets, v: VatBuckets, factor: number) {
  out.rcBase += v.rcBase * factor
  out.nonEuBase += v.nonEuBase * factor
  for (const [key, g] of Object.entries(v.vat)) {
    const rate = Number(key)
    out.vat[rate] = out.vat[rate] ?? { base: 0, vat: 0 }
    out.vat[rate].base += g.base * factor
    out.vat[rate].vat += g.vat * factor
  }
}

// How `gross` of a document splits into its tax buckets (proportionally to its total).
function split(d: TotalsDoc, gross: number): VatBuckets {
  const out = empty()
  const t = docTotals(d)
  if (!t.total) return out
  const share = gross / t.total
  if (d.tax_treatment === 'eu_reverse_charge') out.rcBase = (t.subtotal - t.discount_amount) * share
  else if (d.tax_treatment === 'non_eu') out.nonEuBase = (t.subtotal - t.discount_amount) * share
  else addTo(out, { vat: Object.fromEntries(t.vat_groups.map(g => [g.rate, { base: g.base, vat: g.amount }])), rcBase: 0, nonEuBase: 0 }, share)
  return out
}

// Ist-Besteuerung: turnover counts when money moves.
//  - Money received on an invoice counts in the period it arrived, split at the rates of what was
//    still to be paid for: the invoice minus the credit notes applied to it so far.
//  - A credit note applied to its invoice moves no money. Money received before it was split at
//    the old rates, so it is re-split at the corrected ones in the period the credit was applied
//    (a credited 10 % line stops counting as 10 % turnover; nothing moves when nothing was paid).
//  - Money paid back on a credit note (kind 'refund') is deducted at its rates when it was paid.
// Skonto and write-offs never reach this function: they close a balance without turnover, so
// partial payments count proportionally across the rates.
export function istTurnover(input: {
  start: string
  end: string
  invoices: InvoiceHistory[]
  refunded: { amount: number; creditNote: TotalsDoc }[]
}): VatBuckets {
  const out = empty()
  const inPeriod = (date: string) => date >= input.start && date <= input.end

  for (const h of input.invoices) {
    const total = docTotals(h.invoice).total
    if (!total) continue
    const remaining = split(h.invoice, total)
    let open = total
    let received = 0
    const unit = () => {
      const rates = empty()
      // Credited in full (only an overpayment pays after that): the invoice's own split.
      addTo(rates, open > 0.005 ? remaining : split(h.invoice, total), 1 / (open > 0.005 ? open : total))
      return rates
    }
    const events = [
      ...h.credits.map(c => ({ ...c, credit: true })),
      ...h.payments.map(p => ({ ...p, credit: false, creditNote: null })),
    ].sort((a, b) => a.date.localeCompare(b.date) || Number(b.credit) - Number(a.credit))

    for (const e of events) {
      if (!e.credit || !e.creditNote) {
        if (inPeriod(e.date)) addTo(out, unit(), e.amount)
        received += e.amount
        continue
      }
      const before = unit()
      addTo(remaining, split(e.creditNote, e.amount), -1)
      open -= e.amount
      if (received && inPeriod(e.date)) {
        addTo(out, unit(), received)
        addTo(out, before, -received)
      }
    }
  }

  for (const r of input.refunded) addTo(out, split(r.creditNote, r.amount), -1)
  return out
}
