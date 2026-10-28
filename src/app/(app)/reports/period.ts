// Report period shared by the VAT report, its controls and the accountant export. Pure: no
// server or React imports, so the client controls can use it too.

export type PeriodKind = 'month' | 'quarter' | 'year'

export interface Period {
  kind: PeriodKind
  year: number
  month: number   // 1–12; for a quarter its first month
  quarter: number // 1–4
  start: string
  end: string
}

export type PeriodParams = { period?: string | null; year?: string | null; quarter?: string | null; month?: string | null }

export const MIN_YEAR = 2000
export const MAX_YEAR = 2100
// One PDF ZIP holds at most this many documents (a freelancer's year fits comfortably); kept
// below PostgREST's 1000-row page so an overflow is detected instead of truncated.
export const MAX_PDFS = 500

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

function intIn(value: string | null | undefined, min: number, max: number): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

export function makePeriod(kind: PeriodKind, year: number, index: number): Period {
  const month = kind === 'month' ? index : kind === 'quarter' ? (index - 1) * 3 + 1 : 1
  const quarter = kind === 'quarter' ? index : Math.ceil(month / 3)
  const lastMonth = kind === 'month' ? month : kind === 'quarter' ? quarter * 3 : 12
  return {
    kind, year, month, quarter,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(lastMonth)}-${pad(lastDay(year, lastMonth))}`,
  }
}

// Out-of-range or malformed values fall back to the current period instead of building dates
// like 2026-19-01. `?quarter=all` is the old link format for a whole year.
export function parsePeriod(p: PeriodParams, today: string, fallback: PeriodKind = 'quarter'): Period {
  const currentYear = Number(today.slice(0, 4))
  const currentMonth = Number(today.slice(5, 7))
  const year = intIn(p.year, MIN_YEAR, MAX_YEAR) ?? currentYear
  const quarter = intIn(p.quarter, 1, 4)
  const givenMonth = intIn(p.month, 1, 12)
  const kind: PeriodKind = p.period === 'month' || p.period === 'quarter' || p.period === 'year' ? p.period
    : p.quarter === 'all' ? 'year'
    : quarter ? 'quarter'
    : givenMonth ? 'month'
    : fallback
  const month = givenMonth ?? (quarter ? (quarter - 1) * 3 + 1 : currentMonth)
  if (kind === 'month') return makePeriod('month', year, month)
  if (kind === 'quarter') return makePeriod('quarter', year, quarter ?? Math.ceil(month / 3))
  return makePeriod('year', year, 0)
}

export function periodParams(p: Period): URLSearchParams {
  const params = new URLSearchParams({ period: p.kind, year: String(p.year) })
  if (p.kind === 'quarter') params.set('quarter', String(p.quarter))
  if (p.kind === 'month') params.set('month', String(p.month))
  return params
}

// For file names: 2026, 2026-Q3, 2026-07.
export function periodSlug(p: Period): string {
  return p.kind === 'year' ? String(p.year) : p.kind === 'quarter' ? `${p.year}-Q${p.quarter}` : `${p.year}-${pad(p.month)}`
}

export function monthName(month: number, lang: 'de' | 'en', style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1)))
}

// "Juli 2026", "Q3 2026", or the caller's year label ("Jahr 2026").
export function periodLabel(p: Period, lang: 'de' | 'en', yearLabel: string): string {
  if (p.kind === 'month') return `${monthName(p.month, lang)} ${p.year}`
  if (p.kind === 'quarter') return `Q${p.quarter} ${p.year}`
  return yearLabel
}
