'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, FileText } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
}

const STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled']

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'status'
type SortDir = 'asc' | 'desc'

interface DocItem { quantity: number | null; unit_price: number | null; vat_rate: number | null }
interface Invoice {
  id: string
  number: string | null
  status: string
  date: string | null
  due_date: string | null
  currency: string | null
  clients: { name: string; company: string | null } | null
  document_items: DocItem[]
}

function calcTotal(items: DocItem[]) {
  return items.reduce((s, i) => {
    if (i.quantity == null || i.unit_price == null) return s
    return s + i.quantity * i.unit_price * (1 + (i.vat_rate ?? 0) / 100)
  }, 0)
}

function SortIcon({ col, sort }: { col: SortKey; sort: { key: SortKey; dir: SortDir } }) {
  if (sort.key !== col) return <ArrowUpDown size={12} className="opacity-30" />
  return sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
}

const PAGE_SIZE = 25

export default function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' })
  const [page, setPage] = useState(0)

  function toggleSort(key: SortKey) {
    setPage(0)
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  const filtered = useMemo(() => {
    let list = invoices
    if (status) list = list.filter(d => d.status === status)
    if (q) {
      const lq = q.toLowerCase()
      list = list.filter(d =>
        `${d.number ?? ''} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase().includes(lq)
      )
    }
    return [...list].sort((a, b) => {
      let av: string | number = 0, bv: string | number = 0
      if (sort.key === 'number') { av = a.number ?? ''; bv = b.number ?? '' }
      else if (sort.key === 'client') { av = a.clients?.company ?? a.clients?.name ?? ''; bv = b.clients?.company ?? b.clients?.name ?? '' }
      else if (sort.key === 'date') { av = a.date ?? ''; bv = b.date ?? '' }
      else if (sort.key === 'due_date') { av = a.due_date ?? ''; bv = b.due_date ?? '' }
      else if (sort.key === 'total') { av = calcTotal(a.document_items); bv = calcTotal(b.document_items) }
      else if (sort.key === 'status') { av = a.status; bv = b.status }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [invoices, q, status, sort])

  function Th({ col, label, className = '' }: { col: SortKey; label: string; className?: string }) {
    return (
      <th
        className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors ${className}`}
        onClick={() => toggleSort(col)}
      >
        <span className="flex items-center gap-1">{label}<SortIcon col={col} sort={sort} /></span>
      </th>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <Link href="/invoices/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
          <Plus size={14} /> New Invoice
        </Link>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setPage(0) }}
          placeholder="Search number or client…"
          className="flex-1 min-w-48 max-w-sm pl-3 pr-3 py-1.5 text-sm border border-neutral-200 dark:border-neutral-700 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-400 bg-white dark:bg-neutral-900 dark:text-neutral-100"
        />
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(0) }}
          className="text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none"
        >
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr>
              <Th col="number" label="Number" className="text-left" />
              <Th col="client" label="Client" className="text-left" />
              <Th col="date" label="Date" className="text-left" />
              <Th col="due_date" label="Due" className="text-left" />
              <Th col="total" label="Total" className="text-right" />
              <Th col="status" label="Status" className="text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center">
                  <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">
                    {q || status ? 'No invoices match your filters.' : 'No invoices yet.'}
                  </p>
                  {!q && !status && (
                    <Link href="/invoices/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                      Create your first invoice
                    </Link>
                  )}
                </td>
              </tr>
            )}
            {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(doc => (
              <tr key={doc.id} className={`hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${doc.status === 'overdue' ? 'border-l-2 border-l-red-400 dark:border-l-red-600' : ''}`}>
                <td className="px-4 py-3">
                  <Link href={`/invoices/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                  {doc.clients?.company ?? doc.clients?.name ?? '—'}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.date ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.due_date ?? '—'}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(calcTotal(doc.document_items), doc.currency ?? undefined)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{filtered.length} invoice{filtered.length !== 1 ? 's' : ''}</p>
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">Prev</button>
            <span>Page {page + 1} of {Math.ceil(filtered.length / PAGE_SIZE)}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= filtered.length} className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">Next</button>
          </div>
        )}
      </div>
    </div>
  )
}
