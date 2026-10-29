'use client'

import { useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, FileText, Download, CheckCircle, Send, X, Trash2, Repeat, Landmark, FileWarning, BookCheck } from 'lucide-react'
import { toast } from 'sonner'
import { formatMoney, calcTotals, today } from '@/lib/utils/document'
import { toCsv, csvDate, downloadCsv } from '@/lib/utils/csv'
import { clientDisplayName } from '@/lib/utils/clients'
import { ConfirmDialog, Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { fieldClass } from '@/components/ui/control'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey, type TFn } from '@/lib/i18n'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import { StatusBadge } from './StatusBadge'
import { displayStatus, isOverdue, statusLabelKey } from '@/lib/status'
import { bookamatErrorMessage, bookamatState, formatBookings, hasMoneyToBook, requestBookamatSync } from '@/lib/bookamat-client'
import { invoiceKindBadge } from '@/lib/document-labels'
import { isIssuedNoteList, latestIssued, type IssuedNote } from '@/lib/utils/bulk-issue'
import { BulkIssueNotice, BulkIssueResult } from './BulkIssue'
import type { BookamatState, InvoiceKind } from '@/types'
import { useListState, useSelection, paginate, compareBy, type ListConfig } from './useListState'
import {
  SortableTh, SelectToggle, ClickableRow, EmptyState, Pagination, BulkBar, BulkButton, ExportButton,
  inputClass, searchClass, headerButtonClass, primaryLinkClass, listCardClass, theadClass, rowStateClass, listDate,
} from './ListParts'

const STATUSES = ['outstanding', 'draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const BOOKAMAT_FILTERS = ['unsynced', 'failed', 'synced'] as const

type SortKey = 'number' | 'client' | 'date' | 'due_date' | 'total' | 'balance' | 'status'
const LIST: ListConfig<'status' | 'q' | 'from' | 'to' | 'client' | 'bookamat', SortKey> = {
  filters: { status: STATUSES, q: null, from: null, to: null, client: null, bookamat: BOOKAMAT_FILTERS },
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
  bookamat_error?: string | null
  bookamat_booking_id?: string | null
  bookamat_bookings?: { year: number; booking_id: string }[] | null
  invoice_kind?: InvoiceKind | null
  document_items: DocItem[]
  payments?: { amount: number; kind?: string }[]
}

type BulkSyncRow = { id: string; number: string; ok: boolean; text: string }
type BulkSync = { invoices: Invoice[]; skipped: number; done: number; running: boolean; results: BulkSyncRow[] }

const BOOKAMAT_BADGE: Record<Exclude<BookamatState, 'none'>, string> = {
  synced: 'text-green-700 bg-green-50 dark:bg-green-950/60 dark:text-green-300',
  unsynced: 'text-neutral-600 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-300',
  failed: 'text-red-700 bg-red-50 dark:bg-red-950/60 dark:text-red-300',
}

function docTotals(d: Invoice) {
  return calcTotals(d.document_items, d.payments ?? [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, d.tax_treatment)
}
const docTotal = (d: Invoice) => docTotals(d).total
// Nothing is owed on a draft (not issued yet) or a cancelled invoice (settled by its Storno).
const docBalance = (d: Invoice) => d.status === 'draft' || d.status === 'cancelled' ? 0 : docTotals(d).balance_due
// Outstanding: issued and still owing something; a zero total or a settled balance never is.
const isOpen = (d: Invoice) => (d.status === 'sent' || d.status === 'overdue') && docTotal(d) > 0.005 && docBalance(d) > 0.005
const clientLabel = (d: Invoice) => clientDisplayName(d.clients)
// Partly paid and written-off invoices show that instead of their stored status. Dunning fees
// and interest are paid on top and never change it.
const shownStatus = (d: Invoice, todayStr: string) =>
  displayStatus({ type: 'invoice', status: d.status, total: docTotal(d), payments: (d.payments ?? []).filter(p => p.kind !== 'fee') }, todayStr)

function exportCSV(invoices: Invoice[], t: TFn, todayStr: string) {
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
      t(statusLabelKey(shownStatus(inv, todayStr))),
    ]
  })
  const header = [t('csv.number'), t('csv.client'), t('csv.company'), t('csv.date'), t('csv.dueDate'), t('csv.net'), t('csv.vat'), t('csv.total'), t('csv.paid'), t('csv.balance'), t('csv.currency'), t('csv.status')]
  downloadCsv(`invoices-${todayStr}.csv`, toCsv(header, rows))
}

