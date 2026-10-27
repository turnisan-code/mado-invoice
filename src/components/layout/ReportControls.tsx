'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useT } from '@/lib/i18n/client'

interface Props {
  year: number
  quarter: number // 0 = whole year
  years: number[]
}

export default function ReportControls({ year, quarter, years }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useT()

  function navigate(newYear: number, newQuarter: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('year', String(newYear))
    params.set('quarter', newQuarter === 0 ? 'all' : String(newQuarter))
    router.push(`/reports?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div role="group" aria-label={t('reports.period')} className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {[1, 2, 3, 4, 0].map((q, i) => (
          <button
            key={q}
            type="button"
            onClick={() => navigate(year, q)}
            aria-pressed={q === quarter}
            className={`px-3 py-2 sm:py-1.5 text-sm font-medium transition-colors focus-visible:outline-offset-[-2px] ${
              q === quarter
                ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
            } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
          >
            {q === 0 ? t('reports.year') : `Q${q}`}
          </button>
        ))}
      </div>
      <select
        aria-label={t('reports.year')}
        value={year}
        onChange={e => navigate(parseInt(e.target.value), quarter)}
        className="text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100"
      >
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  )
}
