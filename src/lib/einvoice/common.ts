// The format-neutral content of a structured e-invoice, derived from an issued invoice or credit
// note exactly as the PDF prints it: line nets from lineAmount with each line's own discount as a
// line allowance, totals and VAT per rate from calcTotals, section and document discounts as
// allowances per VAT category. Pure (no I/O), so ebinterface.ts and ubl.ts only lay this out and
// node can check it directly.
import type { TFn } from '@/lib/i18n'
import { isDeductionLine, type DepositKind } from '@/lib/deposits'
import { docTitle, documentKind, documentLanguage } from '@/lib/document-labels'
import { clientDisplayName } from '@/lib/utils/clients'
import { countryName, toCountryCode } from '@/lib/utils/country'
import {
  calcTotals, clampPercent, discountAmount, formatDate, getTaxNote, lineAmount, lineSummary, orderItems,
  paymentTermsSentence, roundCents, skontoAmount, skontoDeadline, viennaDate,
} from '@/lib/utils/document'
import type { DocReference } from '@/lib/utils/document-reference'
import { epcBeneficiary } from '@/lib/utils/epc-qr'
import { isValidBic, normalizeBic, normalizeIban, normalizeVatId } from '@/lib/utils/validation'
import type { Client, Document, DocumentItem, InvoiceKind, Language, Payment, Settings, Unit } from '@/types'
import { decimal } from './xml'

export type EInvoiceErrorCode =
  | 'not_issued' | 'unsupported_type' | 'currency' | 'client_country'
  | 'buyer_reference' | 'buyer_endpoint' | 'seller_endpoint' | 'line_amount'

// A document that cannot become this e-invoice; the UI words the code (einvoice.errors.*).
// 'line_amount' guards the line maths: quantity × price less the line discount must give the printed net.
export class EInvoiceError extends Error {
  constructor(readonly code: EInvoiceErrorCode, message: string) {
    super(message)
    this.name = 'EInvoiceError'
  }
}

// EN 16931 VAT categories: S standard (any positive rate), Z zero rated, AE reverse charge,
// O outside the scope of VAT (services to clients outside the EU).
export type TaxCategory = 'S' | 'Z' | 'AE' | 'O'
export interface TaxKey { category: TaxCategory; rate: number }

export interface Endpoint { scheme: string; id: string }

export interface EInvoiceParty {
  name: string
  contactName: string | null
  street: string | null
  street2: string | null
  zip: string
  city: string
  countryCode: string
  countryName: string
  vatId: string | null
  email: string | null
  phone: string | null
  endpoint: Endpoint | null
}

export type Period = { start: string; end: string }

export interface EInvoiceLine {
  position: number
  name: string
  descriptionLines: string[]
  quantity: number
  unitCode: string
  // The price before the line's own discount, never negative (BR-27).
  unitPrice: number
  // quantity × unitPrice to the cent: the line before its own discount.
  gross: number
  // The line's own discount, gross − net, 0 without one: a line allowance, or a charge where it
  // is negative (a discount that shrinks a credit line, as with section and document discounts).
  discount: number
  // Only when gross × percent / 100 gives exactly the discount at the two decimals written.
  discountPercent: number | null
  // In the document's language; null without a discount.
  discountReason: string | null
  // What the PDF prints and calcTotals sums (lineAmount).
  net: number
  tax: TaxKey
  period: Period | null
}

export interface EInvoiceSection {
  header: string | null
  lines: EInvoiceLine[]
}

// A document level allowance or, with charge set, a surcharge; always a positive amount.
export interface EInvoiceAllowance {
  charge: boolean
  reason: string
  // From a section or document discount; a charge where the discount shrinks a net credit.
  discount: boolean
  amount: number
  base: number
  // Only when base × percent / 100 gives exactly the amount, so no reader recomputes another one.
  percent: number | null
  tax: TaxKey
}

export interface EInvoiceTax {
  tax: TaxKey
  taxable: number
  amount: number
  exemptionCode: string | null
  exemptionReason: string | null
}

// An advance or partial invoice a final invoice deducts (BG-3 / RelatedDocument).
export interface PrecedingInvoice { number: string; date: string; kind: DepositKind }

