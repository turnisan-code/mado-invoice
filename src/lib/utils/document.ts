import type { DocumentTotals, Settings, VatRate } from '@/types'
import { roundCents } from './number'

export { roundCents } from './number'

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

type Amounts = {
  quantity: number | null
  unit_price: number | null
  discount_type?: string | null
  discount_value?: number | null
}
type Discount = { type: string; value: number | null } | null | undefined

// An item line before and after its own discount (percent 0–100 or a fixed amount up to the
// line's gross), each rounded to the cent as printed.
export function lineSummary(item: Amounts) {
  const gross = roundCents((item.quantity ?? 0) * (item.unit_price ?? 0))
  const discount = discountAmount(gross, item.discount_type != null ? { type: item.discount_type, value: item.discount_value ?? null } : null)
  return {
    gross,
    discount,
    net: roundCents(gross - discount),
    percent: item.discount_type === 'percent' ? clampPercent(item.discount_value) : null,
  }
}

// The amount a line prints and every view sums (totals, VAT split, reports, Bookamat):
// quantity × unit price less the line's own discount, rounded to the cent.
export function lineAmount(item: Amounts): number {
  return lineSummary(item).net
}

// Why a line discount cannot be issued: a negative value, more than 100 %, or a fixed amount
// above the line's gross. calcTotals caps such values; issuing refuses them (issue-checks.ts).
export function lineDiscountOutOfRange(item: Amounts): boolean {
  if (item.discount_type == null || item.discount_value == null) return false
  const v = item.discount_value
  if (!Number.isFinite(v) || v < 0) return true
  if (item.discount_type === 'percent') return v > 100
  return v > 0 && v > Math.max(0, roundCents((item.quantity ?? 0) * (item.unit_price ?? 0)))
}

// Percent is capped at 100 and a fixed amount at its base, so a typo can never make a section
// or a document negative. Nothing is taken off a base that is zero or negative.
export function discountAmount(base: number, discount: Discount): number {
  if (!discount || !discount.value || discount.value <= 0 || base <= 0) return 0
  return roundCents(discount.type === 'percent'
    ? base * (Math.min(discount.value, 100) / 100)
    : Math.min(discount.value, base))
}

// The percentage a discount label may show: the one calcTotals actually applied.
export function clampPercent(value: number | null | undefined): number {
  return Math.min(100, Math.max(0, value ?? 0))
}

// Dunning fees and interest paid on top of an invoice (kind 'fee') are money received, but never
// part of what the invoice asks for: they neither pay it off nor overpay it.
export function settlesBalance(payment: { kind?: string | null }): boolean {
  return payment.kind !== 'fee'
}

export function calcTotals(
  rawItems: CalcItem[],
  payments: { amount: number; kind?: string | null }[] = [],
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

  function flushSection(end: number, sectionDiscount: Discount) {
    const sectionItems = items.slice(sectionStart, end).filter(
      i => (i.line_type ?? 'item') === 'item' && i.quantity != null && i.unit_price != null && i.vat_rate != null
    )
    if (!sectionItems.length) return

    // Lines are summed as printed (rounded to the cent), so a section's gross, discount and net
    // on the PDF add up and Netto is the sum of the section nets.
    const sectionSum = sectionItems.reduce((s, i) => s + lineAmount(i), 0)
    const discAmt = discountAmount(sectionSum, sectionDiscount)
    const scale = discAmt > 0 ? (sectionSum - discAmt) / sectionSum : 1

    for (const item of sectionItems) {
      const base = lineAmount(item) * scale
      const rate: VatRate = vatApplies ? (item.vat_rate as VatRate) : 0
      subtotal += base
      const vatAmt = base * (rate / 100)
      const ex = vatMap.get(rate) ?? { base: 0, amount: 0 }
      vatMap.set(rate, { base: ex.base + base, amount: ex.amount + vatAmt })
    }
  }

  for (let i = 0; i < items.length; i++) {
    if ((items[i].line_type ?? 'item') === 'subtotal') {
      const { discount_type, discount_value } = items[i]
      flushSection(i, discount_type != null ? { type: discount_type, value: discount_value ?? null } : null)
      sectionStart = i + 1
    }
  }
  flushSection(items.length, null) // remaining items after last subtotal

  let vat_groups = Array.from(vatMap.entries())
    .map(([rate, v]) => ({ rate, ...v }))
    .sort((a, b) => b.rate - a.rate)

  const net = roundCents(subtotal)
  const discount_amount = discountAmount(net, discount)
  if (discount_amount > 0) {
    const scale = (net - discount_amount) / net
    vat_groups = vat_groups.map(g => ({ rate: g.rate, base: g.base * scale, amount: g.amount * scale }))
  }

  // Round once, at the end, with VAT per rate derived from the rounded base, so the
  // printed rows always add up to the cent (Netto − Rabatt + Σ USt = Gesamt).
  vat_groups = vat_groups.map(g => {
    const base = roundCents(g.base)
    return { rate: g.rate, base, amount: roundCents(base * (g.rate / 100)) }
  })
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
  const total_paid = roundCents(payments.filter(settlesBalance).reduce((s, p) => s + p.amount, 0))

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
      : (settings?.tax_note_non_eu_en || 'Not subject to Austrian VAT (place of supply outside the EU)')
  }
  return null
}

