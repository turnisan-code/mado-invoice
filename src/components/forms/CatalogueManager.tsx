'use client'

import { useEffect, useId, useState, useRef } from 'react'
import type { PostgrestError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X, Eye, EyeOff, Copy, Pencil, ChevronRight, ChevronUp, ChevronDown, Search } from 'lucide-react'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { CatalogueItem, CatalogueUsage, Unit, VatRate } from '@/types'
import { useT } from '@/lib/i18n/client'
import { n, type DictKey } from '@/lib/i18n'
import { lifecycleErrorMessage } from '@/lib/status'
import { dropIndex, moveItem, type DropEdge } from './builder/model'
import { useReorder } from './builder/useReorder'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]
const CAT_DATALIST_ID = 'cat-options'

// usage: per catalogue item id, the document lines using it and the latest document date, read when the page loaded.
interface Props { initialItems: CatalogueItem[]; usage: Record<string, CatalogueUsage> }
interface AddingState { category: string | null }
type Draft = Partial<CatalogueItem>
type PendingDelete = { kind: 'item'; id: string } | { kind: 'category'; cat: string; count: number }

const areaCls = 'w-full min-h-16 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 field-sizing-content resize-none'
const fieldCls = 'w-full h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500'
const iconBtn = 'h-10 w-10 sm:h-7 sm:w-7 flex items-center justify-center rounded-md transition-colors'

// Trimmed names, or null when both are empty; a missing translation falls back to the other.
function draftNames(d: Draft): { name_de: string; name_en: string } | null {
  const de = (d.name_de ?? '').trim()
  const en = (d.name_en ?? '').trim()
  if (!de && !en) return null
  return { name_de: de || en, name_en: en || de }
}

// The columns a user edits; id, active and sort_order are never written back from a draft.
function editableFields(d: Draft, names: { name_de: string; name_en: string }) {
  return {
    ...names,
    description_de: (d.description_de ?? '').trim() || null,
    description_en: (d.description_en ?? '').trim() || null,
    default_price: Number(d.default_price) || 0,
    unit: d.unit ?? 'flat',
    vat_rate: d.vat_rate ?? 20,
    category: (d.category ?? '').trim() || null,
  }
}

