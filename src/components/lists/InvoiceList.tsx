'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, FileText, CheckSquare, Square, Download, CheckCircle, Send, X, Trash2 } from 'lucide-react'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { toast } from 'sonner'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-400 bg-neutral-100 dark:bg-neutral-800',
}

const STATUSES = ['outstanding', 'draft', 'sent', 'paid', 'overdue', 'cancelled']

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'balance' | 'status'
type SortDir = 'asc' | 'desc'
const SORT_KEYS: SortKey[] = ['number', 'client', 'date', 'due_date', 'total', 'balance', 'status']
const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: 'date', dir: 'desc' }

interface Filters {
  status: string
  q: string
  from: string
  to: string
  client: string
  sort: { key: SortKey; dir: SortDir }
  page: number
}

function parseFilters(p: URLSearchParams): Filters {
  const status = p.get('status') ?? ''
  const [sortKey, sortDir] = (p.get('sort') ?? '').split(':')
  return {
    status: STATUSES.includes(status) ? status : '',
    q: p.get('q') ?? '',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    client: p.get('client') ?? '',
    sort: SORT_KEYS.includes(sortKey as SortKey)
      ? { key: sortKey as SortKey, dir: sortDir === 'asc' ? 'asc' : 'desc' }
      : DEFAULT_SORT,
    page: Math.max(1, parseInt(p.get('page') ?? '', 10) || 1),
  }
}

function serializeFilters(f: Filters): string {
  const p = new URLSearchParams()
  if (f.status) p.set('status', f.status)
  if (f.q) p.set('q', f.q)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.client) p.set('client', f.client)
  if (f.sort.key !== DEFAULT_SORT.key || f.sort.dir !== DEFAULT_SORT.dir) p.set('sort', `${f.sort.key}:${f.sort.dir}`)
  if (f.page > 1) p.set('page', String(f.page))
  return p.toString()
}

interface DocItem { line_type?: string | null; sort_order?: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type?: string | null; discount_value?: number | null }
interface Invoice {
  id: string
  number: string | null
  status: string
  date: string | null
  due_date: string | null
  currency: string | null
  client_id: string | null
  clients: { name: string; company: string | null } | null
  tax_treatment?: string | null
  discount_type?: string | null
  discount_value?: number | null
  document_items: DocItem[]
  payments?: { amount: number }[]
}

