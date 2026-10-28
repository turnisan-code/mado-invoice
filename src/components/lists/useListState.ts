'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

export type SortDir = 'asc' | 'desc'
export interface Sort<K extends string> { key: K; dir: SortDir }

export interface ListConfig<F extends string, K extends string> {
  /** URL filter names → allowed values (null: any text). */
  filters: Record<F, readonly string[] | null>
  sortKeys: readonly K[]
  defaultSort: Sort<K>
  /** Direction a column starts with when it becomes the sort column. */
  firstDir?: SortDir
}

export interface ListView<F extends string, K extends string> {
  filters: Record<F, string>
  sort: Sort<K>
  page: number
}

export const PAGE_SIZE = 25

function parseView<F extends string, K extends string>(config: ListConfig<F, K>, p: URLSearchParams): ListView<F, K> {
  const filters = {} as Record<F, string>
  for (const name of Object.keys(config.filters) as F[]) {
    const value = p.get(name) ?? ''
    const allowed = config.filters[name]
    filters[name] = !allowed || allowed.includes(value) ? value : ''
  }
  const [key, dir] = (p.get('sort') ?? '').split(':')
  return {
    filters,
    sort: config.sortKeys.includes(key as K) ? { key: key as K, dir: dir === 'asc' ? 'asc' : 'desc' } : config.defaultSort,
    page: Math.max(1, parseInt(p.get('page') ?? '', 10) || 1),
  }
}

function serializeView<F extends string, K extends string>(config: ListConfig<F, K>, view: ListView<F, K>): string {
  const p = new URLSearchParams()
  for (const name of Object.keys(config.filters) as F[]) if (view.filters[name]) p.set(name, view.filters[name])
  if (view.sort.key !== config.defaultSort.key || view.sort.dir !== config.defaultSort.dir) p.set('sort', `${view.sort.key}:${view.sort.dir}`)
  if (view.page > 1) p.set('page', String(view.page))
  return p.toString()
}

// Search, filters, sort and page of a list, kept in the URL so Back, reload and shared links
// restore the view. State updates instantly; the URL follows (debounced, via the history API so
// no server round trip). `config` must be a module-level constant.
export function useListState<F extends string, K extends string>(config: ListConfig<F, K>) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlQs = searchParams.toString()
  const [view, setView] = useState(() => parseView(config, searchParams))
  const written = useRef(new Set<string>())

  useEffect(() => {
    const next = serializeView(config, view)
    if (next === urlQs) return
    const timer = setTimeout(() => {
      written.current.add(next)
      window.history.replaceState(null, '', next ? `${pathname}?${next}` : pathname)
    }, 250)
    return () => clearTimeout(timer)
  }, [config, view, urlQs, pathname])

  // A URL we did not write (dashboard card, sidebar link, Back) replaces the state.
  useEffect(() => {
    if (written.current.delete(urlQs)) return
    setView(parseView(config, new URLSearchParams(urlQs)))
  }, [config, urlQs])

  const setFilters = useCallback((patch: Partial<Record<F, string>>) => {
    setView(v => ({ ...v, filters: { ...v.filters, ...patch }, page: 1 }))
  }, [])

  const clearFilters = useCallback(() => {
    setView(v => ({ ...v, filters: Object.fromEntries(Object.keys(v.filters).map(k => [k, ''])) as Record<F, string>, page: 1 }))
  }, [])

  const toggleSort = useCallback((key: K) => {
    setView(v => ({
      ...v,
      page: 1,
      sort: v.sort.key === key ? { key, dir: v.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: config.firstDir ?? 'desc' },
    }))
  }, [config])

  const setPage = useCallback((page: number) => setView(v => ({ ...v, page })), [])

  const hasFilters = Object.values<string>(view.filters).some(Boolean)
  return { ...view, setFilters, clearFilters, toggleSort, setPage, hasFilters }
}

export function paginate<T>(list: T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const current = Math.min(page, pageCount)
  return { page: current, pageCount, pageItems: list.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) }
}

// Only rows the user can currently see take part in bulk actions; selecting "all" means all on this page.
export function useSelection<T extends { id: string }>(filtered: T[], pageItems: T[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectedVisible = useMemo(() => filtered.filter(d => selected.has(d.id)), [filtered, selected])
  const allPageSelected = pageItems.length > 0 && pageItems.every(d => selected.has(d.id))

  const clear = useCallback(() => setSelected(new Set()), [])
  const toggleOne = useCallback((id: string) => {
    setSelected(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }, [])
  function toggleAll() {
    setSelected(s => {
      const next = new Set(s)
      for (const d of pageItems) if (allPageSelected) next.delete(d.id); else next.add(d.id)
      return next
    })
  }

  return { isSelected: (id: string) => selected.has(id), selectedVisible, count: selectedVisible.length, allPageSelected, toggleOne, toggleAll, clear }
}

const collator = new Intl.Collator(undefined, { numeric: true })

// Numbers numerically; text by locale with natural number order (R-2026-9 before R-2026-10).
export function compareBy(a: string | number, b: string | number, dir: SortDir): number {
  const c = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))
  return dir === 'asc' ? c : -c
}
