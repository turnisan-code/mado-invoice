'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { fieldClass } from '@/components/ui/control'
import { formatDate, today } from '@/lib/utils/document'
import { dayOfMonth, defaultNextDate, servicePeriod } from '@/lib/utils/recurring'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { RecurringInterval, RecurringMode } from '@/types'

export const INTERVALS: RecurringInterval[] = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']

export interface ScheduleFormValues {
  name: string
  interval: RecurringInterval
  next_date: string
  end_date: string
  in_advance: boolean
  mode: RecurringMode
}

const inputClass = fieldClass
const labelClass = 'block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1'

export function validateSchedule(v: ScheduleFormValues): DictKey | null {
  if (!v.name.trim()) return 'recurring.nameRequired'
  if (!v.next_date) return 'recurring.nextDateRequired'
  if (v.end_date && v.end_date < v.next_date) return 'recurring.endBeforeNext'
  return null
}

// Shared by the create dialog here and the edit dialog in RecurringList.
export function ScheduleFormFields({ values, onChange, disabled = false }: {
  values: ScheduleFormValues
  onChange: (patch: Partial<ScheduleFormValues>) => void
  disabled?: boolean
}) {
  const { t, lang } = useT()
  const id = useId()
  const period = values.next_date ? servicePeriod(values.next_date, values.interval, values.in_advance) : null

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${id}-name`} className={labelClass}>{t('recurring.name')}</label>
        <input id={`${id}-name`} type="text" value={values.name} onChange={e => onChange({ name: e.target.value })} maxLength={120} disabled={disabled} className={inputClass} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-interval`} className={labelClass}>{t('recurring.interval')}</label>
          <Select id={`${id}-interval`} value={values.interval} onChange={e => onChange({ interval: e.target.value as RecurringInterval })} disabled={disabled}>
            {INTERVALS.map(i => <option key={i} value={i}>{t(`recurring.intervals.${i}` as DictKey)}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={`${id}-next`} className={labelClass}>{t('recurring.nextDate')}</label>
          <input id={`${id}-next`} type="date" value={values.next_date} onChange={e => onChange({ next_date: e.target.value })} disabled={disabled} className={inputClass} />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-end`} className={labelClass}>{t('recurring.endDate')}</label>
        <input id={`${id}-end`} type="date" value={values.end_date} min={values.next_date || undefined} onChange={e => onChange({ end_date: e.target.value })} disabled={disabled} className={inputClass} />
      </div>
      <div>
        <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
          <input type="checkbox" checked={values.in_advance} onChange={e => onChange({ in_advance: e.target.checked })} disabled={disabled} className="w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 accent-neutral-900 dark:accent-white" />
          {t('recurring.inAdvance')}
        </label>
        {period && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 pl-6.5">
            {t('recurring.periodHint', { start: formatDate(period.start, lang), end: formatDate(period.end, lang) })}
          </p>
        )}
      </div>
      <fieldset className="space-y-1.5">
        <legend className={labelClass}>{t('recurring.mode')}</legend>
        {(['draft', 'issue'] as RecurringMode[]).map(mode => (
          <label key={mode} className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
            <input type="radio" name={`${id}-mode`} value={mode} checked={values.mode === mode} onChange={() => onChange({ mode })} disabled={disabled} className="w-4 h-4 accent-neutral-900 dark:accent-white" />
            {mode === 'draft' ? t('recurring.modeDraft') : t('recurring.modeIssue')}
          </label>
        ))}
      </fieldset>
    </div>
  )
}

// "Make recurring" on an invoice page: the invoice becomes the template of a new schedule.
export default function MakeRecurringDialog({ invoiceId, defaultName }: { invoiceId: string; defaultName: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [values, setValues] = useState<ScheduleFormValues>(() => ({
    name: defaultName, interval: 'monthly', next_date: defaultNextDate(today()), end_date: '', in_advance: false, mode: 'draft',
  }))
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  async function create() {
    const invalid = validateSchedule(values)
    if (invalid) { toast.error(t(invalid)); return }
    setSaving(true)
    const { error } = await supabase.from('recurring_schedules').insert({
      source_document_id: invoiceId,
      name: values.name.trim(),
      interval: values.interval,
      anchor_day: dayOfMonth(values.next_date),
      next_date: values.next_date,
      end_date: values.end_date || null,
      in_advance: values.in_advance,
      mode: values.mode,
    })
    if (error) { toast.error(t('recurring.createFailed')); setSaving(false); return }
    toast.success(t('recurring.created'))
    router.push('/recurring')
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} title={t('recurring.makeRecurring')}>
        <Repeat size={14} /> <span className="sr-only sm:not-sr-only">{t('recurring.makeRecurring')}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('recurring.dialogTitle')} description={t('recurring.dialogDesc')} busy={saving} panelClassName="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={e => { e.preventDefault(); void create() }} className="space-y-4">
          <ScheduleFormFields values={values} onChange={patch => setValues(v => ({ ...v, ...patch }))} disabled={saving} />
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>{saving ? t('recurring.creating') : t('recurring.create')}</Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
