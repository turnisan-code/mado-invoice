'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FileText, Pencil, Plus, Receipt, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { formatDate, formatMoney, roundCents } from '@/lib/utils/document'
import { clientDisplayName } from '@/lib/utils/clients'
import { budgetUse, entryAmount, entryRate, expensePrice, formatDuration, isUnbilled, projectTotals } from '@/lib/projects'
import { statusLabelKey } from '@/lib/status'
import { useT } from '@/lib/i18n/client'
import { n } from '@/lib/i18n'
import type { Project, ProjectExpense, TimeEntry, VatRate } from '@/types'
import ProjectDialog, { type ClientOption } from './ProjectDialog'
import TimeEntryDialog from './TimeEntryDialog'
import ExpenseDialog from './ExpenseDialog'
import InvoiceUnbilledDialog from './InvoiceUnbilledDialog'
import ProjectTimer, { clearProjectTimer } from './ProjectTimer'
import { budgetBarColor, cardClass, iconButtonClass, inputClass, outlineButtonClass, primaryButtonClass, projectStatusColor } from './ui'

export type LinkedInvoice = { id: string; number: string | null; status: string; date: string }

type Billing = 'all' | 'unbilled' | 'billed' | 'nonBillable'
type Filters = { billing: Billing; from: string; to: string; q: string }
type Row = { billable: boolean; invoiced_document_id: string | null; date: string }
type Target = { kind: 'time' | 'expense'; id: string }

const NO_FILTERS: Filters = { billing: 'all', from: '', to: '', q: '' }

function billingOf(row: Row): Exclude<Billing, 'all'> {
  if (row.invoiced_document_id) return 'billed'
  return row.billable ? 'unbilled' : 'nonBillable'
}

function matches(row: Row & { description: string }, f: Filters): boolean {
  if (f.billing !== 'all' && billingOf(row) !== f.billing) return false
  if (f.from && row.date < f.from) return false
  if (f.to && row.date > f.to) return false
  return !f.q.trim() || row.description.toLowerCase().includes(f.q.trim().toLowerCase())
}

