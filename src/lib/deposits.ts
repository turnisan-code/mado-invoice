// Anzahlungs-, Teil- und Schlussrechnung (§ 11 Abs 1 UStG, UStR 2000 Rz 1521–1525).
// An advance invoice asks for money before the service, a partial invoice bills a completed part
// of it. The final invoice bills the whole service and deducts, per VAT rate, what those invoices
// carried: an advance invoice only the money actually received on it (net of refunds, at most what
// it billed), a partial invoice its total (less credit notes applied to it). The deduction is
// stored on the final invoice as 'deduction' lines, one per deducted invoice and rate, so
// calcTotals and everything built on it (Ist report, Bookamat, lists, reminders, e-invoices) see
// the remaining amount without special cases. Browser-safe: the builder uses it with its own client.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TFn } from '@/lib/i18n'
import { documentT, formatPercent } from '@/lib/document-labels'
import { logEvent } from '@/lib/events'
import { calcTotals, formatDate, lineAmount, orderItems, roundCents, settlesBalance } from '@/lib/utils/document'
import type { DocumentTotals, InvoiceKind, IssueProblem, Language, VatRate } from '@/types'

type CalcItem = Parameters<typeof calcTotals>[0][number]
type Discount = { type: 'percent' | 'fixed'; value: number } | null
type DiscountFields = { discount_type?: string | null; discount_value?: number | null }

export type DepositKind = 'advance' | 'partial'

export function isDepositKind(kind: unknown): kind is DepositKind {
  return kind === 'advance' || kind === 'partial'
}

export function isDeductionLine(item: { line_type?: string | null }): boolean {
  return item.line_type === 'deduction'
}

export function discountOf(d: DiscountFields): Discount {
  return (d.discount_type === 'percent' || d.discount_type === 'fixed') && d.discount_value
    ? { type: d.discount_type, value: d.discount_value }
    : null
}

// An issued advance or partial invoice as a final invoice sees it.
export interface DepositInvoice {
  id: string
  number: string | null
  date: string
  status: string
  client_id: string
  invoice_kind: InvoiceKind
  final_invoice_id: string | null
  converted_from_id: string | null
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: CalcItem[] | null
  payments: { amount: number; kind: string | null; credit_note_id?: string | null }[] | null
  // Money paid back on the credit notes applied to it.
  refunded: number
  // The final invoice that deducts it.
  final: { id: string; number: string | null; status: string } | null
}

export function depositTotals(d: Pick<DepositInvoice, 'document_items' | 'tax_treatment'> & DiscountFields): DocumentTotals {
  return calcTotals(d.document_items ?? [], [], discountOf(d), d.tax_treatment)
}

const sumOf = (payments: DepositInvoice['payments'], kind: string) =>
  roundCents((payments ?? []).filter(p => p.kind === kind).reduce((s, p) => s + p.amount, 0))

// What a final invoice deducts for one invoice, gross.
export function deductibleAmount(d: DepositInvoice): number {
  const billed = roundCents(depositTotals(d).total - sumOf(d.payments, 'credit'))
  if (d.invoice_kind === 'partial') return Math.max(0, billed)
  const received = roundCents(sumOf(d.payments, 'payment') - d.refunded)
  return Math.max(0, Math.min(received, billed))
}

// What is still open on an invoice: an advance invoice has to be settled (paid, the rest written
// off, or cancelled) before the final invoice that deducts it is issued.
export function depositOpen(d: DepositInvoice): number {
  const settled = (d.payments ?? []).filter(settlesBalance).reduce((s, p) => s + p.amount, 0)
  return roundCents(depositTotals(d).total - settled)
}

export type RatePart = { rate: VatRate; net: number; vat: number }

// The net whose VAT, rounded as calcTotals rounds it, adds up to `gross`, where one exists.
function netOf(gross: number, rate: number): number {
  const guess = roundCents(gross / (1 + rate / 100))
  for (const step of [0, 0.01, -0.01]) {
    const net = roundCents(guess + step)
    if (roundCents(net + roundCents(net * (rate / 100))) === gross) return net
  }
  return guess
}

