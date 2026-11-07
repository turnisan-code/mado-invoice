'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Repeat, Zap, Pause, Play, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { ConfirmDialog, Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { formatDate, today } from '@/lib/utils/document'
import { planNextPeriod, saveScheduleEdit, type CoveredPeriod } from '@/lib/utils/recurring'
import { ScheduleFormFields, formDefinition, validateSchedule, type ScheduleFormValues } from '@/components/recurring/MakeRecurringDialog'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { ClickableRow } from '@/components/lists/ListParts'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-errors'
import type { RecurringSchedule } from '@/types'

export interface ScheduleRow extends RecurringSchedule {
  source: { id: string; number: string | null; client: string } | null
  last: { id: string; number: string | null } | null
  // The service periods its invoices already cover (listRecurringSchedules).
  covered: CoveredPeriod[]
}

type ScheduleStatus = 'active' | 'paused' | 'ended'

// The generator switches a schedule off once its next date passes the end date ("ended");
// any other inactive schedule was paused by hand.
function scheduleStatus(s: ScheduleRow): ScheduleStatus {
  if (s.active) return 'active'
  return s.end_date && s.next_date > s.end_date ? 'ended' : 'paused'
}

const actionClass = 'h-11 w-11 sm:h-8 sm:w-8 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:pointer-events-none'
const linkClass = 'hover:underline underline-offset-2'
const rowClass = 'hover:bg-neutral-50 dark:hover:bg-neutral-800'

