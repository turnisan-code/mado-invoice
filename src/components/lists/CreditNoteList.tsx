'use client'

import { useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, FileX, CheckSquare, Square, Download, X } from 'lucide-react'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { toast } from 'sonner'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
}

const STATUSES = ['draft', 'sent', 'cancelled']

type SortKey = 'number' | 'client' | 'date' | 'total' | 'status'
type SortDir = 'asc' | 'desc'

interface DocItem { line_type?: string | null; sort_order?: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type?: string | null; discount_value?: number | null }
interface Doc {
  id: string
  number: string | null
  status: string
  date: string | null
  currency: string | null
  clients: { name: string; company: string | null } | null
  tax_treatment?: string | null
  discount_type?: string | null
  discount_value?: number | null
  document_items: DocItem[]
}

function docTotal(d: Doc) {
  return calcTotals(d.document_items, [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment).total
}

function SortIcon({ col, sort }: { col: SortKey; sort: { key: SortKey; dir: SortDir } }) {
  if (sort.key !== col) return <ArrowUpDown size={12} className="opacity-30" />
  return sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
}

function Th({ col, label, sort, onSort, className = '' }: { col: SortKey; label: string; sort: { key: SortKey; dir: SortDir }; onSort: (key: SortKey) => void; className?: string }) {
  return (
    <th className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors ${className}`} onClick={() => onSort(col)}>
      <span className={`flex items-center gap-1 ${className.includes('text-right') ? 'justify-end' : ''}`}>{label}<SortIcon col={col} sort={sort} /></span>
    </th>
  )
}

const PAGE_SIZE = 25

function exportCSV(docs: Doc[]) {
  const rows = docs.map(d => [
    d.number ?? '',
    d.clients?.name ?? '',
    d.clients?.company ?? '',
    csvDate(d.date),
    docTotal(d),
    d.currency ?? 'EUR',
    d.status,
  ])
  downloadCsv(`credit-notes-${today()}.csv`, toCsv(['Number', 'Client', 'Company', 'Date', 'Total', 'Currency', 'Status'], rows))
}

export default function CreditNoteList({ docs }: { docs: Doc[] }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'date', dir: 'desc' })
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  function toggleSort(key: SortKey) {
    setPage(0)
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  const filtered = useMemo(() => {
    let list = docs
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
      else if (sort.key === 'total') { av = docTotal(a); bv = docTotal(b) }
      else if (sort.key === 'status') { av = a.status; bv = b.status }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [docs, q, status, sort])

  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const allPageSelected = pageItems.length > 0 && pageItems.every(d => selected.has(d.id))
  const selectedVisible = useMemo(() => filtered.filter(d => selected.has(d.id)), [filtered, selected])
  const selectedCount = selectedVisible.length
  const hasSelection = selectedCount > 0

  function toggleAll() {
    if (allPageSelected) {
      setSelected(s => { const n = new Set(s); pageItems.forEach(d => n.delete(d.id)); return n })
    } else {
      setSelected(s => { const n = new Set(s); pageItems.forEach(d => n.add(d.id)); return n })
    }
  }

  function toggleOne(id: string) {
    setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function handleExport() {
    const toExport = hasSelection ? selectedVisible : filtered
    exportCSV(toExport)
    toast.success(`Exported ${toExport.length} credit note${toExport.length !== 1 ? 's' : ''} to CSV.`)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Credit Notes</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            title="Export CSV"
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-600 dark:text-neutral-400"
          >
            <Download size={14} />
            <span className="hidden sm:inline">Export</span>
          </button>
          <Link href="/credit-notes/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
            <Plus size={14} /> New Credit Note
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input value={q} onChange={e => { setQ(e.target.value); setPage(0); clearSelection() }} placeholder="Search number or client…"
          className="flex-1 min-w-48 max-w-sm pl-3 pr-3 py-1.5 text-sm border border-neutral-200 dark:border-neutral-700 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-400 bg-white dark:bg-neutral-900 dark:text-neutral-100" />
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(0); clearSelection() }}
          className="text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <table className="w-full text-sm">
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
              <Th col="number" label="Number" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="client" label="Client" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="date" label="Date" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="total" label="Total" sort={sort} onSort={toggleSort} className="text-right" />
              <Th col="status" label="Status" sort={sort} onSort={toggleSort} className="text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center">
                  <FileX size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">
                    {q || status ? 'No credit notes match your filters.' : 'No credit notes yet.'}
                  </p>
                  {!q && !status && (
                    <Link href="/credit-notes/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                      Create your first credit note
                    </Link>
                  )}
                </td>
              </tr>
            )}
            {pageItems.map(doc => (
              <tr key={doc.id} className={`transition-colors ${selected.has(doc.id) ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}>
                <td className="pl-4 py-3 w-8">
                  <button onClick={() => toggleOne(doc.id)} className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors">
                    {selected.has(doc.id)
                      ? <CheckSquare size={14} className="text-blue-500" />
                      : <Square size={14} />
                    }
                  </button>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/credit-notes/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">Draft</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{doc.clients?.company ?? doc.clients?.name ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.date ?? '—'}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{filtered.length} credit note{filtered.length !== 1 ? 's' : ''}</p>
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
              {selectedCount} selected
            </span>
            <div className="flex items-center gap-2 flex-1 flex-wrap">
              <button
                onClick={() => {
                  exportCSV(selectedVisible)
                  toast.success(`Exported ${selectedCount} credit note${selectedCount !== 1 ? 's' : ''}.`)
                }}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/20 dark:bg-neutral-900/20 hover:bg-white/30 dark:hover:bg-neutral-900/30 transition-colors"
              >
                <Download size={12} /> Export CSV
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
    </div>
  )
}
