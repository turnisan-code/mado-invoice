'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select } from '@/components/ui/select'
import { useT } from '@/lib/i18n/client'
import { today } from '@/lib/utils/document'
import { makePeriod, monthName, periodParams, type Period, type PeriodKind } from '@/app/(app)/reports/period'

interface Props {
  period: Period
  years: number[]
}

const KINDS: PeriodKind[] = ['month', 'quarter', 'year']

// Inside the group's 1 px border, so the group is as tall as the selects next to it.
const segment = (active: boolean, first: boolean) =>
  `px-3 h-9.5 sm:h-7.5 text-sm font-medium transition-colors focus-visible:outline-offset-[-2px] ${
    active
      ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
      : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
  } ${first ? '' : 'border-l border-neutral-200 dark:border-neutral-700'}`

export default function ReportControls({ period, years }: Props) {
  const router = useRouter()
  const { t, lang } = useT()
  const [pending, startTransition] = useTransition()

  function go(next: Period) {
    startTransition(() => router.push(`/reports?${periodParams(next)}`))
  }

  // Leaving the year view lands on the current month/quarter when the year is the current one.
  function indexFor(kind: PeriodKind) {
    const now = today()
    const month = period.kind === 'year' && Number(now.slice(0, 4)) === period.year ? Number(now.slice(5, 7)) : period.month
    return kind === 'month' ? month : kind === 'quarter' ? Math.ceil(month / 3) : 0
  }

  return (
    <div className={`flex items-center gap-2 flex-wrap transition-opacity ${pending ? 'opacity-60' : ''}`} aria-busy={pending}>
      <div role="group" aria-label={t('exports.period.kind')} className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {KINDS.map((kind, i) => (
          <button key={kind} type="button" onClick={() => go(makePeriod(kind, period.year, indexFor(kind)))} aria-pressed={period.kind === kind} className={segment(period.kind === kind, i === 0)}>
            {t(`exports.period.${kind}`)}
          </button>
        ))}
      </div>
      {period.kind === 'month' && (
        <Select aria-label={t('exports.period.month')} value={period.month} onChange={e => go(makePeriod('month', period.year, Number(e.target.value)))} className="w-auto">
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{monthName(m, lang)}</option>)}
        </Select>
      )}
      {period.kind === 'quarter' && (
        <div role="group" aria-label={t('exports.period.quarter')} className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          {[1, 2, 3, 4].map((q, i) => (
            <button key={q} type="button" onClick={() => go(makePeriod('quarter', period.year, q))} aria-pressed={period.quarter === q} className={segment(period.quarter === q, i === 0)}>
              Q{q}
            </button>
          ))}
        </div>
      )}
      <Select aria-label={t('reports.year')} value={period.year} onChange={e => go(makePeriod(period.kind, Number(e.target.value), indexFor(period.kind)))} className="w-auto">
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </Select>
    </div>
  )
}
