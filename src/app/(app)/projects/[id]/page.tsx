import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/auth'
import ProjectDetail, { type LinkedInvoice } from '@/components/projects/ProjectDetail'
import type { ClientOption } from '@/components/projects/ProjectDialog'
import type { Project, ProjectExpense, TimeEntry, VatRate } from '@/types'

// PostgREST returns at most 1000 rows per request; a long project can have more entries.
const PAGE = 1000

async function loadAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as T[]))
    if ((data?.length ?? 0) < PAGE) return rows
  }
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createClient()

  const [{ data: project }, timeRows, expenseRows, { data: clients }, { data: settings }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', id).maybeSingle(),
    loadAll<TimeEntry>((from, to) => supabase.from('time_entries').select('*').eq('project_id', id)
      .order('date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)),
    loadAll<ProjectExpense>((from, to) => supabase.from('project_expenses').select('*').eq('project_id', id)
      .order('date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)),
    supabase.from('clients').select('id, name, company').order('name'),
    supabase.from('settings').select('default_vat_rate').maybeSingle(),
  ])
  if (!project) notFound()

  // .in() lists travel in the URL, so the invoices are looked up 100 at a time.
  const invoiceIds = [...new Set([...timeRows, ...expenseRows].map(r => r.invoiced_document_id).filter((v): v is string => !!v))]
  const slices: string[][] = []
  for (let i = 0; i < invoiceIds.length; i += 100) slices.push(invoiceIds.slice(i, i + 100))
  const invoices = (await Promise.all(slices.map(slice => supabase.from('documents').select('id, number, status, date').in('id', slice))))
    .flatMap(r => (r.data ?? []) as LinkedInvoice[])
    .sort((x, y) => y.date.localeCompare(x.date))

  const clientList = (clients ?? []) as ClientOption[]
  const client = clientList.find(c => c.id === project.client_id) ?? { id: project.client_id, name: '', company: null }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <ProjectDetail
        project={project as Project}
        client={client}
        entries={timeRows}
        expenses={expenseRows}
        invoices={invoices}
        clients={clientList}
        defaultVatRate={(settings?.default_vat_rate ?? 20) as VatRate}
      />
    </div>
  )
}
