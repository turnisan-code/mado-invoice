import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/auth'
import ProjectDetail, { type LinkedInvoice } from '@/components/projects/ProjectDetail'
import type { ClientOption } from '@/components/projects/ProjectDialog'
import type { Project, ProjectExpense, TimeEntry, VatRate } from '@/types'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createClient()

  const [{ data: project }, { data: entries }, { data: expenses }, { data: clients }, { data: settings }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', id).maybeSingle(),
    supabase.from('time_entries').select('*').eq('project_id', id).order('date', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('project_expenses').select('*').eq('project_id', id).order('date', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('clients').select('id, name, company').order('name'),
    supabase.from('settings').select('default_vat_rate').maybeSingle(),
  ])
  if (!project) notFound()

  const timeRows = (entries ?? []) as TimeEntry[]
  const expenseRows = (expenses ?? []) as ProjectExpense[]
  const invoiceIds = [...new Set([...timeRows, ...expenseRows].map(r => r.invoiced_document_id).filter((v): v is string => !!v))]
  const { data: invoices } = invoiceIds.length
    ? await supabase.from('documents').select('id, number, status, date').in('id', invoiceIds).order('date', { ascending: false })
    : { data: [] }

  const clientList = (clients ?? []) as ClientOption[]
  const client = clientList.find(c => c.id === project.client_id) ?? { id: project.client_id, name: '', company: null }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <ProjectDetail
        project={project as Project}
        client={client}
        entries={timeRows}
        expenses={expenseRows}
        invoices={(invoices ?? []) as LinkedInvoice[]}
        clients={clientList}
        defaultVatRate={(settings?.default_vat_rate ?? 20) as VatRate}
      />
    </div>
  )
}
