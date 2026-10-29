'use client'

import { X } from 'lucide-react'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatMoney } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'
import type { DiscountKind } from './model'

const CHIPS = [5, 10, 15, 20, 25]

const toggleCls = (active: boolean) =>
  `px-2 py-1 sm:py-0.5 transition-colors ${active ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900' : 'bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'}`
const chipCls = (active: boolean) =>
  `text-xs px-2 py-1 sm:px-1.5 sm:py-0.5 rounded-full border transition-colors ${active ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 border-transparent' : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-500'}`
export const removeDiscountCls = 'h-9 w-9 -my-2 sm:h-7 sm:w-7 sm:-my-1 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0'

// Percent or a fixed amount, its value, what it takes off and quick percentages: the same control
// for a line, a section and the whole document. The caller clamps the value as calcTotals does.
export function DiscountControls({ kind, value, amount, currency, label, onChange, onRemove, autoFocus, children }: {
  kind: DiscountKind
  value: number
  amount: number
  currency: string
  label: string
  onChange: (kind: DiscountKind, value: number) => void
  onRemove: () => void
  autoFocus?: boolean
  children?: React.ReactNode
}) {
  const { t } = useT()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        {children}
        <div role="group" aria-label={t('builder.discountType')} className="flex rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden text-xs shrink-0">
          <button type="button" aria-pressed={kind === 'percent'} onClick={() => onChange('percent', value)} className={toggleCls(kind === 'percent')}>%</button>
          <button type="button" aria-pressed={kind === 'fixed'} onClick={() => onChange('fixed', value)} className={toggleCls(kind === 'fixed')}>{currency}</button>
        </div>
        <MoneyInput
          value={value}
          onValueChange={n => onChange(kind, n ?? 0)}
          aria-label={label}
          autoFocus={autoFocus}
          className="w-20 h-8 sm:h-7 md:text-xs text-right"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400 min-w-20 sm:min-w-24 text-right">−{formatMoney(amount, currency)}</span>
        <button type="button" aria-label={t('builder.removeDiscount')} onClick={onRemove} className={removeDiscountCls}><X size={13} /></button>
      </div>
      {kind === 'percent' && (
        <div className="flex gap-1 justify-end flex-wrap">
          {CHIPS.map(p => (
            <button key={p} type="button" aria-pressed={value === p} onClick={() => onChange('percent', p)} className={chipCls(value === p)}>{p}%</button>
          ))}
        </div>
      )}
    </div>
  )
}
