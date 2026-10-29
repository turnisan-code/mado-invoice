// Client-side mirror of format_document_number / next_document_number in
// supabase/migrations/20261029_clients_numbering.sql, for the Settings preview and checks.
import type { DictKey, TFn } from '@/lib/i18n'

export const NUMBER_TOKENS = ['{prefix}', '{YYYY}', '{YY}', '{MM}', '{NNNN}', '{NNN}', '{NN}', '{N}'] as const
const KNOWN_TOKENS = new Set<string>(NUMBER_TOKENS)
const COUNTER_TOKEN = /\{N{1,4}\}/
const YEAR_TOKEN = /\{YY(YY)?\}/
const PREFIX = /^[A-Za-z0-9._/-]{0,10}$/
const MAX_FORMAT_LENGTH = 40

export const hasYearToken = (fmt: string) => YEAR_TOKEN.test(fmt)

// Same replacement order as SQL; a counter longer than its token is printed in full.
export function formatDocumentNumber(fmt: string, prefix: string, num: number, isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-')
  const pad = (width: number) => String(num).padStart(width, '0')
  return fmt
    .replaceAll('{prefix}', prefix)
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yyyy.slice(2))
    .replaceAll('{MM}', mm)
    .replaceAll('{NNNN}', pad(4))
    .replaceAll('{NNN}', pad(3))
    .replaceAll('{NN}', pad(2))
    .replaceAll('{N}', String(num))
}

// The counter the next document dated in `year` gets: 1 when the yearly restart applies.
export function nextCounter(counter: number, counterYear: number | null, resetYearly: boolean, fmt: string, year: number): number {
  return resetYearly && hasYearToken(fmt) && counterYear !== null && year > counterYear ? 1 : counter
}

export type NumberFormatIssue =
  | { kind: 'tooLong' }
  | { kind: 'unknownToken'; token: string }
  | { kind: 'noCounter' }

export function numberFormatIssue(fmt: string): NumberFormatIssue | null {
  if (fmt.length > MAX_FORMAT_LENGTH) return { kind: 'tooLong' }
  const unknown = (fmt.match(/\{[^}]*\}/g) ?? []).find(token => !KNOWN_TOKENS.has(token))
  if (unknown) return { kind: 'unknownToken', token: unknown }
  if (!COUNTER_TOKEN.test(fmt)) return { kind: 'noCounter' }
  return null
}

export type NumberPrefixIssue = 'invalid' | 'required'

// Letters, digits and . _ / - (no spaces or braces), at most 10; required when the format prints it.
export function numberPrefixIssue(prefix: string, fmt: string): NumberPrefixIssue | null {
  if (!PREFIX.test(prefix)) return 'invalid'
  if (!prefix && fmt.includes('{prefix}')) return 'required'
  return null
}

// issue_document's MI004 detail codes (20261031_editor.sql). Line problems carry no position in
// SQL, so they get their own wording.
const ISSUE_PROBLEM_KEYS: Record<string, DictKey> = {
  settings_incomplete: 'lifecycle.errors.settingsIncomplete',
  no_client: 'issueChecks.problems.noClient',
  no_items: 'issueChecks.problems.noItems',
  currency_not_eur: 'issueChecks.problems.currencyNotEur',
  blank_description: 'editor.sqlProblems.blankDescription',
  bad_quantity: 'editor.sqlProblems.badQuantity',
  missing_price: 'editor.sqlProblems.missingPrice',
  bad_discount: 'editor.sqlProblems.badDiscount',
  period_start_missing: 'issueChecks.problems.periodStartMissing',
  period_end_before_start: 'issueChecks.problems.periodEndBeforeStart',
  reverse_charge_without_uid: 'issueChecks.problems.reverseChargeNoUid',
  client_country_missing: 'issueChecks.problems.clientCountryMissing',
  no_service_date: 'issueChecks.problems.noServiceDate',
  negative_total: 'editor.problems.negativeTotal',
}

// The SQL raises English messages; MI001–MI004 are shown from the dictionaries instead, and any
// other database or network failure as a generic sentence (its raw text is for logs only).
export function numberingErrorMessage(error: { code?: string | null; message: string; details?: string | null }, t: TFn): string {
  switch (error.code) {
    case 'MI001': return t('clientData.numbering.errorFuture')
    case 'MI002': return error.details ? t('clientData.numbering.errorClosedYear', { year: error.details }) : t('messages.api.issue_failed')
    case 'MI003': return t('clientData.numbering.errorNoCounter')
    case 'MI004': {
      const codes = (error.details ?? '').split(',').map(c => c.trim()).filter(Boolean)
      const messages = codes.filter(c => c in ISSUE_PROBLEM_KEYS).map(c => t(ISSUE_PROBLEM_KEYS[c]))
      if (messages.length < codes.length || !codes.length) messages.push(t('lifecycle.errors.incomplete'))
      return messages.join(' ')
    }
    default: return t('messages.generic')
  }
}
