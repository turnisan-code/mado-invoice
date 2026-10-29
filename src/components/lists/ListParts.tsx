'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUpDown, ArrowUp, ArrowDown, CheckSquare, Square, X, Loader2, Download, type LucideIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n/client'
import type { UiLang } from '@/lib/i18n'
import { formatDate } from '@/lib/utils/document'
import type { Sort } from './useListState'

// Filter bars: the shared control look at its natural width.
export const inputClass = cn(fieldClass, 'w-auto')
export const searchClass = cn(fieldClass, 'flex-1 min-w-48 max-w-sm')
export const headerButtonClass = buttonVariants({ variant: 'outline' })
export const primaryLinkClass = buttonVariants()
export const listCardClass = 'bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden'
export const theadClass = 'border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800'
export const rowStateClass = (selected: boolean) => selected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'

// A list date in the UI language (29.10.2026 / 29/10/2026), never the stored ISO string.
export const listDate = (date: string | null | undefined, lang: UiLang) => date ? formatDate(date, lang) : '—'

export function SortableTh<K extends string>({ col, label, sort, onSort, align = 'left' }: {
  col: K
  label: string
  sort: Sort<K>
  onSort: (key: K) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === col
  return (
    <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={() => onSort(col)} className={`flex items-center gap-1 w-full rounded hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors ${align === 'right' ? 'justify-end' : ''}`}>
        {label}
        {!active ? <ArrowUpDown size={12} className="opacity-30" /> : sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      </button>
    </th>
  )
}

// Header export: the selected rows if any, otherwise everything the filters show.
export function ExportButton({ onClick }: { onClick: () => void }) {
  const { t } = useT()
  return (
    <Button type="button" variant="outline" onClick={onClick} title={t('lists.exportCsv')}>
      <Download size={14} />
      <span className="sr-only sm:not-sr-only">{t('lists.exportCsv')}</span>
    </Button>
  )
}

export function PlainTh({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>
}

// Checkbox-style toggle; `large` is the 44 px touch target of the mobile cards.
export function SelectToggle({ checked, onToggle, label, large = false }: { checked: boolean; onToggle: () => void; label: string; large?: boolean }) {
  const size = large ? 16 : 14
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      aria-label={label}
      className={`${large ? 'shrink-0 h-11 w-11 -ml-3' : 'h-8 w-8'} -my-2 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors`}
    >
      {checked ? <CheckSquare size={size} className="text-blue-500" /> : <Square size={size} />}
    </button>
  )
}

// A table row that opens the document from anywhere in the row, not only the number link.
// Clicks on controls inside the row, text selections and modifier clicks keep their own meaning.
// A cell marked data-row-ignore never opens the row: a click on a disabled button lands on
// the cell around it, not on the button.
export function ClickableRow({ href, className = '', children }: { href: string; className?: string; children: React.ReactNode }) {
  const router = useRouter()
  function open(e: React.MouseEvent<HTMLTableRowElement>, newTab: boolean) {
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label, [data-row-ignore]')) return
    if (window.getSelection()?.toString()) return
    if (newTab) window.open(href, '_blank', 'noopener')
    else router.push(href)
  }
  return (
    <tr
      onClick={e => open(e, e.metaKey || e.ctrlKey || e.shiftKey)}
      onAuxClick={e => { if (e.button === 1) open(e, true) }}
      className={`cursor-pointer transition-colors ${className}`}
    >
      {children}
    </tr>
  )
}

export function EmptyState({ icon: Icon, message, cta }: { icon: LucideIcon; message: string; cta?: { href: string; label: string } }) {
  return (
    <div className="py-16 px-4 text-center">
      <Icon size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{message}</p>
      {cta && (
        <Link href={cta.href} className="mt-3 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
          {cta.label}
        </Link>
      )}
    </div>
  )
}

export function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  const { t } = useT()
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      <Button type="button" variant="outline" onClick={() => onPage(page - 1)} disabled={page <= 1}>{t('common.prev')}</Button>
      <span>{t('common.pageOf', { page, count: pageCount })}</span>
      <Button type="button" variant="outline" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>{t('common.next')}</Button>
    </div>
  )
}

const TONES = {
  blue: 'bg-blue-500 hover:bg-blue-600 text-white',
  green: 'bg-green-500 hover:bg-green-600 text-white',
  red: 'bg-red-500 hover:bg-red-600 text-white',
  neutral: 'bg-white/20 dark:bg-neutral-900/20 hover:bg-white/30 dark:hover:bg-neutral-900/30',
}

export function BulkButton({ tone = 'neutral', icon: Icon, onClick, disabled, busy = false, children }: {
  tone?: keyof typeof TONES
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  children: React.ReactNode
}) {
  return (
    <Button type="button" onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} className={cn('text-xs px-3', TONES[tone])}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {children}
    </Button>
  )
}

// Fixed bar above the mobile tab bar while rows are selected; inert (not just invisible) when empty
// so its buttons cannot be reached with Tab.
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: React.ReactNode }) {
  const { t } = useT()
  const open = count > 0
  return (
    <div
      role="region"
      aria-label={t('lists.bulkActions')}
      inert={!open}
      className={`fixed left-0 right-0 z-50 transition-all duration-200 ${open ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'}`}
      style={{ bottom: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="max-w-5xl mx-auto px-4 pb-[4.5rem] md:pb-6">
        <div className="bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium shrink-0">{t('lists.selected', { count })}</span>
          <div className="flex items-center gap-2 flex-1 flex-wrap">{children}</div>
          <button
            type="button"
            onClick={onClear}
            aria-label={t('lists.clearSelection')}
            className="shrink-0 h-11 w-11 -my-2 -mr-2 flex items-center justify-center rounded-lg hover:bg-white/20 dark:hover:bg-neutral-900/20 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
