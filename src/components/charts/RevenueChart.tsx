'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/utils/document'

export interface MonthData {
  label: string   // "Jan", "Feb" …
  yearMonth: string // "2025-01"
  revenue: number
  current: boolean
}

export default function RevenueChart({ months, currency = 'EUR' }: { months: MonthData[]; currency?: string }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(...months.map(m => m.revenue), 1)

  const W = 600
  const H = 120
  const BAR_GAP = 4
  const barW = (W - BAR_GAP * (months.length - 1)) / months.length
  const LABEL_H = 20

  return (
    <div className="w-full" style={{ fontFamily: 'inherit' }}>
      <svg
        viewBox={`0 0 ${W} ${H + LABEL_H}`}
        className="w-full"
        style={{ overflow: 'visible' }}
        onMouseLeave={() => setHovered(null)}
      >
        {months.map((m, i) => {
          const x = i * (barW + BAR_GAP)
          const barH = Math.max((m.revenue / max) * H, m.revenue > 0 ? 3 : 0)
          const y = H - barH
          const isHov = hovered === i

          return (
            <g key={m.yearMonth} onMouseEnter={() => setHovered(i)}>
              {/* hit area */}
              <rect x={x} y={0} width={barW} height={H + LABEL_H} fill="transparent" />

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

              {/* tooltip */}
              {isHov && m.revenue > 0 && (
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
    </div>
  )
}