export interface EInvoice {
  kind: 'invoice' | 'credit_note'
  invoiceKind: InvoiceKind
  title: string
  number: string
  issueDate: string
  dueDate: string | null
  language: Language
  currency: 'EUR'
  note: string | null
  buyerReference: string | null
  // The supplier number the buyer assigned to the studio (Lieferantennummer).
  supplierNumber: string | null
  // The studio's number for the client (K-0001).
  clientNumber: string | null
  reference: { kind: 'storno' | 'correction'; number: string; date: string; text: string } | null
  // A final invoice: the invoices its deduction lines take off, each line negative per VAT rate.
  preceding: (PrecedingInvoice & { text: string })[]
  // Service date or period of the whole document; lines may carry their own.
  delivery: Period | null
  seller: EInvoiceParty
  buyer: EInvoiceParty
  sections: EInvoiceSection[]
  footer: string | null
  lines: EInvoiceLine[]
  allowances: EInvoiceAllowance[]
  taxes: EInvoiceTax[]
  totals: {
    lineTotal: number
    allowanceTotal: number
    chargeTotal: number
    taxExclusive: number
    taxTotal: number
    taxInclusive: number
    prepaid: number
    payable: number
  }
  // Invoices only: the SEPA transfer the PDF asks for.
  payment: { iban: string; bic: string | null; holder: string; bankName: string | null; reference: string } | null
  paymentTerms: string | null
  skonto: { date: string; percent: number; base: number; amount: number } | null
  taxNote: string | null
  attachment: { filename: string; base64: string; description: string } | null
}

type SourceItem = Pick<DocumentItem, 'line_type' | 'description' | 'quantity' | 'unit' | 'unit_price' | 'vat_rate' | 'service_date' | 'service_date_end' | 'discount_type' | 'discount_value'> & { sort_order?: number | null }

export interface EInvoiceSource {
  doc: Pick<Document, 'type' | 'invoice_kind' | 'number' | 'date' | 'due_date' | 'service_date' | 'service_date_end' | 'currency' | 'tax_treatment' | 'language' | 'notes' | 'discount_type' | 'discount_value' | 'skonto_percent' | 'skonto_days' | 'issued_at' | 'cancels_document_id'>
  items: SourceItem[]
  payments: Pick<Payment, 'date' | 'amount'>[]
  client: Pick<Client, 'name' | 'company' | 'client_number' | 'address_line1' | 'address_line2' | 'zip' | 'city' | 'country' | 'email' | 'phone' | 'uid_number' | 'peppol_scheme' | 'peppol_id' | 'supplier_number'>
  settings: Pick<Settings, 'company_name' | 'owner_name' | 'address_line1' | 'address_line2' | 'zip' | 'city' | 'country' | 'email' | 'phone' | 'uid_number' | 'iban' | 'bic' | 'bank_name' | 'bank_account_holder' | 'peppol_scheme' | 'peppol_id' | 'tax_note_reverse_charge_de' | 'tax_note_reverse_charge_en' | 'tax_note_non_eu_de' | 'tax_note_non_eu_en'>
  reference: DocReference | null
  buyerReference: string | null
  preceding?: PrecedingInvoice[]
  // In the document's language.
  t: TFn
}

// UN/ECE Recommendation 20 codes.
const UNIT_CODES: Record<Unit, string> = {
  hour: 'HUR',
  day: 'DAY',
  month: 'MON',
  piece: 'H87',
  flat: 'C62',
  session: 'C62',
}

// Peppol electronic address schemes (EAS) of VAT numbers, by the number's country prefix. Italy,
// Denmark and Finland address their participants by other registers, entered on the client.
const VAT_SCHEMES: Record<string, string> = {
  AT: '9914', BE: '9925', BG: '9926', CH: '9927', CY: '9928', CZ: '9929', DE: '9930', EE: '9931',
  GB: '9932', EL: '9933', GR: '9933', HR: '9934', IE: '9935', LI: '9936', LT: '9937', LU: '9938',
  LV: '9939', MC: '9940', MT: '9943', NL: '9944', PL: '9945', PT: '9946', RO: '9947', SI: '9949',
  SK: '9950', SM: '9951', FR: '9957', HU: '9910', ES: '9920', SE: '9955',
}

