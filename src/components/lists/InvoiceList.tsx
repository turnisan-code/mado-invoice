'use client'

import { useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, FileText, CheckSquare, Square, Download, CheckCircle, Send, X, Trash2 } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'
import { toast } from 'sonner'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
}

const STATUSES = ['outstanding', 'draft', 'sent', 'paid', 'overdue', 'cancelled']

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'status'
type SortDir = 'asc' | 'desc'

interface DocItem { line_type?: string; quantity: number | null; unit_price: number | null; vat_rate: number | null }
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

function exportCSV(invoices: Invoice[]) {
  const rows = [
    ['Number', 'Client', 'Company', 'Date', 'Due Date', 'Total', 'Currency', 'Status'],
    ...invoices.map(inv => [
      inv.number ?? '',
      inv.clients?.name ?? '',
      inv.clients?.company ?? '',
      inv.date ?? '',
      inv.due_date ?? '',
      calcTotal(inv.document_items).toFixed(2),
      inv.currency ?? 'EUR',
      inv.status,
    ]),
  ]
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function InvoiceList({ invoices, initialStatus }: { invoices: Invoice[]; initialStatus?: string }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState(initialStatus ?? '')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' })
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<{ action: string; label: string } | null>(null)

  function toggleSort(key: SortKey) {
    setPage(0)
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  const filtered = useMemo(() => {
    let list = invoices
    if (status === 'outstanding') list = list.filter(d => d.status === 'sent' || d.status === 'overdue')
    else if (status) list = list.filter(d => d.status === status)
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

  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const allPageSelected = pageItems.length > 0 && pageItems.every(d => selected.has(d.id))

  function toggleAll() {
    if (allPageSelected) {
      setSelected(s => { const n = new Set(s); pageItems.forEach(d => n.delete(d.id)); return n })
    } else {
      setSelected(s => { const n = new Set(s); pageItems.forEach(d => n.add(d.id)); return n })
    }
  }

  function toggleOne(id: string) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  async function bulkUpdateStatus(newStatus: string) {
    setBulkLoading(true)
    setBulkConfirm(null)
    const ids = [...selected]
    const res = await fetch('/api/invoices/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, status: newStatus }),
    })
    setBulkLoading(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Failed' }))
      toast.error(`Bulk update failed: ${error}`)
      return
    }
    const { updated } = await res.json()
    toast.success(`${updated} invoice${updated !== 1 ? 's' : ''} marked as ${newStatus}.`)
    clearSelection()
    router.refresh()
  }

  async function bulkDelete() {
    setBulkLoading(true)
    setBulkConfirm(null)
    const ids = [...selected]
    const res = await fetch('/api/invoices/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    setBulkLoading(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Failed' }))
      toast.error(`Delete failed: ${error}`)
      return
    }
    const { deleted } = await res.json()
    toast.success(`${deleted} invoice${deleted !== 1 ? 's' : ''} deleted.`)
    clearSelection()
    router.refresh()
  }

  function handleExport() {
    const toExport = selected.size > 0
      ? filtered.filter(d => selected.has(d.id))
      : filtered
    exportCSV(toExport)
    toast.success(`Exported ${toExport.length} invoice${toExport.length !== 1 ? 's' : ''} to CSV.`)
  }

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

  const hasSelection = selected.size > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            title="Export CSV"
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-600 dark:text-neutral-400"
          >
            <Download size={14} />
            <span className="hidden sm:inline">Export</span>
          </button>
          <Link href="/invoices/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
            <Plus size={14} /> New Invoice
          </Link>
        </div>
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
          {STATUSES.map(s => <option key={s} value={s}>{s === 'outstanding' ? 'Outstanding (sent + overdue)' : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-400 dark:text-neutral-500">
                {q || status ? 'No invoices match your filters.' : 'No invoices yet.'}
              </p>
              {!q && !status && (
                <Link href="/invoices/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  Create your first invoice
                </Link>
              )}
            </div>
          )}
          {pageItems.map(doc => (
            <div
              key={doc.id}
              className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${selected.has(doc.id) ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'} ${doc.status === 'overdue' ? 'border-l-2 border-l-red-400 dark:border-l-red-600' : ''}`}
            >
              <button
                onClick={() => toggleOne(doc.id)}
                className="shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors"
              >
                {selected.has(doc.id)
                  ? <CheckSquare size={16} className="text-blue-500" />
                  : <Square size={16} />
                }
              </button>
              <Link href={`/invoices/${doc.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm">
                    {doc.number ?? <span className="text-neutral-400">Draft</span>}
                  </p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">
                    {doc.clients?.company ?? doc.clients?.name ?? '—'}
                  </p>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{doc.date ?? '—'}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <p className="font-semibold text-sm">{formatMoney(calcTotal(doc.document_items), doc.currency ?? undefined)}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                </div>
              </Link>
            </div>
          ))}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr>
              <th className="pl-4 py-3 w-8">
                <button onClick={toggleAll} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                  {allPageSelected
                    ? <CheckSquare size={14} className="text-blue-500" />
                    : <Square size={14} />
                  }
                </button>
              </th>
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
                <td colSpan={7} className="px-4 py-16 text-center">
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
            {pageItems.map(doc => (
              <tr
                key={doc.id}
                className={`transition-colors ${selected.has(doc.id) ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'} ${doc.status === 'overdue' ? 'border-l-2 border-l-red-400 dark:border-l-red-600' : ''}`}
              >
                <td className="pl-4 py-3 w-8">
                  <button onClick={() => toggleOne(doc.id)} className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors">
                    {selected.has(doc.id)
                      ? <CheckSquare size={14} className="text-blue-500" />
                      : <Square size={14} />
                    }
                  </button>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/invoices/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{doc.clients?.company ?? doc.clients?.name ?? '—'}</td>
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

      {/* Bulk action bar */}
      <div
        className={`fixed left-0 right-0 z-50 transition-all duration-200 ${hasSelection ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'}`}
        style={{ bottom: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="max-w-5xl mx-auto px-4 pb-[4.5rem] md:pb-6">
          <div className="bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium shrink-0">
              {selected.size} selected
            </span>
            <div className="flex items-center gap-2 flex-1 flex-wrap">
              <button
                onClick={() => setBulkConfirm({ action: 'sent', label: 'Mark as sent' })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
              >
                <Send size={12} /> Mark Sent
              </button>
              <button
                onClick={() => setBulkConfirm({ action: 'paid', label: 'Mark as paid' })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
              >
                <CheckCircle size={12} /> Mark Paid
              </button>
              <button
                onClick={() => {
                  const toExport = filtered.filter(d => selected.has(d.id))
                  exportCSV(toExport)
                  toast.success(`Exported ${toExport.length} invoice${toExport.length !== 1 ? 's' : ''}.`)
                }}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/20 dark:bg-neutral-900/20 hover:bg-white/30 dark:hover:bg-neutral-900/30 transition-colors disabled:opacity-50"
              >
                <Download size={12} /> Export CSV
              </button>
              <button
                onClick={() => setBulkConfirm({ action: 'delete', label: 'Delete' })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
            <button
              onClick={clearSelection}
              className="shrink-0 p-1.5 rounded-lg hover:bg-white/20 dark:hover:bg-neutral-900/20 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Bulk action confirmation */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <div>
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">{bulkConfirm.label} {selected.size} invoice{selected.size !== 1 ? 's' : ''}?</h3>
              {bulkConfirm.action === 'delete' && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">This cannot be undone.</p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setBulkConfirm(null)}
                className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkConfirm.action === 'delete' ? bulkDelete() : bulkUpdateStatus(bulkConfirm.action)}
                className={`text-sm px-3 py-1.5 rounded-md text-white transition-colors ${bulkConfirm.action === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-neutral-900 dark:bg-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100'}`}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
