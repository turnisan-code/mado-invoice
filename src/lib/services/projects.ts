// Projects, time entries and expenses as the project page, its dialogs, the timer, the "Invoice
// unbilled" route and the Claude connector write them. A billed entry is never changed or deleted
// here: every write to one is filtered on invoiced_document_id being null. Browser-safe.
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { DictKey } from '@/lib/i18n'
import { logEvent } from '@/lib/events'
import { buildInvoiceLines } from '@/lib/projects'
import type { InvoiceGrouping, Project, ProjectExpense, ProjectStatus, TimeEntry, VatRate } from '@/types'

export type ProjectValues = {
  client_id: string
  name: string
  status: ProjectStatus
  hourly_rate: number | null
  budget_hours: number | null
  budget_amount: number | null
  notes: string
}

export function projectProblem(v: ProjectValues): DictKey | null {
  if (!v.client_id) return 'projects.form.clientRequired'
  if (!v.name.trim()) return 'projects.form.nameRequired'
  if ([v.hourly_rate, v.budget_hours, v.budget_amount].some(n => n !== null && n < 0)) return 'projects.form.negative'
  return null
}

export function projectRow(v: ProjectValues) {
  return {
    client_id: v.client_id,
    name: v.name.trim(),
    status: v.status,
    hourly_rate: v.hourly_rate,
    // A zero budget means none (the columns only take positive budgets).
    budget_hours: v.budget_hours || null,
    budget_amount: v.budget_amount || null,
    notes: v.notes.trim() || null,
  }
}

// `id` is the new project's on an insert; an update hands back the one it was given.
export async function saveProject(
  supabase: SupabaseClient,
  row: ReturnType<typeof projectRow>,
  id?: string,
): Promise<{ id: string | null; error: PostgrestError | null }> {
  if (id) {
    const { error } = await supabase.from('projects').update(row).eq('id', id)
    return { id: error ? null : id, error }
  }
  const { data, error } = await supabase.from('projects').insert(row).select('id').single()
  return { id: (data?.id as string | undefined) ?? null, error }
}

export type TimeEntryRow = {
  project_id: string
  date: string
  minutes: number
  description: string
  billable: boolean
  rate?: number | null
}

export function timeEntryProblem(v: { project_id: string; date: string; minutes: number | null; rate: number | null }): DictKey | null {
  if (!v.project_id) return 'projects.time.projectRequired'
  if (!v.date) return 'projects.time.dateRequired'
  if (v.minutes === null) return 'projects.time.durationInvalid'
  if (v.rate !== null && v.rate < 0) return 'projects.time.rateInvalid'
  return null
}

// A new entry, or a change to an unbilled one; `entry` is null when an update matched nothing
// (billed or deleted meanwhile).
export async function saveTimeEntry(
  supabase: SupabaseClient,
  row: TimeEntryRow | Partial<TimeEntryRow>,
  id?: string,
): Promise<{ entry: TimeEntry | null; error: PostgrestError | null }> {
  const { data, error } = id
    ? await supabase.from('time_entries').update(row).eq('id', id).is('invoiced_document_id', null).select('*')
    : await supabase.from('time_entries').insert(row).select('*')
  return { entry: ((data ?? [])[0] as TimeEntry | undefined) ?? null, error }
}

export type ExpenseValues = {
  date: string
  description: string
  net_amount: number | null
  vat_rate: VatRate
  billable: boolean
  markup_percent: number | null
}

export function expenseProblem(v: ExpenseValues): DictKey | null {
  if (!v.date) return 'projects.time.dateRequired'
  if (!v.description.trim()) return 'projects.expense.descriptionRequired'
  if (v.net_amount === null || v.net_amount <= 0) return 'projects.expense.amountRequired'
  if (v.markup_percent !== null && (v.markup_percent < 0 || v.markup_percent > 1000)) return 'projects.expense.markupInvalid'
  return null
}

export function expenseRow(projectId: string, v: ExpenseValues) {
  return {
    project_id: projectId,
    date: v.date,
    description: v.description.trim(),
    net_amount: v.net_amount,
    vat_rate: v.vat_rate,
    billable: v.billable,
    markup_percent: v.markup_percent || null,
  }
}

export async function saveExpense(
  supabase: SupabaseClient,
  row: ReturnType<typeof expenseRow>,
  id?: string,
): Promise<{ expense: ProjectExpense | null; error: PostgrestError | null }> {
  const { data, error } = id
    ? await supabase.from('project_expenses').update(row).eq('id', id).is('invoiced_document_id', null).select('*')
    : await supabase.from('project_expenses').insert(row).select('*')
  return { expense: ((data ?? [])[0] as ProjectExpense | undefined) ?? null, error }
}

export type EntryKind = 'time' | 'expense'

const ENTRY_TABLE: Record<EntryKind, 'time_entries' | 'project_expenses'> = { time: 'time_entries', expense: 'project_expenses' }