// A VAT number used as a Peppol address, e.g. 9914:ATU12345678.
export function vatEndpoint(vatId: string | null): Endpoint | null {
  if (!vatId) return null
  const scheme = VAT_SCHEMES[vatId.slice(0, 2)]
  return scheme ? { scheme, id: vatId } : null
}

function configuredEndpoint(scheme: string | null | undefined, id: string | null | undefined): Endpoint | null {
  const s = scheme?.trim()
  const i = id?.trim()
  return s && i ? { scheme: s, id: i } : null
}

const clean = (v: string | null | undefined) => v?.trim() || null

// EN 16931 wants a VAT number with its country prefix (BR-CO-09); anything else is not one.
function vatIdOf(value: string | null | undefined): string | null {
  const id = normalizeVatId(value ?? '')
  return /^[A-Z]{2}[A-Z0-9]{2,}$/.test(id) ? id : null
}

export function taxKeyFor(treatment: string, rate: number): TaxKey {
  if (treatment === 'eu_reverse_charge') return { category: 'AE', rate: 0 }
  if (treatment === 'non_eu') return { category: 'O', rate: 0 }
  return rate > 0 ? { category: 'S', rate } : { category: 'Z', rate: 0 }
}

const keyId = (k: TaxKey) => `${k.category}:${k.rate}`

// A percentage as both formats write it (two decimals), or null unless base × it / 100 gives
// exactly the amount, so no reader recomputes another one (PEPPOL-EN16931-R040).
function exactPercent(base: number, percent: number | null, value: number): number | null {
  if (percent == null) return null
  const written = Number(decimal(percent, 2))
  return roundCents(base * written / 100) === value ? written : null
}

function textLines(value: string | null | undefined): string[] {
  return (value ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

function periodOf(start: string | null | undefined, end: string | null | undefined): Period | null {
  if (!start) return null
  return { start, end: end && end > start ? end : start }
}

type Row = { reason: string; target: number; percent: number | null; base: Map<string, number>; ideal: Map<string, number> }

// Splits each VAT category's allowance total (lines minus the taxable amount calcTotals printed)
// into the discounts it came from, in signed cents: a discount on a category whose lines are net
// negative (credit lines) shrinks that credit, so its share there is negative and becomes a charge.
// Category totals are exact, so every VAT breakdown adds up; then cents are moved between
// discounts within a category until each discount also matches the amount the PDF shows for it,
// as far as the categories they share allow, never flipping a share's sign.
function allocate(rows: Row[], targets: Map<string, number>, order: string[]): Map<string, number>[] {
  const cents = rows.map(() => new Map<string, number>())
  for (const key of order) {
    const cells = rows.map((r, i) => ({ i, v: (r.ideal.get(key) ?? 0) * 100 })).filter(c => Math.abs(c.v) > 1e-6)
    if (!cells.length) continue
    let left = Math.round((targets.get(key) ?? 0) * 100)
    for (const c of cells) { const f = Math.floor(c.v); cents[c.i].set(key, f); left -= f }
    // Missing cents go to the largest remainders, surplus ones come off the smallest.
    const byRemainder = [...cells].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)) || a.i - b.i)
    if (left < 0) byRemainder.reverse()
    const step = Math.sign(left)
    for (let n = 0; n < Math.abs(left); n++) {
      const c = byRemainder[n % byRemainder.length]
      cents[c.i].set(key, cents[c.i].get(key)! + step)
    }
  }

  const sign = (i: number, key: string) => Math.sign(rows[i].ideal.get(key) ?? 0)
  const canGive = (i: number, key: string) => sign(i, key) < 0 || (sign(i, key) > 0 && (cents[i].get(key) ?? 0) > 0)
  const canTake = (i: number, key: string) => sign(i, key) > 0 || (sign(i, key) < 0 && (cents[i].get(key) ?? 0) < 0)
  const rowSum = (i: number) => [...cents[i].values()].reduce((s, v) => s + v, 0)
  for (let guard = 0; guard < 1000; guard++) {
    const diff = rows.map((r, i) => rowSum(i) - Math.round(r.target * 100))
    let moved = false
    for (let from = 0; from < rows.length && !moved; from++) {
      if (diff[from] <= 0) continue
      for (let to = 0; to < rows.length && !moved; to++) {
        if (diff[to] >= 0) continue
        const key = order.find(k => canGive(from, k) && canTake(to, k))
        if (!key) continue
        cents[from].set(key, cents[from].get(key)! - 1)
        cents[to].set(key, (cents[to].get(key) ?? 0) + 1)
        moved = true
      }
    }
    if (!moved) break
  }
  return cents
}

