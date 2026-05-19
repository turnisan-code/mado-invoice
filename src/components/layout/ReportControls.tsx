'use client'

import { useRouter, useSearchParams } from 'next/navigation'

interface Props {
  year: number
  quarter: number
  years: number[]
}

export default function ReportControls({ year, quarter, years }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function navigate(newYear: number, newQuarter: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('year', String(newYear))
    params.set('quarter', String(newQuarter))
    router.push(`/reports?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {[1, 2, 3, 4].map(q => (
          <button
            key={q}
            onClick={() => navigate(year, q)}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              q === quarter
                ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
            } ${q > 1 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
          >
            Q{q}
          </button>
        ))}
      </div>
      <select
        value={year}
        onChange={e => navigate(parseInt(e.target.value), quarter)}
        className="text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none"
      >
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  )
}