// `deleted` is false when the entry was billed or is gone already.
export async function deleteEntry(supabase: SupabaseClient, kind: EntryKind, id: string): Promise<{ deleted: boolean; error: PostgrestError | null }> {
  const { data, error } = await supabase.from(ENTRY_TABLE[kind]).delete().eq('id', id).is('invoiced_document_id', null).select('id')
  return { deleted: !error && !!data?.length, error }
}

// Entries billed on a draft or cancelled invoice count as unbilled again; an issued invoice keeps
// what it billed. `released` is how many were freed.
export async function releaseEntries(
  supabase: SupabaseClient,
  ids: { timeEntryIds: string[]; expenseIds: string[] },
): Promise<{ released: number; error: PostgrestError | null }> {
  const { data, error } = await supabase.rpc('release_project_entries', { p_time_entry_ids: ids.timeEntryIds, p_expense_ids: ids.expenseIds })
  return { released: error ? 0 : Number(data) || 0, error }
}

// .in() lists travel in the URL, so the ids are looked up in slices.
const SLICE = 100

// The requested rows that are still unbilled billable entries of the project.
async function unbilledRows<T>(supabase: SupabaseClient, table: 'time_entries' | 'project_expenses', projectId: string, ids: string[]): Promise<T[]> {
  const slices = []
  for (let i = 0; i < ids.length; i += SLICE) slices.push(ids.slice(i, i + SLICE))
  const results = await Promise.all(slices.map(slice => supabase
    .from(table)
    .select('*')
    .eq('project_id', projectId)
    .in('id', slice)
    .eq('billable', true)
    .is('invoiced_document_id', null)))
  const failed = results.find(r => r.error)
  if (failed?.error) throw new Error(failed.error.message)
  return results.flatMap(r => (r.data ?? []) as T[])
}

export type InvoiceProjectResult =
  | { ok: true; documentId: string; timeEntries: number; expenses: number }
  | { ok: false; code: 'not_found' | 'nothing' | 'entries_changed' | 'failed'; message: string; error?: PostgrestError }

// "Invoice unbilled": the chosen unbilled billable time entries and expenses of a project become
// one draft invoice for its client. The lines are computed here from the stored entries (the same
// buildInvoiceLines the dialog previews with); invoice_project_entries creates the draft and links
// every entry to its line in one transaction. The ids are distinct.
export async function invoiceProjectEntries(
  supabase: SupabaseClient,
  projectId: string,
  { timeEntryIds, expenseIds, grouping }: { timeEntryIds: string[]; expenseIds: string[]; grouping: InvoiceGrouping },
): Promise<InvoiceProjectResult> {
  if (!timeEntryIds.length && !expenseIds.length) return { ok: false, code: 'nothing', message: 'Nothing to invoice' }

  const [{ data: project, error: projectErr }, { data: settings }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', projectId).maybeSingle(),
    supabase.from('settings').select('default_vat_rate').maybeSingle(),
  ])
  if (projectErr) return { ok: false, code: 'failed', message: projectErr.message, error: projectErr }
  if (!project) return { ok: false, code: 'not_found', message: 'Project not found' }

  let entries: TimeEntry[]
  let expenses: ProjectExpense[]
  try {
    [entries, expenses] = await Promise.all([
      unbilledRows<TimeEntry>(supabase, 'time_entries', projectId, timeEntryIds),
      unbilledRows<ProjectExpense>(supabase, 'project_expenses', projectId, expenseIds),
    ])
  } catch (err) {
    return { ok: false, code: 'failed', message: err instanceof Error ? err.message : 'Load failed' }
  }
  if (entries.length !== timeEntryIds.length || expenses.length !== expenseIds.length) {
    return { ok: false, code: 'entries_changed', message: 'Some entries are no longer unbilled' }
  }

  const vatRate = (settings?.default_vat_rate ?? 20) as VatRate
  const lines = buildInvoiceLines(project as Project, entries, expenses, grouping, vatRate)
  const { data: documentId, error } = await supabase.rpc('invoice_project_entries', { p_project_id: projectId, p_lines: lines })
  if (error) {
    if (error.code === 'MI030') return { ok: false, code: 'not_found', message: error.message, error }
    if (error.code === 'MI031') return { ok: false, code: 'nothing', message: error.message, error }
    if (error.code === 'MI032') return { ok: false, code: 'entries_changed', message: error.message, error }
    console.error('[projects/invoice]', error)
    return { ok: false, code: 'failed', message: error.message, error }
  }
  await logEvent(supabase, documentId as string, 'project_invoiced', {
    project_id: projectId, project_name: (project as Project).name, time_entries: entries.length, expenses: expenses.length,
  })
  return { ok: true, documentId: documentId as string, timeEntries: entries.length, expenses: expenses.length }
}
