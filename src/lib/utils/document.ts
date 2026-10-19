import { DocumentTotals, Settings, VatRate } from '@/types'

export const roundCents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

type CalcItem = {
  line_type?: string | null
  sort_order?: number | null
  quantity: number | null
  unit_price: number | null
  vat_rate: number | null
  discount_type?: string | null
  discount_value?: number | null
}

// PostgREST returns embedded rows in storage order, which drifts from sort_order once
// items are rewritten; section math and rendering depend on the real order.
export function orderItems<T>(items: T[]): T[] {
  const pos = (i: T) => (i as { sort_order?: number | null }).sort_order ?? 0
  return [...items].sort((a, b) => pos(a) - pos(b))
}

export function calcTotals(
  rawItems: CalcItem[],
  payments: { amount: number }[] = [],
  discount?: { type: 'percent' | 'fixed'; value: number } | null,
  taxTreatment?: string | null
): DocumentTotals {
  const items = orderItems(rawItems)
  // Reverse charge / non-EU: lines keep their vat_rate, but no VAT is charged
  const vatApplies = !taxTreatment || taxTreatment === 'at_vat'
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
        ? sectionSum * (Math.min(sectionDiscount.value, 100) / 100)
        : Math.min(sectionDiscount.value, sectionSum)
      scale = (sectionSum - discAmt) / sectionSum
    }

    for (const item of sectionItems) {
      const base = item.quantity! * item.unit_price! * scale
      const rate: VatRate = vatApplies ? (item.vat_rate as VatRate) : 0
      subtotal += base
      const vatAmt = base * (rate / 100)
      const ex = vatMap.get(rate) ?? { base: 0, amount: 0 }
      vatMap.set(rate, { base: ex.base + base, amount: ex.amount + vatAmt })
    }
  }

  for (let i = 0; i < items.length; i++) {
    if ((items[i].line_type ?? 'item') === 'subtotal') {
      const sd = items[i].discount_type != null && items[i].discount_value != null
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
    discount_amount = roundCents(discount.type === 'percent'
      ? subtotal * (Math.min(discount.value, 100) / 100)
      : Math.min(discount.value, subtotal))
    const scale = (subtotal - discount_amount) / subtotal
    vat_groups = vat_groups.map(g => ({ rate: g.rate, base: g.base * scale, amount: g.amount * scale }))
  }

  // Round once, at the end, with VAT per rate derived from the rounded base, so the
  // printed rows always add up to the cent (Netto − Rabatt + Σ USt = Gesamt).
  vat_groups = vat_groups.map(g => {
    const base = roundCents(g.base)
    return { rate: g.rate, base, amount: roundCents(base * (g.rate / 100)) }
  })
  const net = roundCents(subtotal)
  // Per-rate bases are rounded individually; push any cent of drift into the largest group so
  // the printed "davon Netto" rows sum exactly to Netto − Rabatt.
  const baseDrift = roundCents(net - discount_amount - vat_groups.reduce((s, g) => s + g.base, 0))
  if (baseDrift !== 0 && vat_groups.length) {
    const largest = vat_groups.reduce((a, b) => (b.base > a.base ? b : a))
    largest.base = roundCents(largest.base + baseDrift)
    largest.amount = roundCents(largest.base * (largest.rate / 100))
  }
  const total_vat = roundCents(vat_groups.reduce((s, g) => s + g.amount, 0))
  const total = roundCents(net - discount_amount + total_vat)
  const total_paid = roundCents(payments.reduce((s, p) => s + p.amount, 0))

  return { subtotal: net, discount_amount, vat_groups, total_vat, total, total_paid, balance_due: roundCents(total - total_paid) }
}

type TaxNoteSettings = Pick<Settings, 'tax_note_reverse_charge_de' | 'tax_note_reverse_charge_en' | 'tax_note_non_eu_de' | 'tax_note_non_eu_en'>

export function getTaxNote(taxTreatment: string, lang: 'de' | 'en', settings?: TaxNoteSettings | null): string | null {
  if (taxTreatment === 'eu_reverse_charge') {
    return lang === 'de'
      ? (settings?.tax_note_reverse_charge_de || 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)')
      : (settings?.tax_note_reverse_charge_en || 'Reverse charge — VAT to be accounted for by the recipient')
  }
  if (taxTreatment === 'non_eu') {
    return lang === 'de'
      ? (settings?.tax_note_non_eu_de || 'Nicht steuerbar (Leistungsort außerhalb der EU)')
      : (settings?.tax_note_non_eu_en || 'Tax liability shifts to the recipient of the services.')
  }
  return null
}

type SectionItem = { line_type?: string | null; quantity: number | null; unit_price: number | null }

export function calcSectionSubtotal(items: SectionItem[], upToIdx: number): number {
  let sum = 0
  for (let i = upToIdx - 1; i >= 0; i--) {
    if ((items[i].line_type ?? 'item') === 'subtotal') break
    if ((items[i].line_type ?? 'item') === 'item' && items[i].quantity != null && items[i].unit_price != null) {
      sum += items[i].quantity! * items[i].unit_price!
    }
  }
  return sum
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

// Local calendar dates: toISOString() would yield the UTC date, which is "yesterday"
// in Vienna between midnight and 02:00 and shifts across DST changes.
function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = (date || today()).split('-').map(Number)
  return toDateString(new Date(y, m - 1, d + days))
}

// The owner works in Vienna and the servers run in UTC, so "today" is always the Vienna date.
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
