// Sentences the irreversible actions store and show: the label, the notices and the result. They
// are kept as a dictionary key with language-neutral values, so the same row reads in English for
// Claude (the label Claude echoes is the English text) and in the owner's language on the
// approval page. Pure: the page and the server share it.
import type { DictKey, TFn, UiLang } from '@/lib/i18n'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { DocumentType } from '@/types'

export type WordValue =
  | string
  | number
  | { money: number; currency?: string | null }
  | { date: string }
  | { docType: DocumentType }
  | { list: string[] }

export interface Worded {
  key: DictKey
  vars?: Record<string, WordValue>
}

function value(t: TFn, lang: UiLang, v: WordValue): string | number {
  if (typeof v === 'string' || typeof v === 'number') return v
  if ('money' in v) return formatMoney(v.money, v.currency || 'EUR', lang)
  if ('date' in v) return formatDate(v.date, lang)
  if ('docType' in v) return t(`mcp.approve.types.${v.docType}`)
  return v.list.join(', ')
}

export function word(t: TFn, lang: UiLang, w: Worded): string {
  const vars = w.vars ? Object.fromEntries(Object.entries(w.vars).map(([k, v]) => [k, value(t, lang, v)])) : undefined
  return t(w.key, vars)
}

export const money = (amount: number, currency?: string | null): WordValue => ({ money: amount, currency: currency ?? 'EUR' })

// Stored text is untrusted (client names come from the database, addresses and subjects from
// Claude): one line, and short enough for a label.
export function clip(text: string | null | undefined, max = 60): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function isWorded(value: unknown): value is Worded {
  return !!value && typeof value === 'object' && typeof (value as Worded).key === 'string' && (value as Worded).key.startsWith('mcp.approve.')
}
