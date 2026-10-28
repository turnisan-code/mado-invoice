import type { Settings } from '@/types'
import { addDays, formatDate, formatMoney, roundCents, today } from './document'

export interface ReminderContext {
  invoiceNumber: string
  clientName: string
  amount: string      // what is still owed (balance due)
  total: string       // invoice total
  dueDate: string
  date: string
  daysOverdue: number
  iban: string
  sender: string
  company: string
  owner: string
  level: number
  reminderTitle: string
  fee: string         // Mahnspesen, '' below level 2 or when not configured
  interest: string    // Verzugszinsen, '' when zero
  newDeadline: string // Nachfrist: today + grace days
}

// Single-pass replacement prevents chained injection (e.g. a client name
// containing "{{iban}}" being substituted again in a later pass).
// A line whose placeholders all resolve to '' (e.g. "Mahnspesen: {{fee}}" on a
// Zahlungserinnerung) is dropped, so one template serves every dunning level.
export function fillTemplate(template: string, ctx: ReminderContext): string {
  const map: Record<string, string> = {
    invoice_number: ctx.invoiceNumber,
    client:         ctx.clientName,
    amount:         ctx.amount,
    total:          ctx.total,
    balance_due:    ctx.amount,
    due_date:       ctx.dueDate,
    date:           ctx.date,
    days_overdue:   String(ctx.daysOverdue),
    iban:           ctx.iban,
    sender:         ctx.sender,
    company:        ctx.company,
    owner:          ctx.owner,
    reminder_title: ctx.reminderTitle,
    level:          String(ctx.level),
    fee:            ctx.fee,
    interest:       ctx.interest,
    new_deadline:   ctx.newDeadline,
  }
  const lines: string[] = []
  let dropped = false
  for (const line of template.split('\n')) {
    let placeholders = 0
    let empty = 0
    const filled = line.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in map)) return `{{${key}}}`
      placeholders++
      if (map[key] === '') empty++
      return map[key]
    })
    if (placeholders > 0 && placeholders === empty) { dropped = true; continue }
    lines.push(filled)
  }
  const out = lines.join('\n')
  return dropped ? out.replace(/\n{3,}/g, '\n\n') : out
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

// Level 1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung, …
export function reminderTitle(level: number, lang: 'de' | 'en'): string {
  if (level <= 1) return lang === 'de' ? 'Zahlungserinnerung' : 'Payment reminder'
  return lang === 'de' ? `${level - 1}. Mahnung` : `${ordinal(level - 1)} dunning notice`
}

// The level the next reminder carries: one above the current one, never above the configured maximum
// (resending at the maximum repeats the last level).
export function nextReminderLevel(currentLevel: number | null | undefined, maxLevel: number | null | undefined): number {
  const max = Math.max(1, maxLevel ?? 3)
  return Math.min((currentLevel ?? 0) + 1, max)
}

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.floor((Date.parse(toIsoDate) - Date.parse(fromIsoDate)) / 86400000)
}

type ReminderSettings = Pick<Settings,
  'iban' | 'company_name' | 'owner_name' | 'reminder_fee' | 'reminder_interest_rate' | 'reminder_grace_days'
>

export function buildReminderContext({ invoice, client, settings, totals, level, lang }: {
  invoice: { number: string; date: string | null; due_date: string | null; currency?: string | null }
  client: { name: string; company: string | null }
  settings: ReminderSettings
  totals: { total: number; balance_due: number }
  level: number
  lang: 'de' | 'en'
}): ReminderContext {
  const currency = invoice.currency ?? 'EUR'
  const now = today()
  const daysOverdue = invoice.due_date ? Math.max(0, daysBetween(invoice.due_date, now)) : 0
  const fee = level >= 2 ? roundCents(Number(settings.reminder_fee) || 0) : 0
  const rate = Number(settings.reminder_interest_rate) || 0
  const interest = roundCents(totals.balance_due * (rate / 100) * daysOverdue / 365)
  return {
    invoiceNumber: invoice.number,
    clientName: client.company ?? client.name,
    amount: formatMoney(totals.balance_due, currency),
    total: formatMoney(totals.total, currency),
    dueDate: invoice.due_date ? formatDate(invoice.due_date, lang) : '',
    date: invoice.date ? formatDate(invoice.date, lang) : '',
    daysOverdue,
    iban: settings.iban ?? '',
    sender: settings.company_name ?? settings.owner_name ?? '',
    company: settings.company_name ?? '',
    owner: settings.owner_name ?? '',
    level,
    reminderTitle: reminderTitle(level, lang),
    fee: fee > 0 ? formatMoney(fee, currency) : '',
    interest: interest > 0 ? formatMoney(interest, currency) : '',
    newDeadline: formatDate(addDays(now, Number(settings.reminder_grace_days) || 0), lang),
  }
}

type ReminderTemplateSettings = Pick<Settings,
  'email_subject_reminder_de' | 'email_body_reminder_de' | 'email_subject_reminder_en' | 'email_body_reminder_en'
>

export function reminderTemplates(settings: ReminderTemplateSettings, lang: 'de' | 'en'): { subject: string; body: string } {
  return lang === 'en'
    ? { subject: settings.email_subject_reminder_en || DEFAULT_SUBJECT_EN, body: settings.email_body_reminder_en || DEFAULT_BODY_EN }
    : { subject: settings.email_subject_reminder_de || DEFAULT_SUBJECT_DE, body: settings.email_body_reminder_de || DEFAULT_BODY_DE }
}

export const DEFAULT_SUBJECT_DE = '{{reminder_title}}: Rechnung {{invoice_number}}'
export const DEFAULT_BODY_DE = `Sehr geehrte(r) {{client}},

wir möchten Sie daran erinnern, dass Rechnung {{invoice_number}} über {{amount}} am {{due_date}} fällig war und nun seit {{days_overdue}} Tagen überfällig ist.

Bitte überweisen Sie den offenen Betrag bis spätestens {{new_deadline}} auf folgende Bankverbindung:
IBAN: {{iban}}

Mahnspesen: {{fee}}
Verzugszinsen: {{interest}}

Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.

Mit freundlichen Grüßen,
{{sender}}`

export const DEFAULT_SUBJECT_EN = '{{reminder_title}}: Invoice {{invoice_number}}'
export const DEFAULT_BODY_EN = `Dear {{client}},

This is a reminder that invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is now {{days_overdue}} days overdue.

Please transfer the outstanding amount by {{new_deadline}} to:
IBAN: {{iban}}

Reminder fee: {{fee}}
Late payment interest: {{interest}}

If your payment has crossed with this message, please disregard it.

Best regards,
{{sender}}`
