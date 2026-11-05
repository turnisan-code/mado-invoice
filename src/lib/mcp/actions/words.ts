// Sentences the irreversible actions store and show: the label, the notices and the result. They
// are kept as a dictionary key with language-neutral values, so the same row reads in English for
// Claude (the label Claude echoes is the English text) and in the owner's language on the
// approval page. Pure: the page and the server share it.
import type { DictKey, TFn, UiLang } from '@/lib/i18n'
import { knownApiError } from '@/lib/api-errors'
import { bookamatErrorMessage } from '@/lib/bookamat-client'
import { lifecycleErrorMessage } from '@/lib/status'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { DocumentType } from '@/types'

// A failure stored with an action: the English ToolError Claude gets, plus the dictionary key of
// a refusal (common.ts storedError).
export interface StoredError {
  code: string
  message: string
  details?: Record<string, unknown>
  worded?: Worded
}

export type WordValue =
  | string
  | number
  | { money: number; currency?: string | null }
  | { date: string }
  | { docType: DocumentType }
  | { list: string[] }
  // Time entries and expenses, each counted in the singular or plural, a zero left out.
  | { entries: { time: number; expenses: number } }
  | { error: StoredError }

export interface Worded {
  key: DictKey
  vars?: Record<string, WordValue>
}

function entriesText(t: TFn, { time, expenses }: { time: number; expenses: number }): string {
  const timeText = t(time === 1 ? 'mcp.approve.nouns.timeEntry' : 'mcp.approve.nouns.timeEntries', { count: time })
  const expensesText = t(expenses === 1 ? 'mcp.approve.nouns.expense' : 'mcp.approve.nouns.expenses', { count: expenses })
  if (!expenses) return timeText
  if (!time) return expensesText
  return t('mcp.approve.nouns.both', { time: timeText, expenses: expensesText })
}

function value(t: TFn, lang: UiLang, v: WordValue): string | number {
  if (typeof v === 'string' || typeof v === 'number') return v
  if ('money' in v) return formatMoney(v.money, v.currency || 'EUR', lang)
  if ('date' in v) return formatDate(v.date, lang)
  if ('docType' in v) return t(`mcp.approve.types.${v.docType}`)
  if ('entries' in v) return entriesText(t, v.entries)
  if ('error' in v) return errorText(t, lang, v.error)
  return v.list.join(', ')
}

export function word(t: TFn, lang: UiLang, w: Worded): string {
  const vars = w.vars ? Object.fromEntries(Object.entries(w.vars).map(([k, v]) => [k, value(t, lang, v)])) : undefined
  return t(w.key, vars)
}

export const money = (amount: number, currency?: string | null): WordValue => ({ money: amount, currency: currency ?? 'EUR' })

export const entries = (time: number, expenses: number): WordValue => ({ entries: { time, expenses } })

// Stored text is untrusted (client names come from the database, addresses and subjects from
// Claude): one line.
export function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

// One line, and short enough for a label.
export function clip(text: string | null | undefined, max = 60): string {
  const line = oneLine(text)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function isWorded(value: unknown): value is Worded {
  return !!value && typeof value === 'object' && typeof (value as Worded).key === 'string' && (value as Worded).key.startsWith('mcp.approve.')
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// A stored failure in the given language where the app words its code or kept its dictionary
// key; otherwise the English text it was stored with.
export function errorText(t: TFn, lang: UiLang, error: unknown): string {
  const e = obj(error)
  const code = str(e.code)
  const message = str(e.message)
  const details = obj(e.details)
  if (isWorded(e.worded)) return word(t, lang, e.worded)
  if (code.startsWith('einvoice_')) return t(`einvoice.errors.${code.slice('einvoice_'.length)}` as 'einvoice.errors.not_issued')
  if (code.startsWith('bookamat_')) return bookamatErrorMessage(t, { code: code.slice('bookamat_'.length), error: message, detail: details.detail ?? details })
  if (/^MI0\d\d$/.test(code)) return lifecycleErrorMessage({ code, message, details: str(details.detail) || null }, t)
  if (code === 'state_changed') return t('mcp.errors.stateChanged')
  if (code === 'deadline') return t('mcp.errors.deadline')
  if (code === 'not_found') return t('mcp.errors.notFound')
  if (code === 'database') return t('messages.api.database')
  if (code === 'internal') return t('messages.api.server_error')
  return knownApiError(t, { code, error: message, problems: details.problems }) ?? (message || t('mcp.approve.errors.generic'))
}
