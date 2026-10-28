'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Plus, Users, ChevronRight, Download, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { formatMoney, roundCents, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { StatusBadge } from './StatusBadge'
import { useListState, useSelection, paginate, compareBy, type ListConfig } from './useListState'
import {
  SortableTh, PlainTh, SelectToggle, ClickableRow, EmptyState, Pagination, BulkBar, BulkButton, ExportButton,
  inputClass, searchClass, primaryLinkClass, listCardClass, theadClass, rowStateClass,
} from './ListParts'

const STATUSES = ['active', 'inactive', 'lead'] as const

type SortKey = 'name' | 'company' | 'country' | 'status' | 'balance' | 'last_invoiced'
const LIST: ListConfig<'status' | 'q' | 'tag', SortKey> = {
  filters: { status: STATUSES, q: null, tag: null },
  sortKeys: ['name', 'company', 'country', 'status', 'balance', 'last_invoiced'],
  defaultSort: { key: 'name', dir: 'asc' },
  firstDir: 'asc',
}

export interface ClientRow {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  zip: string | null
  city: string | null
  country: string | null
  uid_number: string | null
  tax_treatment: string
  language: string | null
  payment_days: number | null
  status: string
  tags: string[] | null
}

const displayName = (c: ClientRow) => c.name || c.company || ''

function exportCSV(clients: ClientRow[], balances: Record<string, number>, lastInvoiced: Record<string, string>, t: TFn) {
  const rows = clients.map(c => [
    c.name,
    c.company ?? '',
    c.email ?? '',
    c.phone ?? '',
    c.address_line1 ?? '',
    c.address_line2 ?? '',
    c.zip ?? '',
    c.city ?? '',
    c.country ?? '',
    c.uid_number ?? '',
    t(`taxTreatments.${c.tax_treatment}` as DictKey),
    c.language === 'en' ? t('common.english') : t('common.german'),
    c.payment_days,
    t(`status.${c.status}` as DictKey),
    (c.tags ?? []).join(', '),
    balances[c.id] ?? 0,
    csvDate(lastInvoiced[c.id]),
  ])
  const header = [
    t('clients.form.name'), t('clients.form.company'), t('clients.form.email'), t('clients.form.phone'), t('clients.form.address'),
    t('clients.form.addressLine2'), t('clients.form.zip'), t('clients.form.city'), t('clients.form.country'), t('clients.form.uid'),
    t('clients.form.taxTreatment'), t('clients.form.language'), t('clients.form.paymentDays'), t('clients.form.status'), t('clients.form.tags'),
    t('clients.openBalance'), t('clients.lastInvoice'),
  ]
  downloadCsv(`clients-${today()}.csv`, toCsv(header, rows))
}

