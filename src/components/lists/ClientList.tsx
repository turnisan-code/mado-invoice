'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Plus, ArrowUpDown, ArrowUp, ArrowDown, Users, ChevronRight } from 'lucide-react'

const statusColor: Record<string, string> = {
  active: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  inactive: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800',
  lead: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
}

const taxLabel: Record<string, string> = {
  at_vat: 'AT VAT',
  eu_reverse_charge: 'Reverse Charge',
  non_eu: 'Non-EU',
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

const PAGE_SIZE = 25

export default function ClientList({ clients, lastInvoicedMap = {} }: { clients: Client[]; lastInvoicedMap?: Record<string, string> }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [page, setPage] = useState(0)

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
      if (sort.key === 'name') { av = a.name; bv = b.name }
      else if (sort.key === 'company') { av = a.company ?? ''; bv = b.company ?? '' }
      else if (sort.key === 'country') { av = a.country ?? ''; bv = b.country ?? '' }
      else if (sort.key === 'status') { av = a.status; bv = b.status }
      else if (sort.key === 'last_invoiced') { av = lastInvoicedMap[a.id] ?? ''; bv = lastInvoicedMap[b.id] ?? '' }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [clients, q, status, sort])

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
        <h1 className="text-2xl font-semibold">Clients</h1>
        <Link href="/clients/new" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
          <Plus size={14} /> New Client
        </Link>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setPage(0) }}
          placeholder="Search name, company, email…"
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
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <Users size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-sm text-neutral-400 dark:text-neutral-500">
                {q || status ? 'No clients match your filters.' : 'No clients yet.'}
              </p>
              {!q && !status && (
                <Link href="/clients/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  Add your first client
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
                <p className="font-medium text-sm">{c.name}</p>
                {c.company && <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{c.company}</p>}
                <div className="flex items-center gap-2 mt-1">
                  {c.tags.slice(0, 2).map(t => (
                    <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{t}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[c.status] ?? ''}`}>{c.status}</span>
                <ChevronRight size={14} className="text-neutral-300 dark:text-neutral-600" />
              </div>
            </Link>
          ))}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr>
              <Th col="name" label="Name" className="text-left" />
              <Th col="company" label="Company" className="text-left" />
              <Th col="country" label="Country" className="text-left" />
              <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">Tax</th>
              <Th col="status" label="Status" className="text-left" />
              <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">Tags</th>
              <th
                className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
                onClick={() => toggleSort('last_invoiced')}
              >
                <span className="flex items-center gap-1">Last Invoice<SortIcon col="last_invoiced" sort={sort} /></span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center">
                  <Users size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">
                    {q || status ? 'No clients match your filters.' : 'No clients yet.'}
                  </p>
                  {!q && !status && (
                    <Link href="/clients/new" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                      Add your first client
                    </Link>
                  )}
                </td>
              </tr>
            )}
            {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(c => (
              <tr key={c.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.company ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.country ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{taxLabel[c.tax_treatment] ?? c.tax_treatment}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[c.status] ?? ''}`}>{c.status}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {c.tags.map((t: string) => (
                      <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{t}</span>
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
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{filtered.length} client{filtered.length !== 1 ? 's' : ''}</p>
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
