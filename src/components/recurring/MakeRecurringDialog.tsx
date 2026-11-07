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
import { MAX_PERIODS_PER_RUN, anchorDayFor, defaultNextDate, definitionStartingOn, planNextPeriod, type CoveredPeriod, type PeriodDefinition } from '@/lib/utils/recurring'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'
import type { RecurringInterval, RecurringMode } from '@/types'

export const INTERVALS: RecurringInterval[] = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']

export interface ScheduleFormValues {
  name: string
  interval: RecurringInterval
  next_date: string
  // Set by "Bill from" (definitionStartingOn); null: the day of next_date, or the schedule's own
  // anchor while next_date is unchanged (anchorDayFor).
  anchor_day: number | null
  end_date: string
  in_advance: boolean
  mode: RecurringMode
}

// The schedule the form describes, as the generator reads it.
export function formDefinition(values: ScheduleFormValues, stored: Pick<PeriodDefinition, 'next_date' | 'anchor_day'> | null): PeriodDefinition {
  return {
    interval: values.interval,
    next_date: values.next_date,
    anchor_day: anchorDayFor(stored, values.next_date, values.anchor_day),
    in_advance: values.in_advance,
    end_date: values.end_date || null,
  }
}

const inputClass = fieldClass
const labelClass = 'block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1'

export function validateSchedule(v: ScheduleFormValues): DictKey | null {
  if (!v.name.trim()) return 'recurring.nameRequired'
  if (!v.next_date) return 'recurring.nextDateRequired'
  if (v.end_date && v.end_date < v.next_date) return 'recurring.endBeforeNext'
  return null
}

// What the schedule creates next as the form stands (planNextPeriod): the invoice's date and service
// period, the periods skipped because invoices of the schedule already cover them, the days no
// invoice covers (with "Bill from", which makes the next period start on the first of them), how
// many invoices are already due, later periods skipped too, or that the schedule ends.
function SchedulePlan({ values, stored, covered, paused, onChange, disabled }: {
  values: ScheduleFormValues
  stored: Pick<PeriodDefinition, 'next_date' | 'anchor_day'> | null
  covered: readonly CoveredPeriod[]
  paused: boolean
  onChange: (patch: Partial<ScheduleFormValues>) => void
  disabled: boolean
}) {
  const { t, lang } = useT()
  const def = formDefinition(values, stored)
  const plan = planNextPeriod(def, covered, today())
  const day = (date: string) => formatDate(date, lang)
  const fill = plan.gap ? { ...def, ...definitionStartingOn(def, plan.gap.start) } : null
  const fillPlan = fill && planNextPeriod(fill, covered)
  const first = plan.skipped[0]
  const last = plan.skipped[plan.skipped.length - 1]
  return (
    <div className="text-xs text-neutral-500 dark:text-neutral-400 space-y-1" aria-live="polite">
      {plan.ended
        ? <p>{t('recurring.plan.ended')}</p>
        : <p className="text-neutral-700 dark:text-neutral-300">{t(stored ? 'recurring.plan.next' : 'recurring.plan.first', { date: day(plan.date), start: day(plan.period.start), end: day(plan.period.end) })}</p>}
      {first && <p>{t('recurring.plan.skipped', { start: day(first.start), end: day(last.end) })}</p>}
      {plan.gap && (
        <p className="text-amber-700 dark:text-amber-400">
          {t('recurring.plan.gap', { start: day(plan.gap.start), end: day(plan.gap.end) })}
          {fill && fillPlan && !fillPlan.gap && !fillPlan.skipped.length && (
            <>
              {' '}
              <button type="button" disabled={disabled} onClick={() => onChange({ next_date: fill.next_date, anchor_day: fill.anchor_day })} className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 disabled:opacity-50">
                {t('recurring.plan.fillGap', { start: day(plan.gap.start) })}
              </button>
            </>
          )}
        </p>
      )}
      {!plan.ended && plan.due > 0 && (
        <p>
          {paused
            ? t('recurring.plan.duePaused', { count: plan.due })
            : plan.due > MAX_PERIODS_PER_RUN
              ? t('recurring.plan.dueMany', { count: plan.due, max: MAX_PERIODS_PER_RUN })
              : n(plan.due, t('recurring.plan.dueOne'), t('recurring.plan.dueOther', { count: plan.due }))}
        </p>
      )}
      {!plan.ended && plan.later && (
        <p className={plan.later.uncovered.length ? 'text-amber-700 dark:text-amber-400' : undefined}>
          {plan.later.uncovered.length
            ? t('recurring.plan.laterGap', { start: day(plan.later.start), end: day(plan.later.end), gap: plan.later.uncovered.map(r => `${day(r.start)} – ${day(r.end)}`).join(', ') })
            : t('recurring.plan.later', { start: day(plan.later.start), end: day(plan.later.end) })}
        </p>
      )}
    </div>
  )
}

// Shared by the create dialog here and the edit dialog in RecurringList. `stored` and `covered`:
// the schedule being edited and the periods its invoices cover; none when creating one. `paused`:
// it stays paused when saved, so nothing due is created until it is resumed.
export function ScheduleFormFields({ values, onChange, disabled = false, stored = null, covered = [], paused = false }: {
  values: ScheduleFormValues
  onChange: (patch: Partial<ScheduleFormValues>) => void
  disabled?: boolean
  stored?: Pick<PeriodDefinition, 'next_date' | 'anchor_day'> | null
  covered?: readonly CoveredPeriod[]
  paused?: boolean
}) {
  const { t } = useT()
  const id = useId()

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
          <input id={`${id}-next`} type="date" value={values.next_date} onChange={e => onChange({ next_date: e.target.value, anchor_day: null })} disabled={disabled} className={inputClass} />
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
      </div>
      {values.next_date && <SchedulePlan values={values} stored={stored} covered={covered} paused={paused} onChange={onChange} disabled={disabled} />}
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
    name: defaultName, interval: 'monthly', next_date: defaultNextDate(today()), anchor_day: null, end_date: '', in_advance: false, mode: 'draft',
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
      anchor_day: anchorDayFor(null, values.next_date, values.anchor_day),
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
