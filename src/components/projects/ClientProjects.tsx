import { createClient } from '@/lib/supabase/server'
import { projectTotals } from '@/lib/projects'
import type { Project, ProjectExpense, TimeEntry } from '@/types'
import ClientProjectsPanel, { type ClientProjectRow } from './ClientProjectsPanel'
import type { ClientOption } from './ProjectDialog'

type ProjectWithRows = Project & {
  time_entries: Pick<TimeEntry, 'minutes' | 'rate' | 'billable' | 'invoiced_document_id'>[] | null
  project_expenses: Pick<ProjectExpense, 'net_amount' | 'markup_percent' | 'billable' | 'invoiced_document_id'>[] | null
}

const STATUS_ORDER = { active: 0, done: 1, archived: 2 } as const

// Server part of the client page's projects section: loads the client's projects with their
// unbilled time and expenses.
export default async function ClientProjects({ client }: { client: ClientOption }) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('projects')
    .select('*, time_entries(minutes, rate, billable, invoiced_document_id), project_expenses(net_amount, markup_percent, billable, invoiced_document_id)')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })

  const projects: ClientProjectRow[] = ((data ?? []) as unknown as ProjectWithRows[])
    .map(p => {
      const totals = projectTotals(p, p.time_entries ?? [], p.project_expenses ?? [])
      return { id: p.id, name: p.name, status: p.status, unbilledMinutes: totals.unbilledMinutes, unbilledAmount: totals.unbilledAmount }
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])

  return <ClientProjectsPanel client={{ id: client.id, name: client.name, company: client.company }} projects={projects} />
}
