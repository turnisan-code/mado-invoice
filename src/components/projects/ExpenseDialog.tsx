'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatMoney, today } from '@/lib/utils/document'
import { expensePrice } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { ProjectExpense, VatRate } from '@/types'
import { Select } from '@/components/ui/select'
import { CONTROL_HEIGHT } from '@/components/ui/control'
import { checkboxClass, inputClass, labelClass } from './ui'

const VAT_RATES: VatRate[] = [20, 13, 10, 0]

type Values = { date: string; description: string; net_amount: number | null; vat_rate: VatRate; billable: boolean; markup_percent: number | null }

// A cost passed on to the client at its net amount plus an optional markup. Mount only while open.
export default function ExpenseDialog({ projectId, expense, defaultVatRate, onClose }: {
  projectId: string
  expense?: ProjectExpense
  defaultVatRate: VatRate
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()
  const id = useId()
  const [values, setValues] = useState<Values>(() => ({
    date: expense?.date ?? today(),
    description: expense?.description ?? '',
    net_amount: expense?.net_amount ?? null,
    vat_rate: expense?.vat_rate ?? defaultVatRate,
    billable: expense?.billable ?? true,
    markup_percent: expense?.markup_percent ?? null,
  }))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Values>) => setValues(v => ({ ...v, ...patch }))

  function invalid(): DictKey | null {
    if (!values.date) return 'projects.time.dateRequired'
    if (!values.description.trim()) return 'projects.expense.descriptionRequired'
    if (values.net_amount === null || values.net_amount <= 0) return 'projects.expense.amountRequired'
    if (values.markup_percent !== null && (values.markup_percent < 0 || values.markup_percent > 1000)) return 'projects.expense.markupInvalid'
    return null
  }

  async function save() {
    const problem = invalid()
    if (problem) { toast.error(t(problem)); return }
    setSaving(true)
    const row = {
      project_id: projectId,
      date: values.date,
      description: values.description.trim(),
      net_amount: values.net_amount,
      vat_rate: values.vat_rate,
      billable: values.billable,
      markup_percent: values.markup_percent || null,
    }
    const { data, error } = expense
      ? await supabase.from('project_expenses').update(row).eq('id', expense.id).is('invoiced_document_id', null).select('id')
      : await supabase.from('project_expenses').insert(row).select('id')
    setSaving(false)
    if (error || !data?.length) { toast.error(t('projects.expense.saveFailed')); return }
    toast.success(t('projects.expense.saved'))
    onClose()
    router.refresh()
  }

  const price = values.net_amount && values.net_amount > 0 && values.markup_percent
    ? expensePrice({ net_amount: values.net_amount, markup_percent: values.markup_percent })
    : null

  return (
    <Dialog open onClose={onClose} title={expense ? t('projects.expense.editTitle') : t('projects.expense.createTitle')} busy={saving} panelClassName="max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <form onSubmit={e => { e.preventDefault(); void save() }} className="space-y-4">
        <div className="space-y-3">
          <div>
            <label htmlFor={`${id}-date`} className={labelClass}>{t('projects.expense.date')}</label>
            <input id={`${id}-date`} type="date" value={values.date} onChange={e => set({ date: e.target.value })} disabled={saving} className={inputClass} />
          </div>
          <div>
            <label htmlFor={`${id}-description`} className={labelClass}>{t('projects.expense.description')}</label>
            <input id={`${id}-description`} type="text" value={values.description} onChange={e => set({ description: e.target.value })} placeholder={t('projects.expense.descriptionPlaceholder')} maxLength={500} disabled={saving} className={inputClass} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-net`} className={labelClass}>{t('projects.expense.netAmount')}</label>
              <MoneyInput id={`${id}-net`} value={values.net_amount} onValueChange={v => set({ net_amount: v })} disabled={saving} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-vat`} className={labelClass}>{t('projects.expense.vatRate')}</label>
              <Select id={`${id}-vat`} aria-describedby={`${id}-vat-hint`} value={values.vat_rate} onChange={e => set({ vat_rate: Number(e.target.value) as VatRate })} disabled={saving}>
                {VAT_RATES.map(r => <option key={r} value={r}>{r} %</option>)}
              </Select>
            </div>
            <p id={`${id}-vat-hint`} className="sm:col-span-2 -mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('projects.expense.vatHint')}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <label className={`flex items-center gap-2.5 ${CONTROL_HEIGHT} text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none`}>
              <input type="checkbox" checked={values.billable} onChange={e => set({ billable: e.target.checked })} disabled={saving} className={checkboxClass} />
              {t('projects.expense.billable')}
            </label>
            <div>
              <label htmlFor={`${id}-markup`} className={labelClass}>{t('projects.expense.markup')}</label>
              <MoneyInput id={`${id}-markup`} value={values.markup_percent} onValueChange={v => set({ markup_percent: v })} disabled={saving || !values.billable} className={inputClass} />
            </div>
          </div>
          {values.billable && price !== null && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-right">{t('projects.expense.price', { amount: formatMoney(price) })}</p>
          )}
          <p className="text-xs text-neutral-400 dark:text-neutral-500">{t('projects.detail.vatNote')}</p>
        </div>
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
