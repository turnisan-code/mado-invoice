'use client'

import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { formatMoney } from '@/lib/utils/document'
import { catalogueName, cataloguePrice, type RateMap } from '@/lib/utils/catalogue'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import type { CatalogueItem, Language, Unit, VatRate } from '@/types'
import { AutoTextarea } from './AutoTextarea'
import { UNITS, VAT_RATES } from './model'

const POPUP_HEIGHT = 288
const fieldCls = 'text-base md:text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100'
const EMPTY_DRAFT = { name_de: '', name_en: '', default_price: 0, unit: 'flat' as Unit, vat_rate: 20 as VatRate, category: '' }

type Position = { top?: number; bottom?: number; left: number; width?: string }

// A line's description: free text over several lines, and while it is a single line a search of
// the catalogue (arrow keys pick, Escape closes, Enter on a highlighted entry takes it). It stays
// a textbox, the one role a textarea may have; aria-controls and aria-activedescendant tie the list to it.
export function CatalogueField({ value, language, items, rates, invalid, className, onChange, onPick, onItemCreated }: {
  value: string
  language: Language
  items: CatalogueItem[]
  // The client's own prices, shown (and taken) instead of the catalogue price.
  rates: RateMap
  invalid: boolean
  className: string
  onChange: (description: string) => void
  onPick: (item: CatalogueItem) => void
  onItemCreated: (item: CatalogueItem) => void
}) {
  const { t } = useT()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [pos, setPos] = useState<Position>({ left: 0 })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  // Several lines are a written description, not a search.
  const searchable = (text: string) => !text.includes('\n')
  const q = value.toLowerCase()
  const matches = items.filter(i => {
    if (!i.active) return false
    const n = catalogueName(i, language).toLowerCase()
    return !q || n.includes(q) || i.name_de.toLowerCase().includes(q) || (i.name_en ?? '').toLowerCase().includes(q)
  })
  const shown = open && searchable(value)

  function openAt(el: HTMLElement) {
    setOpen(true)
    setHighlight(-1)
    const rect = el.getBoundingClientRect()
    const phone = window.matchMedia('(max-width: 639px)').matches
    const left = phone ? 16 : rect.left
    const width = phone ? 'calc(100vw - 2rem)' : undefined
    setPos(rect.bottom + POPUP_HEIGHT > window.innerHeight
      ? { bottom: window.innerHeight - rect.top + 4, left, width }
      : { top: rect.bottom + 4, left, width })
  }

  function close() {
    setOpen(false)
    setAdding(false)
  }

  function pick(item: CatalogueItem) {
    onPick(item)
    setOpen(false)
  }

  async function createItem() {
    const payload = {
      name_de: draft.name_de || draft.name_en,
      name_en: draft.name_en || draft.name_de,
      default_price: draft.default_price,
      unit: draft.unit,
      vat_rate: draft.vat_rate,
      category: draft.category || null,
      sort_order: items.length * 10,
      active: true,
    }
    const { data, error } = await createClient().from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    onItemCreated(data)
    pick(data)
    setAdding(false)
    setDraft(EMPTY_DRAFT)
    toast.success(t('builder.itemAdded'))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!shown) {
      if (e.key === 'ArrowDown' && searchable(value)) { e.preventDefault(); openAt(e.currentTarget) }
      return
    }
    const count = matches.length + 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => (h + 1) % count) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => (h <= 0 ? count - 1 : h - 1)) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault()
      if (highlight < matches.length) pick(matches[highlight])
      else setAdding(true)
    }
  }

  return (
    // The popup closes once focus has left both the description and the popup itself.
    <div className="relative min-w-0" onBlur={e => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) close() }}>
      <AutoTextarea
        value={value}
        placeholder={t('builder.descriptionPlaceholder')}
        aria-label={t('builder.description')}
        aria-invalid={invalid || undefined}
        aria-controls={shown ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={shown && highlight >= 0 && highlight < matches.length ? `${listId}-${highlight}` : undefined}
        onChange={e => {
          onChange(e.target.value)
          setHighlight(-1)
          if (!open && searchable(e.target.value)) openAt(e.currentTarget)
        }}
        onFocus={e => { if (searchable(value)) openAt(e.currentTarget) }}
        onKeyDown={onKeyDown}
        className={className}
      />
      {shown && (
        <div
          className={`fixed z-50 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg max-h-72 overflow-auto ${pos.width ? '' : 'w-96 max-w-[calc(100vw-2rem)]'}`}
          style={pos}
        >
          <div role="listbox" id={listId} aria-label={t('builder.catalogueItems')}>
            {matches.length === 0 && (
              <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400 text-center">{t('builder.noItems')}</p>
            )}
            {matches.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="option"
                id={`${listId}-${i}`}
                aria-selected={highlight === i}
                tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(item)}
                className={`w-full text-left px-3 py-2.5 sm:py-2 text-sm flex justify-between items-center gap-3 ${highlight === i ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
              >
                <span className="min-w-0 truncate">{catalogueName(item, language)}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 text-right">
                  {formatMoney(cataloguePrice(item, rates))}/{t(`units.${item.unit}` as DictKey)}
                  {rates[item.id] !== undefined && <span className="block text-[11px]">{t('rates.clientRate')}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-neutral-100 dark:border-neutral-800">
            {adding ? (
              <div className="p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input value={draft.name_de} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} placeholder={t('builder.nameDe')} aria-label={t('builder.nameDeLabel')} autoFocus className={fieldCls} />
                  <input value={draft.name_en} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} placeholder={t('builder.nameEn')} aria-label={t('builder.nameEnLabel')} className={fieldCls} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <MoneyInput value={draft.default_price} onValueChange={n => setDraft(d => ({ ...d, default_price: n ?? 0 }))} placeholder={t('builder.price')} aria-label={t('builder.price')} className="h-7 px-2 md:text-xs" />
                  <select value={draft.unit} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} aria-label={t('builder.unit')} className={`${fieldCls} px-1`}>
                    {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
                  </select>
                  <select value={draft.vat_rate} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} aria-label={t('builder.vatRate')} className={`${fieldCls} px-1`}>
                    {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                </div>
                <input value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))} placeholder={t('builder.category')} aria-label={t('builder.category')} className={fieldCls} />
                <div className="flex gap-2">
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void createItem()} className="text-xs px-2.5 py-1.5 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:bg-neutral-700 dark:hover:bg-neutral-200">{t('builder.addAndUse')}</button>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => setAdding(false)} className="text-xs px-2.5 py-1.5 border border-neutral-200 dark:border-neutral-700 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800">{t('common.cancel')}</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHighlight(matches.length)}
                onClick={() => setAdding(true)}
                className={`w-full text-left px-3 py-2.5 text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5 ${highlight === matches.length ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
              >
                <Plus size={12} /> {t('builder.newCatalogueItem')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
