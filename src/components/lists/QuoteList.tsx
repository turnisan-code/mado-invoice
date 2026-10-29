'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, MessageSquareQuote, Download, Send } from 'lucide-react'
import { toast } from 'sonner'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { clientDisplayName } from '@/lib/utils/clients'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import { StatusBadge } from './StatusBadge'
import { useListState, useSelection, paginate, compareBy, type ListConfig } from './useListState'
import {
  SortableTh, SelectToggle, ClickableRow, EmptyState, Pagination, BulkBar, BulkButton, ExportButton,
  searchClass, primaryLinkClass, listCardClass, theadClass, rowStateClass, listDate,
} from './ListParts'
import { Select } from '@/components/ui/select'
import { isIssuedNoteList, latestIssued, type IssuedNote } from '@/lib/utils/bulk-issue'
import { BulkIssueNotice, BulkIssueResult } from './BulkIssue'

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'cancelled'] as const

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'status'
const LIST: ListConfig<'status' | 'q', SortKey> = {
  filters: { status: STATUSES, q: null },
  sortKeys: ['number', 'client', 'date', 'due_date', 'total', 'status'],
  defaultSort: { key: 'date', dir: 'desc' },
}

interface DocItem { line_type?: string | null; sort_order?: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type?: string | null; discount_value?: number | null }
export interface Quote {
  id: string
  number: string | null
  status: string
  date: string | null
  due_date: string | null
  currency: string | null
  clients: { name: string; company: string | null } | null
  tax_treatment?: string | null
  discount_type?: string | null
  discount_value?: number | null
  document_items: DocItem[]
}