type SectionItem = Amounts & { line_type?: string | null; discount_type?: string | null; discount_value?: number | null }

// Gross of the section closed by the subtotal line at `upToIdx`, lines rounded as printed.
export function calcSectionSubtotal(items: SectionItem[], upToIdx: number): number {
  let sum = 0
  for (let i = upToIdx - 1; i >= 0; i--) {
    if ((items[i].line_type ?? 'item') === 'subtotal') break
    if ((items[i].line_type ?? 'item') === 'item' && items[i].quantity != null && items[i].unit_price != null) {
      sum += lineAmount(items[i])
    }
  }
  return roundCents(sum)
}

// The subtotal block of the subtotal line at `idx`, with the same clamped discount calcTotals applies.
export function sectionSummary(items: SectionItem[], idx: number) {
  const gross = calcSectionSubtotal(items, idx)
  const { discount_type, discount_value } = items[idx] ?? {}
  const discount = discountAmount(gross, discount_type != null ? { type: discount_type, value: discount_value ?? null } : null)
  return {
    gross,
    discount,
    net: roundCents(gross - discount),
    percent: discount_type === 'percent' ? clampPercent(discount_value) : null,
  }
}

// Skonto is taken off the gross total (Austrian practice); 0 when no Skonto is agreed.
export function skontoAmount(total: number, percent: number | null | undefined): number {
  if (!percent || percent <= 0) return 0
  return roundCents(total * (Math.min(percent, 100) / 100))
}

export function skontoDeadline(date: string, days: number | null | undefined): string {
  return addDays(date, Math.max(0, days ?? 0))
}

type PaymentTermsDoc = {
  type: string
  date: string
  due_date: string | null
  skonto_percent?: number | null
  skonto_days?: number | null
  currency?: string | null
}

// Printed under the totals of an invoice:
// "Zahlbar bis <due>. Bei Zahlung bis <date> <x> % Skonto (<amount>)."
export function paymentTermsSentence(doc: PaymentTermsDoc, total: number, lang: 'de' | 'en'): string | null {
  if (doc.type !== 'invoice') return null
  const parts: string[] = []
  if (doc.due_date) {
    const due = formatDate(doc.due_date, lang)
    parts.push(lang === 'de' ? `Zahlbar bis ${due}.` : `Payable by ${due}.`)
  }
  const amount = skontoAmount(total, doc.skonto_percent)
  if (amount > 0 && doc.skonto_days != null) {
    const deadline = formatDate(skontoDeadline(doc.date, doc.skonto_days), lang)
    const pct = new Intl.NumberFormat(lang === 'de' ? 'de-AT' : 'en-GB', { maximumFractionDigits: 2 }).format(doc.skonto_percent!)
    const money = formatMoney(amount, doc.currency ?? 'EUR', lang)
    parts.push(lang === 'de'
      ? `Bei Zahlung bis ${deadline} ${pct} % Skonto (${money}).`
      : `${pct} % early payment discount (${money}) if paid by ${deadline}.`)
  }
  return parts.length ? parts.join(' ') : null
}

// The app's own views print '€ 1.234,56' whatever the UI language; what a client receives passes
// the document's language: German '€ 1.234,56', English '€1,234.56' (en-GB, as its dates).
export function formatMoney(amount: number, currency = 'EUR', lang: 'de' | 'en' = 'de'): string {
  return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-AT', { style: 'currency', currency }).format(amount)
}

export function formatDate(date: string, lang: 'de' | 'en' = 'de'): string {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return date
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {
    timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric'
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

// The owner works in Vienna and the servers run in UTC, so calendar dates are always Vienna dates.
export function viennaDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function today(): string {
  return viennaDate(new Date())
}
