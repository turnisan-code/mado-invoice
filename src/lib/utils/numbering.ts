// Client-side mirror of format_document_number / next_document_number in
// supabase/migrations/20261029_clients_numbering.sql, for the Settings preview and checks.
import type { DictKey, TFn } from '@/lib/i18n'
import type { DocumentType } from '@/types'

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

// ─── What a new next number means against the numbers already issued ─────────
// Settings → Numbering, while the owner edits a "next number". Read with the format and prefix
// being saved: numbers of an earlier format or prefix are another series (they cannot collide).

const TOKEN_SPLIT = /(\{prefix\}|\{YYYY\}|\{YY\}|\{MM\}|\{NNNN\}|\{NNN\}|\{NN\}|\{N\})/
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface ParsedNumber {
  counter: number
  // The year the number prints ({YYYY}, or 2000 + {YY}); null when the format has no year.
  year: number | null
}

// Reads a number back the way format_document_number wrote it with this format and prefix: the
// counter (padded to its token's width, longer ones in full) and the year. Null for a number of
// another format or prefix.
export function numberParser(fmt: string, prefix: string): (number: string) => ParsedNumber | null {
  const groups: ('counter' | 'YYYY' | 'YY')[] = []
  const source = fmt.split(TOKEN_SPLIT).map((part, i) => {
    if (i % 2 === 0) return escapeRegExp(part)
    switch (part) {
      case '{prefix}': return escapeRegExp(prefix)
      case '{YYYY}': groups.push('YYYY'); return '(\\d{4})'
      case '{YY}': groups.push('YY'); return '(\\d{2})'
      case '{MM}': return '(?:0[1-9]|1[0-2])'
      default: {
        const width = part.length - 2
        groups.push('counter')
        return `(\\d{${width}}|[1-9]\\d{${width},})`
      }
    }
  }).join('')
  if (!groups.includes('counter')) return () => null
  const pattern = new RegExp(`^${source}$`)
  return number => {
    const match = pattern.exec(number)
    if (!match) return null
    let counter: number | null = null
    let yyyy: string | null = null
    let yy: string | null = null
    for (const [i, group] of groups.entries()) {
      const value = match[i + 1]
      if (group === 'counter') {
        // Every counter token prints the same counter.
        if (counter !== null && counter !== Number(value)) return null
        counter = Number(value)
      } else if (group === 'YYYY') {
        if (yyyy !== null && yyyy !== value) return null
        yyyy = value
      } else {
        if (yy !== null && yy !== value) return null
        yy = value
      }
    }
    if (yyyy !== null && yy !== null && yyyy.slice(2) !== yy) return null
    return { counter: counter!, year: yyyy !== null ? Number(yyyy) : yy !== null ? 2000 + Number(yy) : null }
  }
}

export interface IssuedCounter { counter: number; number: string; year: number | null }

export type CounterHint =
  // At or below a counter already issued in the series: refused on save.
  | { kind: 'below'; highest: IssuedCounter; next: number }
  // Above the counter that follows the highest one: from–to stay unused. `highest` is null when
  // nothing of the series has been issued (in `year`, for a format with a year); `first` when
  // nothing of this format and prefix has been issued at all.
  | { kind: 'gap'; highest: IssuedCounter | null; from: number; to: number; first: boolean }