function docTotal(d: Quote) {
  return calcTotals(d.document_items, [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment).total
}

function isExpired(d: Quote, todayStr: string) {
  return d.status === 'sent' && !!d.due_date && d.due_date < todayStr
}

const clientLabel = (d: Quote) => clientDisplayName(d.clients)
const shownStatus = (d: Quote, todayStr: string) => isExpired(d, todayStr) ? 'expired' : d.status

function exportCSV(quotes: Quote[], todayStr: string, t: TFn) {
  const rows = quotes.map(d => [
    d.number ?? '',
    d.clients?.name ?? '',
    d.clients?.company ?? '',
    csvDate(d.date),
    csvDate(d.due_date),
    docTotal(d),
    d.currency ?? 'EUR',
    t(`status.${shownStatus(d, todayStr)}` as DictKey),
  ])
  const header = [t('csv.number'), t('csv.client'), t('csv.company'), t('csv.date'), t('csv.validUntil'), t('csv.total'), t('csv.currency'), t('csv.status')]
  downloadCsv(`quotes-${todayStr}.csv`, toCsv(header, rows))
}

export default function QuoteList({ quotes }: { quotes: Quote[] }) {
  const router = useRouter()
  const { t, lang } = useT()
  const list = useListState(LIST)
  const { status, q } = list.filters
  const { sort } = list
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState(false)
  // Drafts dated before today are issued with today's date unless the confirm says otherwise.
  const [redate, setRedate] = useState(true)
  const [issueNotes, setIssueNotes] = useState<IssuedNote[] | null>(null)

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const quoteCount = (count: number) => n(count, t('quotes.countOne', { count }), t('quotes.countOther', { count }))
  const todayStr = today()
  const latest = useMemo(() => latestIssued(quotes), [quotes])

  const filtered = useMemo(() => {
    let rows = quotes
    if (status) rows = rows.filter(d => d.status === status)
    if (q) {
      const lq = q.toLowerCase()
      rows = rows.filter(d => `${d.number ?? ''} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase().includes(lq))
    }
    const value = (d: Quote): string | number => {
      switch (sort.key) {
        case 'number': return d.number ?? ''
        case 'client': return clientLabel(d)
        case 'date': return d.date ?? ''
        case 'due_date': return d.due_date ?? ''
        case 'total': return docTotal(d)
        case 'status': return d.status
      }
    }
    return [...rows].sort((a, b) => compareBy(value(a), value(b), sort.dir))
  }, [quotes, q, status, sort])

  const { page, pageCount, pageItems } = paginate(filtered, list.page)
  const selection = useSelection(filtered, pageItems)
  const selectedCount = selection.count

  function setFilters(patch: Partial<Record<keyof typeof LIST.filters, string>>) {
    selection.clear()
    list.setFilters(patch)
  }

  async function bulkMarkSent() {
    setBulkLoading(true)
    // Shown once the confirm has closed, so focus moves from one dialog to the next.
    let notes: IssuedNote[] = []
    try {
      const res = await fetch('/api/quotes/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selection.selectedVisible.map(d => d.id), status: 'sent', redate }),
      })
      const data = await res.json().catch(() => ({}))
      if (isIssuedNoteList(data.documents)) notes = data.documents
      if (!res.ok) {
        // Drafts before the incomplete one were issued.
        if (res.status === 422) {
          const { toastBulkIssueProblems } = await import('@/components/forms/builder/IssueProblems')
          if (toastBulkIssueProblems(t, data)) { router.refresh(); return }
        }
        // Drafts before the failed one were issued.
        if (notes.length) router.refresh()
        toast.error(t('lists.bulkFailed', { error: apiErrorMessage(t, data) }))
        return
      }
      const { updated, skipped } = data
      const redated = notes.filter(note => note.movedFrom).length
      toast.success(n(updated, t('quotes.markedSentOne', { count: updated }), t('quotes.markedSentOther', { count: updated })), {
        description: redated ? n(redated, t('views.bulkIssue.redatedOne', { count: redated }), t('views.bulkIssue.redatedOther', { count: redated })) : undefined,
      })
      if (skipped) toast.info(n(skipped, t('quotes.skippedOne', { count: skipped }), t('quotes.skippedOther', { count: skipped })))
      selection.clear()
      router.refresh()
    } catch (err) {
      toast.error(t('lists.bulkFailed', { error: requestErrorMessage(t, err) }))
    } finally {
      setBulkLoading(false)
      setBulkConfirm(false)
      setIssueNotes(notes)
    }
  }

  function handleExport(rows: Quote[], bulk: boolean) {
    exportCSV(rows, todayStr, t)
    const count = rows.length
    toast.success(bulk
      ? n(count, t('quotes.bulkExportedOne', { count }), t('quotes.bulkExportedOther', { count }))
      : n(count, t('quotes.exportedOne', { count }), t('quotes.exportedOther', { count })))
  }

  const badge = (doc: Quote) => isExpired(doc, todayStr)
    ? <StatusBadge status="expired" label={t('status.expired')} />
    : <StatusBadge status={doc.status} label={statusLabel(doc.status)} />
  const empty = (
    <EmptyState
      icon={MessageSquareQuote}
      message={list.hasFilters ? t('quotes.noMatch') : t('quotes.noneYet')}
      cta={list.hasFilters ? undefined : { href: '/quotes/new', label: t('quotes.createFirst') }}
    />
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('quotes.title')}</h1>
        <div className="flex items-center gap-2">
          <ExportButton onClick={() => handleExport(selectedCount ? selection.selectedVisible : filtered, false)} />
          <Link href="/quotes/new" className={primaryLinkClass}>
            <Plus size={14} /> {t('quotes.new')}
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input type="search" aria-label={t('quotes.searchLabel')} value={q} onChange={e => setFilters({ q: e.target.value })} placeholder={t('lists.searchPlaceholder')} className={searchClass} />
        <Select aria-label={t('common.status')} value={status} onChange={e => setFilters({ status: e.target.value })} className="w-auto">
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </Select>
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
                <Link href={`/quotes/${doc.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {doc.number ?? <span className="text-neutral-500 dark:text-neutral-400">{t('common.draft')}</span>}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{clientLabel(doc) || '—'}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-0.5">
                      {listDate(doc.date, lang)}{doc.due_date && <> · {t('quotes.validUntilInline', { date: listDate(doc.due_date, lang) })}</>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    {badge(doc)}
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
              <SortableTh col="due_date" label={t('quotes.validUntil')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="total" label={t('common.total')} sort={sort} onSort={list.toggleSort} align="right" />
              <SortableTh col="status" label={t('common.status')} sort={sort} onSort={list.toggleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && <tr><td colSpan={7}>{empty}</td></tr>}
            {pageItems.map(doc => (
              <ClickableRow key={doc.id} href={`/quotes/${doc.id}`} className={rowStateClass(selection.isSelected(doc.id))}>
                <td className="pl-4 py-3 w-8">
                  <SelectToggle checked={selection.isSelected(doc.id)} onToggle={() => selection.toggleOne(doc.id)} label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/quotes/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-500 dark:text-neutral-500">{t('common.draft')}</span>}
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{clientLabel(doc) || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{listDate(doc.date, lang)}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                  <span className="flex items-center gap-2">
                    {listDate(doc.due_date, lang)}
                    {isExpired(doc, todayStr) && <StatusBadge status="expired" label={t('status.expired')} />}
                  </span>
                </td>
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
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{quoteCount(filtered.length)}</p>
        <Pagination page={page} pageCount={pageCount} onPage={list.setPage} />
      </div>

      <BulkBar count={selectedCount} onClear={selection.clear}>
        <BulkButton tone="blue" icon={Send} onClick={() => { setRedate(true); setBulkConfirm(true) }} busy={bulkLoading}>{t('lists.markSent')}</BulkButton>
        <BulkButton icon={Download} onClick={() => handleExport(selection.selectedVisible, true)} disabled={bulkLoading}>{t('lists.exportCsv')}</BulkButton>
      </BulkBar>

      <ConfirmDialog
        open={bulkConfirm}
        title={n(selectedCount, t('quotes.confirmTitleOne', { count: selectedCount }), t('quotes.confirmTitleOther', { count: selectedCount }))}
        description={t('quotes.confirmSentDesc')}
        confirmLabel={bulkLoading ? t('common.working') : t('common.confirm')}
        busy={bulkLoading}
        onConfirm={() => void bulkMarkSent()}
        onCancel={() => setBulkConfirm(false)}
      >
        <BulkIssueNotice
          type="quote"
          drafts={bulkConfirm ? selection.selectedVisible.filter(d => d.status === 'draft').map(d => ({ id: d.id, date: d.date, total: docTotal(d) })) : []}
          latest={latest}
          today={todayStr}
          redate={redate}
          onRedate={setRedate}
        />
      </ConfirmDialog>

      <BulkIssueResult notes={issueNotes} path="quotes" onClose={() => setIssueNotes(null)} />
    </div>
  )
}
