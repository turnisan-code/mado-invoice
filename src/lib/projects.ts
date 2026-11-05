// Projects, time entries and billable expenses: pure functions shared by the pages, the timer
// and the "Invoice unbilled" route, so the amounts shown are the amounts invoiced.
import { n, type TFn } from '@/lib/i18n'
import { lineAmount, roundCents, viennaDate } from '@/lib/utils/document'
import type { InvoiceGrouping, Project, ProjectExpense, ProjectStatus, TimeEntry, Unit, VatRate } from '@/types'

export const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'done', 'archived']
export const INVOICE_GROUPINGS: readonly InvoiceGrouping[] = ['entry', 'description', 'day']
export const MAX_ENTRY_MINUTES = 24 * 60

type EntryRate = Pick<TimeEntry, 'rate'> & Partial<Pick<TimeEntry, 'billed_rate' | 'invoiced_document_id'>>
type EntryAmounts = EntryRate & Pick<TimeEntry, 'minutes'>
type RateSource = Pick<Project, 'hourly_rate'>
type ExpenseAmounts = Pick<ProjectExpense, 'net_amount' | 'markup_percent'>
type BillingState = { billable: boolean; invoiced_document_id: string | null }

const decimal = (s: string) => Number(s.replace(',', '.'))

// What a duration field accepts: "1:30", "1,5", "1.5h", "1 h 30", "1h30m", "90m", "90 min",
// "2 Std". Null unless it is 1 minute to 24 hours.
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  let minutes: number | null = null
  let m: RegExpMatchArray | null
  if ((m = s.match(/^(\d{1,2}):(\d{1,2})$/))) {
    if (Number(m[2]) >= 60) return null
    minutes = Number(m[1]) * 60 + Number(m[2])
  } else if ((m = s.match(/^(\d+(?:[.,]\d+)?) ?(?:h|std\.?)(?: ?(\d{1,2}) ?(?:m|min\.?)?)?$/))) {
    if (m[2] && Number(m[2]) >= 60) return null
    minutes = decimal(m[1]) * 60 + Number(m[2] ?? 0)
  } else if ((m = s.match(/^(\d+) ?(?:m|min\.?)$/))) {
    minutes = Number(m[1])
  } else if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) {
    minutes = decimal(m[1]) * 60
  }
  if (minutes === null || !Number.isFinite(minutes)) return null
  minutes = Math.round(minutes)
  return minutes >= 1 && minutes <= MAX_ENTRY_MINUTES ? minutes : null
}

// 90 → "1:30"; also for totals beyond a day ("126:05").
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Hours as an invoice quantity (document_items.quantity keeps four decimals).
export function hoursQuantity(minutes: number): number {
  return Math.round((minutes / 60) * 10000) / 10000
}

// A billed entry keeps the rate it was billed at; otherwise its own rate or the project's.
export function entryRate(entry: EntryRate, project: RateSource): number {
  if (entry.invoiced_document_id && entry.billed_rate != null) return entry.billed_rate
  return entry.rate ?? project.hourly_rate ?? 0
}

// Net value of an entry billed on its own line: the hours as invoiced × its rate.
export function entryAmount(entry: EntryAmounts, project: RateSource): number {
  return lineAmount({ quantity: hoursQuantity(entry.minutes), unit_price: entryRate(entry, project) })
}

// The net price an expense is passed on at: its net amount plus the markup.
export function expensePrice(expense: ExpenseAmounts): number {
  return roundCents(expense.net_amount * (1 + (expense.markup_percent ?? 0) / 100))
}

export const isBilled = (row: BillingState) => row.invoiced_document_id !== null
export const isUnbilled = (row: BillingState) => row.billable && row.invoiced_document_id === null

export interface ProjectTotals {
  minutes: number
  billableMinutes: number
  unbilledMinutes: number
  unbilledTime: number
  unbilledExpenses: number
  unbilledAmount: number
  unbilledCount: number
  billedMinutes: number
  billedAmount: number
  // Every billable entry and expense, billed or not: what the amount budget is measured against.
  value: number
}

export function projectTotals(
  project: RateSource,
  entries: readonly (EntryAmounts & BillingState)[],
  expenses: readonly (ExpenseAmounts & BillingState)[],
): ProjectTotals {
  const t: ProjectTotals = {
    minutes: 0, billableMinutes: 0, unbilledMinutes: 0, unbilledTime: 0, unbilledExpenses: 0,
    unbilledAmount: 0, unbilledCount: 0, billedMinutes: 0, billedAmount: 0, value: 0,
  }
  for (const e of entries) {
    t.minutes += e.minutes
    if (!e.billable && !isBilled(e)) continue
    const amount = entryAmount(e, project)
    t.billableMinutes += e.minutes
    t.value += amount
    if (isBilled(e)) {
      t.billedMinutes += e.minutes
      t.billedAmount += amount
    } else {
      t.unbilledMinutes += e.minutes
      t.unbilledTime += amount
      t.unbilledCount++
    }
  }
  for (const x of expenses) {
    if (!x.billable && !isBilled(x)) continue
    const amount = expensePrice(x)
    t.value += amount
    if (isBilled(x)) t.billedAmount += amount
    else {
      t.unbilledExpenses += amount
      t.unbilledCount++
    }
  }
  t.unbilledTime = roundCents(t.unbilledTime)
  t.unbilledExpenses = roundCents(t.unbilledExpenses)
  t.unbilledAmount = roundCents(t.unbilledTime + t.unbilledExpenses)
  t.billedAmount = roundCents(t.billedAmount)
  t.value = roundCents(t.value)
  return t
}

