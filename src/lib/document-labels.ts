import { getDict, makeT, n, type DictKey, type TFn } from '@/lib/i18n'
import { defaultTemplate, resolveTemplate, type TemplateText } from '@/lib/templates'
import { countryName, toCountryCode } from '@/lib/utils/country'
import { formatDate, formatMoney, roundCents } from '@/lib/utils/document'
import { epcBeneficiary } from '@/lib/utils/epc-qr'
import type { DocumentKind, DocumentType, InvoiceKind, Language, Settings, Unit } from '@/types'

// One table for what a document and its parts are called. The PDF and the client portal print in
// the document's language (documentT); the app and its exports pass their UI-language t.

export function documentLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'de'
}

export function documentT(lang: Language): TFn {
  return makeT(lang)
}

export function documentKind(type: DocumentType, isStorno: boolean): DocumentKind {
  return type === 'credit_note' && isStorno ? 'storno' : type
}

// An advance, partial or final invoice is titled as one (§ 11 UStG: an advance invoice must say
// so); every invoice keeps the one invoice number range and its number label.
export const docTitle = (t: TFn, kind: DocumentKind, invoiceKind?: InvoiceKind | null) =>
  kind === 'invoice' && invoiceKind && invoiceKind !== 'standard' ? t(`deposits.title.${invoiceKind}`) : t(`pdfPortal.title.${kind}`)
export const invoiceKindLabel = (t: TFn, kind: InvoiceKind) => t(`deposits.kinds.${kind}`)
export const docNumberLabel = (t: TFn, kind: DocumentKind) => t(`pdfPortal.numberLabel.${kind}`)
export const recipientLabel = (t: TFn, kind: DocumentKind) => t(`pdfPortal.recipient.${kind}`)
export const docTypeLabel = (t: TFn, type: DocumentType) => t(`docTypes.${type}`)
export const statusLabel = (t: TFn, status: string) => t(`status.${status}` as DictKey)

// The email text of an invoice: the owner's own text as written; where the built-in one applies,
// that of an advance, partial or final invoice names it as such.
export function invoiceEmailTemplate(settings: Parameters<typeof resolveTemplate>[0], kind: InvoiceKind | null | undefined, lang: Language): TemplateText {
  const tpl = resolveTemplate(settings, 'invoice', lang)
  if (!kind || kind === 'standard') return tpl
  const builtIn = defaultTemplate('invoice', lang)
  const own = getDict(lang).deposits.email[kind]
  return {
    subject: tpl.subject === builtIn.subject ? own.subject : tpl.subject,
    body: tpl.body === builtIn.body ? own.body : tpl.body,
  }
}

export function unitLabel(t: TFn, unit: Unit, quantity: number): string {
  return n(quantity, t(`pdfPortal.unitsOne.${unit}`), t(`pdfPortal.units.${unit}`))
}

const locale = (lang: Language) => (lang === 'de' ? 'de-AT' : 'en-GB')

export function formatQuantity(value: number, lang: Language): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 4, useGrouping: false }).format(value)
}

export function formatPercent(t: TFn, value: number, lang: Language): string {
  return t('pdfPortal.percent', { value: new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 2 }).format(value) })
}

// Credits and discounts print with a real minus sign (Intl uses a hyphen), and never as "-0,00".
export function formatSignedMoney(amount: number, currency = 'EUR'): string {
  const value = roundCents(amount)
  return value < 0 ? `−${formatMoney(-value, currency)}` : formatMoney(Math.abs(value), currency)
}

export function formatIban(iban: string): string {
  return iban.replace(/\s/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

// "01.10.2026 – 05.10.2026" for a period, a single date when only one end is set.
export function servicePeriod(start: string | null | undefined, end: string | null | undefined, lang: Language) {
  if (start && end && end !== start) return { isPeriod: true, text: `${formatDate(start, lang)} – ${formatDate(end, lang)}` }
  const day = start || end
  return day ? { isPeriod: false, text: formatDate(day, lang) } : null
}

export type IssuerSettings = Pick<Settings,
  'company_name' | 'owner_name' | 'address_line1' | 'address_line2' | 'zip' | 'city' | 'country' |
  'phone' | 'email' | 'website' | 'uid_number' | 'iban' | 'bic' | 'bank_name' | 'bank_account_holder'>

function lines(values: (string | null | undefined | false)[]): string[] {
  return values.map(v => (v || '').trim()).filter(Boolean)
}

// The issuer as every printed document shows it (§ 11 UStG: name, address, UID), without empty
// lines. bank is empty without an IBAN.
export function issuerBlocks(s: IssuerSettings, t: TFn, lang: Language) {
  const company = s.company_name?.trim()
  const owner = s.owner_name?.trim()
  return {
    address: lines([
      company || owner,
      company && owner && owner !== company && t('pdfPortal.issuer.owner', { name: owner }),
      s.address_line1,
      s.address_line2,
      [s.zip, s.city].map(v => v?.trim()).filter(Boolean).join(' '),
      // Settings may still hold a free-text name such as the old default 'Austria'.
      countryName(toCountryCode(s.country) ?? s.country, lang),
    ]),
    contact: lines([
      s.phone,
      s.email,
      s.website,
      s.uid_number?.trim() && `${t('pdfPortal.issuer.uid')} ${s.uid_number.trim()}`,
    ]),
    bank: s.iban?.trim()
      ? lines([
          epcBeneficiary(s),
          s.bank_name,
          `${t('pdfPortal.payment.iban')} ${formatIban(s.iban)}`,
          s.bic?.trim() && `${t('pdfPortal.payment.bic')} ${s.bic.trim()}`,
        ])
      : [],
  }
}