function docTotals(d: Invoice) {
  return calcTotals(d.document_items, d.payments ?? [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment)
}
const docTotal = (d: Invoice) => docTotals(d).total
// Nothing is owed on a draft (not issued yet) or a cancelled invoice (settled by its Storno).
const docBalance = (d: Invoice) => d.status === 'draft' || d.status === 'cancelled' ? 0 : docTotals(d).balance_due
const isOpen = (d: Invoice) => d.status === 'sent' || d.status === 'overdue'

function SortIcon({ col, sort }: { col: SortKey; sort: { key: SortKey; dir: SortDir } }) {
  if (sort.key !== col) return <ArrowUpDown size={12} className="opacity-30" />
  return sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
}

function Th({ col, label, sort, onSort, className = '' }: { col: SortKey; label: string; sort: { key: SortKey; dir: SortDir }; onSort: (key: SortKey) => void; className?: string }) {
  return (
    <th
      className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors ${className}`}
      onClick={() => onSort(col)}
    >
      <span className={`flex items-center gap-1 ${className.includes('text-right') ? 'justify-end' : ''}`}>{label}<SortIcon col={col} sort={sort} /></span>
    </th>
  )
}

const PAGE_SIZE = 25

function exportCSV(invoices: Invoice[]) {
  const rows = invoices.map(inv => {
    const t = docTotals(inv)
    return [
      inv.number ?? '',
      inv.clients?.name ?? '',
      inv.clients?.company ?? '',
      csvDate(inv.date),
      csvDate(inv.due_date),
      t.subtotal - t.discount_amount,
      t.total_vat,
      t.total,
      t.total_paid,
      docBalance(inv),
      inv.currency ?? 'EUR',
      inv.status,
    ]
  })
  downloadCsv(`invoices-${today()}.csv`, toCsv(['Number', 'Client', 'Company', 'Date', 'Due date', 'Net', 'VAT', 'Total', 'Paid', 'Balance', 'Currency', 'Status'], rows))
}

const inputClass = 'text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400'

export default function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlQs = searchParams.toString()
  const [filters, setFilters] = useState<Filters>(() => parseFilters(searchParams))
  const pendingUrls = useRef(new Set<string>())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<{ action: string; label: string } | null>(null)

  // Filter state lives in the component for instant feedback and is mirrored to the URL
  // (debounced, so typing does not navigate per keystroke) to survive reloads and back/forward.
  useEffect(() => {
    const next = serializeFilters(filters)
    if (next === urlQs) return
    const t = setTimeout(() => {
      pendingUrls.current.add(next)
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
    }, 250)
    return () => clearTimeout(t)
  }, [filters, urlQs, pathname, router])

  // URL changes we did not write (dashboard card, sidebar link, back button) replace the state.
  useEffect(() => {
    if (pendingUrls.current.delete(urlQs)) return
    setFilters(parseFilters(new URLSearchParams(urlQs)))
  }, [urlQs])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  function updateFilter(patch: Partial<Pick<Filters, 'status' | 'q' | 'from' | 'to' | 'client'>>) {
    clearSelection()
    setFilters(f => ({ ...f, ...patch, page: 1 }))
  }

  function setPage(page: number) {
    setFilters(f => ({ ...f, page }))
  }

  function toggleSort(key: SortKey) {
    setFilters(f => ({
      ...f,
      page: 1,
      sort: f.sort.key === key ? { key, dir: f.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    }))
  }

  const todayStr = today()
  const { status, q, from, to, client, sort } = filters
  const hasFilters = !!(status || q || from || to || client)

  const clientOptions = useMemo(() => {
    const names = new Map<string, string>()
    for (const d of invoices) {
      if (d.client_id && d.clients && !names.has(d.client_id)) names.set(d.client_id, d.clients.company || d.clients.name)
    }
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [invoices])

  const filtered = useMemo(() => {
    let list = invoices
    if (status === 'outstanding') list = list.filter(d => d.status === 'sent' || d.status === 'overdue')
    else if (status === 'overdue') list = list.filter(d => d.status === 'overdue' || (d.status === 'sent' && !!d.due_date && d.due_date < todayStr))
    else if (status) list = list.filter(d => d.status === status)
    if (client) list = list.filter(d => d.client_id === client)
    if (from) list = list.filter(d => !!d.date && d.date >= from)
    if (to) list = list.filter(d => !!d.date && d.date <= to)
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
      else if (sort.key === 'total') { av = docTotal(a); bv = docTotal(b) }
      else if (sort.key === 'balance') { av = docBalance(a); bv = docBalance(b) }
      else if (sort.key === 'status') { av = a.status; bv = b.status }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [invoices, q, status, client, from, to, sort, todayStr])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const page = Math.min(filters.page, pageCount)
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const allPageSelected = pageItems.length > 0 && pageItems.every(d => selected.has(d.id))

  const totals = useMemo(() => filtered.reduce(
    (acc, d) => {
      acc.total += docTotal(d)
      if (isOpen(d)) acc.open += docBalance(d)
      return acc
    },
    { total: 0, open: 0 },
  ), [filtered])
  const currency = filtered[0]?.currency ?? 'EUR'

  // Only rows the user can currently see take part in bulk actions.
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

  async function bulkUpdateStatus(newStatus: string) {
    setBulkLoading(true)
    setBulkConfirm(null)
    const ids = selectedVisible.map(d => d.id)
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
    const { updated, skipped } = await res.json()
    toast.success(`${updated} invoice${updated !== 1 ? 's' : ''} marked as ${newStatus}.`)
    if (skipped) toast.info(`${skipped} invoice${skipped !== 1 ? 's were' : ' was'} left alone (already ${newStatus === 'sent' ? 'issued' : 'paid or cancelled'}).`)
    clearSelection()
    router.refresh()
  }

  async function bulkDelete() {
    setBulkLoading(true)
    setBulkConfirm(null)
    const ids = selectedVisible.map(d => d.id)
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
    const { deleted, skipped } = await res.json()
    toast.success(`${deleted} draft${deleted !== 1 ? 's' : ''} deleted.`)
    if (skipped) toast.info(`${skipped} issued invoice${skipped !== 1 ? 's were' : ' was'} kept — issued documents cannot be deleted, cancel them instead.`)
    clearSelection()
    router.refresh()
  }

  function handleExport() {
    const toExport = hasSelection ? selectedVisible : filtered
    exportCSV(toExport)
    toast.success(`Exported ${toExport.length} invoice${toExport.length !== 1 ? 's' : ''} to CSV.`)
  }

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

      <div className="flex gap-3 flex-wrap items-center">
        <input
          value={q}
          onChange={e => updateFilter({ q: e.target.value })}
          placeholder="Search number or client…"
          className={`flex-1 min-w-48 max-w-sm pl-3 pr-3 py-1.5 ${inputClass}`}
        />
        <select
          value={status}
          onChange={e => updateFilter({ status: e.target.value })}
          className={inputClass}
        >
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s === 'outstanding' ? 'Outstanding (sent + overdue)' : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select
          value={client}
          onChange={e => updateFilter({ client: e.target.value })}
          className={`${inputClass} max-w-48`}
        >
          <option value="">All clients</option>
          {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
          <input type="date" value={from} max={to || undefined} onChange={e => updateFilter({ from: e.target.value })} aria-label="From date" className={inputClass} />
          <span>–</span>
          <input type="date" value={to} min={from || undefined} onChange={e => updateFilter({ to: e.target.value })} aria-label="To date" className={inputClass} />
        </div>
        {hasFilters && (
          <button
            onClick={() => updateFilter({ status: '', q: '', from: '', to: '', client: '' })}
            className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-400 dark:text-neutral-500">
                {hasFilters ? 'No invoices match your filters.' : 'No invoices yet.'}
              </p>
              {!hasFilters && (
                <Link href="/invoices/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  Create your first invoice
                </Link>
              )}
            </div>
          )}
          {pageItems.map(doc => {
            const balance = docBalance(doc)
            return (
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
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    {isOpen(doc) && balance !== docTotal(doc) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">Open {formatMoney(balance, doc.currency ?? undefined)}</p>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                  </div>
                </Link>
              </div>
            )
          })}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 text-xs bg-neutral-50 dark:bg-neutral-800">
              <span className="text-neutral-500 dark:text-neutral-400">Total {formatMoney(totals.total, currency)}</span>
              <span className="font-semibold">Open {formatMoney(totals.open, currency)}</span>
            </div>
          )}
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
              <Th col="number" label="Number" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="client" label="Client" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="date" label="Date" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="due_date" label="Due" sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="total" label="Total" sort={sort} onSort={toggleSort} className="text-right" />
              <Th col="balance" label="Balance" sort={sort} onSort={toggleSort} className="text-right" />
              <Th col="status" label="Status" sort={sort} onSort={toggleSort} className="text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">
                    {hasFilters ? 'No invoices match your filters.' : 'No invoices yet.'}
                  </p>
                  {!hasFilters && (
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
                <td className="px-4 py-3 text-right font-medium">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</td>
                <td className={`px-4 py-3 text-right ${isOpen(doc) && docBalance(doc) > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-neutral-400 dark:text-neutral-500'}`}>
                  {doc.status === 'draft' || doc.status === 'cancelled' ? '—' : formatMoney(docBalance(doc), doc.currency ?? undefined)}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{doc.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-xs">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400">
                  {filtered.length} invoice{filtered.length !== 1 ? 's' : ''}{hasFilters ? ' (filtered)' : ''}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold">{formatMoney(totals.total, currency)}</td>
                <td className="px-4 py-2.5 text-right font-semibold">{formatMoney(totals.open, currency)}</td>
                <td className="px-4 py-2.5 text-neutral-400 dark:text-neutral-500">open</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{filtered.length} invoice{filtered.length !== 1 ? 's' : ''}</p>
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <button onClick={() => setPage(page - 1)} disabled={page <= 1} className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">Prev</button>
            <span>Page {page} of {pageCount}</span>
            <button onClick={() => setPage(page + 1)} disabled={page >= pageCount} className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">Next</button>
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
                  exportCSV(selectedVisible)
                  toast.success(`Exported ${selectedCount} invoice${selectedCount !== 1 ? 's' : ''}.`)
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
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">{bulkConfirm.label} {selectedCount} invoice{selectedCount !== 1 ? 's' : ''}?</h3>
              {bulkConfirm.action === 'delete' && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Only drafts are deleted — issued invoices are kept. This cannot be undone.</p>
              )}
              {bulkConfirm.action === 'paid' && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">The open balance of each invoice is recorded as a payment dated today. Invoices that are already paid or cancelled are left alone; drafts are issued first.</p>
              )}
              {bulkConfirm.action === 'sent' && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Drafts get the next invoice number assigned; invoices that are already issued are left alone.</p>
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