// Module level on purpose: a component declared inside CatalogueManager would be a new type on
// every render, remounting the form and dropping focus after each keystroke.
function EditForm({ d, setD, onSave, onCancel, categories, error, autoFocusName = true }: {
  d: Draft
  setD: (fn: (prev: Draft) => Draft) => void
  onSave: () => void
  onCancel: () => void
  categories: string[]
  error: string | null
  autoFocusName?: boolean
}) {
  const id = useId()
  const { t } = useT()
  const price = typeof d.default_price === 'number' && !isNaN(d.default_price) ? d.default_price : 0
  return (
    <form
      onSubmit={e => { e.preventDefault(); onSave() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}
      className="px-4 py-4 bg-neutral-50 dark:bg-neutral-800/60 border-t border-neutral-100 dark:border-neutral-800"
    >
      <datalist id={CAT_DATALIST_ID}>{categories.map(c => <option key={c} value={c} />)}</datalist>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-de`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.nameDe')}</label>
          <input id={`${id}-de`} autoFocus={autoFocusName} value={d.name_de ?? ''} onChange={e => setD(p => ({ ...p, name_de: e.target.value }))} placeholder={t('catalogue.nameDePlaceholder')} className={fieldCls} aria-invalid={!!error || undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-en`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.nameEn')}</label>
          <input id={`${id}-en`} value={d.name_en ?? ''} onChange={e => setD(p => ({ ...p, name_en: e.target.value }))} placeholder={t('catalogue.nameEnPlaceholder')} className={fieldCls} aria-invalid={!!error || undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-price`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.defaultPrice')}</label>
          <MoneyInput id={`${id}-price`} value={price} onValueChange={v => setD(p => ({ ...p, default_price: v ?? 0 }))} className={fieldCls} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-unit`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.unit')}</label>
          <select id={`${id}-unit`} value={d.unit ?? 'flat'} onChange={e => setD(p => ({ ...p, unit: e.target.value as Unit }))} className={fieldCls}>{UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}</select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-vat`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.vatRate')}</label>
          <select id={`${id}-vat`} value={d.vat_rate ?? 20} onChange={e => setD(p => ({ ...p, vat_rate: parseInt(e.target.value) as VatRate }))} className={fieldCls}>{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-section`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('catalogue.section')}</label>
          <input id={`${id}-section`} value={(d.category as string) ?? ''} onChange={e => setD(p => ({ ...p, category: e.target.value || null }))} list={CAT_DATALIST_ID} placeholder={t('catalogue.sectionPlaceholder')} className={fieldCls} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 mb-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-desc-de`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('clientData.catalogue.descriptionDe')}</label>
          <textarea id={`${id}-desc-de`} rows={3} value={d.description_de ?? ''} onChange={e => setD(p => ({ ...p, description_de: e.target.value }))} placeholder={t('clientData.catalogue.descriptionPlaceholder')} className={areaCls} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-desc-en`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('clientData.catalogue.descriptionEn')}</label>
          <textarea id={`${id}-desc-en`} rows={3} value={d.description_en ?? ''} onChange={e => setD(p => ({ ...p, description_en: e.target.value }))} placeholder={t('clientData.catalogue.descriptionPlaceholder')} className={areaCls} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" className="h-8 px-4 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">
          {t('common.save')}
        </button>
        <button type="button" onClick={onCancel} className="h-8 px-3 rounded-lg text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

export default function CatalogueManager({ initialItems, usage }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [adding, setAdding] = useState<AddingState | null>(null)
  const [addDraft, setAddDraft] = useState<Draft>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [catRenameVal, setCatRenameVal] = useState('')
  const [pendingCats, setPendingCats] = useState<string[]>([])
  const [newCatInput, setNewCatInput] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleting, setDeleting] = useState(false)
  // The control a keyboard or button move came from, focused again once the item has moved.
  const refocus = useRef<{ id: string; control: 'handle' | 'up' | 'down' } | null>(null)
  const renameInFlight = useRef(false)
  const supabase = createClient()
  const { t, lang } = useT()

  // The database's own text goes to the console; the toast is worded in the UI language.
  function failed(error: PostgrestError) {
    console.error('[catalogue] write failed:', error.code, error.message)
    toast.error(lifecycleErrorMessage(error, t))
  }

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))) as string[]
  const allCatNames = Array.from(new Set([...categories, ...pendingCats]))
  const groupKeys: (string | null)[] = [...allCatNames, null]

  const query = search.trim().toLowerCase()
  const hiddenCount = items.filter(i => !i.active).length
  const isVisible = (i: CatalogueItem) =>
    (showHidden || i.active) &&
    (!query || [i.name_de, i.name_en, i.description_de ?? '', i.description_en ?? '', i.category ?? ''].some(s => s.toLowerCase().includes(query)))
  const anyVisible = items.some(isVisible)
  // The uncategorised group carries its own "Add item" row; without it (e.g. an empty catalogue) offer one below.
  const showGlobalAdd = adding === null && !items.some(i => i.category == null && isVisible(i))

  function startEdit(item: CatalogueItem) {
    setAdding(null)
    setFormError(null)
    setEditingId(item.id)
    setDraft({ ...item })
  }
  function cancelEdit() { setEditingId(null); setDraft({}); setFormError(null) }

  function startAdd(category: string | null) {
    setEditingId(null)
    setFormError(null)
    setAdding({ category })
    setAddDraft({ name_de: '', name_en: '', default_price: 0, unit: 'flat', vat_rate: 20, category: category ?? undefined })
  }
  function cancelAdd() { setAdding(null); setAddDraft({}); setFormError(null) }

  async function saveEdit() {
    if (!editingId) return
    const names = draftNames(draft)
    if (!names) { setFormError(t('catalogue.nameRequired')); return }
    // Only the columns this edit changed are written.
    const original = items.find(i => i.id === editingId)
    const payload = Object.fromEntries(
      Object.entries(editableFields(draft, names)).filter(([key, value]) => original?.[key as keyof CatalogueItem] !== value),
    ) as Partial<CatalogueItem>
    if (Object.keys(payload).length) {
      const { error } = await supabase.from('catalogue_items').update(payload).eq('id', editingId)
      if (error) { failed(error); return }
    }
    setItems(items.map(i => i.id === editingId ? { ...i, ...payload } : i))
    setEditingId(null)
    setFormError(null)
  }

  async function deleteItem(id: string) {
    setDeleting(true)
    const { error: unlinkError } = await supabase.from('document_items').update({ catalogue_item_id: null }).eq('catalogue_item_id', id)
    if (unlinkError) { failed(unlinkError); setDeleting(false); return }
    const { error } = await supabase.from('catalogue_items').delete().eq('id', id)
    setDeleting(false)
    if (error) { failed(error); return }
    setItems(items.filter(i => i.id !== id))
    setPendingDelete(null)
    toast.success(t('catalogue.deleted'))
  }

  async function duplicateItem(item: CatalogueItem) {
    const suffix = t('catalogue.copySuffix')
    const payload = { name_de: item.name_de + suffix, name_en: item.name_en + suffix, description_de: item.description_de, description_en: item.description_en, default_price: item.default_price, unit: item.unit, vat_rate: item.vat_rate, category: item.category, sort_order: items.length * 10, active: item.active }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { failed(error); return }
    setItems([...items, data])
    startEdit(data)
  }

  async function addItem() {
    const names = draftNames(addDraft)
    if (!names) { setFormError(t('catalogue.nameRequired')); return }
    const payload = { ...editableFields(addDraft, names), sort_order: items.length * 10, active: true }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { failed(error); return }
    setItems([...items, data])
    cancelAdd()
    toast.success(t('catalogue.added'))
  }

  async function toggleActive(item: CatalogueItem) {
    const { error } = await supabase.from('catalogue_items').update({ active: !item.active }).eq('id', item.id)
    if (error) { failed(error); return }
    setItems(items.map(i => i.id === item.id ? { ...i, active: !item.active } : i))
  }

  const indexOf = (id: string) => items.findIndex(i => i.id === id)
  const sameSection = (a: string, b: string) => (items[indexOf(a)]?.category ?? null) === (items[indexOf(b)]?.category ?? null)
  // The visible items of an item's section, in order: what the arrows move it among.
  const sectionOf = (id: string) => items.filter(i => (i.category ?? null) === (items[indexOf(id)]?.category ?? null) && isVisible(i))

  // Moves an item to that edge of another one: exactly where the drag indicator is drawn.
  async function reorderItems(sourceId: string, targetId: string, edge: DropEdge) {
    const from = indexOf(sourceId)
    const over = indexOf(targetId)
    if (from < 0 || over < 0) return
    const next = moveItem(items, from, dropIndex(from, over, edge))
    if (next === items) return
    const section = next.filter(i => (i.category ?? null) === (items[from].category ?? null) && isVisible(i))
    reorder.announce(t('editor.reorder.moved', { position: section.findIndex(i => i.id === sourceId) + 1, count: section.length }))
    const withOrder = next.map((item, idx) => ({ ...item, sort_order: idx * 10 }))
    const previous = items
    setItems(withOrder)
    // One statement that writes only sort_order, so a failure leaves the database as it was.
    const { error } = await supabase.rpc('reorder_catalogue_items', { p_ids: withOrder.map(i => i.id) })
    if (error) {
      setItems(previous)
      console.error('[catalogue] order not saved:', error.code, error.message)
      toast.error(t('catalogue.orderFailed'))
    }
  }

  function step(id: string, delta: -1 | 1, control: 'handle' | 'up' | 'down') {
    const section = sectionOf(id)
    const neighbour = section[section.findIndex(i => i.id === id) + delta]
    if (!neighbour) return
    refocus.current = { id, control }
    void reorderItems(id, neighbour.id, delta < 0 ? 'before' : 'after')
  }

  const reorder = useReorder({
    isNoop: (from, over, edge) => { const f = indexOf(from); return dropIndex(f, indexOf(over), edge) === f },
    canDrop: sameSection,
    onDrop: (from, over, edge) => void reorderItems(from, over, edge),
    onStep: (id, delta) => step(id, delta, 'handle'),
  })

  useEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    const row = document.querySelector(`[data-catalogue-item="${target.id}"]`)
    if (target.control === 'handle') {
      row?.querySelector<HTMLElement>('[draggable="true"]')?.focus()
      return
    }
    // At the top or bottom that arrow is disabled; the other one keeps the focus on the item.
    const [up, down] = Array.from(row?.querySelectorAll<HTMLButtonElement>('button[data-move]') ?? [])
    const preferred = target.control === 'up' ? up : down
    ;(preferred && !preferred.disabled ? preferred : target.control === 'up' ? down : up)?.focus()
  }, [items])

  function startRenameCat(cat: string) { setRenamingCat(cat); setCatRenameVal(cat) }
  function cancelRenameCat() { setRenamingCat(null) }

  async function saveCatRename() {
    if (!renamingCat || renameInFlight.current) return
    const newName = catRenameVal.trim()
    if (!newName) { toast.error(t('catalogue.sectionEmpty')); return }
    if (newName === renamingCat) { setRenamingCat(null); return }
    if (allCatNames.includes(newName)) { toast.error(t('catalogue.sectionExists')); return }
    renameInFlight.current = true
    const { error } = await supabase.from('catalogue_items').update({ category: newName }).eq('category', renamingCat)
    renameInFlight.current = false
    if (error) { failed(error); return }
    setItems(items.map(i => i.category === renamingCat ? { ...i, category: newName } : i))
    setPendingCats(p => p.map(c => c === renamingCat ? newName : c))
    setRenamingCat(null)
    toast.success(t('catalogue.sectionRenamed'))
  }

  async function deleteCategory(cat: string, count: number) {
    setDeleting(true)
    if (count > 0) {
      const { error } = await supabase.from('catalogue_items').update({ category: null }).eq('category', cat)
      if (error) { failed(error); setDeleting(false); return }
      setItems(items.map(i => i.category === cat ? { ...i, category: null } : i))
    }
    setDeleting(false)
    setPendingCats(p => p.filter(c => c !== cat))
    setPendingDelete(null)
    toast.success(count > 0 ? t('catalogue.sectionRemoved') : t('catalogue.sectionDeleted'))
  }

  function confirmNewCat() {
    const name = newCatName.trim()
    if (!name) return
    if (allCatNames.includes(name)) { toast.error(t('catalogue.sectionExists')); return }
    setPendingCats(p => [...p, name])
    setNewCatInput(false)
    setNewCatName('')
    startAdd(name)
  }

  const deleteTitle = pendingDelete?.kind === 'item'
    ? t('catalogue.deleteItemTitle')
    : pendingDelete && pendingDelete.count > 0
      ? t('catalogue.removeSectionTitle', { name: pendingDelete.cat })
      : pendingDelete ? t('catalogue.deleteEmptySectionTitle', { name: pendingDelete.cat }) : ''
  const deleteDescription = pendingDelete?.kind === 'item'
    ? t('catalogue.deleteItemDesc')
    : pendingDelete && pendingDelete.count > 0
      ? n(pendingDelete.count, t('catalogue.removeSectionDescOne', { count: pendingDelete.count }), t('catalogue.removeSectionDescOther', { count: pendingDelete.count }))
      : undefined

  return (
    <div className="space-y-3">
      <p aria-live="polite" className="sr-only">{reorder.announcement}</p>

      {/* Search + hidden toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400 pointer-events-none" />
          <input
            type="search"
            aria-label={t('catalogue.searchLabel')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('catalogue.searchPlaceholder')}
            className={`${fieldCls} pl-9`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 cursor-pointer select-none">
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600" />
          {hiddenCount ? t('catalogue.showHiddenCount', { count: hiddenCount }) : t('catalogue.showHidden')}
        </label>
      </div>

      {!anyVisible && items.length > 0 && !adding && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 px-1">
          {query ? t('catalogue.noMatch') : t('catalogue.allHidden')}
        </p>
      )}

      {groupKeys.map(cat => {
        const group = items.filter(i => (i.category ?? null) === cat && isVisible(i))
        const isPending = cat !== null && pendingCats.includes(cat)
        const isAddingHere = adding?.category === cat
        if (!group.length && !isPending && !isAddingHere) return null

        return (
          <div key={cat ?? '__none'} className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">

            {/* Section header — only for named categories */}
            {cat !== null && (
              <div className="px-4 py-2.5 flex items-center gap-2 bg-neutral-50 dark:bg-neutral-800/80 border-b border-neutral-100 dark:border-neutral-800 group/header">
                {renamingCat === cat ? (
                  <form onSubmit={e => { e.preventDefault(); saveCatRename() }} className="flex items-center gap-2 flex-1">
                    <input
                      autoFocus
                      aria-label={t('catalogue.sectionName')}
                      value={catRenameVal}
                      onChange={e => setCatRenameVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') cancelRenameCat() }}
                      className="text-base md:text-xs font-semibold uppercase tracking-widest bg-transparent border-b border-neutral-400 dark:border-neutral-500 outline-none focus:border-neutral-700 dark:focus:border-neutral-200 text-neutral-700 dark:text-neutral-200 w-40 pb-0.5"
                    />
                    <button type="submit" title={t('common.save')} aria-label={t('catalogue.saveSectionName')} className={`${iconBtn} text-green-600 hover:text-green-700 dark:text-green-400`}><Check size={14} /></button>
                    <button type="button" title={t('common.cancel')} aria-label={t('catalogue.cancelRenaming')} onClick={cancelRenameCat} className={`${iconBtn} text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200`}><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <span className="text-xs font-semibold tracking-widest uppercase text-neutral-500 dark:text-neutral-400">{cat}</span>
                    <span className="text-xs text-neutral-400 dark:text-neutral-600 font-medium">{group.length}</span>
                    <div className="flex items-center gap-0.5 ml-1 sm:opacity-0 sm:group-hover/header:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button type="button" onClick={() => startRenameCat(cat)} title={t('catalogue.rename')} aria-label={t('catalogue.renameSection', { name: cat })} className={`${iconBtn} text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200`}><Pencil size={12} /></button>
                      <button type="button" onClick={() => setPendingDelete({ kind: 'category', cat, count: items.filter(i => i.category === cat).length })} title={t('catalogue.deleteSection')} aria-label={t('catalogue.deleteSectionNamed', { name: cat })} className={`${iconBtn} text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400`}><Trash2 size={12} /></button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Items */}
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800/80">
              {group.map((item, position) => (
                <div
                  key={item.id}
                  data-catalogue-item={item.id}
                  {...reorder.rowProps(item.id)}
                  className={`${reorder.indicatorCls(item.id)} ${reorder.dragging === item.id ? 'opacity-50' : ''}`}
                >
                  {/* Row */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={editingId === item.id}
                    onClick={() => editingId === item.id ? cancelEdit() : startEdit(item)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (editingId === item.id) cancelEdit(); else startEdit(item) }
                    }}
                    className={`flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-3.5 cursor-pointer group/row transition-colors
                      ${editingId === item.id ? 'bg-neutral-50 dark:bg-neutral-800/60' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40'}
                      ${!item.active ? 'opacity-50' : ''}`}
                  >
                    {/* Drag handle; Alt+↑/↓ moves the item too. On phones the arrows below do.
                        Not a <button>: Firefox does not start a drag from one. */}
                    <span
                      role="button"
                      tabIndex={0}
                      {...reorder.handleProps(item.id)}
                      onClick={e => e.stopPropagation()}
                      aria-label={t('editor.reorder.itemHandle', { name: item.name_de })}
                      title={t('editor.reorder.hint')}
                      className="hidden sm:flex h-7 w-4 -mx-0.5 shrink-0 items-center justify-center rounded text-neutral-300 dark:text-neutral-600 group-hover/row:text-neutral-500 dark:group-hover/row:text-neutral-400 cursor-grab active:cursor-grabbing transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
                    >
                      <GripVertical size={15} aria-hidden="true" />
                    </span>

                    {/* Name: a line of its own on phones */}
                    <div className="w-full sm:w-auto sm:flex-1 min-w-0">
                      <p className={`text-sm font-medium leading-snug ${!item.active ? 'line-through' : 'text-neutral-900 dark:text-neutral-100'}`}>
                        {item.name_de}
                      </p>
                      {item.name_en && item.name_en !== item.name_de && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5 leading-snug">{item.name_en}</p>
                      )}
                      {(item.description_de || item.description_en) && (
                        <p className="text-xs text-neutral-400 dark:text-neutral-500 line-clamp-1 mt-0.5 leading-snug">{item.description_de || item.description_en}</p>
                      )}
                      {(usage[item.id]?.uses ?? 0) > 0 && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 leading-snug">
                          {n(usage[item.id].uses, t('clientData.catalogue.usedOne'), t('clientData.catalogue.usedOther', { count: usage[item.id].uses }))}
                          {usage[item.id].lastUsed && ` · ${t('rates.lastUsed', { date: formatDate(usage[item.id].lastUsed!, lang) })}`}
                        </p>
                      )}
                    </div>

                    {/* Price + meta */}
                    <div className="flex items-center gap-2.5 w-full sm:w-auto sm:shrink-0">
                      <span className="mr-auto sm:mr-0 text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-100 sm:min-w-[72px] sm:text-right">
                        {formatMoney(item.default_price)}
                      </span>
                      <span className="hidden sm:inline-block text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 rounded-md px-2 py-0.5 font-medium">
                        {t(`units.${item.unit}` as DictKey)}
                      </span>
                      <span className="hidden sm:inline-block text-xs text-neutral-500 dark:text-neutral-400 w-8 text-right tabular-nums">
                        {item.vat_rate}%
                      </span>

                      {/* Actions — always on touch screens, on hover/focus with a pointer */}
                      <div
                        className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity"
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => e.stopPropagation()}
                      >
                        <button type="button" data-move onClick={() => step(item.id, -1, 'up')} disabled={position === 0}
                          aria-label={t('editor.reorder.itemUp', { name: item.name_de })}
                          className={`${iconBtn} sm:hidden text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-30`}>
                          <ChevronUp size={14} />
                        </button>
                        <button type="button" data-move onClick={() => step(item.id, 1, 'down')} disabled={position === group.length - 1}
                          aria-label={t('editor.reorder.itemDown', { name: item.name_de })}
                          className={`${iconBtn} sm:hidden text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-30`}>
                          <ChevronDown size={14} />
                        </button>
                        <button type="button" onClick={() => duplicateItem(item)} title={t('catalogue.duplicate')} aria-label={t('catalogue.duplicateItem', { name: item.name_de })} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700`}>
                          <Copy size={13} />
                        </button>
                        <button type="button" onClick={() => toggleActive(item)} title={item.active ? t('catalogue.hide') : t('catalogue.show')} aria-label={item.active ? t('catalogue.hideItem', { name: item.name_de }) : t('catalogue.showItem', { name: item.name_de })} aria-pressed={!item.active} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700`}>
                          {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <button type="button" onClick={() => setPendingDelete({ kind: 'item', id: item.id })} title={t('common.delete')} aria-label={t('catalogue.deleteItem', { name: item.name_de })} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30`}>
                          <Trash2 size={13} />
                        </button>
                      </div>

                      {/* Chevron indicator */}
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        className={`text-neutral-400 dark:text-neutral-600 transition-transform duration-150 ${editingId === item.id ? 'rotate-90' : ''}`}
                      />
                    </div>
                  </div>

                  {/* Inline edit form */}
                  {editingId === item.id && (
                    <EditForm d={draft} setD={setDraft} onSave={saveEdit} onCancel={cancelEdit} categories={categories} error={formError} />
                  )}
                </div>
              ))}
            </div>

            {/* Add item row / form */}
            {isAddingHere ? (
              <EditForm d={addDraft} setD={setAddDraft} onSave={addItem} onCancel={cancelAdd} categories={categories} error={formError} />
            ) : (
              <button
                type="button"
                onClick={() => startAdd(cat)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 border-t border-dashed border-neutral-200 dark:border-neutral-800 transition-colors"
              >
                <Plus size={13} />
                <span>{cat ? t('catalogue.addItemTo', { section: cat }) : t('catalogue.addItem')}</span>
              </button>
            )}
          </div>
        )
      })}

      {showGlobalAdd && (
        <button
          type="button"
          onClick={() => startAdd(null)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 border border-dashed border-neutral-200 dark:border-neutral-800 transition-colors"
        >
          <Plus size={13} />
          <span>{t('catalogue.addItem')}</span>
        </button>
      )}

      {/* New section / global controls */}
      <div className="pt-1 flex items-center gap-4">
        {newCatInput ? (
          <form onSubmit={e => { e.preventDefault(); confirmNewCat() }} className="flex items-center gap-2 flex-wrap">
            <input
              autoFocus
              aria-label={t('catalogue.newSectionName')}
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              placeholder={t('catalogue.newSectionPlaceholder')}
              className="h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-base md:text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-400 w-44"
            />
            <button type="submit" className="h-8 px-3 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">
              {t('common.create')}
            </button>
            <button type="button" onClick={() => { setNewCatInput(false); setNewCatName('') }} className="h-8 px-2 text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors">
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNewCatInput(true)}
            className="flex items-center gap-1.5 text-sm py-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            <Plus size={14} /> {t('catalogue.newSection')}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel={deleting ? t('common.deleting') : pendingDelete?.kind === 'category' && pendingDelete.count > 0 ? t('catalogue.removeSection') : t('common.delete')}
        destructive
        busy={deleting}
        onConfirm={() => {
          if (!pendingDelete) return
          if (pendingDelete.kind === 'item') void deleteItem(pendingDelete.id)
          else void deleteCategory(pendingDelete.cat, pendingDelete.count)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