// `gross` split over VAT groups in proportion to their gross, to the cent (largest remainder).
// The full amount keeps every group exactly as it was invoiced.
export function splitGross(groups: readonly { rate: VatRate; base: number; amount: number }[], gross: number): RatePart[] {
  const parts = groups.map(g => ({ ...g, gross: roundCents(g.base + g.amount) })).filter(p => p.gross > 0)
  const full = roundCents(parts.reduce((s, p) => s + p.gross, 0))
  if (full <= 0 || gross <= 0) return []
  if (Math.abs(gross - full) < 0.005) return parts.map(p => ({ rate: p.rate, net: p.base, vat: p.amount }))

  const target = Math.round(gross * 100)
  const exact = parts.map(p => (p.gross * 100 * target) / Math.round(full * 100))
  const cents = exact.map(Math.floor)
  const order = exact.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (let left = target - cents.reduce((s, c) => s + c, 0), n = 0; left > 0; left--, n++) cents[order[n % order.length].i]++

  return parts.flatMap((p, i) => {
    const net = netOf(cents[i] / 100, p.rate)
    const vat = roundCents(net * (p.rate / 100))
    return net || vat ? [{ rate: p.rate, net, vat }] : []
  })
}

export interface DeductionPart extends RatePart {
  invoiceId: string
  number: string
  date: string
  kind: DepositKind
}

export function deductionParts(invoices: readonly DepositInvoice[]): DeductionPart[] {
  return invoices.flatMap(d => {
    if (!d.number || !isDepositKind(d.invoice_kind)) return []
    const parts = splitGross(depositTotals(d).vat_groups, deductibleAmount(d))
    return parts.map(p => ({ ...p, invoiceId: d.id, number: d.number!, date: d.date, kind: d.invoice_kind as DepositKind }))
  })
}

// "abzüglich Anzahlungsrechnung AR-2026-001 vom 01.10.2026", in the final invoice's language.
export function deductionLabel(t: TFn, d: { kind: DepositKind; number: string; date: string }, lang: Language): string {
  return t(`deposits.doc.less.${d.kind}`, { number: d.number, date: formatDate(d.date, lang) })
}

export interface DeductionItem {
  line_type: 'deduction'
  description: string
  service_date: null
  service_date_end: null
  quantity: number
  unit: 'flat'
  unit_price: number
  vat_rate: VatRate
  catalogue_item_id: null
  discount_type: null
  discount_value: null
}

export function deductionItems(parts: readonly DeductionPart[], lang: Language): DeductionItem[] {
  const t = documentT(lang)
  return parts.map(p => ({
    line_type: 'deduction',
    description: deductionLabel(t, p, lang),
    service_date: null,
    service_date_end: null,
    quantity: 1,
    unit: 'flat',
    unit_price: -p.net,
    vat_rate: p.rate,
    catalogue_item_id: null,
    discount_type: null,
    discount_value: null,
  }))
}

type LineLike = { line_type?: string | null; description?: string | null; quantity: number | null; unit_price: number | null; vat_rate?: number | null }
const deductionKey = (i: LineLike) => `${(i.description ?? '').trim()}|${i.vat_rate ?? ''}|${lineAmount(i)}`

// Whether the deduction lines among `items` are exactly `expected` (order aside).
export function sameDeductions(items: readonly LineLike[], expected: readonly LineLike[]): boolean {
  const have = items.filter(isDeductionLine).map(deductionKey).sort()
  const want = expected.map(deductionKey).sort()
  return have.length === want.length && have.every((k, i) => k === want[i])
}

