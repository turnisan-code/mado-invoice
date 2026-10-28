import { getDict, makeT } from '@/lib/i18n'
import { clientDisplayName, type NamedClient } from '@/lib/utils/clients'
import { addDays, skontoAmount, skontoDeadline, viennaDate } from '@/lib/utils/document'
import type { DocumentType, EmailTemplateKind, Language, Settings } from '@/types'

// The one engine behind every email the app writes: document emails from the builder, manual and
// automatic reminders, and the settings preview. Templates are plain text with {{variable}} tokens.

const ALL: readonly EmailTemplateKind[] = ['invoice', 'quote', 'credit_note', 'reminder']
const INVOICE_LIKE: readonly EmailTemplateKind[] = ['invoice', 'reminder']
const REMINDER: readonly EmailTemplateKind[] = ['reminder']

// Which template offers which variable. Every variable here resolves (possibly to '') in every
// template, so a token copied from another template never stays visible in an email.
export const TEMPLATE_VARIABLES = {
  invoice_number: ALL,
  client: ALL,
  contact: ALL,
  date: ALL,
  due_date: ['invoice', 'quote', 'reminder'],
  subtotal: ['invoice', 'quote', 'credit_note'],
  total: ALL,
  balance_due: INVOICE_LIKE,
  payment_terms: ['invoice'],
  skonto: ['invoice'],
  skonto_date: ['invoice'],
  late_fee: INVOICE_LIKE,
  interest_rate: INVOICE_LIKE,
  iban: INVOICE_LIKE,
  portal_link: ALL,
  sender: ALL,
  company: ALL,
  owner: ALL,
  reminder_title: REMINDER,
  level: REMINDER,
  amount: REMINDER,
  days_overdue: REMINDER,
  new_deadline: REMINDER,
  fee: REMINDER,
  interest: REMINDER,
  total_due: REMINDER,
} as const satisfies Record<string, readonly EmailTemplateKind[]>

export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES
export type TemplateVars = Partial<Record<TemplateVariable, string>>

const VARIABLE_NAMES = Object.keys(TEMPLATE_VARIABLES) as TemplateVariable[]

export function variablesFor(kind: EmailTemplateKind): TemplateVariable[] {
  return VARIABLE_NAMES.filter(name => (TEMPLATE_VARIABLES[name] as readonly EmailTemplateKind[]).includes(kind))
}

function isVariable(name: string): name is TemplateVariable {
  return Object.hasOwn(TEMPLATE_VARIABLES, name)
}

const TOKEN = /\{\{\s*(\w+)\s*\}\}/g

export function usesVariable(template: string | null | undefined, name: TemplateVariable): boolean {
  if (!template) return false
  for (const match of template.matchAll(TOKEN)) if (match[1] === name) return true
  return false
}

// One pass over the template: a substituted value is never scanned again, so a client called
// "{{iban}}" stays literal. Unknown tokens stay visible so a typo shows up in the preview. A line
// whose tokens all resolve to '' (e.g. "Mahnspesen: {{fee}}" on a Zahlungserinnerung) is dropped,
// so one template serves documents with and without Skonto, fees or a portal link.
export function fillTemplate(template: string, vars: TemplateVars): string {
  const lines: string[] = []
  let dropped = false
  for (const line of template.replace(/\r\n?/g, '\n').split('\n')) {
    let tokens = 0
    let empty = 0
    const filled = line.replace(TOKEN, (raw, name: string) => {
      if (!isVariable(name)) return raw
      tokens++
      const value = vars[name] ?? ''
      if (!value) empty++
      return value
    })
    if (tokens > 0 && tokens === empty) { dropped = true; continue }
    lines.push(filled)
  }
  const out = lines.join('\n')
  return dropped ? out.replace(/\n{3,}/g, '\n\n') : out
}