export default function InvoiceList({ invoices, recurringSourceIds = [], bookamatConfigured = false }: { invoices: Invoice[]; recurringSourceIds?: string[]; bookamatConfigured?: boolean }) {
  const router = useRouter()
  const { t, lang } = useT()
  const uid = useId()
  const list = useListState(LIST)
  const { status, q, from, to, client, bookamat } = list.filters
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null)
  const [paidDate, setPaidDate] = useState('')
  const [paidMethod, setPaidMethod] = useState<PaymentMethod>('bank')
  const [paidDateInvalid, setPaidDateInvalid] = useState(false)
  const [bulkSync, setBulkSync] = useState<BulkSync | null>(null)
  // Drafts dated before today are issued with today's date unless the confirm says otherwise.
  const [redate, setRedate] = useState(true)
  const [issueNotes, setIssueNotes] = useState<IssuedNote[] | null>(null)

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
      {doc.invoice_kind && doc.invoice_kind !== 'standard' && (
        <span className="ml-1.5 inline-flex align-middle text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
          {invoiceKindBadge(t, doc.invoice_kind)}
        </span>
      )}
      {doc.number && !doc.pdf_path && <span className="ml-1.5">{noArchiveMarker}</span>}
      {recurring.has(doc.id) && <span className="ml-1.5">{recurringBadge}</span>}
    </>
  )

  const todayStr = today()
  const latest = useMemo(() => latestIssued(invoices), [invoices])

  const clientOptions = useMemo(() => {
    const names = new Map<string, string>()
    for (const d of invoices) {
      if (d.client_id && d.clients && !names.has(d.client_id)) names.set(d.client_id, clientDisplayName(d.clients))
    }
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [invoices])

  const { sort } = list
  const filtered = useMemo(() => {
    let rows = invoices
    if (status === 'outstanding') rows = rows.filter(isOpen)
    else if (status === 'overdue') rows = rows.filter(d => isOpen(d) && isOverdue(d, todayStr))
    else if (status) rows = rows.filter(d => d.status === status)
    if (client) rows = rows.filter(d => d.client_id === client)
    if (bookamat && bookamatConfigured) rows = rows.filter(d => bookamatState(d) === bookamat)
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
  }, [invoices, q, status, client, bookamat, bookamatConfigured, from, to, sort, todayStr])

  const { page, pageCount, pageItems } = paginate(filtered, list.page)
  const selection = useSelection(filtered, pageItems)

  const statusBadge = (d: Invoice) => {
    const shown = shownStatus(d, todayStr)
    return <StatusBadge status={shown} label={t(statusLabelKey(shown))} />
  }

  const bookamatBadge = (d: Invoice) => {
    if (!bookamatConfigured) return null
    const state = bookamatState(d)
    if (state === 'none') return null
    const bookings = d.bookamat_bookings ?? []
    const title = state === 'synced' && bookings.length ? formatBookings(t, bookings) : state === 'failed' ? d.bookamat_error ?? undefined : undefined
    return (
      <span title={title} className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${BOOKAMAT_BADGE[state]}`}>
        <BookCheck size={11} aria-hidden="true" />{t(`books.state.${state}`)}
      </span>
    )
  }

  function openBulkSync() {
    const chosen = selection.selectedVisible
    const eligible = chosen.filter(d => { const s = bookamatState(d); return s === 'unsynced' || (s === 'failed' && hasMoneyToBook(d)) })
    setBulkSync({ invoices: eligible, skipped: chosen.length - eligible.length, done: 0, running: false, results: [] })
  }

  // One invoice after the other: each sync claims its invoice and attaches the PDF, and Bookamat
  // throttles parallel calls.
  async function runBulkSync() {
    if (!bulkSync) return
    const results: BulkSyncRow[] = []
    setBulkSync(b => b && { ...b, running: true })
    for (const inv of bulkSync.invoices) {
      const res = await requestBookamatSync(inv.id)
      const number = inv.number ?? t('common.draft')
      results.push(res.ok
        ? {
            id: inv.id, number, ok: true,
            text: res.data.pdf.error
              ? t('books.sync.pdfNotAttached', { bookings: formatBookings(t, res.data.created), error: res.data.pdf.error })
              : formatBookings(t, res.data.created.length ? res.data.created : res.data.bookings),
          }
        : { id: inv.id, number, ok: false, text: bookamatErrorMessage(t, res.payload) })
      setBulkSync(b => b && { ...b, done: results.length, results: [...results] })
    }
    setBulkSync(b => b && { ...b, running: false })
  }

  function closeBulkSync() {
    const ran = !!bulkSync?.results.length
    setBulkSync(null)
    if (ran) {
      selection.clear()
      router.refresh()
    }
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
    setRedate(true)
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
    // Shown once the confirm has closed, so focus moves from one dialog to the next.
    let notes: IssuedNote[] = []
    try {
      const res = await fetch('/api/invoices/bulk', {
        method: isDelete ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isDelete ? { ids } : action === 'paid' ? { ids, status: action, paidDate, method: paidMethod, redate } : { ids, status: action, redate }),
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
        toast.error(t(isDelete ? 'lists.deleteFailed' : 'lists.bulkFailed', { error: apiErrorMessage(t, data) }))
        return
      }
      if (isDelete) {
        const { deleted, skipped } = data
        toast.success(n(deleted, t('invoices.deletedOne', { count: deleted }), t('invoices.deletedOther', { count: deleted })))
        if (skipped) toast.info(n(skipped, t('invoices.deleteSkippedOne', { count: skipped }), t('invoices.deleteSkippedOther', { count: skipped })))
      } else {
        const { updated, skipped } = data
        const vars = { count: updated, status: statusLabel(action) }
        const redated = notes.filter(note => note.movedFrom).length
        toast.success(n(updated, t('invoices.markedOne', vars), t('invoices.markedOther', vars)), {
          description: redated ? n(redated, t('views.bulkIssue.redatedOne', { count: redated }), t('views.bulkIssue.redatedOther', { count: redated })) : undefined,
        })
        if (skipped) {
          toast.info(action === 'sent'
            ? n(skipped, t('invoices.skippedSentOne', { count: skipped }), t('invoices.skippedSentOther', { count: skipped }))
            : n(skipped, t('invoices.skippedPaidOne', { count: skipped }), t('invoices.skippedPaidOther', { count: skipped })))
        }
      }
      selection.clear()
      router.refresh()
    } catch (err) {
      toast.error(t(isDelete ? 'lists.deleteFailed' : 'lists.bulkFailed', { error: requestErrorMessage(t, err) }))
    } finally {
      setBulkLoading(false)
      setBulkConfirm(null)
      setIssueNotes(notes)
    }
  }

  function handleExport(rows: Invoice[], bulk: boolean) {
    exportCSV(rows, t, todayStr)
    const count = rows.length
    toast.success(bulk
      ? n(count, t('invoices.bulkExportedOne', { count }), t('invoices.bulkExportedOther', { count }))
      : n(count, t('invoices.exportedOne', { count }), t('invoices.exportedOther', { count })))
  }

  // The drafts a confirmed "Mark sent" or "Mark paid" issues first.
  const bulkDrafts = bulkConfirm === 'sent' || bulkConfirm === 'paid'
    ? selection.selectedVisible.filter(d => d.status === 'draft').map(d => ({ id: d.id, date: d.date, total: docTotal(d) }))
    : []
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
        <Select aria-label={t('common.status')} value={status} onChange={e => setFilters({ status: e.target.value })} className="w-auto">
          <option value="">{t('status.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </Select>
        <Select aria-label={t('common.client')} value={client} onChange={e => setFilters({ client: e.target.value })} className="w-auto max-w-48">
          <option value="">{t('lists.allClients')}</option>
          {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
        {bookamatConfigured && (
          <Select aria-label={t('books.sync.filterLabel')} value={bookamat} onChange={e => setFilters({ bookamat: e.target.value })} className="w-auto">
            <option value="">{t('books.sync.filterAll')}</option>
            {BOOKAMAT_FILTERS.map(f => <option key={f} value={f}>{t(`books.state.${f}`)}</option>)}
          </Select>
        )}
        <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <input type="date" value={from} max={to || undefined} onChange={e => setFilters({ from: e.target.value })} aria-label={t('lists.fromDate')} className={inputClass} />
          <span>–</span>
          <input type="date" value={to} min={from || undefined} onChange={e => setFilters({ to: e.target.value })} aria-label={t('lists.toDate')} className={inputClass} />
        </div>
        {list.hasFilters && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => { selection.clear(); list.clearFilters() }}
            className="text-xs text-neutral-500 dark:text-neutral-400"
          >
            <X size={12} /> {t('lists.clearFilters')}
          </Button>
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
                    <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-0.5">{listDate(doc.date, lang)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <p className="font-semibold text-sm">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</p>
                    {isOpen(doc) && balance !== docTotal(doc) && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('invoices.openAmount', { amount: formatMoney(balance, doc.currency ?? undefined) })}</p>
                    )}
                    {statusBadge(doc)}
                    {bookamatBadge(doc)}
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
                    {doc.number ?? <span className="text-neutral-500 dark:text-neutral-500">{t('common.draft')}</span>}
                  </Link>
                  {markers(doc)}
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{clientLabel(doc) || '—'}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{listDate(doc.date, lang)}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{listDate(doc.due_date, lang)}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(docTotal(doc), doc.currency ?? undefined)}</td>
                <td className={`px-4 py-3 text-right ${isOpen(doc) && docBalance(doc) > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-500'}`}>
                  {doc.status === 'draft' || doc.status === 'cancelled' ? '—' : formatMoney(docBalance(doc), doc.currency ?? undefined)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    {statusBadge(doc)}
                    {bookamatBadge(doc)}
                  </div>
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
                <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-500">{t('invoices.open')}</td>
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
        {bookamatConfigured && <BulkButton icon={BookCheck} onClick={openBulkSync} disabled={bulkLoading}>{t('books.sync.bulk')}</BulkButton>}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                className={fieldClass}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-paid-method`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('payments.paymentMethod')}</label>
              <Select id={`${uid}-paid-method`} value={paidMethod} onChange={e => setPaidMethod(e.target.value as PaymentMethod)}>
                <option value="bank">{t('payments.methodBank')}</option>
                <option value="cash">{t('payments.methodCash')}</option>
              </Select>
            </div>
            {paidDateInvalid && <p id={`${uid}-paid-date-error`} role="alert" className="sm:col-span-2 text-xs text-red-600 dark:text-red-400">{t('exports.lists.paidDateInvalid')}</p>}
          </div>
        )}
        <BulkIssueNotice type="invoice" drafts={bulkDrafts} latest={latest} today={todayStr} redate={redate} onRedate={setRedate} />
      </ConfirmDialog>

      <BulkIssueResult notes={issueNotes} path="invoices" onClose={() => setIssueNotes(null)} />

      <Dialog
        open={!!bulkSync}
        onClose={closeBulkSync}
        busy={bulkSync?.running}
        title={!bulkSync ? '' : bulkSync.results.length && !bulkSync.running ? t('books.sync.bulkResultTitle')
          : n(bulkSync.invoices.length, t('books.sync.bulkTitleOne', { count: bulkSync.invoices.length }), t('books.sync.bulkTitleOther', { count: bulkSync.invoices.length }))}
        description={!bulkSync ? undefined : bulkSync.invoices.length ? t('books.sync.bulkDesc') : t('books.sync.bulkNone')}
        panelClassName="max-w-md"
      >
        {bulkSync && (
          <div className="space-y-3">
            {bulkSync.skipped > 0 && !bulkSync.results.length && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{n(bulkSync.skipped, t('books.sync.bulkSkippedOne', { count: bulkSync.skipped }), t('books.sync.bulkSkippedOther', { count: bulkSync.skipped }))}</p>
            )}
            {bulkSync.running && (
              <p role="status" className="text-sm">{t('books.sync.bulkProgress', { done: bulkSync.done, count: bulkSync.invoices.length })}</p>
            )}
            {bulkSync.results.length > 0 && (
              <>
                {!bulkSync.running && (
                  <p role="status" className="text-sm font-medium">
                    {t('books.sync.bulkResultSummary', { ok: bulkSync.results.filter(r => r.ok).length, failed: bulkSync.results.filter(r => !r.ok).length })}
                  </p>
                )}
                <ul className="max-h-64 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                  {bulkSync.results.map(r => (
                    <li key={r.id} className="py-1.5 flex items-start gap-2">
                      <Link href={`/invoices/${r.id}`} className="font-medium shrink-0 hover:underline">{r.number}</Link>
                      <span className={`min-w-0 break-words ${r.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{r.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="flex gap-2 justify-end">
              {!bulkSync.results.length ? (
                <>
                  <Button type="button" variant="outline" onClick={closeBulkSync} disabled={bulkSync.running}>{t('dialogs.cancel')}</Button>
                  {bulkSync.invoices.length > 0 && (
                    <Button type="button" onClick={() => void runBulkSync()} disabled={bulkSync.running}>{t('books.sync.bulkStart')}</Button>
                  )}
                </>
              ) : (
                <Button type="button" onClick={closeBulkSync} disabled={bulkSync.running}>{t('books.sync.bulkClose')}</Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
