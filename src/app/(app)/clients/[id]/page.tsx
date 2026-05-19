import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ClientEditSection from '@/components/layout/ClientEditSection'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'
import { calcTotals, formatMoney } from '@/lib/utils/document'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  accepted: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  rejected: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
}

const typeLabel: Record<string, string> = {
  invoice: 'Invoice',
  quote: 'Quote',
  credit_note: 'Credit Note',
}

const typeRoute: Record<string, string> = {
  invoice: 'invoices',
  quote: 'quotes',
  credit_note: 'credit-notes',
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single()
  if (!client) notFound()

  const { data: documents } = await supabase
    .from('documents')
    .select('id, type, number, date, status, currency, document_items(*), payments(*)')
    .eq('client_id', id)
    .order('date', { ascending: false })
    .limit(50)

  const totalRevenue = (documents ?? [])
    .filter(d => d.type === 'invoice' && d.status === 'paid')
    .reduce((s, d) => s + calcTotals(d.document_items ?? [], d.payments ?? []).total_paid, 0)

  const openBalance = (documents ?? [])
    .filter(d => d.type === 'invoice' && (d.status === 'sent' || d.status === 'overdue'))
    .reduce((s, d) => s + calcTotals(d.document_items ?? [], d.payments ?? []).balance_due, 0)

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <Link href="/clients" className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-2xl font-semibold">{client.name}</h1>
        {client.company && <span className="text-neutral-400 dark:text-neutral-500 text-sm">· {client.company}</span>}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ml-auto ${statusColor[client.status] ?? ''}`}>
          {client.status}
        </span>
      </div>

      {/* Revenue stats */}
      {(totalRevenue > 0 || openBalance > 0) && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Total paid</p>
            <p className="text-xl font-semibold mt-1">{formatMoney(totalRevenue, client.currency)}</p>
          </div>
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Open balance</p>
            <p className={`text-xl font-semibold mt-1 ${openBalance > 0 ? 'text-amber-600' : ''}`}>
              {formatMoney(openBalance, client.currency)}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-4">Client Details</p>
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
            <ClientEditSection client={client} />
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Documents</p>
            <div className="flex gap-2">
              <Link href={`/quotes/new?client=${id}`} className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors dark:text-neutral-300">
                <Plus size={12} /> Quote
              </Link>
              <Link href={`/invoices/new?client=${id}`} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
                <Plus size={12} /> Invoice
              </Link>
            </div>
          </div>
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-50 dark:divide-neutral-800">
            {(documents?.length ?? 0) === 0 && (
              <p className="px-4 py-8 text-sm text-neutral-400 dark:text-neutral-500 text-center">No documents yet.</p>
            )}
            {documents?.map(doc => {
              const totals = calcTotals(doc.document_items ?? [], doc.payments ?? [])
              return (
                <Link
                  key={doc.id}
                  href={`/${typeRoute[doc.type] ?? 'invoices'}/${doc.id}`}
                  className="flex items-center px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}
                    </div>
                    <div className="text-xs text-neutral-400 dark:text-neutral-500">{typeLabel[doc.type]} · {doc.date}</div>
                  </div>
                  <span className="text-sm font-medium shrink-0">{formatMoney(totals.total, doc.currency)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColor[doc.status] ?? ''}`}>
                    {doc.status}
                  </span>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
