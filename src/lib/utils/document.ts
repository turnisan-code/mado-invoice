import { DocumentItem, DocumentTotals, VatRate } from '@/types'

export function calcTotals(items: DocumentItem[], payments: { amount: number }[] = []): DocumentTotals {
  const vatMap = new Map<VatRate, { base: number; amount: number }>()

  let subtotal = 0
  for (const item of items) {
    const line = item.quantity * item.unit_price
    subtotal += line
    const vatAmt = line * (item.vat_rate / 100)
    const existing = vatMap.get(item.vat_rate) ?? { base: 0, amount: 0 }
    vatMap.set(item.vat_rate, { base: existing.base + line, amount: existing.amount + vatAmt })
  }

  const vat_groups = Array.from(vatMap.entries())
    .map(([rate, v]) => ({ rate, ...v }))
    .sort((a, b) => b.rate - a.rate)

  const total_vat = vat_groups.reduce((s, g) => s + g.amount, 0)
  const total = subtotal + total_vat
  const total_paid = payments.reduce((s, p) => s + p.amount, 0)

  return {
    subtotal,
    vat_groups,
    total_vat,
    total,
    total_paid,
    balance_due: total - total_paid,
  }
}

export function formatMoney(amount: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency }).format(amount)
}

export function formatDate(date: string, lang: 'de' | 'en' = 'de'): string {
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(new Date(date))
}

export function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export function today(): string {
  return new Date().toISOString().split('T')[0]
}
