// Anzahlungs-, Teil- und Schlussrechnung (§ 11 Abs 1 UStG, UStR 2000 Rz 1521–1525).
// An advance invoice asks for money before the service, a partial invoice bills a completed part
// of it. The final invoice bills the whole service and deducts, per VAT rate, what those invoices
// carried: an advance invoice only the money actually received on it (net of refunds, at most what
// it billed), a partial invoice its total, both less their credit notes. The deduction is
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
  payments: { amount: number; kind: string | null }[] | null
  // Its issued, uncancelled credit notes: what each takes off and the money paid back on it.
  // A credit note on a paid invoice is refunded, not applied, so the invoice's 'credit' rows
  // alone would miss it.
  credit_notes: { totals: DocumentTotals; refunded: number }[]
  // The final invoice that deducts it.
  final: { id: string; number: string | null; status: string } | null
}

export function depositTotals(d: Pick<DepositInvoice, 'document_items' | 'tax_treatment'> & DiscountFields): DocumentTotals {
  return calcTotals(d.document_items ?? [], [], discountOf(d), d.tax_treatment)
}

const sumOf = (payments: DepositInvoice['payments'], kind: string) =>
  roundCents((payments ?? []).filter(p => p.kind === kind).reduce((s, p) => s + p.amount, 0))

type Credited = Pick<DepositInvoice, 'document_items' | 'tax_treatment' | 'credit_notes'> & DiscountFields

// What an invoice bills once its credit notes are taken off, in total and per VAT rate.
export function billedAmount(d: Credited): number {
  return roundCents(depositTotals(d).total - d.credit_notes.reduce((s, c) => s + c.totals.total, 0))
}

export function billedGroups(d: Credited): RateGroup[] {
  const groups = depositTotals(d).vat_groups.map(g => ({ ...g }))
  for (const g of d.credit_notes.flatMap(c => c.totals.vat_groups)) {
    let x = groups.find(y => y.rate === g.rate)
    if (!x) groups.push(x = { rate: g.rate, base: 0, amount: 0 })
    x.base = roundCents(x.base - g.base)
    x.amount = roundCents(x.amount - g.amount)
  }
  return groups
}

// What a final invoice deducts for one invoice, gross.
export function deductibleAmount(d: DepositInvoice): number {
  const billed = billedAmount(d)
  if (d.invoice_kind === 'partial') return Math.max(0, billed)
  const refunded = d.credit_notes.reduce((s, c) => s + c.refunded, 0)
  const received = roundCents(sumOf(d.payments, 'payment') - refunded)
  return Math.max(0, Math.min(received, billed))
}

// What is still open on an invoice: an advance invoice has to be settled (paid, the rest written
// off, or cancelled) before the final invoice that deducts it is issued.
export function depositOpen(d: DepositInvoice): number {
  const settled = (d.payments ?? []).filter(settlesBalance).reduce((s, p) => s + p.amount, 0)
  return roundCents(depositTotals(d).total - settled)
}

export type RatePart = { rate: VatRate; net: number; vat: number }
type RateGroup = { rate: VatRate; base: number; amount: number }

const grossOf = (net: number, rate: number) => roundCents(net + roundCents(net * (rate / 100)))

// The net whose VAT, rounded as calcTotals rounds it, adds up to `gross`. Not every gross has
// one (at 20 % one in six cents); then the net just below it, so nothing beyond `gross` is taken.
function netOf(gross: number, rate: number): number {
  const guess = roundCents(gross / (1 + rate / 100))
  const nets = [-0.02, -0.01, 0, 0.01, 0.02].map(step => roundCents(guess + step))
  return nets.find(net => grossOf(net, rate) === gross) ?? nets.filter(net => grossOf(net, rate) < gross).pop() ?? guess
}

