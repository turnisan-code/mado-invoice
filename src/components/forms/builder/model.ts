// The editor's data model: pure functions only, so node can verify them without React.
import type { Client, Currency, Document, DocumentItem, DocumentType, InvoiceKind, Language, LineType, Settings, TaxTreatment, Unit, VatRate } from '@/types'
import type { PublicSettings } from '@/lib/public-settings'
import { addDays, clampPercent, orderItems, today } from '@/lib/utils/document'
import { formatDocumentNumber, nextCounter } from '@/lib/utils/numbering'

export type DiscountKind = 'percent' | 'fixed'

export interface LineItem {
  id: string
  line_type: LineType
  description: string
  service_date: string | null
  service_date_end: string | null
  quantity: number
  unit: Unit
  unit_price: number
  vat_rate: VatRate
  catalogue_item_id: string | null
  // On an item line its own discount, on a subtotal line the section's.
  discount_type: DiscountKind | null
  discount_value: number
}

// Everything the editor writes. One snapshot feeds every save (autosave, Save draft, issuing,
// the flush on leaving) and the device backup, so no path can write stale values.
export interface FormState {
  clientId: string
  date: string
  serviceDate: string
  serviceDateEnd: string
  dueDate: string
  language: Language
  currency: Currency
  taxTreatment: TaxTreatment
  notes: string
  notesInternal: string
  discountType: DiscountKind | null
  discountValue: number
  skontoPercent: number | ''
  skontoDays: number | ''
  // Invoices: standard, advance, partial or final (src/lib/deposits.ts).
  invoiceKind: InvoiceKind
  // null = never set: the PDF and e-invoice use the corrected invoice's or the client's default.
  buyerReference: string | null
  lines: LineItem[]
}

export type EditorDocument = Document & { items?: DocumentItem[]; payments?: { id: string; date: string; amount: number; note: string | null; kind?: string | null }[] }

export const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
export const VAT_RATES: VatRate[] = [0, 10, 13, 20]
export const AUTOSAVE_DELAY = 2000
export const PATHS: Record<DocumentType, string> = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes' }

// Line ids are UUIDs: replace_document_items stores a new line under the id the editor gave it
// and updates that row on every later save, so what is billed on a line stays linked to it.
export function makeId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function blankLine(settings: Pick<Settings, 'default_unit' | 'default_vat_rate'>): LineItem {
  return { id: makeId(), line_type: 'item', description: '', service_date: null, service_date_end: null, quantity: 1, unit: settings.default_unit ?? 'flat', unit_price: 0, vat_rate: settings.default_vat_rate ?? 20, catalogue_item_id: null, discount_type: null, discount_value: 0 }
}

export function blankSpecial(type: LineType): LineItem {
  return { id: makeId(), line_type: type, description: '', service_date: null, service_date_end: null, quantity: 0, unit: 'flat', unit_price: 0, vat_rate: 0, catalogue_item_id: null, discount_type: null, discount_value: 0 }
}

// Quotes carry their validity period in due_date; invoices and credit notes a payment term.
export function termDays(type: DocumentType, settings: Pick<Settings, 'default_quote_validity_days' | 'default_payment_days'>, client?: Pick<Client, 'payment_days'> | null): number {
  if (type === 'quote') return settings.default_quote_validity_days ?? 14
  return client?.payment_days ?? settings.default_payment_days
}

// The Skonto an invoice for this client starts with; each field the client leaves empty follows
// the settings default, and 0 % means none. Only invoices carry Skonto.
export function skontoTerms(
  type: DocumentType,
  settings: Pick<Settings, 'default_skonto_percent' | 'default_skonto_days'>,
  client?: Pick<Client, 'skonto_percent' | 'skonto_days'> | null,
): { percent: number | null; days: number | null } {
  const percent = type === 'invoice' ? client?.skonto_percent ?? settings.default_skonto_percent : null
  if (!percent || percent <= 0) return { percent: null, days: null }
  return { percent, days: client?.skonto_days ?? settings.default_skonto_days ?? null }
}

type TermsSettings = Pick<Settings, 'default_quote_validity_days' | 'default_payment_days' | 'default_skonto_percent' | 'default_skonto_days'>
type TermsClient = Pick<Client, 'payment_days' | 'skonto_percent' | 'skonto_days'>

// What a new document for this client starts with: the due date from its terms and, on an
// invoice, its Skonto.
export function clientTerms(type: DocumentType, settings: TermsSettings, client: TermsClient, date: string): Pick<FormState, 'dueDate' | 'skontoPercent' | 'skontoDays'> {
  const skonto = skontoTerms(type, settings, client)
  return { dueDate: addDays(date, termDays(type, settings, client)), skontoPercent: skonto.percent ?? '', skontoDays: skonto.days ?? '' }
}

const sameSkonto = (value: number | '', term: number | null) =>
  value === '' ? term === null : term !== null && Number(value) === Number(term)