export default function RecurringList({ schedules }: { schedules: ScheduleRow[] }) {
  const router = useRouter()
  const supabase = createClient()
  const { t, lang } = useT()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [form, setForm] = useState<ScheduleFormValues | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<ScheduleRow | null>(null)

  const intervalLabel = (s: ScheduleRow) => t(`recurring.intervals.${s.interval}` as DictKey)
  const modeLabel = (s: ScheduleRow) => t(`recurring.modes.${s.mode}` as DictKey)
  const statusLabel = (status: ScheduleStatus) => t(`recurring.statuses.${status}` as DictKey)
  const docLabel = (d: { number: string | null }) => d.number ?? t('common.draft')
  const scheduleCount = (count: number) => n(count, t('recurring.countOne', { count }), t('recurring.countOther', { count }))

  async function generate(s: ScheduleRow) {
    setBusyId(s.id)
    const res = await fetch(`/api/recurring/${s.id}/generate`, { method: 'POST' }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    setBusyId(null)
    if (!res) { toast.error(`${t('recurring.generateFailed')} ${t('messages.network')}`); return }
    if (!res.ok) {
      if (data.code === 'template_cancelled') {
        // The generator paused the schedule; refresh so the row shows it.
        toast.error(t('recurring.templateCancelled'))
        router.refresh()
        return
      }
      toast.error(data.code === 'inactive' ? t('recurring.generateInactive') : apiErrorMessage(t, data, t('recurring.generateFailed')))
      return
    }
    if (!data.documentId) {
      // `notice`: the periods skipped because invoices of the schedule already cover part of them.
      toast.info(data.notice ?? t('recurring.nothingGenerated'))
      router.refresh()
      return
    }
    if (data.warning) toast.warning(data.warning)
    const count: number = data.generated ?? 1
    toast.success(
      <span>
        {n(count, t('recurring.generated', { date: formatDate(data.date, lang) }), t('recurring.generatedMany', { count }))}{' '}
        <Link href={`/invoices/${data.documentId}`} className="underline">{t('recurring.openInvoice')}</Link>
      </span>,
      { duration: 6000 },
    )
    router.refresh()
  }

  async function setActive(s: ScheduleRow, active: boolean) {
    setBusyId(s.id)
    const { error } = await supabase.from('recurring_schedules').update({ active }).eq('id', s.id)
    setBusyId(null)
    if (error) { toast.error(t('recurring.updateFailed')); return }
    toast.success(active ? t('recurring.resumedToast') : t('recurring.pausedToast'))
    router.refresh()
  }

  function openEdit(s: ScheduleRow) {
    setForm({ name: s.name, interval: s.interval, next_date: s.next_date, anchor_day: null, end_date: s.end_date ?? '', in_advance: s.in_advance, mode: s.mode })
    setEditing(s)
  }

  // Saves the next date the editor shows (past the periods already covered); a moved next date
  // re-anchors the day of month, and an ended schedule whose end moved out again resumes.
  async function saveEdit() {
    if (!editing || !form) return
    const invalid = validateSchedule(form)
    if (invalid) { toast.error(t(invalid)); return }
    setSaving(true)
    const result = await saveScheduleEdit(supabase, editing, { name: form.name.trim(), mode: form.mode, ...formDefinition(form, editing) }, editing.covered)
    setSaving(false)
    if (!result.ok) {
      toast.error(result.changed ? t('recurring.changedMeanwhile') : t('recurring.updateFailed'))
      if (result.changed) { setEditing(null); router.refresh() }
      return
    }
    toast.success(t('recurring.saved'))
    setEditing(null)
    router.refresh()
  }

  // The invoice each schedule creates next (planNextPeriod): its date, service period and the days
  // before it that no invoice of the schedule covers.
  const asOf = today()
  const plans = new Map(schedules.map(s => [s.id, planNextPeriod(s, s.covered, asOf)]))
  const nextDate = (s: ScheduleRow) => (scheduleStatus(s) === 'ended' ? s.next_date : plans.get(s.id)!.date)
  function planNote(s: ScheduleRow) {
    const plan = plans.get(s.id)!
    if (scheduleStatus(s) === 'ended' || plan.ended) return null
    return (
      <>
        <span className="block">{t('recurring.nextFor', { start: formatDate(plan.period.start, lang), end: formatDate(plan.period.end, lang) })}</span>
        {plan.gap && <span className="block text-amber-700 dark:text-amber-400">{t('recurring.notCovered', { start: formatDate(plan.gap.start, lang), end: formatDate(plan.gap.end, lang) })}</span>}
      </>
    )
  }

  async function confirmDelete() {
    if (!deleting) return
    setSaving(true)
    const { error } = await supabase.from('recurring_schedules').delete().eq('id', deleting.id)
    setSaving(false)
    if (error) { toast.error(t('recurring.deleteFailed')); return }
    toast.success(t('recurring.deleted'))
    setDeleting(null)
    router.refresh()
  }

  function renderActions(s: ScheduleRow) {
    const status = scheduleStatus(s)
    const busy = busyId === s.id
    return (
      <div className="flex items-center gap-0.5">
        <button type="button" onClick={() => generate(s)} disabled={busy || status !== 'active'} title={t('recurring.generateNow')} aria-label={t('recurring.generateNow')} className={actionClass}>
          <Zap size={15} />
        </button>
        {status !== 'ended' && (
          s.active
            ? <button type="button" onClick={() => setActive(s, false)} disabled={busy} title={t('recurring.pause')} aria-label={t('recurring.pause')} className={actionClass}><Pause size={15} /></button>
            : <button type="button" onClick={() => setActive(s, true)} disabled={busy} title={t('recurring.resume')} aria-label={t('recurring.resume')} className={actionClass}><Play size={15} /></button>
        )}
        <button type="button" onClick={() => openEdit(s)} disabled={busy} title={t('common.edit')} aria-label={t('common.edit')} className={actionClass}>
          <Pencil size={15} />
        </button>
        <button type="button" onClick={() => setDeleting(s)} disabled={busy} title={t('common.delete')} aria-label={t('common.delete')} className={`${actionClass} hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30`}>
          <Trash2 size={15} />
        </button>
      </div>
    )
  }

  const emptyState = (
    <div className="py-16 px-6 text-center">
      <Repeat size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('recurring.empty')}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1 max-w-sm mx-auto">{t('recurring.emptyHint')}</p>
      <Link href="/invoices" className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
        {t('recurring.goToInvoices')}
      </Link>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Mobile cards */}
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {schedules.length === 0 && emptyState}
          {schedules.map(s => {
            const status = scheduleStatus(s)
            const note = planNote(s)
            return (
              <div key={s.id} className="px-4 py-3.5 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{s.name}</p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{s.source?.client ?? '—'}</p>
                  </div>
                  <StatusBadge status={status} label={statusLabel(status)} className="shrink-0" />
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {intervalLabel(s)} · {t('recurring.next')} {formatDate(nextDate(s), lang)}
                  {s.end_date && <> · {t('recurring.until')} {formatDate(s.end_date, lang)}</>}
                  {' · '}{modeLabel(s)}
                </p>
                {note && <p className="text-xs text-neutral-500 dark:text-neutral-400">{note}</p>}
                <p className="text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap gap-x-3">
                  {s.source && <Link href={`/invoices/${s.source.id}`} className={linkClass}>{t('recurring.template')}: {docLabel(s.source)}</Link>}
                  <span>
                    {t('recurring.lastInvoice')}:{' '}
                    {s.last ? <Link href={`/invoices/${s.last.id}`} className={linkClass}>{docLabel(s.last)}</Link> : t('recurring.noLastInvoice')}
                  </span>
                </p>
                <div className="-ml-2.5 -mb-1">{renderActions(s)}</div>
              </div>
            )
          })}
        </div>

        {/* Desktop table */}
        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.name')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.client')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.interval')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.next')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.until')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.mode')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.status')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('recurring.lastInvoice')}</th>
              <th className="px-4 py-3"><span className="sr-only">{t('common.actions')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {schedules.length === 0 && (
              <tr><td colSpan={9}>{emptyState}</td></tr>
            )}
            {schedules.map(s => {
              const status = scheduleStatus(s)
              const cells = (
                <>
                  <td className="px-4 py-3">
                    <p className="font-medium">{s.name}</p>
                    {s.source && (
                      <Link href={`/invoices/${s.source.id}`} className={`text-xs text-neutral-500 dark:text-neutral-400 ${linkClass}`}>
                        {t('recurring.template')}: {docLabel(s.source)}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{s.source?.client ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{intervalLabel(s)}</td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                    <span className="whitespace-nowrap">{formatDate(nextDate(s), lang)}</span>
                    <span className="block text-xs">{planNote(s)}</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 whitespace-nowrap">{s.end_date ? formatDate(s.end_date, lang) : '—'}</td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{modeLabel(s)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={status} label={statusLabel(status)} />
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                    {s.last ? <Link href={`/invoices/${s.last.id}`} className={`font-medium ${linkClass}`}>{docLabel(s.last)}</Link> : <span className="text-neutral-500 dark:text-neutral-500">{t('recurring.noLastInvoice')}</span>}
                  </td>
                  <td data-row-ignore className="px-2 py-2 text-right">{renderActions(s)}</td>
                </>
              )
              // The row opens the template invoice; its link in the name cell stays the keyboard target.
              return s.source
                ? <ClickableRow key={s.id} href={`/invoices/${s.source.id}`} className={rowClass}>{cells}</ClickableRow>
                : <tr key={s.id} className={`transition-colors ${rowClass}`}>{cells}</tr>
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">{scheduleCount(schedules.length)}</p>

      <Dialog open={!!editing && !!form} onClose={() => setEditing(null)} title={t('recurring.editTitle')} busy={saving} panelClassName="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {form && (
          <form onSubmit={e => { e.preventDefault(); void saveEdit() }} className="space-y-4">
            <ScheduleFormFields values={form} onChange={patch => setForm(f => (f ? { ...f, ...patch } : f))} disabled={saving} stored={editing} covered={editing?.covered ?? []} paused={!!editing && scheduleStatus(editing) === 'paused'} />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={saving}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
            </div>
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        title={t('recurring.deleteTitle')}
        description={t('recurring.deleteDesc')}
        confirmLabel={saving ? t('common.deleting') : t('common.delete')}
        destructive
        busy={saving}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}