// `counter` is the next number as the next document dated in `year` would get it. With a year in
// the format the series is that year's numbers (they cannot collide with another year's); a year
// with nothing issued yet starts at 1, or, without the yearly restart, may also carry the counter
// on from the latest earlier year. Without a year in the format the series is every number. No
// hint when the counter follows the highest one.
export function counterHint(issued: readonly string[], opts: { fmt: string; prefix: string; counter: number; year: number; resetYearly: boolean }): CounterHint | null {
  const { counter } = opts
  if (!Number.isInteger(counter) || counter < 1) return null
  const parse = numberParser(opts.fmt, opts.prefix)
  const parsed: IssuedCounter[] = []
  for (const number of issued) {
    const p = parse(number)
    if (p) parsed.push({ ...p, number })
  }
  const highestOf = (list: IssuedCounter[]) => list.reduce<IssuedCounter | null>((best, p) => (!best || p.counter > best.counter ? p : best), null)
  const against = (highest: IssuedCounter | null): CounterHint | null => {
    const last = highest?.counter ?? 0
    if (highest && counter <= last) return { kind: 'below', highest, next: last + 1 }
    if (counter > last + 1) return { kind: 'gap', highest, from: last + 1, to: counter - 1, first: !parsed.length }
    return null
  }

  if (!hasYearToken(opts.fmt)) return against(highestOf(parsed))
  const inYear = highestOf(parsed.filter(p => p.year === opts.year))
  if (inYear || counter === 1) return against(inYear)
  // Nothing issued in this year yet: a counter carried on from the latest earlier year is no gap
  // without the yearly restart, and one above it leaves the numbers in between unused.
  const earlierYear = Math.max(...parsed.filter(p => p.year !== null && p.year < opts.year).map(p => p.year!))
  const carried = opts.resetYearly ? null : highestOf(parsed.filter(p => p.year === earlierYear))
  if (carried && counter > carried.counter) return against(carried)
  return against(null)
}

// The hint for a next number the owner typed in Settings: the series is read with the format and
// prefix as they would be saved, the counter is the one the next document gets (as the preview
// shows it), and with the yearly restart the year is the counter year should it be later than
// this year (a document dated 1 January issued on 31 December). `year` is null for a format
// without a year. No hint while the format or prefix cannot be saved: their own errors say why.
export function nextNumberHint(issued: readonly string[], opts: {
  fmt: string; prefix: string; typed: number; counterYear: number | null; resetYearly: boolean; thisYear: number
}): { hint: CounterHint; year: number | null } | null {
  const fmt = opts.fmt.trim()
  const prefix = opts.prefix.trim()
  if (numberFormatIssue(fmt) || numberPrefixIssue(prefix, fmt)) return null
  const resetYearly = opts.resetYearly && hasYearToken(fmt)
  const year = resetYearly ? Math.max(opts.counterYear ?? opts.thisYear, opts.thisYear) : opts.thisYear
  const counter = nextCounter(opts.typed, opts.counterYear, resetYearly, fmt, year)
  const hint = counterHint(issued, { fmt, prefix, counter, year, resetYearly })
  return hint && { hint, year: hasYearToken(fmt) ? year : null }
}

// The hint in words: the highest number issued in the series (or none yet), then the warning, and
// for invoices and credit notes (quotes carry no legal requirement) that the numbers should run on.
export function counterHintText(t: TFn, type: DocumentType, { hint, year }: { hint: CounterHint; year: number | null }): string {
  const { highest } = hint
  const lead = highest
    ? highest.year !== null
      ? t('settings.numbering.hint.highestYear', { year: highest.year, number: highest.number, counter: highest.counter })
      : t('settings.numbering.hint.highest', { number: highest.number, counter: highest.counter })
    : year !== null ? t('settings.numbering.hint.noneYetYear', { year }) : t('settings.numbering.hint.noneYet')
  if (hint.kind === 'below') return `${lead} ${t('settings.numbering.hint.below', { next: hint.next })}`
  const vars = { start: hint.to + 1, from: hint.from, to: hint.to, count: hint.to - hint.from + 1 }
  const one = hint.from === hint.to
  const gap = hint.first
    ? t(one ? 'settings.numbering.hint.firstGapOne' : 'settings.numbering.hint.firstGapOther', vars)
    : t(one ? 'settings.numbering.hint.gapOne' : 'settings.numbering.hint.gapOther', vars)
  return type === 'quote' ? `${lead} ${gap}` : `${lead} ${gap} ${t('settings.numbering.hint.consecutive')}`
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