// What the final invoice bills for the whole service, then each deducted invoice (Entgelt and
// VAT per rate) as printed on the PDF and the portal; null without deduction lines.
export interface DeductionRow { label: string; parts: { rate: number; net: number; vat: number }[]; gross: number }
export interface DeductionSummary { full: DocumentTotals; rows: DeductionRow[] }

export function deductionSummary(
  items: readonly (CalcItem & { description?: string | null })[],
  discount: Discount,
  taxTreatment: string | null | undefined,
): DeductionSummary | null {
  const ordered = orderItems([...items])
  const lines = ordered.filter(isDeductionLine)
  if (!lines.length) return null
  const vatApplies = !taxTreatment || taxTreatment === 'at_vat'
  const rows: DeductionRow[] = []
  for (const line of lines) {
    if (line.quantity == null || line.unit_price == null) continue
    const net = roundCents(-lineAmount(line))
    const rate = vatApplies ? line.vat_rate ?? 0 : 0
    const vat = roundCents(net * (rate / 100))
    const label = (line.description ?? '').trim()
    let row = rows.find(r => r.label === label)
    if (!row) rows.push(row = { label, parts: [], gross: 0 })
    row.parts.push({ rate, net, vat })
    row.gross = roundCents(row.gross + net + vat)
  }
  return { full: calcTotals(ordered.filter(i => !isDeductionLine(i)), [], discount, taxTreatment), rows }
}

// ─── Issue checks (run by src/lib/utils/issue-checks.ts) ─────────────────────

export interface DepositCheck {
  kind: InvoiceKind
  // Null for a document that is not saved yet (it deducts nothing).
  documentId: string | null
  language: Language
  discount: Discount
  // The client's issued, uncancelled advance and partial invoices (loadClientDeposits).
  invoices: DepositInvoice[]
}

export function depositProblems(input: {
  items: readonly LineLike[]
  taxTreatment: string | null
  deposit: DepositCheck
}): IssueProblem[] {
  const { kind, documentId, language, discount, invoices } = input.deposit
  const problems: IssueProblem[] = []
  const items = input.items.map(i => ({ ...i, vat_rate: i.vat_rate ?? null }))
  const lines = items.filter(isDeductionLine)

  if (isDepositKind(kind) && calcTotals(items.filter(i => !isDeductionLine(i)), [], discount, input.taxTreatment).total <= 0) {
    problems.push({ code: 'depositZero' })
  }

  const linked = kind === 'final' && documentId ? invoices.filter(d => d.final_invoice_id === documentId) : []
  if (!sameDeductions(items, deductionItems(deductionParts(linked), language))) {
    const t = documentT(language)
    const elsewhere = invoices.filter(d =>
      d.number && isDepositKind(d.invoice_kind) && d.final_invoice_id && d.final_invoice_id !== documentId &&
      lines.some(l => (l.description ?? '').trim() === deductionLabel(t, { kind: d.invoice_kind as DepositKind, number: d.number!, date: d.date }, language)))
    for (const d of elsewhere) problems.push({ code: 'advanceSettledElsewhere', number: d.number! })
    if (!elsewhere.length) problems.push({ code: 'deductionsOutdated' })
  }

  for (const d of linked) {
    if (d.invoice_kind === 'advance' && depositOpen(d) > 0.005) problems.push({ code: 'advanceOpen', number: d.number ?? '' })
  }

  if (lines.length) {
    const totals = calcTotals(items, [], discount, input.taxTreatment)
    if (totals.total < 0 || totals.vat_groups.some(g => g.base < 0)) problems.push({ code: 'deductionExceedsTotal' })
  }
  return problems
}

// ─── Advance invoice from a quote ────────────────────────────────────────────

type QuoteForAdvance = DiscountFields & {
  number: string | null
  date: string
  tax_treatment: string | null
  document_items: CalcItem[] | null
}

