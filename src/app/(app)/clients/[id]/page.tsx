import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ClientEditSection from '@/components/layout/ClientEditSection'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'
import { calcTotals, formatMoney } from '@/lib/utils/document'

const statusColor: Record<string, string> = {
  active: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  inactive: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800',
  lead: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
}

const docStatusColor: Record<string, string> = {
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

  const allDocs = documents ?? []
  const totalRevenue = allDocs
    .filter(d => d.type === 'invoice' && d.status === 'paid')
    .reduce((s, d) => s + calcTotals(d.document_items ?? [], d.payments ?? []).total_paid, 0)
  const openBalance = allDocs
    .filter(d => d.type === 'invoice' && (d.status === 'sent' || d.status === 'overdue'))
    .reduce((s, d) => s + calcTotals(d.document_items ?? [], d.payments ?? []).balance_due, 0)
  const invoiceCount = allDocs.filter(d => d.type === 'invoice').length

  const initials = client.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/clients" className="mt-1 text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors shrink-0">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-neutral-900 dark:bg-neutral-100 flex items-center justify-center shrink-0">
            <span className="text-sm font-semibold text-white dark:text-neutral-900">{initials}</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">{client.name}</h1>
            {client.company && <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{client.company}</p>}
          </div>
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ml-auto shrink-0 ${statusColor[client.status] ?? 'text-neutral-500 bg-neutral-100'}`}>
            {client.status}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">Total revenue</p>
          <p className="text-lg font-semibold">{formatMoney(totalRevenue, client.currency)}</p>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">Open balance</p>
          <p className={`text-lg font-semibold ${openBalance > 0 ? 'text-amber-600' : ''}`}>
            {formatMoney(openBalance, client.currency)}
          </p>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">Invoices</p>
          <p className="text-lg font-semibold">{invoiceCount}</p>
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Client details */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-5">
          <ClientEditSection client={client} />
        </div>

        {/* Documents */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <span className="text-sm font-medium">Documents</span>
            <div className="flex gap-2">
              <Link href={`/quotes/new?client=${id}`} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors dark:text-neutral-300">
                <Plus size={11} /> Quote
              </Link>
              <Link href={`/invoices/new?client=${id}`} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
                <Plus size={11} /> Invoice
              </Link>
            </div>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {allDocs.length === 0 && (
              <div className="px-5 py-12 text-center">
                <p className="text-sm text-neutral-400 dark:text-neutral-500">No documents yet.</p>
                <Link href={`/invoices/new?client=${id}`} className="mt-2 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  Create first invoice
                </Link>
              </div>
            )}
            {allDocs.map(doc => {
              const totals = calcTotals(doc.document_items ?? [], doc.payments ?? [])
              return (
                <Link
                  key={doc.id}
                  href={`/${typeRoute[doc.type] ?? 'invoices'}/${doc.id}`}
                  className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500 font-normal">Draft</span>}
                    </div>
                    <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{typeLabel[doc.type]} · {doc.date}</div>
                  </div>
                  <span className="text-sm font-medium shrink-0">{formatMoney(totals.total, doc.currency)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${docStatusColor[doc.status] ?? ''}`}>
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
