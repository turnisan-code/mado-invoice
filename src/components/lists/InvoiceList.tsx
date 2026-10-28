'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, FileText, CheckSquare, Square, Download, CheckCircle, Send, X, Trash2 } from 'lucide-react'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'

const statusColor: Record<string, string> = {
  draft: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
  sent: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  paid: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  overdue: 'text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300',
  cancelled: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
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
      aria-sort={sort.key === col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 ${className}`}
    >
      <button type="button" onClick={() => onSort(col)} className={`flex items-center gap-1 w-full rounded hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors ${className.includes('text-right') ? 'justify-end' : ''}`}>
        {label}<SortIcon col={col} sort={sort} />
      </button>
    </th>
  )
}

const PAGE_SIZE = 25

function exportCSV(invoices: Invoice[], t: TFn) {
  const rows = invoices.map(inv => {
    const tot = docTotals(inv)
    return [
      inv.number ?? '',
      inv.clients?.name ?? '',
      inv.clients?.company ?? '',
      csvDate(inv.date),
      csvDate(inv.due_date),
      tot.subtotal - tot.discount_amount,
      tot.total_vat,
      tot.total,
      tot.total_paid,
      docBalance(inv),
      inv.currency ?? 'EUR',
      inv.status,
    ]
  })
  const header = [t('csv.number'), t('csv.client'), t('csv.company'), t('csv.date'), t('csv.dueDate'), t('csv.net'), t('csv.vat'), t('csv.total'), t('csv.paid'), t('csv.balance'), t('csv.currency'), t('csv.status')]
  downloadCsv(`invoices-${today()}.csv`, toCsv(header, rows))
}

const inputClass = 'text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400'

export default function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useT()
  const urlQs = searchParams.toString()
  const [filters, setFilters] = useState<Filters>(() => parseFilters(searchParams))
  const pendingUrls = useRef(new Set<string>())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<{ action: string; label: string } | null>(null)

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const invoiceCount = (count: number) => n(count, t('invoices.countOne', { count }), t('invoices.countOther', { count }))

  // Filter state lives in the component for instant feedback and is mirrored to the URL
  // (debounced, so typing does not navigate per keystroke) to survive reloads and back/forward.
  useEffect(() => {
    const next = serializeFilters(filters)
    if (next === urlQs) return
    const timer = setTimeout(() => {
      pendingUrls.current.add(next)
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
    }, 250)
    return () => clearTimeout(timer)
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
      setSelected(s => { const next = new Set(s); pageItems.forEach(d => next.delete(d.id)); return next })
    } else {
      setSelected(s => { const next = new Set(s); pageItems.forEach(d => next.add(d.id)); return next })
    }
  }

  function toggleOne(id: string) {
    setSelected(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next })
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
      const { error } = await res.json().catch(() => ({ error: t('common.failed') }))
      toast.error(t('lists.bulkFailed', { error }))
      return
    }
    const { updated, skipped } = await res.json()
    const vars = { count: updated, status: statusLabel(newStatus) }
    toast.success(n(updated, t('invoices.markedOne', vars), t('invoices.markedOther', vars)))
    if (skipped) {
      toast.info(newStatus === 'sent'
        ? n(skipped, t('invoices.skippedSentOne', { count: skipped }), t('invoices.skippedSentOther', { count: skipped }))
        : n(skipped, t('invoices.skippedPaidOne', { count: skipped }), t('invoices.skippedPaidOther', { count: skipped })))
    }
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
      const { error } = await res.json().catch(() => ({ error: t('common.failed') }))
      toast.error(t('lists.deleteFailed', { error }))
      return
    }
    const { deleted, skipped } = await res.json()
    toast.success(n(deleted, t('invoices.deletedOne', { count: deleted }), t('invoices.deletedOther', { count: deleted })))
    if (skipped) toast.info(n(skipped, t('invoices.deleteSkippedOne', { count: skipped }), t('invoices.deleteSkippedOther', { count: skipped })))
    clearSelection()
    router.refresh()
  }

  function handleExport() {
    const toExport = hasSelection ? selectedVisible : filtered
    exportCSV(toExport, t)
    const count = toExport.length
    toast.success(n(count, t('invoices.exportedOne', { count }), t('invoices.exportedOther', { count })))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('invoices.title')}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            title={t('lists.exportCsv')}
            className="flex items-center gap-1.5 text-sm px-3 py-2 sm:py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-600 dark:text-neutral-400"
          >
            <Download size={14} />
            <span className="sr-only sm:not-sr-only">{t('lists.exportCsv')}</span>
          </button>
          <Link href="/invoices/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
            <Plus size={14} /> {t('invoices.new')}
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="search"
          aria-label={t('invoices.searchLabel')}
          value={q}
          onChange={e => updateFilter({ q: e.target.value })}
          placeholder={t('lists.searchPlaceholder')}
          className={`flex-1 min-w-48 max-w-sm pl-3 pr-3 py-1.5 ${inputClass}`}
        />
        <select
          aria-label={t('common.status')}
          value={status}
          onChange={e => updateFilter({ status: e.target.value })}
          className={inputClass}
        >
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <select
          aria-label={t('common.client')}
          value={client}
          onChange={e => updateFilter({ client: e.target.value })}
          className={`${inputClass} max-w-48`}
        >
          <option value="">{t('lists.allClients')}</option>
          {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <input type="date" value={from} max={to || undefined} onChange={e => updateFilter({ from: e.target.value })} aria-label={t('lists.fromDate')} className={inputClass} />
          <span>–</span>
          <input type="date" value={to} min={from || undefined} onChange={e => updateFilter({ to: e.target.value })} aria-label={t('lists.toDate')} className={inputClass} />
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => updateFilter({ status: '', q: '', from: '', to: '', client: '' })}
            className="flex items-center gap-1 text-xs px-2 py-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={12} /> {t('lists.clearFilters')}
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {hasFilters ? t('invoices.noMatch') : t('invoices.noneYet')}
              </p>
              {!hasFilters && (
                <Link href="/invoices/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  {t('invoices.createFirst')}
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
                  type="button"
                  onClick={() => toggleOne(doc.id)}
                  aria-pressed={selected.has(doc.id)}
                  aria-label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })}
                  className="shrink-0 h-11 w-11 -ml-3 -my-2 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                >
                  {selected.has(doc.id)
                    ? <CheckSquare size={16} className="text-blue-500" />
                    : <Square size={16} />
                  }
                </button>
                <Link href={`/invoices/${doc.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {doc.number ?? <span className="text-neutral-500 dark:text-neutral-400">{t('common.draft')}</span>}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">
                      {doc.clients?.company ?? doc.clients?.name ?? '—'}
                    </p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{doc.date ?? '—'}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    {isOpen(doc) && balance !== docTotal(doc) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('invoices.openAmount', { amount: formatMoney(balance, doc.currency ?? undefined) })}</p>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{statusLabel(doc.status)}</span>
                  </div>
                </Link>
              </div>
            )
          })}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 text-xs bg-neutral-50 dark:bg-neutral-800">
              <span className="text-neutral-500 dark:text-neutral-400">{t('invoices.totalAmount', { amount: formatMoney(totals.total, currency) })}</span>
              <span className="font-semibold">{t('invoices.openAmount', { amount: formatMoney(totals.open, currency) })}</span>
            </div>
          )}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr>
              <th className="pl-4 py-3 w-8">
                <button type="button" onClick={toggleAll} aria-pressed={allPageSelected} aria-label={t('lists.selectAll')} className="h-8 w-8 -my-2 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                  {allPageSelected
                    ? <CheckSquare size={14} className="text-blue-500" />
                    : <Square size={14} />
                  }
                </button>
              </th>
              <Th col="number" label={t('common.number')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="client" label={t('common.client')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="date" label={t('common.date')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="due_date" label={t('invoices.due')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="total" label={t('common.total')} sort={sort} onSort={toggleSort} className="text-right" />
              <Th col="balance" label={t('invoices.balance')} sort={sort} onSort={toggleSort} className="text-right" />
              <Th col="status" label={t('common.status')} sort={sort} onSort={toggleSort} className="text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <FileText size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {hasFilters ? t('invoices.noMatch') : t('invoices.noneYet')}
                  </p>
                  {!hasFilters && (
                    <Link href="/invoices/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                      {t('invoices.createFirst')}
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
                  <button type="button" onClick={() => toggleOne(doc.id)} aria-pressed={selected.has(doc.id)} aria-label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} className="h-8 w-8 -my-2 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                    {selected.has(doc.id)
                      ? <CheckSquare size={14} className="text-blue-500" />
                      : <Square size={14} />
                    }
                  </button>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/invoices/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}
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
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[doc.status] ?? ''}`}>{statusLabel(doc.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-xs">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400">
                  {invoiceCount(filtered.length)}{hasFilters ? ` ${t('lists.filtered')}` : ''}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold">{formatMoney(totals.total, currency)}</td>
                <td className="px-4 py-2.5 text-right font-semibold">{formatMoney(totals.open, currency)}</td>
                <td className="px-4 py-2.5 text-neutral-400 dark:text-neutral-500">{t('invoices.open')}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{invoiceCount(filtered.length)}</p>
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <button type="button" onClick={() => setPage(page - 1)} disabled={page <= 1} className="px-2.5 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">{t('common.prev')}</button>
            <span>{t('common.pageOf', { page, count: pageCount })}</span>
            <button type="button" onClick={() => setPage(page + 1)} disabled={page >= pageCount} className="px-2.5 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">{t('common.next')}</button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      <div
        role="region"
        aria-label={t('lists.bulkActions')}
        aria-hidden={!hasSelection}
        className={`fixed left-0 right-0 z-50 transition-all duration-200 ${hasSelection ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'}`}
        style={{ bottom: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="max-w-5xl mx-auto px-4 pb-[4.5rem] md:pb-6">
          <div className="bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium shrink-0">
              {t('lists.selected', { count: selectedCount })}
            </span>
            <div className="flex items-center gap-2 flex-1 flex-wrap">
              <button
                type="button"
                onClick={() => setBulkConfirm({ action: 'sent', label: t('invoices.actionSent') })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-2 sm:py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
              >
                <Send size={12} /> {t('lists.markSent')}
              </button>
              <button
                type="button"
                onClick={() => setBulkConfirm({ action: 'paid', label: t('invoices.actionPaid') })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-2 sm:py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
              >
                <CheckCircle size={12} /> {t('lists.markPaid')}
              </button>
              <button
                type="button"
                onClick={() => {
                  exportCSV(selectedVisible, t)
                  toast.success(n(selectedCount, t('invoices.bulkExportedOne', { count: selectedCount }), t('invoices.bulkExportedOther', { count: selectedCount })))
                }}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-2 sm:py-1.5 rounded-lg bg-white/20 dark:bg-neutral-900/20 hover:bg-white/30 dark:hover:bg-neutral-900/30 transition-colors disabled:opacity-50"
              >
                <Download size={12} /> {t('lists.exportCsv')}
              </button>
              <button
                type="button"
                onClick={() => setBulkConfirm({ action: 'delete', label: t('invoices.actionDelete') })}
                disabled={bulkLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-2 sm:py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} /> {t('common.delete')}
              </button>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              aria-label={t('lists.clearSelection')}
              className="shrink-0 h-11 w-11 -my-2 -mr-2 flex items-center justify-center rounded-lg hover:bg-white/20 dark:hover:bg-neutral-900/20 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Bulk action confirmation */}
      <ConfirmDialog
        open={!!bulkConfirm}
        title={bulkConfirm ? n(selectedCount, t('invoices.confirmTitleOne', { action: bulkConfirm.label, count: selectedCount }), t('invoices.confirmTitleOther', { action: bulkConfirm.label, count: selectedCount })) : ''}
        description={
          bulkConfirm?.action === 'delete' ? t('invoices.confirmDeleteDesc')
          : bulkConfirm?.action === 'paid' ? t('invoices.confirmPaidDesc')
          : bulkConfirm?.action === 'sent' ? t('invoices.confirmSentDesc')
          : undefined
        }
        confirmLabel={bulkLoading ? t('common.working') : t('common.confirm')}
        destructive={bulkConfirm?.action === 'delete'}
        busy={bulkLoading}
        onConfirm={() => { if (!bulkConfirm) return; if (bulkConfirm.action === 'delete') void bulkDelete(); else void bulkUpdateStatus(bulkConfirm.action) }}
        onCancel={() => setBulkConfirm(null)}
      />
    </div>
  )
}