// Share of the budget used (1 = all of it), null when the project has no such budget.
export function budgetUse(project: Pick<Project, 'budget_hours' | 'budget_amount'>, totals: Pick<ProjectTotals, 'minutes' | 'value'>) {
  return {
    hours: project.budget_hours ? totals.minutes / 60 / project.budget_hours : null,
    amount: project.budget_amount ? totals.value / project.budget_amount : null,
  }
}

// One line of the draft invoice, in the shape invoice_project_entries inserts, with the entries
// it bills.
export interface InvoiceLine {
  line_type: 'item' | 'heading'
  description: string
  service_date: string | null
  service_date_end: string | null
  quantity: number | null
  unit: Unit | null
  unit_price: number | null
  vat_rate: VatRate | null
  time_entry_ids: string[]
  expense_ids: string[]
}

type InvoiceEntry = Pick<TimeEntry, 'id' | 'date' | 'minutes' | 'description' | 'rate'> & { created_at?: string }
type InvoiceExpense = Pick<ProjectExpense, 'id' | 'date' | 'description' | 'net_amount' | 'vat_rate' | 'markup_percent'>

const byDate = <T extends { date: string; created_at?: string }>(a: T, b: T) =>
  a.date.localeCompare(b.date) || (a.created_at ?? '').localeCompare(b.created_at ?? '')
const clean = (s: string) => s.trim().replace(/\s+/g, ' ')

// Non-empty descriptions in order, compared case-insensitively like the description grouping.
function distinctDescriptions(entries: readonly InvoiceEntry[]): string[] {
  const byKey = new Map<string, string>()
  for (const e of entries) {
    const d = clean(e.description)
    if (d && !byKey.has(d.toLowerCase())) byKey.set(d.toLowerCase(), d)
  }
  return [...byKey.values()]
}

// The draft's lines: the project name as a heading, the hours (quantity in hours at the entry's
// rate) one line per entry, per description or per day — entries at different rates never share a
// line — and every expense on its own line at its VAT rate. Lines follow the first date they bill.
export function buildInvoiceLines(
  project: Pick<Project, 'name' | 'hourly_rate'>,
  entries: readonly InvoiceEntry[],
  expenses: readonly InvoiceExpense[],
  grouping: InvoiceGrouping,
  vatRate: VatRate,
): InvoiceLine[] {
  type Group = { key: string; entries: InvoiceEntry[] }
  const groups: Group[] = []
  const index = new Map<string, Group>()
  for (const e of [...entries].sort(byDate)) {
    const rate = entryRate(e, project)
    const key = grouping === 'entry' ? e.id
      : grouping === 'day' ? `${e.date}|${rate}`
      : `${clean(e.description).toLowerCase()}|${rate}`
    let group = index.get(key)
    if (!group) {
      group = { key, entries: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.entries.push(e)
  }

  const timeLines: InvoiceLine[] = groups.map(({ entries: es }) => {
    const descriptions = distinctDescriptions(es)
    const first = es[0].date
    const last = es.reduce((max, e) => (e.date > max ? e.date : max), first)
    return {
      line_type: 'item',
      description: (grouping === 'day' ? descriptions.join('; ') : descriptions[0]) || project.name,
      service_date: first,
      service_date_end: last > first ? last : null,
      quantity: hoursQuantity(es.reduce((s, e) => s + e.minutes, 0)),
      unit: 'hour',
      unit_price: entryRate(es[0], project),
      vat_rate: vatRate,
      time_entry_ids: es.map(e => e.id),
      expense_ids: [],
    }
  })

  const expenseLines: InvoiceLine[] = [...expenses].sort(byDate).map(x => ({
    line_type: 'item',
    description: clean(x.description) || project.name,
    service_date: x.date,
    service_date_end: null,
    quantity: 1,
    unit: 'flat',
    unit_price: expensePrice(x),
    vat_rate: x.vat_rate,
    time_entry_ids: [],
    expense_ids: [x.id],
  }))

  const items = [...timeLines, ...expenseLines]
  if (!items.length) return []
  const heading: InvoiceLine = {
    line_type: 'heading', description: project.name, service_date: null, service_date_end: null,
    quantity: null, unit: null, unit_price: null, vat_rate: null, time_entry_ids: [], expense_ids: [],
  }
  return [heading, ...items]
}

// Net total of the lines, summed as the invoice prints them.
export function linesNet(lines: readonly InvoiceLine[]): number {
  return roundCents(lines.reduce((s, l) => s + (l.line_type === 'item' ? lineAmount(l) : 0), 0))
}

// "2 time entries and 1 expense", leaving out a kind with none.
export function entriesLabel(t: TFn, time: number, expenses: number): string {
  const parts = [
    time > 0 ? n(time, t('records.history.timeOne', { count: time }), t('records.history.timeOther', { count: time })) : null,
    expenses > 0 ? n(expenses, t('records.history.expenseOne', { count: expenses }), t('records.history.expenseOther', { count: expenses })) : null,
  ].filter((p): p is string => !!p)
  return parts.length === 2 ? t('records.history.both', { time: parts[0], expenses: parts[1] }) : parts[0] ?? ''
}

// ── Running timer ──────────────────────────────────────────────────────────────
// A timer only lives on this device (localStorage): the start time per project.

export const timerKey = (projectId: string) => `mado-invoice:timer:${projectId}`

export function readTimer(projectId: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(timerKey(projectId)))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

// The entry a timer stopped at `now` becomes: dated the (Vienna) day it started, at least a minute
// and at most a day long; `capped` when it ran longer than that.
export function timerEntry(startedAt: number, now: number): { date: string; minutes: number; capped: boolean } {
  const elapsed = Math.max(1, Math.round((now - startedAt) / 60000))
  return { date: viennaDate(new Date(startedAt)), minutes: Math.min(MAX_ENTRY_MINUTES, elapsed), capped: elapsed > MAX_ENTRY_MINUTES }
}
