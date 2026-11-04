import { createClient } from '@/lib/supabase/server'
import ProjectList, { type ProjectRow } from '@/components/projects/ProjectList'
import type { ClientOption } from '@/components/projects/ProjectDialog'
import { clientDisplayName } from '@/lib/utils/clients'
import { budgetUse, projectTotals } from '@/lib/projects'
import { listProjectRows } from '@/lib/services/queries'

export default async function ProjectsPage() {
  const supabase = await createClient()
  const [{ data: projects }, { data: clients }] = await Promise.all([
    listProjectRows(supabase),
    supabase.from('clients').select('id, name, company').neq('status', 'inactive').order('name'),
  ])

  const rows: ProjectRow[] = (projects ?? []).map(p => {
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
