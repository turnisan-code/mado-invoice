'use client'

import { useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, FileText, Download, CheckCircle, Send, X, Trash2, Repeat, Landmark, FileWarning } from 'lucide-react'
import { toast } from 'sonner'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { StatusBadge } from './StatusBadge'
import { displayStatus, statusLabelKey } from '@/lib/status'
import { useListState, useSelection, paginate, compareBy, type ListConfig } from './useListState'
import {
  SortableTh, SelectToggle, ClickableRow, EmptyState, Pagination, BulkBar, BulkButton, ExportButton,
  inputClass, searchClass, headerButtonClass, primaryLinkClass, listCardClass, theadClass, rowStateClass,
} from './ListParts'

const STATUSES = ['outstanding', 'draft', 'sent', 'paid', 'overdue', 'cancelled'] as const

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'balance' | 'status'
const LIST: ListConfig<'status' | 'q' | 'from' | 'to' | 'client', SortKey> = {
  filters: { status: STATUSES, q: null, from: null, to: null, client: null },
  sortKeys: ['number', 'client', 'date', 'due_date', 'total', 'balance', 'status'],
  defaultSort: { key: 'date', dir: 'desc' },
}

type BulkAction = 'sent' | 'paid' | 'delete'
type PaymentMethod = 'bank' | 'cash'

interface DocItem { line_type?: string | null; sort_order?: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type?: string | null; discount_value?: number | null }
export interface Invoice {
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
  pdf_path?: string | null
  document_items: DocItem[]
  payments?: { amount: number; kind?: string }[]
}