// One line per VAT rate of the quote, each the share of `gross` that falls on that rate:
// "Anzahlung 30 % laut Angebot AN-2026-012 vom 01.10.2026".
export function advanceItems(quote: QuoteForAdvance, gross: number, percent: number | null, lang: Language) {
  const t = documentT(lang)
  const parts = splitGross(depositTotals(quote).vat_groups, gross)
  const vars = { number: quote.number ?? '', date: formatDate(quote.date, lang) }
  const base = percent != null
    ? t('deposits.doc.advanceLine', { ...vars, share: formatPercent(t, percent, lang) })
    : t('deposits.doc.advanceLinePlain', vars)
  return parts.map((p, i) => ({
    sort_order: i,
    line_type: 'item' as const,
    description: parts.length > 1 ? `${base} – ${t('deposits.doc.atRate', { rate: formatPercent(t, p.rate, lang) })}` : base,
    service_date: null,
    service_date_end: null,
    quantity: 1,
    unit: 'flat' as const,
    unit_price: p.net,
    vat_rate: p.rate,
    catalogue_item_id: null,
    discount_type: null,
    discount_value: null,
  }))
}

// ─── Loading and linking ─────────────────────────────────────────────────────

const DEPOSIT_COLS = 'id, number, date, status, client_id, invoice_kind, final_invoice_id, converted_from_id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind, credit_note_id)'

type DepositRow = Omit<DepositInvoice, 'refunded' | 'final'>

