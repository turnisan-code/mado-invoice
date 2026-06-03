import { DocumentTotals, VatRate } from '@/types'

type CalcItem = {
  line_type?: string | null
  quantity: number | null
  unit_price: number | null
  vat_rate: number | null
  discount_type?: string | null
  discount_value?: number | null
}

export function calcTotals(
  items: CalcItem[],
  payments: { amount: number }[] = [],
  discount?: { type: 'percent' | 'fixed'; value: number } | null
): DocumentTotals {
  const vatMap = new Map<VatRate, { base: number; amount: number }>()
  let subtotal = 0

  // Process items in sections bounded by 'subtotal' lines.
  // Each section's items are scaled by the section's own discount before
  // being added to the global totals.
  let sectionStart = 0

  function flushSection(end: number, sectionDiscount?: { type: string; value: number } | null) {
    const sectionItems = items.slice(sectionStart, end).filter(
      i => (i.line_type ?? 'item') === 'item' && i.quantity != null && i.unit_price != null && i.vat_rate != null
    )
    if (!sectionItems.length) return

    const sectionSum = sectionItems.reduce((s, i) => s + i.quantity! * i.unit_price!, 0)
    let scale = 1
    if (sectionDiscount && sectionDiscount.value > 0 && sectionSum > 0) {
      const discAmt = sectionDiscount.type === 'percent'
        ? sectionSum * (sectionDiscount.value / 100)
        : Math.min(sectionDiscount.value, sectionSum)
      scale = (sectionSum - discAmt) / sectionSum
    }

    for (const item of sectionItems) {
      const base = item.quantity! * item.unit_price! * scale
      const rate = item.vat_rate as VatRate
      subtotal += base
      const vatAmt = base * (rate / 100)
      const ex = vatMap.get(rate) ?? { base: 0, amount: 0 }
      vatMap.set(rate, { base: ex.base + base, amount: ex.amount + vatAmt })
    }
  }

  for (let i = 0; i < items.length; i++) {
    if ((items[i].line_type ?? 'item') === 'subtotal') {
      const sd = items[i].discount_type && items[i].discount_value
        ? { type: items[i].discount_type!, value: items[i].discount_value! }
        : null
      flushSection(i, sd)
      sectionStart = i + 1
    }
  }
  flushSection(items.length, null) // remaining items after last subtotal

  let vat_groups = Array.from(vatMap.entries())
    .map(([rate, v]) => ({ rate, ...v }))
    .sort((a, b) => b.rate - a.rate)

  let discount_amount = 0
  if (discount && discount.value > 0 && subtotal > 0) {
    discount_amount = discount.type === 'percent'
      ? subtotal * (discount.value / 100)
      : Math.min(discount.value, subtotal)
    const scale = (subtotal - discount_amount) / subtotal
    vat_groups = vat_groups.map(g => ({ rate: g.rate, base: g.base * scale, amount: g.amount * scale }))
  }

  const total_vat = vat_groups.reduce((s, g) => s + g.amount, 0)
  const total = subtotal - discount_amount + total_vat
  const total_paid = payments.reduce((s, p) => s + p.amount, 0)

  return { subtotal, discount_amount, vat_groups, total_vat, total, total_paid, balance_due: total - total_paid }
}

export function formatMoney(amount: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency }).format(amount)
}

export function formatDate(date: string, lang: 'de' | 'en' = 'de'): string {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return date
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(d)
}

export function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export function today(): string {
  return new Date().toISOString().split('T')[0]
}
