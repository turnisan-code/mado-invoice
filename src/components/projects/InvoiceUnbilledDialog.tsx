'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { buildInvoiceLines, entryAmount, entryRate, expensePrice, formatDuration, INVOICE_GROUPINGS, linesNet } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import { n } from '@/lib/i18n'
import type { InvoiceGrouping, Project, ProjectExpense, TimeEntry, VatRate } from '@/types'
import { checkboxClass, labelClass } from './ui'

// Picks unbilled billable entries and expenses and turns them into one draft invoice for the
// project's client; the builder opens on it. Mount only while open.
export default function InvoiceUnbilledDialog({ project, clientName, entries, expenses, vatRate, onClose }: {
  project: Project
  clientName: string
  // Unbilled billable rows only.
  entries: TimeEntry[]
  expenses: ProjectExpense[]
  vatRate: VatRate
  onClose: () => void
}) {
  const router = useRouter()
  const { t, lang } = useT()
  const id = useId()
  const [timeIds, setTimeIds] = useState(() => new Set(entries.map(e => e.id)))
  const [expenseIds, setExpenseIds] = useState(() => new Set(expenses.map(x => x.id)))
  const [grouping, setGrouping] = useState<InvoiceGrouping>('entry')
  const [creating, setCreating] = useState(false)

  const chosenEntries = entries.filter(e => timeIds.has(e.id))
  const chosenExpenses = expenses.filter(x => expenseIds.has(x.id))
  const lines = buildInvoiceLines(project, chosenEntries, chosenExpenses, grouping, vatRate)
  const itemCount = lines.filter(l => l.line_type === 'item').length
  const selected = chosenEntries.length + chosenExpenses.length
  const missingRate = chosenEntries.some(e => entryRate(e, project) <= 0)

  const toggle = (set: Set<string>, rowId: string) => {
    const next = new Set(set)
    if (next.has(rowId)) next.delete(rowId)
    else next.add(rowId)
    return next
  }
  const allSelected = selected === entries.length + expenses.length

  async function create() {
    if (!selected) { toast.error(t('projects.invoice.nothingSelected')); return }
    setCreating(true)
    const res = await fetch(`/api/projects/${project.id}/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only rows still listed: after a refresh billed ones are gone from the props.
      body: JSON.stringify({ timeEntryIds: chosenEntries.map(e => e.id), expenseIds: chosenExpenses.map(x => x.id), grouping }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.documentId) {
      setCreating(false)
      toast.error(data.code === 'entries_changed' ? t('projects.invoice.changed') : t('projects.invoice.failed'))
      if (data.code === 'entries_changed') router.refresh()
      return
    }
    toast.success(t('projects.invoice.created'))
    router.push(`/invoices/${data.documentId}`)
  }

  const rowClass = 'flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/60'
  const groupClass = 'px-3 pt-2.5 pb-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-800/60'

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('projects.invoice.title')}
      description={t('projects.invoice.desc', { client: clientName })}
      busy={creating}
      panelClassName="max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto"
    >
      <form onSubmit={e => { e.preventDefault(); void create() }} className="space-y-4">
        <fieldset className="space-y-1.5">
          <legend className={labelClass}>{t('projects.invoice.grouping')}</legend>
          {INVOICE_GROUPINGS.map(g => (
            <label key={g} className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none min-h-9 sm:min-h-0">
              <input type="radio" name={`${id}-grouping`} value={g} checked={grouping === g} onChange={() => setGrouping(g)} disabled={creating} className="w-4 h-4 accent-neutral-900 dark:accent-white" />
              {t(`projects.invoice.groupings.${g}`)}
            </label>
          ))}
        </fieldset>

        <div className="flex justify-end -mb-2">
          <button
            type="button"
            onClick={() => {
              setTimeIds(new Set(allSelected ? [] : entries.map(e => e.id)))
              setExpenseIds(new Set(allSelected ? [] : expenses.map(x => x.id)))
            }}
            disabled={creating}
            className="text-xs text-neutral-500 dark:text-neutral-400 underline underline-offset-2 min-h-9 sm:min-h-0"
          >
            {allSelected ? t('projects.invoice.selectNone') : t('projects.invoice.selectAll')}
          </button>
        </div>

        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-100 dark:divide-neutral-800 max-h-72 overflow-y-auto">
          {entries.length > 0 && <p className={groupClass}>{t('projects.invoice.time')}</p>}
          {entries.map(e => (
            <label key={e.id} className={rowClass}>
              <input type="checkbox" checked={timeIds.has(e.id)} onChange={() => setTimeIds(s => toggle(s, e.id))} disabled={creating} className={`${checkboxClass} mt-0.5 shrink-0`} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{e.description || <span className="text-neutral-500 dark:text-neutral-500">{t('projects.entries.noDescription')}</span>}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">{formatDate(e.date, lang)} · {formatDuration(e.minutes)} h × {formatMoney(entryRate(e, project))}</span>
              </span>
              <span className="text-sm tabular-nums shrink-0">{formatMoney(entryAmount(e, project))}</span>
            </label>
          ))}
          {expenses.length > 0 && <p className={groupClass}>{t('projects.invoice.expenses')}</p>}
          {expenses.map(x => (
            <label key={x.id} className={rowClass}>
              <input type="checkbox" checked={expenseIds.has(x.id)} onChange={() => setExpenseIds(s => toggle(s, x.id))} disabled={creating} className={`${checkboxClass} mt-0.5 shrink-0`} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{x.description}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{formatDate(x.date, lang)} · {x.vat_rate} %</span>
              </span>
              <span className="text-sm tabular-nums shrink-0">{formatMoney(expensePrice(x))}</span>
            </label>
          ))}
        </div>

        <p className="text-sm text-neutral-600 dark:text-neutral-300 tabular-nums">
          {t('projects.invoice.summary', {
            count: selected,
            lines: n(itemCount, t('projects.invoice.lineOne', { count: itemCount }), t('projects.invoice.lineOther', { count: itemCount })),
            amount: formatMoney(linesNet(lines)),
          })}
        </p>
        {missingRate && (
          <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle size={14} className="shrink-0 mt-px" /> {t('projects.invoice.noRate')}
          </p>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('records.projects.removeHint')}</p>

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={creating}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={creating || !selected}>{creating ? t('projects.invoice.creating') : t('projects.invoice.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