export default function ProjectDetail({ project, client, entries, expenses, invoices, clients, defaultVatRate }: {
  project: Project
  client: ClientOption
  entries: TimeEntry[]
  expenses: ProjectExpense[]
  invoices: LinkedInvoice[]
  clients: ClientOption[]
  defaultVatRate: VatRate
}) {
  const router = useRouter()
  const supabase = createClient()
  const { t, lang } = useT()
  const [tab, setTab] = useState<'time' | 'expenses'>('time')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [editing, setEditing] = useState(false)
  const [deletingProject, setDeletingProject] = useState(false)
  const [timeDialog, setTimeDialog] = useState<{ entry?: TimeEntry } | null>(null)
  const [expenseDialog, setExpenseDialog] = useState<{ expense?: ProjectExpense } | null>(null)
  const [invoicing, setInvoicing] = useState(false)
  const [releasing, setReleasing] = useState<(Target & { number: string }) | null>(null)
  const [deleting, setDeleting] = useState<Target | null>(null)
  const [busy, setBusy] = useState(false)

  const clientName = clientDisplayName(client)
  const totals = projectTotals(project, entries, expenses)
  const use = budgetUse(project, totals)
  const invoiceById = new Map(invoices.map(i => [i.id, i]))
  const hasBilled = entries.some(e => e.invoiced_document_id) || expenses.some(x => x.invoiced_document_id)
  const unbilledEntries = entries.filter(isUnbilled)
  const unbilledExpenses = expenses.filter(isUnbilled)
  const filtersActive = filters.billing !== 'all' || !!filters.from || !!filters.to || !!filters.q.trim()

  const shownEntries = entries.filter(e => matches(e, filters))
  const shownExpenses = expenses.filter(x => matches(x, filters))
  const shownMinutes = shownEntries.reduce((s, e) => s + e.minutes, 0)
  const shownTimeAmount = roundCents(shownEntries.reduce((s, e) => s + (billingOf(e) === 'nonBillable' ? 0 : entryAmount(e, project)), 0))
  const shownExpenseAmount = roundCents(shownExpenses.reduce((s, x) => s + (billingOf(x) === 'nonBillable' ? 0 : expensePrice(x)), 0))

  const invoiceLabel = (id: string | null) => {
    const inv = id ? invoiceById.get(id) : undefined
    return inv?.number ?? t('common.draft')
  }
  // What an issued invoice billed stays billed; a draft or cancelled one can give entries back.
  const releasable = (id: string | null) => {
    const inv = id ? invoiceById.get(id) : undefined
    return !!inv && (!inv.number || inv.status === 'cancelled')
  }

  async function confirmRelease() {
    if (!releasing) return
    setBusy(true)
    const { data, error } = await supabase.rpc('release_project_entries', {
      p_time_entry_ids: releasing.kind === 'time' ? [releasing.id] : [],
      p_expense_ids: releasing.kind === 'expense' ? [releasing.id] : [],
    })
    setBusy(false)
    if (error || !data) { toast.error(t('projects.entries.releaseFailed')); return }
    toast.success(t('projects.entries.released'))
    setReleasing(null)
    router.refresh()
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    const { data, error } = await supabase
      .from(deleting.kind === 'time' ? 'time_entries' : 'project_expenses')
      .delete()
      .eq('id', deleting.id)
      .is('invoiced_document_id', null)
      .select('id')
    setBusy(false)
    if (error || !data?.length) { toast.error(t('projects.entries.deleteFailed')); return }
    toast.success(t('projects.entries.deleted'))
    setDeleting(null)
    router.refresh()
  }

  async function deleteProject() {
    setBusy(true)
    const { error } = await supabase.from('projects').delete().eq('id', project.id)
    if (error) { setBusy(false); toast.error(t('projects.form.deleteFailed')); return }
    clearProjectTimer(project.id)
    toast.success(t('projects.form.deleted'))
    router.push('/projects')
  }

  function billingBadge(row: Row) {
    const state = billingOf(row)
    if (state === 'billed') {
      return (
        <Link href={`/invoices/${row.invoiced_document_id}`} className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300 hover:underline underline-offset-2">
          {invoiceById.get(row.invoiced_document_id!)?.number ? t('projects.entries.billedOn', { number: invoiceLabel(row.invoiced_document_id) }) : t('projects.entries.billedDraft')}
        </Link>
      )
    }
    return state === 'unbilled'
      ? <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300">{t('projects.entries.unbilled')}</span>
      : <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400">{t('projects.entries.nonBillable')}</span>
  }

  function rowActions(row: Row, target: Target, edit: () => void) {
    if (row.invoiced_document_id) {
      if (!releasable(row.invoiced_document_id)) return null
      return (
        <button type="button" onClick={() => setReleasing({ ...target, number: invoiceLabel(row.invoiced_document_id) })} title={t('projects.entries.release')} aria-label={t('projects.entries.release')} className={iconButtonClass}>
          <Undo2 size={15} />
        </button>
      )
    }
    return (
      <div className="flex items-center gap-0.5">
        <button type="button" onClick={edit} title={t('common.edit')} aria-label={t('common.edit')} className={iconButtonClass}><Pencil size={15} /></button>
        <button type="button" onClick={() => setDeleting(target)} title={t('common.delete')} aria-label={t('common.delete')} className={`${iconButtonClass} hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30`}><Trash2 size={15} /></button>
      </div>
    )
  }

  const description = (text: string) => text || <span className="text-neutral-400 dark:text-neutral-500">{t('projects.entries.noDescription')}</span>
  const th = 'px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 text-left'
  const thRight = 'px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 text-right'
  const entryCount = (count: number) => n(count, t('projects.entries.entryOne', { count }), t('projects.entries.entryOther', { count }))
  const expenseCount = (count: number) => n(count, t('projects.entries.expenseOne', { count }), t('projects.entries.expenseOther', { count }))
  const locale = lang === 'de' ? 'de-AT' : 'en-GB'
  const percent = (share: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share)
  const num = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)

  function budgetBar(share: number, label: string) {
    return (
      <div className="space-y-1">
        <div className="flex justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums"><span>{label}</span><span>{percent(share)}</span></div>
        <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={label}>
          <div className={`h-full rounded-full ${budgetBarColor(share)}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
        </div>
      </div>
    )
  }

  const emptyRows = (empty: string) => (
    <p className="px-4 py-10 text-center text-sm text-neutral-400 dark:text-neutral-500">{filtersActive ? t('projects.entries.noMatch') : empty}</p>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/projects" aria-label={t('projects.backToProjects')} className="h-11 w-11 -mx-3.5 -mb-3.5 -mt-2.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold leading-tight break-words">{project.name}</h1>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${projectStatusColor[project.status]}`}>{t(`projects.statuses.${project.status}`)}</span>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
            <Link href={`/clients/${client.id}`} className="hover:underline underline-offset-2">{clientName}</Link>
            {' · '}
            {project.hourly_rate != null ? t('projects.detail.rate', { rate: formatMoney(project.hourly_rate) }) : t('projects.detail.noRate')}
          </p>
        </div>
        <div className="flex items-center gap-0.5 -mr-2 -mt-2 sm:mt-0 sm:mr-0 shrink-0">
          <button type="button" onClick={() => setEditing(true)} title={t('common.edit')} aria-label={t('common.edit')} className={iconButtonClass}><Pencil size={15} /></button>
          <button
            type="button"
            onClick={() => (hasBilled ? toast.info(t('projects.form.deleteBilled')) : setDeletingProject(true))}
            title={t('common.delete')}
            aria-label={t('common.delete')}
            className={`${iconButtonClass} hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
        <button type="button" onClick={() => setTimeDialog({})} className={primaryButtonClass}><Plus size={14} /> {t('projects.logTime')}</button>
        <ProjectTimer projectId={project.id} onStopped={entry => setTimeDialog({ entry })} />
        <button type="button" onClick={() => setExpenseDialog({})} className={outlineButtonClass}><Receipt size={14} /> {t('projects.addExpense')}</button>
        <button type="button" onClick={() => setInvoicing(true)} disabled={!unbilledEntries.length && !unbilledExpenses.length} title={!unbilledEntries.length && !unbilledExpenses.length ? t('projects.invoice.nothing') : undefined} className={outlineButtonClass}>
          <FileText size={14} /> {t('projects.invoice.button')}
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className={`${cardClass} p-4`}>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('projects.detail.tracked')}</p>
          <p className="text-lg font-semibold tabular-nums">{t('projects.hours', { hours: formatDuration(totals.minutes) })}</p>
        </div>
        <div className={`${cardClass} p-4`}>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('projects.detail.unbilled')}</p>
          <p className={`text-lg font-semibold tabular-nums ${totals.unbilledAmount > 0 ? 'text-amber-600' : ''}`}>{formatMoney(totals.unbilledAmount)}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">{t('projects.hours', { hours: formatDuration(totals.unbilledMinutes) })}</p>
        </div>
        <div className={`${cardClass} p-4`}>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('projects.detail.billed')}</p>
          <p className="text-lg font-semibold tabular-nums">{formatMoney(totals.billedAmount)}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">{t('projects.hours', { hours: formatDuration(totals.billedMinutes) })}</p>
        </div>
        <div className={`${cardClass} p-4 space-y-2`}>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('projects.detail.budget')}</p>
          {use.hours === null && use.amount === null && <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('projects.detail.noBudget')}</p>}
          {use.hours !== null && budgetBar(use.hours, t('projects.detail.budgetHours', { used: formatDuration(totals.minutes), budget: num(project.budget_hours ?? 0) }))}
          {use.amount !== null && budgetBar(use.amount, t('projects.detail.budgetAmount', { used: formatMoney(totals.value), budget: formatMoney(project.budget_amount ?? 0) }))}
        </div>
      </div>

      {project.notes && <p className="text-sm text-neutral-600 dark:text-neutral-300 whitespace-pre-line">{project.notes}</p>}

      {/* Entries */}
      <div className={`${cardClass} overflow-hidden`}>
        <div className="flex border-b border-neutral-100 dark:border-neutral-800" role="tablist">
          {(['time', 'expenses'] as const).map(key => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex-1 sm:flex-none px-5 h-11 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-neutral-900 dark:border-white text-neutral-900 dark:text-white' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}
            >
              {key === 'time' ? t('projects.detail.time') : t('projects.detail.expenses')}
              <span className="ml-1.5 text-xs text-neutral-400 dark:text-neutral-500 tabular-nums">{key === 'time' ? entries.length : expenses.length}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 p-3 border-b border-neutral-100 dark:border-neutral-800">
          <select value={filters.billing} onChange={e => setFilters(f => ({ ...f, billing: e.target.value as Billing }))} aria-label={t('projects.filters.label')} className={`${inputClass} sm:w-auto`}>
            {(['all', 'unbilled', 'billed', 'nonBillable'] as const).map(b => <option key={b} value={b}>{t(`projects.filters.${b}`)}</option>)}
          </select>
          <input type="search" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} placeholder={t('projects.filters.search')} aria-label={t('projects.filters.search')} className={`${inputClass} sm:w-56`} />
          <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="shrink-0">{t('projects.filters.from')}</span>
            <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className={`${inputClass} sm:w-auto min-w-0`} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="shrink-0">{t('projects.filters.to')}</span>
            <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className={`${inputClass} sm:w-auto min-w-0`} />
          </label>
          {filtersActive && (
            <button type="button" onClick={() => setFilters(NO_FILTERS)} className="col-span-2 text-xs text-neutral-500 dark:text-neutral-400 underline underline-offset-2 min-h-9 sm:min-h-0 sm:self-center">
              {t('projects.filters.reset')}
            </button>
          )}
        </div>

        {tab === 'time' ? (
          <>
            {/* Mobile cards */}
            <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {shownEntries.length === 0 && emptyRows(t('projects.entries.emptyTime'))}
              {shownEntries.map(e => (
                <div key={e.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm min-w-0 break-words">{description(e.description)}</p>
                    <span className="text-sm font-medium tabular-nums shrink-0">{billingOf(e) === 'nonBillable' ? '—' : formatMoney(entryAmount(e, project))}</span>
                  </div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                    {formatDate(e.date, lang)} · {t('projects.hours', { hours: formatDuration(e.minutes) })}
                    {billingOf(e) !== 'nonBillable' && <> · {formatMoney(entryRate(e, project))}/h</>}
                  </p>
                  <div className="flex items-center justify-between gap-2 -mb-1">
                    {billingBadge(e)}
                    <div className="-mr-2.5">{rowActions(e, { kind: 'time', id: e.id }, () => setTimeDialog({ entry: e }))}</div>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
              <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
                <tr>
                  <th className={th}>{t('projects.entries.date')}</th>
                  <th className={thRight}>{t('projects.entries.duration')}</th>
                  <th className={th}>{t('projects.entries.description')}</th>
                  <th className={thRight}>{t('projects.entries.rate')}</th>
                  <th className={thRight}>{t('projects.entries.amount')}</th>
                  <th className={th}>{t('projects.entries.billing')}</th>
                  <th className="px-2 py-3"><span className="sr-only">{t('common.actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
                {shownEntries.length === 0 && <tr><td colSpan={7}>{emptyRows(t('projects.entries.emptyTime'))}</td></tr>}
                {shownEntries.map(e => (
                  <tr key={e.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                    <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{formatDate(e.date, lang)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatDuration(e.minutes)}</td>
                    <td className="px-4 py-2.5 max-w-xs break-words">{description(e.description)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{billingOf(e) === 'nonBillable' ? '—' : formatMoney(entryRate(e, project))}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{billingOf(e) === 'nonBillable' ? '—' : formatMoney(entryAmount(e, project))}</td>
                    <td className="px-4 py-2.5">{billingBadge(e)}</td>
                    <td className="px-2 py-1.5 text-right">{rowActions(e, { kind: 'time', id: e.id }, () => setTimeDialog({ entry: e }))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shownEntries.length > 0 && (
              <p className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                {t('projects.entries.totalTime', { count: entryCount(shownEntries.length), duration: formatDuration(shownMinutes), amount: formatMoney(shownTimeAmount) })}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {shownExpenses.length === 0 && emptyRows(t('projects.entries.emptyExpenses'))}
              {shownExpenses.map(x => (
                <div key={x.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm min-w-0 break-words">{x.description}</p>
                    <span className="text-sm font-medium tabular-nums shrink-0">{formatMoney(expensePrice(x))}</span>
                  </div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                    {formatDate(x.date, lang)} · {t('projects.entries.net')} {formatMoney(x.net_amount)} · {x.vat_rate} %
                    {!!x.markup_percent && <> · +{num(x.markup_percent)} %</>}
                  </p>
                  <div className="flex items-center justify-between gap-2 -mb-1">
                    {billingBadge(x)}
                    <div className="-mr-2.5">{rowActions(x, { kind: 'expense', id: x.id }, () => setExpenseDialog({ expense: x }))}</div>
                  </div>
                </div>
              ))}
            </div>
            <table className="hidden sm:table w-full text-sm">
              <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
                <tr>
                  <th className={th}>{t('projects.entries.date')}</th>
                  <th className={th}>{t('projects.entries.description')}</th>
                  <th className={thRight}>{t('projects.entries.net')}</th>
                  <th className={thRight}>{t('projects.entries.vat')}</th>
                  <th className={thRight}>{t('projects.entries.markup')}</th>
                  <th className={thRight}>{t('projects.entries.price')}</th>
                  <th className={th}>{t('projects.entries.billing')}</th>
                  <th className="px-2 py-3"><span className="sr-only">{t('common.actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
                {shownExpenses.length === 0 && <tr><td colSpan={8}>{emptyRows(t('projects.entries.emptyExpenses'))}</td></tr>}
                {shownExpenses.map(x => (
                  <tr key={x.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                    <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{formatDate(x.date, lang)}</td>
                    <td className="px-4 py-2.5 max-w-xs break-words">{x.description}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{formatMoney(x.net_amount)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{x.vat_rate} %</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500 dark:text-neutral-400">{x.markup_percent ? `${num(x.markup_percent)} %` : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{formatMoney(expensePrice(x))}</td>
                    <td className="px-4 py-2.5">{billingBadge(x)}</td>
                    <td className="px-2 py-1.5 text-right">{rowActions(x, { kind: 'expense', id: x.id }, () => setExpenseDialog({ expense: x }))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shownExpenses.length > 0 && (
              <p className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                {t('projects.entries.totalExpenses', { count: expenseCount(shownExpenses.length), amount: formatMoney(shownExpenseAmount) })}
              </p>
            )}
            <p className="px-4 pb-3 text-xs text-neutral-400 dark:text-neutral-500">{t('projects.detail.vatNote')}</p>
          </>
        )}
        {hasBilled && <p className="px-4 pb-3 text-xs text-neutral-400 dark:text-neutral-500">{t('projects.entries.locked')}</p>}
      </div>

      {/* Invoices */}
      <div className={`${cardClass} overflow-hidden`}>
        <p className="px-5 py-4 text-sm font-medium border-b border-neutral-100 dark:border-neutral-800">{t('projects.detail.invoices')}</p>
        {invoices.length === 0 && <p className="px-5 py-6 text-sm text-neutral-400 dark:text-neutral-500">{t('projects.detail.noInvoices')}</p>}
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
          {invoices.map(inv => (
            <Link key={inv.id} href={`/invoices/${inv.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
              <span className="text-sm font-medium flex-1 min-w-0">{inv.number ?? <span className="font-normal text-neutral-400 dark:text-neutral-500">{t('common.draft')}</span>}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{formatDate(inv.date, lang)}</span>
              <StatusBadge status={inv.status} label={t(statusLabelKey(inv.status))} />
            </Link>
          ))}
        </div>
      </div>

      {editing && <ProjectDialog project={project} clients={clients} lockClient={hasBilled} onClose={() => setEditing(false)} />}
      {timeDialog && (
        <TimeEntryDialog
          projects={[{ id: project.id, name: project.name, client: clientName, hourly_rate: project.hourly_rate }]}
          projectId={project.id}
          entry={timeDialog.entry}
          onClose={() => setTimeDialog(null)}
        />
      )}
      {expenseDialog && <ExpenseDialog projectId={project.id} expense={expenseDialog.expense} defaultVatRate={defaultVatRate} onClose={() => setExpenseDialog(null)} />}
      {invoicing && (
        <InvoiceUnbilledDialog project={project} clientName={clientName} entries={unbilledEntries} expenses={unbilledExpenses} vatRate={defaultVatRate} onClose={() => setInvoicing(false)} />
      )}

      <ConfirmDialog
        open={!!releasing}
        title={t('projects.entries.releaseTitle')}
        description={releasing ? t('projects.entries.releaseDesc', { number: releasing.number }) : undefined}
        confirmLabel={t('projects.entries.release')}
        busy={busy}
        onConfirm={() => void confirmRelease()}
        onCancel={() => setReleasing(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title={deleting?.kind === 'expense' ? t('projects.entries.deleteExpenseTitle') : t('projects.entries.deleteTimeTitle')}
        description={t('projects.entries.deleteDesc')}
        confirmLabel={busy ? t('common.deleting') : t('common.delete')}
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={deletingProject}
        title={t('projects.form.deleteTitle', { name: project.name })}
        description={t('projects.form.deleteDesc')}
        confirmLabel={busy ? t('common.deleting') : t('common.delete')}
        destructive
        busy={busy}
        onConfirm={() => void deleteProject()}
        onCancel={() => setDeletingProject(false)}
      />
    </div>
  )
}
