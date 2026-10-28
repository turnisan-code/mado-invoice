'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Plus, FileX, Download } from 'lucide-react'
import { toast } from 'sonner'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { StatusBadge } from './StatusBadge'
import { useListState, useSelection, paginate, compareBy, type ListConfig } from './useListState'
import {
  SortableTh, SelectToggle, ClickableRow, EmptyState, Pagination, BulkBar, BulkButton,
  inputClass, searchClass, headerButtonClass, primaryLinkClass, listCardClass, theadClass, rowStateClass,
} from './ListParts'

const STATUSES = ['draft', 'sent', 'cancelled'] as const

type SortKey = 'number' | 'client' | 'date' | 'total' | 'status'
const LIST: ListConfig<'status' | 'q', SortKey> = {
  filters: { status: STATUSES, q: null },
  sortKeys: ['number', 'client', 'date', 'total', 'status'],
  defaultSort: { key: 'date', dir: 'desc' },
}

interface DocItem { line_type?: string | null; sort_order?: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type?: string | null; discount_value?: number | null }
export interface CreditNote {
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

function docTotal(d: CreditNote) {
  return calcTotals(d.document_items, [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment).total
}

const clientLabel = (d: CreditNote) => d.clients?.company ?? d.clients?.name ?? ''

function exportCSV(docs: CreditNote[], t: TFn) {
  const rows = docs.map(d => [
    d.number ?? '',
    d.clients?.name ?? '',
    d.clients?.company ?? '',
    csvDate(d.date),
    docTotal(d),
    d.currency ?? 'EUR',
    d.status,
  ])
  const header = [t('csv.number'), t('csv.client'), t('csv.company'), t('csv.date'), t('csv.total'), t('csv.currency'), t('csv.status')]
  downloadCsv(`credit-notes-${today()}.csv`, toCsv(header, rows))
}

export default function CreditNoteList({ docs }: { docs: CreditNote[] }) {
  const { t } = useT()
  const list = useListState(LIST)
  const { status, q } = list.filters
  const { sort } = list

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const docCount = (count: number) => n(count, t('creditNotes.countOne', { count }), t('creditNotes.countOther', { count }))

  const filtered = useMemo(() => {
    let rows = docs
    if (status) rows = rows.filter(d => d.status === status)
    if (q) {
      const lq = q.toLowerCase()
      rows = rows.filter(d => `${d.number ?? ''} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase().includes(lq))
    }
    const value = (d: CreditNote): string | number => {
      switch (sort.key) {
        case 'number': return d.number ?? ''
        case 'client': return clientLabel(d)
        case 'date': return d.date ?? ''
        case 'total': return docTotal(d)
        case 'status': return d.status
      }
    }
    return [...rows].sort((a, b) => compareBy(value(a), value(b), sort.dir))
  }, [docs, q, status, sort])

  const { page, pageCount, pageItems } = paginate(filtered, list.page)
  const selection = useSelection(filtered, pageItems)
  const selectedCount = selection.count

  function setFilters(patch: Partial<Record<keyof typeof LIST.filters, string>>) {
    selection.clear()
    list.setFilters(patch)
  }

  function handleExport(rows: CreditNote[], bulk: boolean) {
    exportCSV(rows, t)
    const count = rows.length
    toast.success(bulk
      ? n(count, t('creditNotes.bulkExportedOne', { count }), t('creditNotes.bulkExportedOther', { count }))
      : n(count, t('creditNotes.exportedOne', { count }), t('creditNotes.exportedOther', { count })))
  }

  const empty = (
    <EmptyState
      icon={FileX}
      message={list.hasFilters ? t('creditNotes.noMatch') : t('creditNotes.noneYet')}
      cta={list.hasFilters ? undefined : { href: '/credit-notes/new', label: t('creditNotes.createFirst') }}
    />
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('creditNotes.title')}</h1>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => handleExport(selectedCount ? selection.selectedVisible : filtered, false)} title={t('lists.exportCsv')} className={headerButtonClass}>
            <Download size={14} />
            <span className="sr-only sm:not-sr-only">{t('lists.exportCsv')}</span>
          </button>
          <Link href="/credit-notes/new" className={primaryLinkClass}>
            <Plus size={14} /> {t('creditNotes.new')}
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input type="search" aria-label={t('creditNotes.searchLabel')} value={q} onChange={e => setFilters({ q: e.target.value })} placeholder={t('lists.searchPlaceholder')} className={searchClass} />
        <select aria-label={t('common.status')} value={status} onChange={e => setFilters({ status: e.target.value })} className={inputClass}>
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
      </div>

      <div className={listCardClass}>
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && empty}
          {pageItems.map(doc => {
            const selected = selection.isSelected(doc.id)
            return (
              <div key={doc.id} className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${rowStateClass(selected)}`}>
                <SelectToggle large checked={selected} onToggle={() => selection.toggleOne(doc.id)} label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} />
                <Link href={`/credit-notes/${doc.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {doc.number ?? <span className="text-neutral-500 dark:text-neutral-400">{t('common.draft')}</span>}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{clientLabel(doc) || '—'}</p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{doc.date ?? '—'}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    <StatusBadge status={doc.status} label={statusLabel(doc.status)} />
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
              <SortableTh col="number" label={t('common.number')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="client" label={t('common.client')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="date" label={t('common.date')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="total" label={t('common.total')} sort={sort} onSort={list.toggleSort} align="right" />
              <SortableTh col="status" label={t('common.status')} sort={sort} onSort={list.toggleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && <tr><td colSpan={6}>{empty}</td></tr>}
            {pageItems.map(doc => (
              <ClickableRow key={doc.id} href={`/credit-notes/${doc.id}`} className={rowStateClass(selection.isSelected(doc.id))}>
                <td className="pl-4 py-3 w-8">
                  <SelectToggle checked={selection.isSelected(doc.id)} onToggle={() => selection.toggleOne(doc.id)} label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/credit-notes/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{clientLabel(doc) || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.date ?? '—'}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={doc.status} label={statusLabel(doc.status)} />
                </td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{docCount(filtered.length)}</p>
        <Pagination page={page} pageCount={pageCount} onPage={list.setPage} />
      </div>

      <BulkBar count={selectedCount} onClear={selection.clear}>
        <BulkButton icon={Download} onClick={() => handleExport(selection.selectedVisible, true)}>{t('lists.exportCsv')}</BulkButton>
      </BulkBar>
    </div>
  )
}