function docTotals(d: Invoice) {
  return calcTotals(d.document_items, d.payments ?? [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment)
}
const docTotal = (d: Invoice) => docTotals(d).total
// Nothing is owed on a draft (not issued yet) or a cancelled invoice (settled by its Storno).
const docBalance = (d: Invoice) => d.status === 'draft' || d.status === 'cancelled' ? 0 : docTotals(d).balance_due
const isOpen = (d: Invoice) => d.status === 'sent' || d.status === 'overdue'
const clientLabel = (d: Invoice) => d.clients?.company ?? d.clients?.name ?? ''

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

export default function InvoiceList({ invoices, recurringSourceIds = [] }: { invoices: Invoice[]; recurringSourceIds?: string[] }) {
  const router = useRouter()
  const { t } = useT()
  const uid = useId()
  const list = useListState(LIST)
  const { status, q, from, to, client } = list.filters
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null)
  const [paidDate, setPaidDate] = useState('')
  const [paidMethod, setPaidMethod] = useState<PaymentMethod>('bank')
  const [paidDateInvalid, setPaidDateInvalid] = useState(false)

  const statusLabel = (s: string) => t(`status.${s}` as DictKey)
  const invoiceCount = (count: number) => n(count, t('invoices.countOne', { count }), t('invoices.countOther', { count }))
  // Template invoices of a recurring schedule; the generated invoices are ordinary invoices.
  const recurring = new Set(recurringSourceIds)
  const recurringBadge = (
    <span className="inline-flex items-center gap-1 align-middle text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      <Repeat size={10} />{t('recurring.badge')}
    </span>
  )
  // An issued invoice should have its frozen PDF; without it the archive copy is missing.
  const noArchiveMarker = (
    <span title={t('exports.lists.noArchive')} className="inline-flex align-middle text-amber-500 dark:text-amber-400">
      <FileWarning size={13} aria-hidden="true" />
      <span className="sr-only">{t('exports.lists.noArchive')}</span>
    </span>
  )
  const markers = (doc: Invoice) => (
    <>
      {doc.number && !doc.pdf_path && <span className="ml-1.5">{noArchiveMarker}</span>}
      {recurring.has(doc.id) && <span className="ml-1.5">{recurringBadge}</span>}
    </>
  )

  const todayStr = today()

  const clientOptions = useMemo(() => {
    const names = new Map<string, string>()
    for (const d of invoices) {
      if (d.client_id && d.clients && !names.has(d.client_id)) names.set(d.client_id, d.clients.company || d.clients.name)
    }
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [invoices])

  const { sort } = list
  const filtered = useMemo(() => {
    let rows = invoices
    if (status === 'outstanding') rows = rows.filter(isOpen)
    else if (status === 'overdue') rows = rows.filter(d => d.status === 'overdue' || (d.status === 'sent' && !!d.due_date && d.due_date < todayStr))
    else if (status) rows = rows.filter(d => d.status === status)
    if (client) rows = rows.filter(d => d.client_id === client)
    if (from) rows = rows.filter(d => !!d.date && d.date >= from)
    if (to) rows = rows.filter(d => !!d.date && d.date <= to)
    if (q) {
      const lq = q.toLowerCase()
      rows = rows.filter(d => `${d.number ?? ''} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase().includes(lq))
    }
    const value = (d: Invoice): string | number => {
      switch (sort.key) {
        case 'number': return d.number ?? ''
        case 'client': return clientLabel(d)
        case 'date': return d.date ?? ''
        case 'due_date': return d.due_date ?? ''
        case 'total': return docTotal(d)
        case 'balance': return docBalance(d)
        case 'status': return d.status
      }
    }
    return [...rows].sort((a, b) => compareBy(value(a), value(b), sort.dir))
  }, [invoices, q, status, client, from, to, sort, todayStr])

  const { page, pageCount, pageItems } = paginate(filtered, list.page)
  const selection = useSelection(filtered, pageItems)

  // Partly paid and written-off invoices show that instead of their stored status.
  const statusBadge = (d: Invoice) => {
    const shown = displayStatus({ type: 'invoice', status: d.status, total: docTotal(d), payments: d.payments ?? [] }, todayStr)
    return <StatusBadge status={shown} label={t(statusLabelKey(shown))} />
  }

  function setFilters(patch: Partial<Record<keyof typeof LIST.filters, string>>) {
    selection.clear()
    list.setFilters(patch)
  }

  const totals = useMemo(() => filtered.reduce(
    (acc, d) => {
      acc.total += docTotal(d)
      if (isOpen(d)) acc.open += docBalance(d)
      return acc
    },
    { total: 0, open: 0 },
  ), [filtered])
  const currency = filtered[0]?.currency ?? 'EUR'

  function askBulk(action: BulkAction) {
    if (action === 'paid') {
      setPaidDate(todayStr)
      setPaidMethod('bank')
      setPaidDateInvalid(false)
    }
    setBulkConfirm(action)
  }

  async function runBulk() {
    const action = bulkConfirm
    if (!action) return
    if (action === 'paid' && (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate) || paidDate > todayStr)) {
      setPaidDateInvalid(true)
      return
    }
    const ids = selection.selectedVisible.map(d => d.id)
    const isDelete = action === 'delete'
    setBulkLoading(true)
    try {
      const res = await fetch('/api/invoices/bulk', {
        method: isDelete ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isDelete ? { ids } : action === 'paid' ? { ids, status: action, paidDate, method: paidMethod } : { ids, status: action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(t(isDelete ? 'lists.deleteFailed' : 'lists.bulkFailed', { error: data.error ?? t('common.failed') }))
        return
      }
      if (isDelete) {
        const { deleted, skipped } = data
        toast.success(n(deleted, t('invoices.deletedOne', { count: deleted }), t('invoices.deletedOther', { count: deleted })))
        if (skipped) toast.info(n(skipped, t('invoices.deleteSkippedOne', { count: skipped }), t('invoices.deleteSkippedOther', { count: skipped })))
      } else {
        const { updated, skipped } = data
        const vars = { count: updated, status: statusLabel(action) }
        toast.success(n(updated, t('invoices.markedOne', vars), t('invoices.markedOther', vars)))
        if (skipped) {
          toast.info(action === 'sent'
            ? n(skipped, t('invoices.skippedSentOne', { count: skipped }), t('invoices.skippedSentOther', { count: skipped }))
            : n(skipped, t('invoices.skippedPaidOne', { count: skipped }), t('invoices.skippedPaidOther', { count: skipped })))
        }
      }
      selection.clear()
      router.refresh()
    } catch {
      toast.error(t(isDelete ? 'lists.deleteFailed' : 'lists.bulkFailed', { error: t('common.failed') }))
    } finally {
      setBulkLoading(false)
      setBulkConfirm(null)
    }
  }

  function handleExport(rows: Invoice[], bulk: boolean) {
    exportCSV(rows, t)
    const count = rows.length
    toast.success(bulk
      ? n(count, t('invoices.bulkExportedOne', { count }), t('invoices.bulkExportedOther', { count }))
      : n(count, t('invoices.exportedOne', { count }), t('invoices.exportedOther', { count })))
  }

  const actionLabel: Record<BulkAction, string> = { sent: t('invoices.actionSent'), paid: t('invoices.actionPaid'), delete: t('invoices.actionDelete') }
  const selectedCount = selection.count
  const empty = (
    <EmptyState
      icon={FileText}
      message={list.hasFilters ? t('invoices.noMatch') : t('invoices.noneYet')}
      cta={list.hasFilters ? undefined : { href: '/invoices/new', label: t('invoices.createFirst') }}
    />
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('invoices.title')}</h1>
        <div className="flex items-center gap-2">
          <Link href="/invoices/import" title={t('bankImport.button')} className={headerButtonClass}>
            <Landmark size={14} />
            <span className="sr-only sm:not-sr-only">{t('bankImport.button')}</span>
          </Link>
          <ExportButton onClick={() => handleExport(selectedCount ? selection.selectedVisible : filtered, false)} />
          <Link href="/invoices/new" className={primaryLinkClass}>
            <Plus size={14} /> {t('invoices.new')}
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <input type="search" aria-label={t('invoices.searchLabel')} value={q} onChange={e => setFilters({ q: e.target.value })} placeholder={t('lists.searchPlaceholder')} className={searchClass} />
        <select aria-label={t('common.status')} value={status} onChange={e => setFilters({ status: e.target.value })} className={inputClass}>
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <select aria-label={t('common.client')} value={client} onChange={e => setFilters({ client: e.target.value })} className={`${inputClass} max-w-48`}>
          <option value="">{t('lists.allClients')}</option>
          {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <input type="date" value={from} max={to || undefined} onChange={e => setFilters({ from: e.target.value })} aria-label={t('lists.fromDate')} className={inputClass} />
          <span>–</span>
          <input type="date" value={to} min={from || undefined} onChange={e => setFilters({ to: e.target.value })} aria-label={t('lists.toDate')} className={inputClass} />
        </div>
        {list.hasFilters && (
          <button
            type="button"
            onClick={() => { selection.clear(); list.clearFilters() }}
            className="flex items-center gap-1 text-xs px-2 py-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={12} /> {t('lists.clearFilters')}
          </button>
        )}
      </div>

      <div className={listCardClass}>
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {filtered.length === 0 && empty}
          {pageItems.map(doc => {
            const balance = docBalance(doc)
            const selected = selection.isSelected(doc.id)
            return (
              <div key={doc.id} className={`flex items-center gap-3 px-4 py-3.5 transition-colors ${rowStateClass(selected)} ${doc.status === 'overdue' ? 'border-l-2 border-l-red-400 dark:border-l-red-600' : ''}`}>
                <SelectToggle large checked={selected} onToggle={() => selection.toggleOne(doc.id)} label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} />
                <Link href={`/invoices/${doc.id}`} className="flex items-center justify-between flex-1 min-w-0 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {doc.number ?? <span className="text-neutral-500 dark:text-neutral-400">{t('common.draft')}</span>}
                      {markers(doc)}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{clientLabel(doc) || '—'}</p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{doc.date ?? '—'}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    {isOpen(doc) && balance !== docTotal(doc) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('invoices.openAmount', { amount: formatMoney(balance, doc.currency ?? undefined) })}</p>
                    )}
                    {statusBadge(doc)}
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
          <thead className={theadClass}>
            <tr>
              <th className="pl-4 py-3 w-8">
                <SelectToggle checked={selection.allPageSelected} onToggle={selection.toggleAll} label={t('lists.selectAll')} />
              </th>
              <SortableTh col="number" label={t('common.number')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="client" label={t('common.client')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="date" label={t('common.date')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="due_date" label={t('invoices.due')} sort={sort} onSort={list.toggleSort} />
              <SortableTh col="total" label={t('common.total')} sort={sort} onSort={list.toggleSort} align="right" />
              <SortableTh col="balance" label={t('invoices.balance')} sort={sort} onSort={list.toggleSort} align="right" />
              <SortableTh col="status" label={t('common.status')} sort={sort} onSort={list.toggleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {filtered.length === 0 && <tr><td colSpan={8}>{empty}</td></tr>}
            {pageItems.map(doc => (
              <ClickableRow key={doc.id} href={`/invoices/${doc.id}`} className={`${rowStateClass(selection.isSelected(doc.id))} ${doc.status === 'overdue' ? 'border-l-2 border-l-red-400 dark:border-l-red-600' : ''}`}>
                <td className="pl-4 py-3 w-8">
                  <SelectToggle checked={selection.isSelected(doc.id)} onToggle={() => selection.toggleOne(doc.id)} label={t('lists.selectRow', { number: doc.number ?? t('common.draft') })} />
                </td>
                <td className="px-4 py-3">
                  <Link href={`/invoices/${doc.id}`} className="font-medium hover:underline">
                    {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}
                  </Link>
                  {markers(doc)}
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{clientLabel(doc) || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.date ?? '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{doc.due_date ?? '—'}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</td>
                <td className={`px-4 py-3 text-right ${isOpen(doc) && docBalance(doc) > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-neutral-400 dark:text-neutral-500'}`}>
                  {doc.status === 'draft' || doc.status === 'cancelled' ? '—' : formatMoney(docBalance(doc), doc.currency ?? undefined)}
                </td>
                <td className="px-4 py-3">
                  {statusBadge(doc)}
                </td>
              </ClickableRow>
            ))}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-xs">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400">
                  {invoiceCount(filtered.length)}{list.hasFilters ? ` ${t('lists.filtered')}` : ''}
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
        <Pagination page={page} pageCount={pageCount} onPage={list.setPage} />
      </div>

      <BulkBar count={selectedCount} onClear={selection.clear}>
        <BulkButton tone="blue" icon={Send} onClick={() => askBulk('sent')} busy={bulkLoading && bulkConfirm === 'sent'} disabled={bulkLoading}>{t('lists.markSent')}</BulkButton>
        <BulkButton tone="green" icon={CheckCircle} onClick={() => askBulk('paid')} busy={bulkLoading && bulkConfirm === 'paid'} disabled={bulkLoading}>{t('lists.markPaid')}</BulkButton>
        <BulkButton icon={Download} onClick={() => handleExport(selection.selectedVisible, true)} disabled={bulkLoading}>{t('lists.exportCsv')}</BulkButton>
        <BulkButton tone="red" icon={Trash2} onClick={() => askBulk('delete')} busy={bulkLoading && bulkConfirm === 'delete'} disabled={bulkLoading}>{t('common.delete')}</BulkButton>
      </BulkBar>

      <ConfirmDialog
        open={!!bulkConfirm}
        title={bulkConfirm ? n(selectedCount, t('invoices.confirmTitleOne', { action: actionLabel[bulkConfirm], count: selectedCount }), t('invoices.confirmTitleOther', { action: actionLabel[bulkConfirm], count: selectedCount })) : ''}
        description={bulkConfirm === 'delete' ? t('invoices.confirmDeleteDesc') : bulkConfirm === 'paid' ? t('invoices.confirmPaidDesc') : bulkConfirm === 'sent' ? t('invoices.confirmSentDesc') : undefined}
        confirmLabel={bulkLoading ? t('common.working') : t('common.confirm')}
        destructive={bulkConfirm === 'delete'}
        busy={bulkLoading}
        onConfirm={() => void runBulk()}
        onCancel={() => setBulkConfirm(null)}
      >
        {bulkConfirm === 'paid' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor={`${uid}-paid-date`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('payments.paymentDate')}</label>
              <input
                id={`${uid}-paid-date`}
                type="date"
                value={paidDate}
                max={todayStr}
                required
                aria-invalid={paidDateInvalid || undefined}
                aria-describedby={paidDateInvalid ? `${uid}-paid-date-error` : undefined}
                onChange={e => { setPaidDate(e.target.value); setPaidDateInvalid(false) }}
                className={`w-full ${inputClass} ${paidDateInvalid ? 'border-red-500 dark:border-red-500' : ''}`}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-paid-method`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('payments.paymentMethod')}</label>
              <select id={`${uid}-paid-method`} value={paidMethod} onChange={e => setPaidMethod(e.target.value as PaymentMethod)} className={`w-full ${inputClass}`}>
                <option value="bank">{t('payments.methodBank')}</option>
                <option value="cash">{t('payments.methodCash')}</option>
              </select>
            </div>
            {paidDateInvalid && <p id={`${uid}-paid-date-error`} role="alert" className="col-span-2 text-xs text-red-600 dark:text-red-400">{t('exports.lists.paidDateInvalid')}</p>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