export default function ClientList({ clients, lastInvoicedMap = {}, balanceMap = {} }: {
  clients: ClientRow[]
  lastInvoicedMap?: Record<string, string>
  balanceMap?: Record<string, number>
}) {
  const { t } = useT()
  const list = useListState(LIST)
  const { status, q, tag } = list.filters
  const { sort } = list

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const taxLabel = (s: string) => t(`taxTreatmentsShort.${s}` as DictKey)
  const balance = (c: ClientRow) => balanceMap[c.id] ?? 0

  const allTags = useMemo(() => [...new Set(clients.flatMap(c => c.tags ?? []))].sort((a, b) => a.localeCompare(b)), [clients])

  const filtered = useMemo(() => {
    let rows = clients
    if (status) rows = rows.filter(c => c.status === status)
    if (tag) rows = rows.filter(c => (c.tags ?? []).includes(tag))
    if (q) {
      const lq = q.toLowerCase()
      rows = rows.filter(c =>
        `${c.name} ${c.company ?? ''} ${c.email ?? ''} ${c.city ?? ''} ${c.uid_number ?? ''} ${(c.tags ?? []).join(' ')}`.toLowerCase().includes(lq)
      )
    }
    const value = (c: ClientRow): string | number => {
      switch (sort.key) {
        case 'name': return displayName(c)
        case 'company': return c.company ?? ''
        case 'country': return c.country ?? ''
        case 'status': return c.status
        case 'balance': return balanceMap[c.id] ?? 0
        case 'last_invoiced': return lastInvoicedMap[c.id] ?? ''
      }
    }
    return [...rows].sort((a, b) => compareBy(value(a), value(b), sort.dir))
  }, [clients, q, status, tag, sort, balanceMap, lastInvoicedMap])

  const { page, pageCount, pageItems } = paginate(filtered, list.page)
  const selection = useSelection(filtered, pageItems)
  const selectedCount = selection.count
  const openTotal = roundCents(filtered.reduce((s, c) => s + balance(c), 0))

  function setFilters(patch: Partial<Record<keyof typeof LIST.filters, string>>) {
    selection.clear()
    list.setFilters(patch)
  }

  function handleExport(rows: ClientRow[]) {
    exportCSV(rows, balanceMap, lastInvoicedMap, t)
    const count = rows.length
    toast.success(n(count, t('exports.lists.clientsExportedOne', { count }), t('exports.lists.clientsExportedOther', { count })))
  }

  const tagChip = (value: string) => (
    <span key={value} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{value}</span>
  )
  const empty = (
    <EmptyState
      icon={Users}
      message={list.hasFilters ? t('clients.noMatch') : t('clients.noneYet')}
      cta={list.hasFilters ? undefined : { href: '/clients/new', label: t('clients.addFirst') }}
    />
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('clients.title')}</h1>
        <div className="flex items-center gap-2">
          <ExportButton onClick={() => handleExport(selectedCount ? selection.selectedVisible : filtered)} />
          <Link href="/clients/new" className={primaryLinkClass}>
            <Plus size={14} /> {t('clients.new')}
          </Link>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex gap-3 flex-wrap">
          <input type="search" aria-label={t('clients.searchLabel')} value={q} onChange={e => setFilters({ q: e.target.value })} placeholder={t('clients.searchPlaceholder')} className={searchClass} />
          <select aria-label={t('common.status')} value={status} onChange={e => setFilters({ status: e.target.value })} className={inputClass}>
            <option value="">{t('status.allStatuses')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </div>
        {allTags.length > 0 && (
          <div role="group" aria-label={t('exports.lists.tagFilter')} className="flex items-center gap-1.5 flex-wrap">
            <Tag size={13} aria-hidden="true" className="text-neutral-400 dark:text-neutral-500" />
            {allTags.map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={tag === value}
                onClick={() => setFilters({ tag: tag === value ? '' : value })}
                className={`text-xs px-2.5 py-1.5 sm:py-1 rounded-full border transition-colors ${tag === value
                  ? 'bg-neutral-900 text-white border-neutral-900 dark:bg-white dark:text-neutral-900 dark:border-white'
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
              >
                {value}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={listCardClass}>
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && empty}
          {pageItems.map(c => {
            const selected = selection.isSelected(c.id)
            return (
              <div key={c.id} className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${rowStateClass(selected)}`}>
                <SelectToggle large checked={selected} onToggle={() => selection.toggleOne(c.id)} label={t('lists.selectRow', { number: displayName(c) })} />
                <Link href={`/clients/${c.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{displayName(c)}</p>
                    {c.name && c.company && <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{c.company}</p>}
                    {(c.tags ?? []).length > 0 && <div className="flex items-center gap-2 mt-1">{(c.tags ?? []).slice(0, 2).map(tagChip)}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge status={c.status} label={statusLabel(c.status)} />
                      {balance(c) > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">{t('invoices.openAmount', { amount: formatMoney(balance(c)) })}</span>}
                    </div>
                    <ChevronRight size={14} aria-hidden="true" className="text-neutral-400 dark:text-neutral-600" />
                  </div>
                </Link>
              </div>
            )
          })}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="pl-4 py-3 w-8">
                <SelectToggle checked={selection.allPageSelected} onToggle={selection.toggleAll} label={t('lists.selectAll')} />
              </th>
              <SortableTh col="name" label={t('clients.name')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="company" label={t('clients.company')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="country" label={t('clients.country')} sort={sort} onSort={list.toggleSort} />
              <PlainTh>{t('clients.tax')}</PlainTh>
              <SortableTh col="status" label={t('common.status')} sort={sort} onSort={list.toggleSort} />
              <PlainTh>{t('clients.tags')}</PlainTh>
              <SortableTh col="balance" label={t('clients.openBalance')} sort={sort} onSort={list.toggleSort} align="right" />
              <SortableTh col="last_invoiced" label={t('clients.lastInvoice')} sort={sort} onSort={list.toggleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && <tr><td colSpan={9}>{empty}</td></tr>}
            {pageItems.map(c => (
              <ClickableRow key={c.id} href={`/clients/${c.id}`} className={rowStateClass(selection.isSelected(c.id))}>
                <td className="pl-4 py-3 w-8">
                  <SelectToggle checked={selection.isSelected(c.id)} onToggle={() => selection.toggleOne(c.id)} label={t('lists.selectRow', { number: displayName(c) })} />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{displayName(c)}</Link>
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.company || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.country || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{taxLabel(c.tax_treatment)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={c.status} label={statusLabel(c.status)} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">{(c.tags ?? []).map(tagChip)}</div>
                </td>
                <td className={`px-4 py-3 text-right whitespace-nowrap ${balance(c) > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-neutral-400 dark:text-neutral-500'}`}>
                  {balance(c) > 0 ? formatMoney(balance(c)) : '—'}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 text-xs whitespace-nowrap">
                  {lastInvoicedMap[c.id] ?? '—'}
                </td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {n(filtered.length, t('clients.countOne', { count: filtered.length }), t('clients.countOther', { count: filtered.length }))}
          {openTotal > 0 && <> · {t('invoices.openAmount', { amount: formatMoney(openTotal) })}</>}
        </p>
        <Pagination page={page} pageCount={pageCount} onPage={list.setPage} />
      </div>

      <BulkBar count={selectedCount} onClear={selection.clear}>
        <BulkButton icon={Download} onClick={() => handleExport(selection.selectedVisible)}>{t('lists.exportCsv')}</BulkButton>
      </BulkBar>
    </div>
  )
}
