import type { Language, Settings } from '@/types'
import type { NamedClient } from './clients'
import { addDays, roundCents, today as viennaToday } from './document'
import {
  documentVariables, resolveTemplate, templateDate, templateLang, templateMoney,
  type TemplateDocument, type TemplateIssuer, type TemplateText, type TemplateVars,
} from '@/lib/templates'

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

export type ReminderIssuer = TemplateIssuer & Pick<Settings, 'reminder_grace_days'>

export interface ReminderFigures {
  level: number
  title: string
  issuedOn: string
  daysOverdue: number
  balance: number
  fee: number
  interestRate: number
  interest: number
  totalDue: number
  newDeadline: string
}

// What a reminder asks for on `issuedOn`: the open balance, Mahnspesen from the 1. Mahnung on,
// Verzugszinsen on the balance for the days past the due date, and a new deadline after the grace period.
export function reminderFigures({ dueDate, balance, issuer, level, lang, issuedOn = viennaToday() }: {
  dueDate: string | null
  balance: number
  issuer: Pick<Settings, 'reminder_fee' | 'reminder_interest_rate' | 'reminder_grace_days'>
  level: number
  lang: Language
  issuedOn?: string
}): ReminderFigures {
  const daysOverdue = dueDate ? Math.max(0, daysBetween(dueDate, issuedOn)) : 0
  const fee = level >= 2 ? roundCents(Math.max(0, Number(issuer.reminder_fee) || 0)) : 0
  const interestRate = Math.max(0, Number(issuer.reminder_interest_rate) || 0)
  const interest = roundCents(balance * (interestRate / 100) * daysOverdue / 365)
  return {
    level,
    title: reminderTitle(level, lang),
    issuedOn,
    daysOverdue,
    balance,
    fee,
    interestRate,
    interest,
    totalDue: roundCents(balance + fee + interest),
    newDeadline: addDays(issuedOn, Math.max(0, Number(issuer.reminder_grace_days) || 0)),
  }
}

export function reminderVariables({ doc, client, issuer, totals, figures, portalLink = '' }: {
  doc: TemplateDocument
  client: NamedClient | null | undefined
  issuer: TemplateIssuer
  totals: { subtotal: number; total: number; balance_due: number }
  figures: ReminderFigures
  portalLink?: string
}): TemplateVars {
  const lang = templateLang(doc.language)
  const money = (amount: number) => templateMoney(amount, lang, doc.currency ?? 'EUR')
  const extra = figures.fee + figures.interest
  return {
    ...documentVariables({ doc, client, issuer, totals, portalLink }),
    reminder_title: figures.title,
    level: String(figures.level),
    amount: money(figures.balance),
    days_overdue: String(figures.daysOverdue),
    new_deadline: templateDate(figures.newDeadline, lang),
    fee: figures.fee > 0 ? money(figures.fee) : '',
    interest: figures.interest > 0 ? money(figures.interest) : '',
    total_due: extra > 0 ? money(figures.totalDue) : '',
  }
}

type ReminderTemplateSettings = Pick<Settings,
  'email_subject_reminder_de' | 'email_body_reminder_de' | 'email_subject_reminder_en' | 'email_body_reminder_en'
>

export function reminderTemplates(settings: ReminderTemplateSettings, lang: Language, level: number): TemplateText {
  return resolveTemplate(settings, 'reminder', lang, level)
}
