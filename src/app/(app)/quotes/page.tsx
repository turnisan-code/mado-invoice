import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { status, q } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('documents')
    .select('*, clients(name, company), document_items(*)')
    .eq('type', 'quote')
    .order('date', { ascending: false })

  if (status) query = query.eq('status', status)
  const { data: docs } = await query

  const filtered = q
    ? docs?.filter(d => `${d.number} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    : docs

  const statusColor: Record<string, string> = {
    draft: 'text-neutral-400 bg-neutral-100',
    sent: 'text-blue-700 bg-blue-100',
    accepted: 'text-green-700 bg-green-100',
    rejected: 'text-red-700 bg-red-100',
    cancelled: 'text-neutral-400 bg-neutral-100',
  }

  const calcTotal = (items: { quantity: number; unit_price: number; vat_rate: number }[]) =>
    items.reduce((s, i) => s + i.quantity * i.unit_price * (1 + i.vat_rate / 100), 0)

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <Link href="/quotes/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 text-white hover:bg-neutral-700 transition-colors">
          <Plus size={14} /> New Quote
        </Link>
      </div>

      <form className="flex gap-3">
        <input name="q" defaultValue={q} placeholder="Search number or client…"
          className="flex-1 max-w-sm pl-3 pr-3 py-1.5 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-400 bg-white" />
        <select name="status" defaultValue={status ?? ''}
          className="text-sm border border-neutral-200 rounded-md px-2 py-1.5 bg-white focus:outline-none">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button type="submit" className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 hover:bg-neutral-50 transition-colors">Filter</button>
      </form>

      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-100 bg-neutral-50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Number</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Client</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Date</th>
              <th className="text-right px-4 py-3 font-medium text-neutral-500">Total</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50">
            {(filtered?.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-neutral-400">No quotes found.</td></tr>
            )}
            {filtered?.map(doc => (
              <tr key={doc.id} className="hover:bg-neutral-50 transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/quotes/${doc.id}`} className="font-medium hover:underline">{doc.number ?? <span className="text-neutral-400">Draft</span>}</Link>
                </td>
                <td className="px-4 py-3 text-neutral-600">{doc.clients?.company ?? doc.clients?.name ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500">{doc.date}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(calcTotal(doc.document_items ?? []), doc.currency)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
