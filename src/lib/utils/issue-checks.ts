// What a document needs before it may get a number. Pure (type imports, the totals maths and the
// deposit rules), so the builder runs it on the editor state, the server on the stored document,
// and node can verify it directly. issue_document (supabase/migrations/20261031_editor.sql) enforces the
// same rules in SQL.
import type { TFn } from '@/lib/i18n'
import { depositProblems, isDeductionLine, type DepositCheck } from '@/lib/deposits'
import type { DocumentType, IssueProblem, IssuerField } from '@/types'
import { calcTotals, lineDiscountOutOfRange } from './document'

export interface IssueCheckItem {
  line_type?: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  vat_rate?: number | null
  discount_type?: string | null
  discount_value?: number | null
  service_date: string | null
  service_date_end?: string | null
}

export interface IssuerSettings {
  company_name: string | null
  address_line1: string | null
  zip: string | null
  city: string | null
  uid_number: string | null
  iban: string | null
}

export const ISSUER_SETTINGS_COLUMNS = 'company_name, address_line1, zip, city, uid_number, iban'

export interface IssueCheckInput {
  type: DocumentType
  currency: string | null
  taxTreatment: string | null
  serviceDate: string | null
  serviceDateEnd: string | null
  // A Storno mirrors the invoice it cancels and must stay possible even when that invoice was
  // incomplete, so only the issuer, the client and the presence of lines are checked.
  isStorno: boolean
  client: { uid_number: string | null; country: string | null } | null
  items: IssueCheckItem[]
  settings: IssuerSettings | null
  // Invoices: what kind of invoice it is and, for a final invoice, what it deducts.
  deposit?: DepositCheck
}

const blank = (s: string | null | undefined) => !s || !s.trim()

export function missingIssuerFields(s: IssuerSettings | null | undefined): IssuerField[] {
  if (!s) return ['companyName', 'address', 'uid', 'iban']
  const missing: IssuerField[] = []
  if (blank(s.company_name)) missing.push('companyName')
  if (blank(s.address_line1) || blank(s.zip) || blank(s.city)) missing.push('address')
  if (blank(s.uid_number)) missing.push('uid')
  if (blank(s.iban)) missing.push('iban')
  return missing
}

// Quotes are offers, not invoices: § 11 UStG (service date, recipient UID) applies to invoices
// and credit notes only.
export function issueProblems(input: IssueCheckInput): IssueProblem[] {
  const problems: IssueProblem[] = []
  const missing = missingIssuerFields(input.settings)
  if (missing.length) problems.push({ code: 'settingsIncomplete', fields: missing })
  if (!input.client) problems.push({ code: 'noClient' })

  const items = input.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.line_type ?? 'item') === 'item')
  if (!items.length) problems.push({ code: 'noItems' })
  // Invoices and quotes are EUR only; a credit note keeps the currency of the invoice it corrects.
  if (input.type !== 'credit_note' && input.currency !== 'EUR') problems.push({ code: 'currencyNotEur' })
  if (input.isStorno) return problems

  const invoiceLike = input.type !== 'quote'
  const { client, taxTreatment } = input
  if (invoiceLike && client && taxTreatment === 'eu_reverse_charge' && blank(client.uid_number)) {
    problems.push({ code: 'reverseChargeNoUid' })
  }
  if (invoiceLike && client && (taxTreatment === 'eu_reverse_charge' || taxTreatment === 'non_eu') && blank(client.country)) {
    problems.push({ code: 'clientCountryMissing' })
  }

  if (!input.serviceDate && input.serviceDateEnd) problems.push({ code: 'periodStartMissing' })
  else if (input.serviceDate && input.serviceDateEnd && input.serviceDateEnd < input.serviceDate) problems.push({ code: 'periodEndBeforeStart' })

  items.forEach(({ item, index }, n) => {
    const line = { index, position: n + 1 }
    if (blank(item.description)) problems.push({ code: 'blankDescription', ...line })
    if (item.quantity == null || !(item.quantity > 0)) problems.push({ code: 'badQuantity', ...line })
    if (item.unit_price == null || !Number.isFinite(item.unit_price)) problems.push({ code: 'missingPrice', ...line })
    if (lineDiscountOutOfRange(item)) problems.push({ code: 'badDiscount', ...line })
    if (!item.service_date && item.service_date_end) problems.push({ code: 'periodStartMissing', ...line })
    else if (item.service_date && item.service_date_end && item.service_date_end < item.service_date) problems.push({ code: 'periodEndBeforeStart', ...line })
  })

  if (invoiceLike && items.length && !input.serviceDate && items.some(({ item }) => !item.service_date)) {
    problems.push({ code: 'noServiceDate' })
  }
  // Money going back is a credit note. A document discount never changes the sign of the
  // total (it is capped at the net), so the lines decide.
  if (input.type !== 'credit_note' && items.length && issueTotal(input) < 0) problems.push({ code: 'negativeTotal' })
  if (input.type === 'invoice' && input.deposit) problems.push(...depositProblems({ items: input.items, taxTreatment, deposit: input.deposit }))
  return problems
}

// The document's total before its document-level discount and a final invoice's deductions
// (checked on their own), as calcTotals computes it.
export function issueTotal(input: Pick<IssueCheckInput, 'items' | 'taxTreatment'>): number {
  const lines = input.items.filter(i => !isDeductionLine(i)).map(i => ({ ...i, vat_rate: i.vat_rate ?? null }))
  return calcTotals(lines, [], null, input.taxTreatment).total
}

export function issueProblemMessage(p: IssueProblem, t: TFn): string {
  switch (p.code) {
    case 'settingsIncomplete':
      return t('issueChecks.problems.settingsIncomplete', { fields: p.fields.map(f => t(`issueChecks.issuerFields.${f}`)).join(', ') })
    case 'blankDescription':
    case 'badQuantity':
    case 'missingPrice':
      return t(`issueChecks.problems.${p.code}`, { position: p.position })
    case 'periodStartMissing':
    case 'periodEndBeforeStart':
      return p.position ? t(`issueChecks.problems.${p.code}Line`, { position: p.position }) : t(`issueChecks.problems.${p.code}`)
    case 'badDiscount':
      return t('editor.problems.badDiscount', { position: p.position })
    case 'negativeTotal':
      return t('editor.problems.negativeTotal')
    case 'depositZero':
    case 'deductionExceedsTotal':
    case 'deductionsOutdated':
      return t(`deposits.problems.${p.code}`)
    case 'advanceOpen':
    case 'advanceSettledElsewhere':
      return t(`deposits.problems.${p.code}`, { number: p.number })
    default:
      return t(`issueChecks.problems.${p.code}`)
  }
}

export class IssueCheckError extends Error {
  problems: IssueProblem[]

  constructor(problems: IssueProblem[], t: TFn) {
    super(problems.map(p => issueProblemMessage(p, t)).join(' '))
    this.name = 'IssueCheckError'
    this.problems = problems
  }
}
