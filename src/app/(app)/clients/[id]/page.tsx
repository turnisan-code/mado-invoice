import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ClientForm from '@/components/forms/ClientForm'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single()
  if (!client) notFound()

  const { data: documents } = await supabase
    .from('documents')
    .select('id, type, number, date, status, currency')
    .eq('client_id', id)
    .order('date', { ascending: false })
    .limit(20)

  const statusColor: Record<string, string> = {
    draft: 'text-neutral-400 bg-neutral-100',
    sent: 'text-blue-700 bg-blue-100',
    paid: 'text-green-700 bg-green-100',
    overdue: 'text-red-700 bg-red-100',
    accepted: 'text-green-700 bg-green-100',
    rejected: 'text-red-700 bg-red-100',
    cancelled: 'text-neutral-400 bg-neutral-100',
  }

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <Link href="/clients" className="text-neutral-400 hover:text-neutral-600 transition-colors">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold">{client.name}</h1>
        {client.company && <span className="text-neutral-400 text-sm">· {client.company}</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h2 className="text-sm font-medium text-neutral-500 mb-4">Client Details</h2>
          <ClientForm client={client} />
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-500">Documents</h2>
            <div className="flex gap-2">
              <Link href={`/quotes/new?client=${id}`} className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 transition-colors">
                <Plus size={12} /> Quote
              </Link>
              <Link href={`/invoices/new?client=${id}`} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-neutral-900 text-white hover:bg-neutral-700 transition-colors">
                <Plus size={12} /> Invoice
              </Link>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-neutral-200 divide-y divide-neutral-50">
            {(documents?.length ?? 0) === 0 && (
              <p className="px-4 py-8 text-sm text-neutral-400 text-center">No documents yet.</p>
            )}
            {documents?.map(doc => (
              <Link
                key={doc.id}
                href={`/${doc.type === 'invoice' ? 'invoices' : doc.type === 'quote' ? 'quotes' : 'invoices'}/${doc.id}`}
                className="flex items-center px-4 py-3 hover:bg-neutral-50 transition-colors"
              >
                <div className="flex-1">
                  <span className="text-sm font-medium">{doc.number}</span>
                  <span className="text-xs text-neutral-400 ml-2">{doc.date}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>
                  {doc.status}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