async function withRefundsAndFinals(supabase: SupabaseClient, rows: DepositRow[]): Promise<DepositInvoice[]> {
  const creditNoteIds = [...new Set(rows.flatMap(r => (r.payments ?? []).filter(p => p.kind === 'credit' && p.credit_note_id).map(p => p.credit_note_id!)))]
  const finalIds = [...new Set(rows.map(r => r.final_invoice_id).filter((id): id is string => !!id))]
  const [refunds, finals] = await Promise.all([
    creditNoteIds.length
      ? supabase.from('payments').select('document_id, amount').eq('kind', 'refund').in('document_id', creditNoteIds)
      : Promise.resolve({ data: [], error: null }),
    finalIds.length
      ? supabase.from('documents').select('id, number, status').in('id', finalIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (refunds.error) throw new Error(refunds.error.message)
  if (finals.error) throw new Error(finals.error.message)
  const refundedBy = new Map<string, number>()
  for (const r of (refunds.data ?? []) as { document_id: string; amount: number }[]) {
    refundedBy.set(r.document_id, roundCents((refundedBy.get(r.document_id) ?? 0) + r.amount))
  }
  const finalById = new Map(((finals.data ?? []) as DepositInvoice['final'][]).map(f => [f!.id, f]))
  return rows.map(r => ({
    ...r,
    refunded: roundCents((r.payments ?? []).filter(p => p.kind === 'credit' && p.credit_note_id)
      .reduce((s, p) => s + (refundedBy.get(p.credit_note_id!) ?? 0), 0)),
    final: (r.final_invoice_id && finalById.get(r.final_invoice_id)) || null,
  }))
}

// The client's issued, uncancelled advance and partial invoices: what a final invoice may deduct.
export async function loadClientDeposits(supabase: SupabaseClient, clientId: string): Promise<DepositInvoice[]> {
  const { data, error } = await supabase.from('documents').select(DEPOSIT_COLS)
    .eq('type', 'invoice').eq('client_id', clientId).in('invoice_kind', ['advance', 'partial'])
    .not('number', 'is', null).neq('status', 'cancelled')
    .order('date').order('number')
  if (error) throw new Error(error.message)
  return withRefundsAndFinals(supabase, (data ?? []) as unknown as DepositRow[])
}

// Every advance and partial invoice made from a quote, drafts and cancelled ones included.
export async function loadQuoteDeposits(supabase: SupabaseClient, quoteId: string): Promise<DepositInvoice[]> {
  const { data, error } = await supabase.from('documents').select(DEPOSIT_COLS)
    .eq('type', 'invoice').eq('converted_from_id', quoteId).in('invoice_kind', ['advance', 'partial'])
    .order('created_at')
  if (error) throw new Error(error.message)
  return withRefundsAndFinals(supabase, (data ?? []) as unknown as DepositRow[])
}

type CheckedDoc = DiscountFields & {
  id: string
  type: string
  client_id: string | null
  language: string | null
  invoice_kind?: InvoiceKind | null
  document_items?: { line_type?: string | null }[] | null
}

// The deposit part of the issue checks for a stored document; undefined for anything but an invoice.
export async function loadDepositCheck(supabase: SupabaseClient, doc: CheckedDoc): Promise<DepositCheck | undefined> {
  if (doc.type !== 'invoice') return undefined
  const kind = doc.invoice_kind ?? 'standard'
  const deducts = kind === 'final' || (doc.document_items ?? []).some(isDeductionLine)
  return {
    kind,
    documentId: doc.id,
    language: doc.language === 'en' ? 'en' : 'de',
    discount: discountOf(doc),
    invoices: deducts && doc.client_id ? await loadClientDeposits(supabase, doc.client_id) : [],
  }
}

// Writes a draft final invoice's deduction lines from the invoices it deducts now (after the
// lines it bills). An issued invoice keeps the deduction it was issued with.
export async function writeDeductions(supabase: SupabaseClient, finalId: string): Promise<void> {
  const { data: doc, error } = await supabase.from('documents')
    .select('id, number, client_id, language, invoice_kind, document_items(id, line_type, sort_order, description, quantity, unit_price, vat_rate)')
    .eq('id', finalId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!doc || doc.number) return
  const lang: Language = doc.language === 'en' ? 'en' : 'de'
  const linked = doc.invoice_kind === 'final'
    ? (await loadClientDeposits(supabase, doc.client_id)).filter(d => d.final_invoice_id === finalId)
    : []
  const expected = deductionItems(deductionParts(linked), lang)
  const items = (doc.document_items ?? []) as (LineLike & { id: string; sort_order: number | null })[]
  if (sameDeductions(items, expected)) return

  const { error: delErr } = await supabase.from('document_items').delete().eq('document_id', finalId).eq('line_type', 'deduction')
  if (delErr) throw new Error(delErr.message)
  if (!expected.length) return
  const after = Math.max(-1, ...items.filter(i => !isDeductionLine(i)).map(i => i.sort_order ?? 0)) + 1
  const { error: insErr } = await supabase.from('document_items')
    .insert(expected.map((item, i) => ({ ...item, document_id: finalId, sort_order: after + i })))
  if (insErr) throw new Error(insErr.message)
}

// Links an issued advance or partial invoice to a draft final invoice, which becomes one.
// 'taken' when another final invoice deducts it already.
export async function linkDeposit(supabase: SupabaseClient, finalId: string, invoiceId: string): Promise<'ok' | 'taken'> {
  const { error: kindErr } = await supabase.from('documents').update({ invoice_kind: 'final' })
    .eq('id', finalId).eq('type', 'invoice').is('number', null)
  if (kindErr) throw new Error(kindErr.message)
  const { data, error } = await supabase.from('documents').update({ final_invoice_id: finalId })
    .eq('id', invoiceId).is('final_invoice_id', null).select('id')
  if (error) throw new Error(error.message)
  if (!data?.length) return 'taken'
  await logEvent(supabase, invoiceId, 'deposit_linked', { final_id: finalId })
  return 'ok'
}

export async function unlinkDeposit(supabase: SupabaseClient, finalId: string, invoiceId: string): Promise<void> {
  const { data, error } = await supabase.from('documents').update({ final_invoice_id: null })
    .eq('id', invoiceId).eq('final_invoice_id', finalId).select('id')
  if (error) throw new Error(error.message)
  if (data?.length) await logEvent(supabase, invoiceId, 'deposit_released', { final_id: finalId, reason: 'removed' })
}
