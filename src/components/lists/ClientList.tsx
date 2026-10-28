'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, Users, ChevronRight } from 'lucide-react'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'

const statusColor: Record<string, string> = {
  active: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  inactive: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800',
  lead: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
}

const STATUSES = ['active', 'inactive', 'lead']

type SortKey = 'name' | 'company' | 'country' | 'status' | 'last_invoiced'
type SortDir = 'asc' | 'desc'

interface Client {
  id: string
  name: string
  company: string | null
  email: string | null
  country: string | null
  tax_treatment: string
  status: string
  tags: string[]
}

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
      <button type="button" onClick={() => onSort(col)} className="flex items-center gap-1 w-full rounded hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
        {label}<SortIcon col={col} sort={sort} />
      </button>
    </th>
  )
}

const PAGE_SIZE = 25

export default function ClientList({ clients, lastInvoicedMap = {} }: { clients: Client[]; lastInvoicedMap?: Record<string, string> }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [page, setPage] = useState(0)

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const taxLabel = (s: string) => t(`taxTreatmentsShort.${s}` as DictKey)

  function toggleSort(key: SortKey) {
    setPage(0)
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }

  const filtered = useMemo(() => {
    let list = clients
    if (status) list = list.filter(c => c.status === status)
    if (q) {
      const lq = q.toLowerCase()
      list = list.filter(c =>
        `${c.name} ${c.company ?? ''} ${c.email ?? ''}`.toLowerCase().includes(lq)
      )
    }
    return [...list].sort((a, b) => {
      let av = '', bv = ''
      if (sort.key === 'name') { av = a.name || a.company || ''; bv = b.name || b.company || '' }
      else if (sort.key === 'company') { av = a.company ?? ''; bv = b.company ?? '' }
      else if (sort.key === 'country') { av = a.country ?? ''; bv = b.country ?? '' }
      else if (sort.key === 'status') { av = a.status; bv = b.status }
      else if (sort.key === 'last_invoiced') { av = lastInvoicedMap[a.id] ?? ''; bv = lastInvoicedMap[b.id] ?? '' }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [clients, q, status, sort])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('clients.title')}</h1>
        <Link href="/clients/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
          <Plus size={14} /> {t('clients.new')}
        </Link>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          type="search"
          aria-label={t('clients.searchLabel')}
          value={q}
          onChange={e => { setQ(e.target.value); setPage(0) }}
          placeholder={t('clients.searchPlaceholder')}
          className="flex-1 min-w-48 max-w-sm pl-3 pr-3 py-1.5 text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md focus:outline-none focus:ring-1 focus:ring-neutral-400 bg-white dark:bg-neutral-900 dark:text-neutral-100"
        />
        <select
          aria-label={t('common.status')}
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(0) }}
          className="text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
      </div>

      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <Users size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {q || status ? t('clients.noMatch') : t('clients.noneYet')}
              </p>
              {!q && !status && (
                <Link href="/clients/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  {t('clients.addFirst')}
                </Link>
              )}
            </div>
          )}
          {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(c => (
            <Link
              key={c.id}
              href={`/clients/${c.id}`}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <div className="min-w-0">
                <p className="font-medium text-sm">{c.name || c.company}</p>
                {c.name && c.company && <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{c.company}</p>}
                <div className="flex items-center gap-2 mt-1">
                  {c.tags.slice(0, 2).map(tag => (
                    <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{tag}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[c.status] ?? ''}`}>{statusLabel(c.status)}</span>
                <ChevronRight size={14} aria-hidden="true" className="text-neutral-400 dark:text-neutral-600" />
              </div>
            </Link>
          ))}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr>
              <Th col="name" label={t('clients.name')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="company" label={t('clients.company')} sort={sort} onSort={toggleSort} className="text-left" />
              <Th col="country" label={t('clients.country')} sort={sort} onSort={toggleSort} className="text-left" />
              <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('clients.tax')}</th>
              <Th col="status" label={t('common.status')} sort={sort} onSort={toggleSort} className="text-left" />
              <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('clients.tags')}</th>
              <Th col="last_invoiced" label={t('clients.lastInvoice')} sort={sort} onSort={toggleSort} className="text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center">
                  <Users size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {q || status ? t('clients.noMatch') : t('clients.noneYet')}
                  </p>
                  {!q && !status && (
                    <Link href="/clients/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                      {t('clients.addFirst')}
                    </Link>
                  )}
                </td>
              </tr>
            )}
            {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(c => (
              <tr key={c.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name || c.company}</Link>
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.company ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.country ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{taxLabel(c.tax_treatment)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[c.status] ?? ''}`}>{statusLabel(c.status)}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {c.tags.map((tag: string) => (
                      <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{tag}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 text-xs">
                  {lastInvoicedMap[c.id] ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{n(filtered.length, t('clients.countOne', { count: filtered.length }), t('clients.countOther', { count: filtered.length }))}</p>
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <button type="button" onClick={() => setPage(p => p - 1)} disabled={page === 0} className="px-2.5 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">{t('common.prev')}</button>
            <span>{t('common.pageOf', { page: page + 1, count: Math.ceil(filtered.length / PAGE_SIZE) })}</span>
            <button type="button" onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= filtered.length} className="px-2.5 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 disabled:opacity-30 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">{t('common.next')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
