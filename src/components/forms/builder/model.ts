// The editor's data model: pure functions only, so node can verify them without React.
import type { Client, Currency, Document, DocumentItem, DocumentType, Language, LineType, Settings, TaxTreatment, Unit, VatRate } from '@/types'
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
  lines: LineItem[]
}

export type EditorDocument = Document & { items?: DocumentItem[]; payments?: { id: string; date: string; amount: number; note: string | null }[] }

export const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
export const VAT_RATES: VatRate[] = [0, 10, 13, 20]
export const AUTOSAVE_DELAY = 2000
export const PATHS: Record<DocumentType, string> = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes' }

export function makeId() { return Math.random().toString(36).slice(2) }

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

export function linesFromItems(items: DocumentItem[]): LineItem[] {
  return orderItems(items).map(i => ({
    id: makeId(),
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
    // Skonto only exists on invoices; new ones start from the settings defaults.
    skontoPercent: doc ? (doc.skonto_percent ?? '') : type === 'invoice' ? (settings.default_skonto_percent ?? '') : '',
    skontoDays: doc ? (doc.skonto_days ?? '') : type === 'invoice' ? (settings.default_skonto_days ?? '') : '',
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
    ...skonto,
    ...(f.currency === 'EUR' ? { exchange_rate: 1 } : {}),
  }
}

// Item lines carry their own discount, subtotal lines the section's; other lines none.
export function itemsPayload(lines: LineItem[]) {
  return lines.map((l, i) => {
    const item = l.line_type === 'item'
    const discounted = item || l.line_type === 'subtotal'
    return {
      sort_order: i,
      line_type: l.line_type,
      description: l.description,
      service_date: item ? (l.service_date || null) : null,
      service_date_end: item ? (l.service_date_end || null) : null,
      quantity: item ? l.quantity : null,
      unit: item ? l.unit : null,
      unit_price: item ? l.unit_price : null,
      vat_rate: item ? l.vat_rate : null,
      catalogue_item_id: item ? l.catalogue_item_id : null,
      discount_type: discounted ? (l.discount_type || null) : null,
      discount_value: discounted ? (l.discount_value || null) : null,
    }
  })
}

// Exactly what a save writes, so a document reloaded from the database has the key it was saved with.
export function savedKeyOf(type: DocumentType, f: FormState): string {
  return JSON.stringify([docFields(type, f), itemsPayload(f.lines)])
}

// What the user wrote beyond the client and what follows from it (language, tax, due date):
// a new document is only created once there is something worth keeping.
export function contentKeyOf(f: FormState): string {
  return JSON.stringify([f.date, f.serviceDate, f.serviceDateEnd, f.notes, f.notesInternal, f.discountType, f.discountValue, f.skontoPercent, f.skontoDays, itemsPayload(f.lines)])
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
