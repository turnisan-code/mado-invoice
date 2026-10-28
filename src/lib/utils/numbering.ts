// Client-side mirror of format_document_number / next_document_number in
// supabase/migrations/20261029_clients_numbering.sql, for the Settings preview and checks.

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
