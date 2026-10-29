'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatMoney, today } from '@/lib/utils/document'
import { formatDuration, parseDuration } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { TimeEntry } from '@/types'
import { Select } from '@/components/ui/select'
import { CONTROL_HEIGHT } from '@/components/ui/control'
import { checkboxClass, inputClass, labelClass } from './ui'

export type ProjectOption = { id: string; name: string; client: string; hourly_rate: number | null }

const PRESETS = [30, 60, 120, 240, 480]

type Values = { project_id: string; date: string; duration: string; description: string; billable: boolean; rate: number | null }

// Logs time on a phone in a few taps (preset durations, date defaulting to today) or edits an
// entry. Without a fixed project it offers the given projects. Mount it only while open.
export default function TimeEntryDialog({ projects, projectId, entry, onClose, onSaved }: {
  projects: ProjectOption[]
  projectId?: string
  entry?: TimeEntry
  onClose: () => void
  onSaved?: () => void
}) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()
  const id = useId()
  const [values, setValues] = useState<Values>(() => ({
    project_id: entry?.project_id ?? projectId ?? (projects.length === 1 ? projects[0].id : ''),
    date: entry?.date ?? today(),
    duration: entry ? formatDuration(entry.minutes) : '',
    description: entry?.description ?? '',
    billable: entry?.billable ?? true,
    rate: entry?.rate ?? null,
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Values>) => setValues(v => ({ ...v, ...patch }))
  const project = projects.find(p => p.id === values.project_id)
  const minutes = parseDuration(values.duration)

  function invalid(): DictKey | null {
    if (!values.project_id) return 'projects.time.projectRequired'
    if (!values.date) return 'projects.time.dateRequired'
    if (minutes === null) return 'projects.time.durationInvalid'
    if (values.rate !== null && values.rate < 0) return 'projects.time.rateInvalid'
    return null
  }

  async function save() {
    const problem = invalid()
    if (problem || minutes === null) { toast.error(t(problem ?? 'projects.time.durationInvalid')); return }
    setSaving(true)
    const row = {
      project_id: values.project_id,
      date: values.date,
      minutes,
      description: values.description.trim(),
      billable: values.billable,
      rate: values.rate,
    }
    // A billed entry is never changed, even from a page that does not know it was billed yet.
    const { data, error } = entry
      ? await supabase.from('time_entries').update(row).eq('id', entry.id).is('invoiced_document_id', null).select('id')
      : await supabase.from('time_entries').insert(row).select('id')
    setSaving(false)
    if (error || !data?.length) { toast.error(t('projects.time.saveFailed')); return }
    toast.success(entry ? t('projects.time.saved') : t('projects.time.added', { duration: formatDuration(minutes) }))
    onSaved?.()
    onClose()
    router.refresh()
  }

  const noProjects = !projectId && !entry && projects.length === 0

  return (
    <Dialog open onClose={onClose} title={entry ? t('projects.time.editTitle') : t('projects.time.createTitle')} busy={saving} panelClassName="max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
      {noProjects ? (
        <div className="space-y-4">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('projects.time.noActiveProjects')}</p>
          <div className="flex justify-end"><Button type="button" variant="outline" onClick={onClose}>{t('common.close')}</Button></div>
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); void save() }} className="space-y-4">
          <div className="space-y-3">
            {!projectId && !entry && (
              <div>
                <label htmlFor={`${id}-project`} className={labelClass}>{t('projects.time.project')}</label>
                <Select id={`${id}-project`} value={values.project_id} onChange={e => set({ project_id: e.target.value })} disabled={saving}>
                  <option value="">{t('projects.time.selectProject')}</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.client}</option>)}
                </Select>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${id}-date`} className={labelClass}>{t('projects.time.date')}</label>
                <input id={`${id}-date`} type="date" value={values.date} onChange={e => set({ date: e.target.value })} disabled={saving} className={inputClass} />
              </div>
              <div>
                <label htmlFor={`${id}-duration`} className={labelClass}>{t('projects.time.duration')}</label>
                <input
                  id={`${id}-duration`}
                  type="text"
                  autoComplete="off"
                  value={values.duration}
                  onChange={e => set({ duration: e.target.value })}
                  placeholder={t('projects.time.durationPlaceholder')}
                  aria-invalid={values.duration.trim() !== '' && minutes === null}
                  aria-describedby={`${id}-duration-hint`}
                  disabled={saving}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set({ duration: formatDuration(m) })}
                  disabled={saving}
                  aria-pressed={minutes === m}
                  className={`h-9 sm:h-7 px-2.5 rounded-full border text-xs tabular-nums transition-colors ${minutes === m ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900' : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
                >
                  {formatDuration(m)}
                </button>
              ))}
              <span id={`${id}-duration-hint`} className="text-xs text-neutral-400 dark:text-neutral-500 basis-full">{t('projects.time.durationHint')}</span>
            </div>
            <div>
              <label htmlFor={`${id}-description`} className={labelClass}>{t('projects.time.description')}</label>
              <input id={`${id}-description`} type="text" value={values.description} onChange={e => set({ description: e.target.value })} placeholder={t('projects.time.descriptionPlaceholder')} maxLength={500} disabled={saving} className={inputClass} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <label className={`flex items-center gap-2.5 ${CONTROL_HEIGHT} text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none`}>
                <input type="checkbox" checked={values.billable} onChange={e => set({ billable: e.target.checked })} disabled={saving} className={checkboxClass} />
                {t('projects.time.billable')}
              </label>
              <div>
                <label htmlFor={`${id}-rate`} className={labelClass}>{t('projects.time.rate')}</label>
                <MoneyInput id={`${id}-rate`} value={values.rate} onValueChange={v => set({ rate: v })} disabled={saving || !values.billable} className={inputClass} />
              </div>
            </div>
            {values.billable && (
              <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1 text-right">
                {project?.hourly_rate != null
                  ? t('projects.time.rateHint', { rate: formatMoney(project.hourly_rate) })
                  : t('projects.time.rateHintNone')}
              </p>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