// What changing the client sets on an unissued document: the due date from the new client's terms
// and, only while the form still holds the previous client's Skonto, the new client's. A Skonto
// set or cleared by hand stays.
export function clientChangeTerms(
  type: DocumentType,
  settings: TermsSettings,
  f: Pick<FormState, 'date' | 'skontoPercent' | 'skontoDays'>,
  previous: Pick<Client, 'skonto_percent' | 'skonto_days'> | null | undefined,
  next: TermsClient,
): Partial<Pick<FormState, 'dueDate' | 'skontoPercent' | 'skontoDays'>> {
  const terms = clientTerms(type, settings, next, f.date || today())
  const prev = skontoTerms(type, settings, previous)
  return sameSkonto(f.skontoPercent, prev.percent) && sameSkonto(f.skontoDays, prev.days) ? terms : { dueDate: terms.dueDate }
}

export function linesFromItems(items: DocumentItem[]): LineItem[] {
  return orderItems(items).map(i => ({
    id: i.id && UUID.test(i.id) ? i.id : makeId(),
    line_type: (i.line_type ?? 'item') as LineType,
    description: i.description,
    service_date: i.service_date ?? null,
    service_date_end: i.service_date_end ?? null,
    quantity: i.quantity ?? 1,
    unit: (i.unit ?? 'flat') as Unit,
    unit_price: i.unit_price ?? 0,
    vat_rate: (i.vat_rate ?? 20) as VatRate,
    catalogue_item_id: i.catalogue_item_id,
    discount_type: (i.discount_type as DiscountKind | null) ?? null,
    discount_value: i.discount_value ?? 0,
  }))
}

// What the editor opens with. A new document opened for a client starts with that client's
// language, tax and terms. A stored due date is kept; a new document, or a draft without one
// (e.g. a duplicate), follows the client's terms, as issuing would; a Storno has none.
// EUR only: an issued document keeps the currency it was written in, a credit note the one of
// the invoice it corrects; any other draft (a duplicate, a converted quote) becomes EUR.
export function initialForm(type: DocumentType, settings: PublicSettings, clients: Client[], doc?: EditorDocument, defaultClientId?: string): FormState {
  const initialClient = !doc && defaultClientId ? clients.find(c => c.id === defaultClientId) ?? null : null
  const skonto = skontoTerms(type, settings, initialClient)
  const dueDate = doc && (doc.due_date || doc.number || doc.cancels_document_id)
    ? doc.due_date ?? ''
    : addDays(doc?.date || today(), termDays(type, settings, doc ? clients.find(x => x.id === doc.client_id) : initialClient))
  return {
    clientId: doc?.client_id ?? defaultClientId ?? '',
    date: doc?.date ?? today(),
    serviceDate: doc?.service_date ?? '',
    serviceDateEnd: doc?.service_date_end ?? '',
    dueDate,
    language: doc?.language ?? initialClient?.language ?? settings.default_language ?? 'de',
    currency: doc && (doc.number || type === 'credit_note') ? doc.currency : 'EUR',
    taxTreatment: (doc?.tax_treatment as TaxTreatment | undefined) ?? initialClient?.tax_treatment ?? settings.default_tax_treatment ?? 'at_vat',
    notes: doc?.notes ?? '',
    notesInternal: doc?.notes_internal ?? '',
    discountType: doc?.discount_type ?? null,
    discountValue: doc?.discount_value ?? 0,
    // Skonto only exists on invoices; new ones start from the client's terms or the settings defaults.
    skontoPercent: doc ? (doc.skonto_percent ?? '') : (skonto.percent ?? ''),
    skontoDays: doc ? (doc.skonto_days ?? '') : (skonto.days ?? ''),
    invoiceKind: doc?.invoice_kind ?? 'standard',
    buyerReference: doc?.buyer_reference ?? null,
    lines: doc?.items?.length ? linesFromItems(doc.items) : [blankLine(settings)],
  }
}

// The documents columns the editor owns; an empty date falls back to today.
export function docFields(type: DocumentType, f: FormState) {
  const skonto = type === 'invoice' && f.skontoPercent !== '' && f.skontoPercent > 0
    ? { skonto_percent: f.skontoPercent, skonto_days: f.skontoDays === '' ? null : f.skontoDays }
    : { skonto_percent: null, skonto_days: null }
  return {
    client_id: f.clientId, date: f.date || today(), service_date: f.serviceDate || null,
    service_date_end: f.serviceDateEnd || null,
    due_date: f.dueDate || null, language: f.language, currency: f.currency, tax_treatment: f.taxTreatment,
    notes: f.notes || null, notes_internal: f.notesInternal || null,
    discount_type: f.discountType, discount_value: f.discountValue || null,
    buyer_reference: f.buyerReference == null ? null : f.buyerReference.trim(),
    ...skonto,
    ...(f.currency === 'EUR' ? { exchange_rate: 1 } : {}),
    ...(type === 'invoice' ? { invoice_kind: f.invoiceKind ?? 'standard' } : {}),
  }
}

