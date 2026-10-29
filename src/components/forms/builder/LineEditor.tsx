'use client'

import { useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useT } from '@/lib/i18n/client'
import type { PublicSettings } from '@/lib/public-settings'
import type { CatalogueItem, Currency, Language, LineType } from '@/types'
import type { RateMap } from '@/lib/utils/catalogue'
import { LineRow, itemColumns, type LineIssues } from './LineRow'
import { blankLine, blankSpecial, dropIndex, moveItem, type LineItem } from './model'
import { useReorder } from './useReorder'

const SPECIAL_LINES: [LineType, 'builder.heading' | 'builder.note' | 'builder.divider' | 'builder.subtotalLine' | 'builder.pageBreak'][] = [
  ['heading', 'builder.heading'],
  ['text', 'builder.note'],
  ['separator', 'builder.divider'],
  ['subtotal', 'builder.subtotalLine'],
  ['page_break', 'builder.pageBreak'],
]

// The document's lines, reordered by drag and drop, Alt+↑/↓ on a handle or the arrows on a phone.
export function LineEditor({ lines, setLines, updateLine, settings, currency, language, vatApplies, lineIssues, catalogue, clientRates, onCatalogueItemCreated }: {
  lines: LineItem[]
  setLines: (fn: (lines: LineItem[]) => LineItem[]) => void
  updateLine: (id: string, patch: Partial<LineItem>) => void
  settings: PublicSettings
  currency: Currency
  language: Language
  vatApplies: boolean
  lineIssues: (index: number) => LineIssues
  catalogue: CatalogueItem[]
  // The selected client's own prices for catalogue items.
  clientRates: RateMap
  onCatalogueItemCreated: (item: CatalogueItem) => void
}) {
  const { t } = useT()
  const listRef = useRef<HTMLDivElement>(null)
  // The control a keyboard or button move came from, focused again once the row has moved.
  const refocus = useRef<{ id: string; control: 'handle' | 'up' | 'down' } | null>(null)
  const indexOf = (id: string) => lines.findIndex(l => l.id === id)

  function moveTo(from: number, to: number) {
    if (from === to || to < 0 || to >= lines.length) return
    setLines(ls => moveItem(ls, from, to))
    reorder.announce(t('editor.reorder.moved', { position: to + 1, count: lines.length }))
  }

  const reorder = useReorder({
    isNoop: (from, over, edge) => { const f = indexOf(from); return dropIndex(f, indexOf(over), edge) === f },
    onDrop: (from, over, edge) => { const f = indexOf(from); moveTo(f, dropIndex(f, indexOf(over), edge)) },
    onStep: (id, delta) => { refocus.current = { id, control: 'handle' }; const f = indexOf(id); moveTo(f, f + delta) },
  })

  useEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    const row = listRef.current?.querySelector(`[data-line="${target.id}"]`)
    if (target.control === 'handle') {
      row?.querySelector<HTMLElement>('[draggable="true"]')?.focus()
      return
    }
    // At the top or bottom that arrow is disabled; the other one keeps the focus in the row.
    const [up, down] = Array.from(row?.querySelectorAll<HTMLButtonElement>('button[data-move]') ?? [])
    const preferred = target.control === 'up' ? up : down
    ;(preferred && !preferred.disabled ? preferred : target.control === 'up' ? down : up)?.focus()
  }, [lines])

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-3">{t('builder.lineItems')}</p>
      <p aria-live="polite" className="sr-only">{reorder.announcement}</p>
      <div className="sm:overflow-x-auto sm:-mx-1 sm:px-1">
        <div className="sm:min-w-[560px]">
          <div className="hidden sm:grid gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 px-1" style={{ gridTemplateColumns: itemColumns(vatApplies) }}>
            <span /><span>{t('builder.description')}</span><span>{t('builder.qty')}</span><span>{t('builder.unit')}</span><span>{t('builder.price')}</span>
            {vatApplies && <span>{t('builder.vat')}</span>}
            <span /><span /><span />
          </div>
          <div ref={listRef} className="sm:space-y-1">
            {lines.map((line, idx) => (
              <div key={line.id} data-line={line.id}>
                <LineRow
                  line={line}
                  index={idx}
                  count={lines.length}
                  lines={lines}
                  currency={currency}
                  language={language}
                  vatApplies={vatApplies}
                  issues={lineIssues(idx)}
                  catalogue={catalogue}
                  clientRates={clientRates}
                  onCatalogueItemCreated={onCatalogueItemCreated}
                  update={patch => updateLine(line.id, patch)}
                  remove={() => setLines(ls => ls.filter(l => l.id !== line.id))}
                  move={delta => { refocus.current = { id: line.id, control: delta < 0 ? 'up' : 'down' }; moveTo(idx, idx + delta) }}
                  reorder={reorder}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 pt-3 flex-wrap">
        <button type="button" onClick={() => setLines(ls => [...ls, blankLine(settings)])}
          className="flex items-center gap-1.5 text-sm px-2.5 py-2 sm:py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
          <Plus size={13} /> {t('builder.addLine')}
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1.5" />
        {SPECIAL_LINES.map(([lt, label]) => (
          <button key={lt} type="button" onClick={() => setLines(ls => [...ls, blankSpecial(lt)])}
            className="text-xs px-2 py-2 sm:py-1 rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            + {t(label)}
          </button>
        ))}
      </div>
    </div>
  )
}