export function buildEInvoice(src: EInvoiceSource): EInvoice {
  const { doc, client, settings, t } = src
  if (doc.type !== 'invoice' && doc.type !== 'credit_note') {
    throw new EInvoiceError('unsupported_type', 'Only invoices and credit notes can be e-invoices')
  }
  if (!doc.number) throw new EInvoiceError('not_issued', 'Only issued documents can be e-invoices')
  if ((doc.currency ?? 'EUR') !== 'EUR') throw new EInvoiceError('currency', 'E-invoices are EUR only')

  const lang = documentLanguage(doc.language)
  const treatment = doc.tax_treatment ?? 'at_vat'
  const isStorno = doc.type === 'credit_note' && !!doc.cancels_document_id
  const kind = doc.type
  const items = orderItems(src.items)
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null

  // The payments the issued copy shows (src/lib/pdf/snapshot.ts): none dated after the issue day.
  const issuedOn = doc.issued_at ? viennaDate(new Date(doc.issued_at)) : doc.date
  const paidAsIssued = kind === 'invoice' ? src.payments.filter(p => p.date <= issuedOn) : []
  const totals = calcTotals(items, paidAsIssued, discount, treatment)

  // Sections are bounded by subtotal lines, as in calcTotals; heading and text lines label them.
  type DraftSection = { texts: string[]; heading: string | null; lines: EInvoiceLine[]; discount: { type: string; value: number | null } | null }
  const drafts: DraftSection[] = [{ texts: [], heading: null, lines: [], discount: null }]
  const lines: EInvoiceLine[] = []
  // A final invoice's deductions: negative lines after the others, outside every discount.
  const deductions = items.filter(isDeductionLine)
  for (const item of items.filter(i => !isDeductionLine(i))) {
    const section = drafts[drafts.length - 1]
    const type = item.line_type ?? 'item'
    if (type === 'subtotal') {
      section.discount = item.discount_type != null ? { type: item.discount_type, value: item.discount_value ?? null } : null
      drafts.push({ texts: [], heading: null, lines: [], discount: null })
    } else if (type === 'heading' || type === 'text') {
      const text = textLines(item.description).join('\n')
      if (text) section.texts.push(text)
      if (type === 'heading' && text && !section.heading) section.heading = text
    } else if (type === 'item' && item.quantity != null && item.unit_price != null && item.vat_rate != null) {
      // Prices are never negative in EN 16931 (BR-27): a credit line carries the sign in its quantity,
      // so quantity × unitPrice keeps the sign of the line's gross.
      const negative = item.unit_price < 0
      const descriptionLines = textLines(item.description)
      const { gross, discount: lineDiscount, percent } = lineSummary(item)
      const line: EInvoiceLine = {
        position: lines.length + 1,
        name: descriptionLines[0] ?? '—',
        descriptionLines: descriptionLines.length ? descriptionLines : ['—'],
        quantity: negative ? -item.quantity : item.quantity,
        unitCode: UNIT_CODES[item.unit ?? 'flat'] ?? 'C62',
        unitPrice: Math.abs(item.unit_price),
        gross,
        discount: lineDiscount,
        discountPercent: lineDiscount > 0 ? exactPercent(gross, percent, lineDiscount) : null,
        discountReason: lineDiscount !== 0 ? t('editor.lineDiscount') : null,
        net: lineAmount(item),
        tax: taxKeyFor(treatment, item.vat_rate),
        period: periodOf(item.service_date, item.service_date_end),
      }
      // Readers recompute every line (PEPPOL-EN16931-R120, ebInterface LineItemAmount): quantity ×
      // unit price as written, rounded to the cent like the PDF (at most half a cent off), less the
      // line allowance must give the net the PDF prints, so a change to lineAmount or lineSummary
      // cannot make the XML disagree with it unnoticed.
      const written = Number(decimal(line.quantity)) * Number(decimal(line.unitPrice))
      if (roundCents(written) !== line.gross || roundCents(line.gross - line.discount) !== line.net) {
        throw new EInvoiceError('line_amount', `Line ${line.position}: ${decimal(line.quantity)} × ${decimal(line.unitPrice)} less ${line.discount} does not give the printed ${line.net}`)
      }
      lines.push(line)
      section.lines.push(line)
    }
  }

  const deductionLines: EInvoiceLine[] = deductions.flatMap(item => {
    if (item.quantity == null || item.unit_price == null || item.vat_rate == null) return []
    const name = textLines(item.description)[0] ?? '—'
    const line: EInvoiceLine = {
      position: lines.length + 1,
      name,
      descriptionLines: [name],
      quantity: item.unit_price < 0 ? -item.quantity : item.quantity,
      unitCode: UNIT_CODES.flat,
      unitPrice: Math.abs(item.unit_price),
      gross: lineAmount(item),
      discount: 0,
      discountPercent: null,
      discountReason: null,
      net: lineAmount(item),
      tax: taxKeyFor(treatment, item.vat_rate),
      period: null,
    }
    if (roundCents(Number(decimal(line.quantity)) * Number(decimal(line.unitPrice))) !== line.net) {
      throw new EInvoiceError('line_amount', `Line ${line.position}: ${decimal(line.quantity)} × ${decimal(line.unitPrice)} does not give the printed ${line.net}`)
    }
    lines.push(line)
    return [line]
  })
  const deductedNet = roundCents(deductionLines.reduce((s, l) => s + l.net, 0))

  // Text of sections without lines goes to the next section with lines, or below the last one.
  const sections: EInvoiceSection[] = []
  let carried: string[] = []
  for (const d of drafts) {
    if (!d.lines.length) { carried.push(...d.texts); continue }
    const header = [...carried, ...d.texts]
    carried = []
    sections.push({ header: header.length ? header.join('\n') : null, lines: d.lines })
  }
  if (deductionLines.length) sections.push({ header: null, lines: deductionLines })

  // VAT categories in the order calcTotals prints its rates.
  const groups = totals.vat_groups.map(g => ({ key: taxKeyFor(treatment, g.rate), base: g.base, amount: g.amount }))
  const order = groups.map(g => keyId(g.key))
  const lineTotalByKey = new Map<string, number>()
  for (const l of lines) lineTotalByKey.set(keyId(l.tax), roundCents((lineTotalByKey.get(keyId(l.tax)) ?? 0) + l.net))
  const targets = new Map(groups.map(g => [keyId(g.key), roundCents((lineTotalByKey.get(keyId(g.key)) ?? 0) - g.base)]))

  const rows: Row[] = []
  const netAfterSections = new Map<string, number>()
  let sectionNo = 0
  for (const d of drafts) {
    if (!d.lines.length) continue
    sectionNo++
    const gross = roundCents(d.lines.reduce((s, l) => s + l.net, 0))
    const cut = discountAmount(gross, d.discount)
    const scale = cut > 0 ? (gross - cut) / gross : 1
    const base = new Map<string, number>()
    for (const l of d.lines) {
      const k = keyId(l.tax)
      base.set(k, (base.get(k) ?? 0) + l.net)
      netAfterSections.set(k, (netAfterSections.get(k) ?? 0) + l.net * scale)
    }
    if (cut <= 0) continue
    const ideal = new Map([...base].map(([k, v]) => [k, v * (1 - scale)]))
    const name = d.heading ?? t('einvoice.xml.section', { n: sectionNo })
    rows.push({
      reason: t('einvoice.xml.sectionDiscount', { section: name.split('\n')[0] }),
      target: cut,
      percent: d.discount?.type === 'percent' ? clampPercent(d.discount.value) : null,
      base,
      ideal,
    })
  }
  const scopeNet = roundCents(totals.subtotal - deductedNet)
  if (totals.discount_amount > 0 && scopeNet > 0) {
    const docScale = (scopeNet - totals.discount_amount) / scopeNet
    rows.push({
      reason: t('pdfPortal.totals.discount'),
      target: totals.discount_amount,
      percent: discount?.type === 'percent' ? clampPercent(discount.value) : null,
      base: netAfterSections,
      ideal: new Map([...netAfterSections].map(([k, v]) => [k, v * (1 - docScale)])),
    })
  }

  const allocated = allocate(rows, targets, order)
  const allowances: EInvoiceAllowance[] = []
  rows.forEach((row, i) => {
    for (const g of groups) {
      const k = keyId(g.key)
      const value = (allocated[i].get(k) ?? 0) / 100
      if (value === 0) continue
      const base = roundCents(row.base.get(k) ?? 0)
      const charge = value < 0
      const exact = !charge && row.percent != null && roundCents(base * row.percent / 100) === value
      allowances.push({ charge, discount: true, reason: row.reason, amount: Math.abs(value), base, percent: exact ? row.percent : null, tax: g.key })
    }
  })
  // The cent drift calcTotals pushed into a category that no discount touches.
  for (const g of groups) {
    const k = keyId(g.key)
    const given = allowances.filter(a => keyId(a.tax) === k).reduce((s, a) => s + (a.charge ? -a.amount : a.amount), 0)
    const rest = roundCents((targets.get(k) ?? 0) - given)
    if (rest === 0) continue
    allowances.push({
      charge: rest < 0,
      discount: false,
      reason: t('einvoice.xml.rounding'),
      amount: Math.abs(rest),
      base: roundCents(lineTotalByKey.get(k) ?? 0),
      percent: null,
      tax: g.key,
    })
  }

  const taxNote = getTaxNote(treatment, lang, settings)
  const taxes: EInvoiceTax[] = groups.map(g => ({
    tax: g.key,
    taxable: g.base,
    amount: g.amount,
    exemptionCode: g.key.category === 'AE' ? 'VATEX-EU-AE' : g.key.category === 'O' ? 'VATEX-EU-O' : null,
    exemptionReason: g.key.category === 'AE' || g.key.category === 'O' ? taxNote : null,
  }))

  const lineTotal = roundCents(lines.reduce((s, l) => s + l.net, 0))
  const allowanceTotal = roundCents(allowances.filter(a => !a.charge).reduce((s, a) => s + a.amount, 0))
  const chargeTotal = roundCents(allowances.filter(a => a.charge).reduce((s, a) => s + a.amount, 0))
  const taxExclusive = roundCents(lineTotal - allowanceTotal + chargeTotal)
  const taxInclusive = roundCents(taxExclusive + totals.total_vat)
  if (taxInclusive !== totals.total) throw new Error(`E-invoice total ${taxInclusive} differs from the document total ${totals.total}`)
  const prepaid = totals.total_paid

  const sellerVat = vatIdOf(settings.uid_number)
  const sellerCountry = toCountryCode(settings.country) ?? 'AT'
  const seller: EInvoiceParty = {
    name: clean(settings.company_name) ?? clean(settings.owner_name) ?? '',
    contactName: clean(settings.owner_name),
    street: clean(settings.address_line1),
    street2: clean(settings.address_line2),
    zip: settings.zip?.trim() ?? '',
    city: settings.city?.trim() ?? '',
    countryCode: sellerCountry,
    countryName: countryName(sellerCountry, lang),
    vatId: sellerVat,
    email: clean(settings.email),
    phone: clean(settings.phone),
    endpoint: configuredEndpoint(settings.peppol_scheme, settings.peppol_id) ?? vatEndpoint(sellerVat),
  }

  const buyerVat = vatIdOf(client.uid_number)
  const buyerCountry = toCountryCode(client.country) ?? (buyerVat && toCountryCode(buyerVat.slice(0, 2) === 'EL' ? 'GR' : buyerVat.slice(0, 2)))
  if (!buyerCountry) throw new EInvoiceError('client_country', 'The client has no country')
  const buyerName = clientDisplayName(client)
  const buyer: EInvoiceParty = {
    name: buyerName,
    contactName: client.company && client.name && client.name !== client.company ? client.name : null,
    street: clean(client.address_line1),
    street2: clean(client.address_line2),
    zip: client.zip?.trim() ?? '',
    city: client.city?.trim() ?? '',
    countryCode: buyerCountry,
    countryName: countryName(buyerCountry, lang),
    vatId: buyerVat,
    email: clean(client.email),
    phone: clean(client.phone),
    endpoint: configuredEndpoint(client.peppol_scheme, client.peppol_id) ?? vatEndpoint(buyerVat),
  }

  const ref = src.reference
  const reference = ref
    ? {
        kind: ref.kind === 'correction' ? 'correction' as const : 'storno' as const,
        number: ref.number,
        date: ref.date,
        text: t(ref.kind === 'correction' ? 'pdfPortal.correctionOf' : 'pdfPortal.stornoOf', { number: ref.number, date: formatDate(ref.date, lang) }),
      }
    : null

  const iban = normalizeIban(settings.iban ?? '')
  const bic = normalizeBic(settings.bic ?? '')
  const payment = kind === 'invoice' && iban
    ? { iban, bic: isValidBic(bic) ? bic : null, holder: epcBeneficiary(settings), bankName: clean(settings.bank_name), reference: doc.number }
    : null

  const skontoValue = kind === 'invoice' ? skontoAmount(totals.total, doc.skonto_percent) : 0
  const skonto = skontoValue > 0 && doc.skonto_days != null
    ? { date: skontoDeadline(doc.date, doc.skonto_days), percent: clampPercent(doc.skonto_percent), base: totals.total, amount: skontoValue }
    : null

  const payable = roundCents(taxInclusive - prepaid)
  // BR-CO-25: an amount due needs a due date or payment terms; without either it is due on receipt.
  const paymentTerms = kind === 'invoice'
    ? paymentTermsSentence({ type: kind, date: doc.date, due_date: doc.due_date, skonto_percent: doc.skonto_percent, skonto_days: doc.skonto_days, currency: 'EUR' }, totals.total, lang)
      ?? (payable > 0 ? t('einvoice.xml.payableOnReceipt') : null)
    : reference ? t('einvoice.xml.creditTerms', { number: reference.number }) : t('einvoice.xml.creditTermsPlain')

  const footer = carried.length ? carried.join('\n') : null

  return {
    kind,
    invoiceKind: kind === 'invoice' ? doc.invoice_kind ?? 'standard' : 'standard',
    title: docTitle(t, documentKind(kind, isStorno), kind === 'invoice' ? doc.invoice_kind : null),
    number: doc.number,
    issueDate: doc.date,
    dueDate: kind === 'invoice' ? doc.due_date : null,
    language: lang,
    currency: 'EUR',
    note: clean(doc.notes),
    buyerReference: clean(src.buyerReference),
    supplierNumber: clean(client.supplier_number),
    clientNumber: clean(client.client_number),
    reference,
    preceding: (src.preceding ?? []).map(p => ({ ...p, text: `${t(`deposits.title.${p.kind}`)} ${p.number}` })),
    delivery: periodOf(doc.service_date, doc.service_date_end),
    seller,
    buyer,
    sections,
    footer,
    lines,
    allowances,
    taxes,
    totals: {
      lineTotal,
      allowanceTotal,
      chargeTotal,
      taxExclusive,
      taxTotal: totals.total_vat,
      taxInclusive,
      prepaid,
      payable,
    },
    payment,
    paymentTerms,
    skonto,
    taxNote,
    attachment: null,
  }
}

export function withAttachment(inv: EInvoice, pdf: { filename: string; base64: string } | null): EInvoice {
  return pdf ? { ...inv, attachment: { ...pdf, description: `${inv.title} ${inv.number}` } } : inv
}

// A file name that is safe in a Content-Disposition header and on every file system.
export function einvoiceFilename(number: string, format: 'ebinterface' | 'ubl'): string {
  const base = number.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'invoice'
  return `${base}_${format === 'ubl' ? 'Peppol-UBL' : 'ebInterface'}.xml`
}