// What a save stores per line, without its id: the saved and content keys compare these. Item
// lines carry their own discount, subtotal lines the section's; other lines none. A final
// invoice's deduction lines keep their amount and rate.
export function lineValues(lines: LineItem[]) {
  return lines.map((l, i) => {
    const item = l.line_type === 'item'
    const amounts = item || l.line_type === 'deduction'
    const discounted = item || l.line_type === 'subtotal'
    return {
      sort_order: i,
      line_type: l.line_type,
      description: l.description,
      service_date: item ? (l.service_date || null) : null,
      service_date_end: item ? (l.service_date_end || null) : null,
      quantity: amounts ? l.quantity : null,
      unit: amounts ? l.unit : null,
      unit_price: amounts ? l.unit_price : null,
      vat_rate: amounts ? l.vat_rate : null,
      catalogue_item_id: item ? l.catalogue_item_id : null,
      discount_type: discounted ? (l.discount_type || null) : null,
      discount_value: discounted ? (l.discount_value || null) : null,
    }
  })
}

// What replace_document_items receives: every line with its id, so the row (and the time entries
// and expenses billed on it) is kept. An id that is no UUID (a device backup from before ids were
// kept) goes as null and becomes a new row; such a save frees no project entries.
export function itemsPayload(lines: LineItem[]) {
  return lineValues(lines).map((values, i) => ({ id: UUID.test(lines[i].id) ? lines[i].id : null, ...values }))
}

// The content replace_document_items compares to move a removed row's entries to a new row.
function twinKey(l: LineItem): string {
  const v = lineValues([l])[0]
  return JSON.stringify([v.line_type, v.description, v.quantity, v.unit, v.unit_price, v.vat_rate, v.service_date, v.service_date_end])
}

// A device backup from before line ids were kept has ids that are no UUIDs. A restored line with
// the same content as an open line takes that line's id, so its row and what is billed on it stay.
// When every open line found its twin, the other restored lines are new and get ids of their own;
// otherwise they keep theirs and save as new rows without freeing anything, since an open line
// without a twin may have been edited rather than removed.
export function adoptLineIds(restored: LineItem[], open: LineItem[]): LineItem[] {
  if (restored.every(l => UUID.test(l.id))) return restored
  const used = new Set(restored.filter(l => UUID.test(l.id)).map(l => l.id))
  const free = open.filter(l => UUID.test(l.id) && !used.has(l.id))
  const lines = restored.map(l => {
    if (UUID.test(l.id)) return l
    const k = free.findIndex(o => twinKey(o) === twinKey(l))
    return k < 0 ? l : { ...l, id: free.splice(k, 1)[0].id }
  })
  return free.length ? lines : lines.map(l => UUID.test(l.id) ? l : { ...l, id: makeId() })
}

// Exactly what a save writes, so a document reloaded from the database has the key it was saved with.
export function savedKeyOf(type: DocumentType, f: FormState): string {
  return JSON.stringify([docFields(type, f), lineValues(f.lines)])
}

// The key of what the database holds once `f` is autosaved: an empty date leaves the stored one
// in place, so entering any other date (today's included) is a change.
export function storedKeyOf(type: DocumentType, f: FormState, storedDate: string | null): string {
  return savedKeyOf(type, f.date || !storedDate ? f : { ...f, date: storedDate })
}

// What the user wrote beyond the client and what follows from it (language, tax, due date,
// Skonto): a new document is only created once there is something worth keeping.
export function contentKeyOf(f: FormState): string {
  return JSON.stringify([f.date, f.serviceDate, f.serviceDateEnd, f.notes, f.notesInternal, f.discountType, f.discountValue, f.buyerReference, lineValues(f.lines)])
}

type NumberingKey<T extends DocumentType> =
  `${T}_number_format` | `${T}_prefix` | `next_${T}_number` | `${T}_counter_year` | `${T}_number_reset_yearly`
export type NumberingSettings = Pick<Settings, NumberingKey<DocumentType>>

// The number issue_document would assign if nothing else is issued first (it skips taken numbers).
export function expectedNumber(settings: Partial<NumberingSettings>, type: DocumentType, isoDate: string): string {
  const fmt = settings[`${type}_number_format`]
  if (!fmt) return ''
  const counter = nextCounter(settings[`next_${type}_number`] ?? 1, settings[`${type}_counter_year`] ?? null, !!settings[`${type}_number_reset_yearly`], fmt, Number(isoDate.slice(0, 4)))
  return formatDocumentNumber(fmt, settings[`${type}_prefix`] ?? '', counter, isoDate)
}

// The same caps calcTotals applies, so what the input shows is what the PDF takes off.
export function clampDiscount(kind: DiscountKind | null, value: number, base: number): number {
  if (kind === 'percent') return clampPercent(value)
  return Math.min(Math.max(0, value), Math.max(0, base))
}

export type DropEdge = 'before' | 'after'

// The index a row dragged from `from` ends up at when dropped on the `edge` of the row at `over`:
// exactly where the indicator line is drawn.
export function dropIndex(from: number, over: number, edge: DropEdge): number {
  const insertAt = edge === 'before' ? over : over + 1
  return insertAt > from ? insertAt - 1 : insertAt
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
