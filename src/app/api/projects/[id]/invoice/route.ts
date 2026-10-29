import { NextResponse } from 'next/server'
import { isUuid, readJsonObject, requireUser } from '@/lib/auth'
import type { createClient } from '@/lib/supabase/server'
import { buildInvoiceLines, INVOICE_GROUPINGS } from '@/lib/projects'
import type { InvoiceGrouping, Project, ProjectExpense, TimeEntry, VatRate } from '@/types'

type ServerClient = Awaited<ReturnType<typeof createClient>>

const MAX_ROWS = 500
// .in() lists travel in the URL, so the ids are looked up in slices.
const SLICE = 100

function uuidList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isUuid)) return null
  return [...new Set(value)]
}

// The requested rows that are still unbilled billable entries of the project.
async function unbilledRows<T>(supabase: ServerClient, table: 'time_entries' | 'project_expenses', projectId: string, ids: string[]): Promise<T[]> {
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

// "Invoice unbilled": the chosen unbilled billable time entries and expenses of a project become
// one draft invoice for its client. The lines are computed here from the stored entries (the same
// buildInvoiceLines the dialog previews with); invoice_project_entries creates the draft and links
// every entry to its line in one transaction. Body: { timeEntryIds, expenseIds, grouping }.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Project not found', code: 'not_found' }, { status: 404 })

  const body = await readJsonObject(req)
  const timeEntryIds = uuidList(body?.timeEntryIds)
  const expenseIds = uuidList(body?.expenseIds)
  const grouping = body?.grouping ?? 'entry'
  if (!body || !timeEntryIds || !expenseIds || !INVOICE_GROUPINGS.includes(grouping as InvoiceGrouping)) {
    return NextResponse.json({ error: 'Invalid request', code: 'bad_request' }, { status: 400 })
  }
  if (!timeEntryIds.length && !expenseIds.length) {
    return NextResponse.json({ error: 'Nothing to invoice', code: 'nothing' }, { status: 400 })
  }

  const [{ data: project, error: projectErr }, { data: settings }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', id).maybeSingle(),
    supabase.from('settings').select('default_vat_rate').maybeSingle(),
  ])
  if (projectErr) return NextResponse.json({ error: projectErr.message, code: 'failed' }, { status: 500 })
  if (!project) return NextResponse.json({ error: 'Project not found', code: 'not_found' }, { status: 404 })

  let entries: TimeEntry[]
  let expenses: ProjectExpense[]
  try {
    [entries, expenses] = await Promise.all([
      unbilledRows<TimeEntry>(supabase, 'time_entries', id, timeEntryIds),
      unbilledRows<ProjectExpense>(supabase, 'project_expenses', id, expenseIds),
    ])
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Load failed', code: 'failed' }, { status: 500 })
  }
  if (entries.length !== timeEntryIds.length || expenses.length !== expenseIds.length) {
    return NextResponse.json({ error: 'Some entries are no longer unbilled', code: 'entries_changed' }, { status: 409 })
  }

  const vatRate = (settings?.default_vat_rate ?? 20) as VatRate
  const lines = buildInvoiceLines(project as Project, entries, expenses, grouping as InvoiceGrouping, vatRate)
  const { data: documentId, error } = await supabase.rpc('invoice_project_entries', { p_project_id: id, p_lines: lines })
  if (error) {
    if (error.code === 'MI030') return NextResponse.json({ error: error.message, code: 'not_found' }, { status: 404 })
    if (error.code === 'MI031') return NextResponse.json({ error: error.message, code: 'nothing' }, { status: 400 })
    if (error.code === 'MI032') return NextResponse.json({ error: error.message, code: 'entries_changed' }, { status: 409 })
    console.error('[projects/invoice]', error)
    return NextResponse.json({ error: error.message, code: 'failed' }, { status: 500 })
  }
  return NextResponse.json({ documentId })
}