// `gross` split over VAT groups in proportion to their gross, to the cent (largest remainder).
// The full amount keeps every group exactly as it was invoiced.
export function splitGross(groups: readonly RateGroup[], gross: number): RatePart[] {
  const parts = groups.map(g => ({ ...g, gross: roundCents(g.base + g.amount) })).filter(p => p.gross > 0)
  const full = roundCents(parts.reduce((s, p) => s + p.gross, 0))
  if (full <= 0 || gross <= 0) return []
  if (Math.abs(gross - full) < 0.005) return parts.map(p => ({ rate: p.rate, net: p.base, vat: p.amount }))

  const target = Math.round(gross * 100)
  const exact = parts.map(p => (p.gross * 100 * target) / Math.round(full * 100))
  const cents = exact.map(Math.floor)
  const order = exact.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (let left = target - cents.reduce((s, c) => s + c, 0), n = 0; left > 0; left--, n++) cents[order[n % order.length].i]++

  const split = parts.map((p, i) => {
    const net = netOf(cents[i] / 100, p.rate)
    return { rate: p.rate, net, vat: roundCents(net * (p.rate / 100)) }
  })
  // A share no net reaches is taken a cent lower, which leaves the sum short. The rates then trade
  // cents (the fewest that work) until the sum is exact; a single rate stays a cent short.
  const short = target - Math.round(split.reduce((s, p) => s + p.net + p.vat, 0) * 100)
  const shifted = (p: RatePart, cent: number) => {
    const want = roundCents(p.net + p.vat + cent / 100)
    const net = netOf(want, p.rate)
    return want > 0 && grossOf(net, p.rate) === want ? net : null
  }
  const cost = (ds: number[]) => ds.reduce((s, d) => s + Math.abs(d), 0)
  const trade = (i: number, left: number): number[] | null => {
    if (i === split.length) return left ? null : []
    let best: number[] | null = null
    for (const d of [0, 1, -1, 2, -2]) {
      const rest = !d || shifted(split[i], d) != null ? trade(i + 1, left - d) : null
      if (rest && (!best || cost([d, ...rest]) < cost(best))) best = [d, ...rest]
    }
    return best
  }
  const traded = short ? trade(0, short) : null
  traded?.forEach((d, i) => {
    if (!d) return
    const net = shifted(split[i], d)!
    split[i] = { rate: split[i].rate, net, vat: roundCents(net * (split[i].rate / 100)) }
  })
  return split.filter(p => p.net || p.vat)
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
    const parts = splitGross(billedGroups(d), deductibleAmount(d))
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
  // The other invoices made from the same quote (loadQuoteInvoices).
  fromQuote: QuoteInvoice[]
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

  // A quote is billed once: its final (or plain) invoice waits for the advance and partial
  // invoices made from it and deducts every issued one, and none follows its issued invoice.
  const fromQuote = input.deposit.fromQuote
  if (isDepositKind(kind)) {
    const invoiced = fromQuote.find(s => !isDepositKind(s.invoice_kind) && s.number)
    if (invoiced) problems.push({ code: 'quoteInvoiced', number: invoiced.number! })
  } else {
    if (fromQuote.some(s => isDepositKind(s.invoice_kind) && !s.number)) problems.push({ code: 'advanceDraftPending' })
    for (const s of fromQuote) {
      if (isDepositKind(s.invoice_kind) && s.number && !s.final_invoice_id) problems.push({ code: 'advanceNotDeducted', number: s.number })
    }
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

// The database guards (20261101_deposits.sql) in the UI language; anything else as it came.
export function depositErrorMessage(err: unknown, t: TFn): string {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : null
  if (code === 'MI019') return t('deposits.errors.useFinal')
  if (code === 'MI020') return t('deposits.errors.deducted')
  if (code === 'MI021') return t('deposits.errors.invalidLink')
  return err instanceof Error ? err.message : String(err)
}

const failure = (error: { message: string; code?: string }) => Object.assign(new Error(error.message), { code: error.code })

const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
const DEPOSIT_COLS = `id, number, date, status, client_id, invoice_kind, final_invoice_id, converted_from_id, tax_treatment, discount_type, discount_value, ${ITEM_COLS}, payments(amount, kind)`

type DepositRow = Omit<DepositInvoice, 'credit_notes' | 'final'>
type CreditNoteRow = DiscountFields & { converted_from_id: string; tax_treatment: string | null; document_items: CalcItem[] | null; payments: DepositInvoice['payments'] }

async function withCreditsAndFinals(supabase: SupabaseClient, rows: DepositRow[]): Promise<DepositInvoice[]> {
  const ids = rows.map(r => r.id)
  const finalIds = [...new Set(rows.map(r => r.final_invoice_id).filter((id): id is string => !!id))]
  const [credits, finals] = await Promise.all([
    ids.length
      ? supabase.from('documents').select(`converted_from_id, tax_treatment, discount_type, discount_value, ${ITEM_COLS}, payments(amount, kind)`)
          .eq('type', 'credit_note').in('converted_from_id', ids).not('number', 'is', null).neq('status', 'cancelled')
      : Promise.resolve({ data: [], error: null }),
    finalIds.length
      ? supabase.from('documents').select('id, number, status').in('id', finalIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (credits.error) throw new Error(credits.error.message)
  if (finals.error) throw new Error(finals.error.message)
  const creditsOf = new Map<string, DepositInvoice['credit_notes']>()
  for (const c of (credits.data ?? []) as unknown as CreditNoteRow[]) {
    creditsOf.set(c.converted_from_id, [...creditsOf.get(c.converted_from_id) ?? [], { totals: depositTotals(c), refunded: sumOf(c.payments, 'refund') }])
  }
  const finalById = new Map(((finals.data ?? []) as DepositInvoice['final'][]).map(f => [f!.id, f]))
  return rows.map(r => ({
    ...r,
    credit_notes: creditsOf.get(r.id) ?? [],
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
  return withCreditsAndFinals(supabase, (data ?? []) as unknown as DepositRow[])
}

// Every advance and partial invoice made from a quote, drafts and cancelled ones included.
export async function loadQuoteDeposits(supabase: SupabaseClient, quoteId: string): Promise<DepositInvoice[]> {
  const { data, error } = await supabase.from('documents').select(DEPOSIT_COLS)
    .eq('type', 'invoice').eq('converted_from_id', quoteId).in('invoice_kind', ['advance', 'partial'])
    .order('created_at')
  if (error) throw new Error(error.message)
  return withCreditsAndFinals(supabase, (data ?? []) as unknown as DepositRow[])
}

export interface QuoteInvoice { id: string; number: string | null; invoice_kind: InvoiceKind; final_invoice_id: string | null }

// The other uncancelled invoices made from the quote `sourceId`, drafts included; none when the
// source is no quote (a recurring invoice points at its template the same way).
export async function loadQuoteInvoices(supabase: SupabaseClient, sourceId: string | null | undefined, selfId: string): Promise<QuoteInvoice[]> {
  if (!sourceId) return []
  const [source, siblings] = await Promise.all([
    supabase.from('documents').select('type').eq('id', sourceId).maybeSingle(),
    supabase.from('documents').select('id, number, invoice_kind, final_invoice_id')
      .eq('type', 'invoice').eq('converted_from_id', sourceId).neq('status', 'cancelled').neq('id', selfId),
  ])
  if (source.error) throw new Error(source.error.message)
  if (siblings.error) throw new Error(siblings.error.message)
  return source.data?.type === 'quote' ? (siblings.data ?? []) as QuoteInvoice[] : []
}

type CheckedDoc = DiscountFields & {
  id: string
  type: string
  client_id: string | null
  language: string | null
  invoice_kind?: InvoiceKind | null
  converted_from_id?: string | null
  document_items?: { line_type?: string | null }[] | null
}

// The deposit part of the issue checks for a stored document; undefined for anything but an invoice.
export async function loadDepositCheck(supabase: SupabaseClient, doc: CheckedDoc): Promise<DepositCheck | undefined> {
  if (doc.type !== 'invoice') return undefined
  const kind = doc.invoice_kind ?? 'standard'
  const deducts = kind === 'final' || (doc.document_items ?? []).some(isDeductionLine)
  const [invoices, fromQuote] = await Promise.all([
    deducts && doc.client_id ? loadClientDeposits(supabase, doc.client_id) : [],
    loadQuoteInvoices(supabase, doc.converted_from_id, doc.id),
  ])
  return { kind, documentId: doc.id, language: doc.language === 'en' ? 'en' : 'de', discount: discountOf(doc), invoices, fromQuote }
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

// What a final invoice deducts for an advance invoice depends on the money received on it and
// paid back on its credit notes; once that final invoice is issued (and not cancelled) the money
// stays as it is (payments_deposit_guard, MI022). Partial invoices are deducted in full whatever
// was paid, so their payments stay free.
export function moneyLocked(
  invoice: { invoice_kind?: string | null; final_invoice_id?: string | null },
  final: { number: string | null; status: string } | null,
): boolean {
  return invoice.invoice_kind === 'advance' && !!invoice.final_invoice_id && !!final?.number && final.status !== 'cancelled'
}

// The final invoice that fixes the money received on this invoice, or null.
export async function loadMoneyLock(supabase: SupabaseClient, invoiceId: string): Promise<{ id: string; number: string } | null> {
  const { data, error } = await supabase.from('documents').select('invoice_kind, final_invoice_id').eq('id', invoiceId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.final_invoice_id) return null
  const { data: final, error: finalErr } = await supabase.from('documents').select('id, number, status').eq('id', data.final_invoice_id).maybeSingle()
  if (finalErr) throw new Error(finalErr.message)
  return final && moneyLocked(data, final) ? { id: final.id as string, number: final.number as string } : null
}

// Links an issued advance or partial invoice to a draft final invoice, which becomes one.
// 'taken' when another final invoice deducts it already.
export async function linkDeposit(supabase: SupabaseClient, finalId: string, invoiceId: string): Promise<'ok' | 'taken'> {
  const { error: kindErr } = await supabase.from('documents').update({ invoice_kind: 'final' })
    .eq('id', finalId).eq('type', 'invoice').is('number', null)
  if (kindErr) throw failure(kindErr)
  const { data, error } = await supabase.from('documents').update({ final_invoice_id: finalId })
    .eq('id', invoiceId).is('final_invoice_id', null).select('id, number')
  if (error) throw failure(error)
  if (!data?.length) return 'taken'
  await Promise.all([
    logEvent(supabase, invoiceId, 'deposit_linked', { final_id: finalId }),
    logEvent(supabase, finalId, 'deposit_linked', { invoice_id: invoiceId, invoice_number: data[0].number }),
  ])
  return 'ok'
}

export async function unlinkDeposit(supabase: SupabaseClient, finalId: string, invoiceId: string): Promise<void> {
  const { data, error } = await supabase.from('documents').update({ final_invoice_id: null })
    .eq('id', invoiceId).eq('final_invoice_id', finalId).select('id, number')
  if (error) throw failure(error)
  if (!data?.length) return
  await Promise.all([
    logEvent(supabase, invoiceId, 'deposit_released', { final_id: finalId, reason: 'removed' }),
    logEvent(supabase, finalId, 'deposit_released', { invoice_id: invoiceId, invoice_number: data[0].number, reason: 'removed' }),
  ])
}
