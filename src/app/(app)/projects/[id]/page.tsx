import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/auth'
import ProjectDetail, { type LinkedInvoice } from '@/components/projects/ProjectDetail'
import type { ClientOption } from '@/components/projects/ProjectDialog'
import type { VatRate } from '@/types'
import { getProjectDetail } from '@/lib/services/queries'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createClient()

  const detail = await getProjectDetail(supabase, id)
  if (!detail) notFound()
  const { project, entries: timeRows, expenses: expenseRows, invoices, clients: clientList, defaultVatRate } = detail
  const client = clientList.find(c => c.id === project.client_id) ?? { id: project.client_id, name: '', company: null }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <ProjectDetail
        project={project}
        client={client}
        entries={timeRows}
        expenses={expenseRows}
        invoices={invoices as LinkedInvoice[]}
        clients={clientList as ClientOption[]}
        defaultVatRate={(defaultVatRate ?? 20) as VatRate}
      />
    </div>
  )
}
