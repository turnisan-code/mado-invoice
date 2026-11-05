'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'

export interface MonthData {
  label: string   // "Jan", "Feb" …
  yearMonth: string // "2025-01"
  revenue: number
  current: boolean
}

export default function RevenueChart({ months, currency = 'EUR', label }: { months: MonthData[]; currency?: string; label?: string }) {
  const { t, lang } = useT()
  const [hovered, setHovered] = useState<number | null>(null)
  // Focus from the keyboard: the active month gets a ring and its value is announced.
  const [keyboard, setKeyboard] = useState(false)
  const max = Math.max(...months.map(m => m.revenue), 1)
  const start = Math.max(0, months.findIndex(m => m.current))

  const W = 600
  const H = 120
  const BAR_GAP = 4
  const barW = (W - BAR_GAP * (months.length - 1)) / months.length
  const LABEL_H = 20

  // One tab stop for the whole chart; the arrow keys, Home and End move between the months.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const last = months.length - 1
    const from = hovered ?? start
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? Math.max(0, from - 1)
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? Math.min(last, from + 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    setKeyboard(true)
    setHovered(next)
  }

  const announced = keyboard && hovered != null ? months[hovered] : null

  return (
    <div className="w-full" style={{ fontFamily: 'inherit' }}>
      {/* Screen readers get the numbers as a table; the bars only repeat them. */}
      <div className="sr-only">
        <table>
          {label && <caption>{label}</caption>}
          <thead>
            <tr><th scope="col">{t('views.chart.month')}</th><th scope="col">{t('views.chart.revenue')}</th></tr>
          </thead>
          <tbody>
            {months.map(m => (
              <tr key={m.yearMonth}><th scope="row">{m.label} {m.yearMonth.slice(0, 4)}</th><td>{formatMoney(m.revenue, currency)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label={t('views.chartKeyboard.label')}
        onFocus={e => {
          if (!e.currentTarget.matches(':focus-visible')) return
          setKeyboard(true)
          setHovered(h => h ?? start)
        }}
        onBlur={() => { setKeyboard(false); setHovered(null) }}
        onKeyDown={onKeyDown}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-4 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900"
      >
        <svg
          viewBox={`0 0 ${W} ${H + LABEL_H}`}
          className="w-full"
          style={{ overflow: 'visible' }}
          aria-hidden="true"
          onMouseLeave={() => { if (!keyboard) setHovered(null) }}
        >
          {months.map((m, i) => {
            const x = i * (barW + BAR_GAP)
            const barH = Math.max((m.revenue / max) * H, m.revenue > 0 ? 3 : 0)
            const y = H - barH
            const isHov = hovered === i

            return (
              <g key={m.yearMonth} onMouseEnter={() => setHovered(i)} onClick={() => setHovered(i)}>
                {/* hit area; with keyboard focus it carries the focus ring */}
                <rect
                  x={x - 1}
                  y={1}
                  width={barW + 2}
                  height={H + LABEL_H - 1}
                  rx={4}
                  fill="transparent"
                  strokeWidth={2}
                  className={keyboard && isHov ? 'stroke-neutral-900 dark:stroke-neutral-100' : 'stroke-transparent'}
                />

                {/* bar */}
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={3}
                  className={
                    m.current
                      ? 'fill-neutral-800 dark:fill-neutral-100'
                      : isHov
                      ? 'fill-neutral-400 dark:fill-neutral-500'
                      : 'fill-neutral-200 dark:fill-neutral-700'
                  }
                  style={{ transition: 'fill 0.12s' }}
                />

                {/* month label */}
                <text
                  x={x + barW / 2}
                  y={H + LABEL_H - 2}
                  textAnchor="middle"
                  className="fill-neutral-400 dark:fill-neutral-500"
                  style={{ fontSize: 9 }}
                >
                  {m.label}
                </text>

                {/* tooltip: by keyboard also for a month without revenue */}
                {isHov && (m.revenue > 0 || keyboard) && (
                  <g>
                    {(() => {
                      const tipW = 90
                      const tipH = 30
                      const tipX = Math.min(Math.max(x + barW / 2 - tipW / 2, 0), W - tipW)
                      const tipY = Math.max(y - tipH - 6, 0)
                      const label = formatMoney(m.revenue, currency)
                      return (
                        <>
                          <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={4} className="fill-neutral-900 dark:fill-neutral-100" />
                          <text
                            x={tipX + tipW / 2}
                            y={tipY + 12}
                            textAnchor="middle"
                            className="fill-white dark:fill-neutral-900"
                            style={{ fontSize: 10, fontWeight: 600 }}
                          >
                            {label}
                          </text>
                          <text
                            x={tipX + tipW / 2}
                            y={tipY + 24}
                            textAnchor="middle"
                            className="fill-neutral-300 dark:fill-neutral-600"
                            style={{ fontSize: 9 }}
                          >
                            {m.label}
                          </text>
                        </>
                      )
                    })()}
                  </g>
                )}
              </g>
            )
          })}
        </svg>
        <p className="sr-only" aria-live="polite">
          {announced ? t('views.chartKeyboard.value', { month: announced.label, year: announced.yearMonth.slice(0, 4), amount: formatMoney(announced.revenue, currency, lang) }) : ''}
        </p>
      </div>
    </div>
  )
}