// A subject is a mail header: whatever a value contains, it stays on one line.
export function fillSubject(template: string, vars: TemplateVars): string {
  return fillTemplate(template, vars).replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

// ── Formatting in the document's language ──────────────────────────────────────

// 28.10.2026 for German documents, 28/10/2026 for English ones. Date-only values are taken as
// calendar dates; timestamps are read as Vienna dates.
export function templateDate(value: string | null | undefined, lang: Language): string {
  if (!value) return ''
  let iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  if (!iso) {
    const d = new Date(value)
    if (isNaN(d.getTime())) return value
    iso = viennaDate(d)
  }
  const [y, m, d] = iso.split('-')
  return lang === 'en' ? `${d}/${m}/${y}` : `${d}.${m}.${y}`
}

export function templateMoney(amount: number, lang: Language, currency: string | null = 'EUR'): string {
  return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-AT', { style: 'currency', currency: currency || 'EUR' }).format(amount)
}

export function templatePercent(value: number, lang: Language): string {
  const n = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'de-AT', { maximumFractionDigits: 2 }).format(value)
  return lang === 'en' ? `${n}%` : `${n} %`
}

export function formatIban(iban: string | null | undefined): string {
  return (iban ?? '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

// ── Built-in texts ─────────────────────────────────────────────────────────────

export type TemplateText = { subject: string; body: string }

type TemplateSettings = Partial<Pick<Settings,
  | 'email_subject_invoice_de' | 'email_body_invoice_de' | 'email_subject_invoice_en' | 'email_body_invoice_en'
  | 'email_subject_quote_de' | 'email_body_quote_de' | 'email_subject_quote_en' | 'email_body_quote_en'
  | 'email_subject_credit_note_de' | 'email_body_credit_note_de' | 'email_subject_credit_note_en' | 'email_body_credit_note_en'
  | 'email_subject_reminder_de' | 'email_body_reminder_de' | 'email_subject_reminder_en' | 'email_body_reminder_en'
>>

// Reminders escalate in tone: level 1 is the Zahlungserinnerung, 2 the 1. Mahnung, 3+ the 2. Mahnung.
export function defaultTemplate(kind: EmailTemplateKind, lang: Language, level = 1): TemplateText {
  const defaults = getDict(lang).dunning.defaults
  if (kind !== 'reminder') return defaults[kind]
  return level <= 1 ? defaults.reminder1 : level === 2 ? defaults.reminder2 : defaults.reminder3
}

// What "Start from the built-in text" puts in the field. The owner's reminder text serves every
// level, so it starts from one that lists fee, interest and total wherever the Mahnung charges them.
export function starterTemplate(kind: EmailTemplateKind, lang: Language): TemplateText {
  return kind === 'reminder' ? getDict(lang).dunning.defaults.reminderCustom : defaultTemplate(kind, lang)
}

// The owner's text where there is one, the built-in text for the rest (subject and body separately).
export function resolveTemplate(settings: TemplateSettings, kind: EmailTemplateKind, lang: Language, level = 1): TemplateText {
  const fallback = defaultTemplate(kind, lang, level)
  return {
    subject: settings[`email_subject_${kind}_${lang}`] || fallback.subject,
    body: settings[`email_body_${kind}_${lang}`] || fallback.body,
  }
}

// ── Variables of a document email ──────────────────────────────────────────────

export interface TemplateDocument {
  type: DocumentType
  number: string | null
  date: string
  due_date: string | null
  language: Language
  currency?: string | null
  skonto_percent?: number | null
  skonto_days?: number | null
}

export type TemplateIssuer = Pick<Settings, 'company_name' | 'owner_name' | 'iban' | 'reminder_fee' | 'reminder_interest_rate'>

export function templateLang(lang: string | null | undefined): Language {
  return lang === 'en' ? 'en' : 'de'
}

export function senderName(issuer: Pick<Settings, 'company_name' | 'owner_name'>): string {
  return issuer.company_name?.trim() || issuer.owner_name?.trim() || ''
}

// "Zahlbar bis 11.11.2026. Bei Zahlung bis 04.11.2026 2 % Skonto (€ 28,80)."
export function paymentTermsText(doc: TemplateDocument, total: number): string {
  if (doc.type !== 'invoice') return ''
  const lang = templateLang(doc.language)
  const t = makeT(lang)
  const parts: string[] = []
  if (doc.due_date) parts.push(t('dunning.terms.payable', { date: templateDate(doc.due_date, lang) }))
  const skonto = skontoAmount(total, doc.skonto_percent)
  if (skonto > 0 && doc.skonto_days != null) {
    parts.push(t('dunning.terms.skonto', {
      date: templateDate(skontoDeadline(doc.date, doc.skonto_days), lang),
      percent: templatePercent(doc.skonto_percent!, lang),
      amount: templateMoney(skonto, lang, doc.currency ?? 'EUR'),
    }))
  }
  return parts.join(' ')
}

export function documentVariables({ doc, client, issuer, totals, portalLink = '' }: {
  doc: TemplateDocument
  client: NamedClient | null | undefined
  issuer: TemplateIssuer
  totals: { subtotal: number; total: number; balance_due: number }
  portalLink?: string
}): TemplateVars {
  const lang = templateLang(doc.language)
  const t = makeT(lang)
  const money = (amount: number) => templateMoney(amount, lang, doc.currency ?? 'EUR')
  const skonto = doc.type === 'invoice' ? skontoAmount(totals.total, doc.skonto_percent) : 0
  const hasSkonto = skonto > 0 && doc.skonto_days != null
  const fee = Number(issuer.reminder_fee) || 0
  const rate = Number(issuer.reminder_interest_rate) || 0
  return {
    invoice_number: doc.number ?? '',
    client: clientDisplayName(client),
    contact: client?.name?.trim() || client?.company?.trim() || '',
    date: templateDate(doc.date, lang),
    due_date: templateDate(doc.due_date, lang),
    subtotal: money(totals.subtotal),
    total: money(totals.total),
    balance_due: money(totals.balance_due),
    payment_terms: paymentTermsText(doc, totals.total),
    skonto: hasSkonto ? `${templatePercent(doc.skonto_percent!, lang)} (${money(skonto)})` : '',
    skonto_date: hasSkonto ? templateDate(skontoDeadline(doc.date, doc.skonto_days), lang) : '',
    late_fee: fee > 0 ? money(fee) : '',
    interest_rate: rate > 0 ? t('dunning.terms.perAnnum', { rate: templatePercent(rate, lang) }) : '',
    iban: formatIban(issuer.iban),
    portal_link: portalLink,
    sender: senderName(issuer),
    company: issuer.company_name ?? '',
    owner: issuer.owner_name ?? '',
  }
}

// ── Recipients ─────────────────────────────────────────────────────────────────

// A bare address that is safe in a mail header: no display name, quotes, brackets or separators.
const PLAIN_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/

export function isPlainAddress(value: string): boolean {
  return PLAIN_ADDRESS.test(value)
}

// A list typed into a CC/BCC field or stored on the client: split on commas, semicolons or
// whitespace, duplicates removed (case-insensitive), invalid entries reported, not dropped.
export function parseEmailList(value: string | readonly string[] | null | undefined): { emails: string[]; invalid: string[] } {
  const parts = (Array.isArray(value) ? value : [value ?? '']).flatMap(v => String(v).split(/[\s,;]+/))
  const emails: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of parts) {
    const email = raw.trim()
    if (!email) continue
    if (!isPlainAddress(email)) { invalid.push(email); continue }
    if (seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    emails.push(email)
  }
  return { emails, invalid }
}

export function portalUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/portal/${token}`
}

// ── Settings preview ───────────────────────────────────────────────────────────

const SAMPLE_NUMBERS: Record<DocumentType, string> = { invoice: 'RE-2026-0042', quote: 'AN-2026-0017', credit_note: 'GS-2026-0003' }

// A plausible document for the live preview: 1.200,00 net + 20 % VAT, issued 30 days ago.
export function sampleDocument(kind: EmailTemplateKind, lang: Language, today: string, skonto: { percent: number | null; days: number | null }): {
  doc: TemplateDocument
  client: NamedClient
  totals: { subtotal: number; total: number; balance_due: number }
} {
  const type: DocumentType = kind === 'reminder' ? 'invoice' : kind
  const date = addDays(today, -30)
  const dict = getDict(lang).dunning.sample
  return {
    doc: {
      type,
      number: SAMPLE_NUMBERS[type],
      date,
      due_date: type === 'credit_note' ? null : addDays(date, 14),
      language: lang,
      currency: 'EUR',
      skonto_percent: type === 'invoice' ? skonto.percent : null,
      skonto_days: type === 'invoice' ? skonto.days : null,
    },
    client: { name: dict.contact, company: dict.company },
    totals: { subtotal: 1200, total: 1440, balance_due: 1440 },
  }
}
