import { createClient } from '@/lib/supabase/server'
import ProjectList, { type ProjectRow } from '@/components/projects/ProjectList'
import type { ClientOption } from '@/components/projects/ProjectDialog'
import { clientDisplayName } from '@/lib/utils/clients'
import { budgetUse, projectTotals } from '@/lib/projects'
import type { Project, ProjectExpense, TimeEntry } from '@/types'

type ProjectWithRows = Project & {
  // Without generated DB types supabase-js types the to-one `clients` embed loosely.
  clients: { name: string; company: string | null } | null
  time_entries: Pick<TimeEntry, 'minutes' | 'rate' | 'billed_rate' | 'billable' | 'invoiced_document_id'>[] | null
  project_expenses: Pick<ProjectExpense, 'net_amount' | 'markup_percent' | 'billable' | 'invoiced_document_id'>[] | null
}

export default async function ProjectsPage() {
  const supabase = await createClient()
  const [{ data: projects }, { data: clients }] = await Promise.all([
    supabase
      .from('projects')
      .select('*, clients(name, company), time_entries(minutes, rate, billed_rate, billable, invoiced_document_id), project_expenses(net_amount, markup_percent, billable, invoiced_document_id)')
      .order('created_at', { ascending: false }),
    supabase.from('clients').select('id, name, company').neq('status', 'inactive').order('name'),
  ])

  const rows: ProjectRow[] = ((projects ?? []) as unknown as ProjectWithRows[]).map(p => {
    const totals = projectTotals(p, p.time_entries ?? [], p.project_expenses ?? [])
    const use = budgetUse(p, totals)
    const shares = [use.hours, use.amount].filter((s): s is number => s !== null)
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      clientId: p.client_id,
      client: clientDisplayName(p.clients) || '—',
      hourly_rate: p.hourly_rate,
      totals,
      budgetShare: shares.length ? Math.max(...shares) : null,
    }
  })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <ProjectList projects={rows} clients={(clients ?? []) as ClientOption[]} />
    </div>
  )
}
