'use client'

import { useId, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X, Eye, EyeOff, Copy, Pencil, ChevronRight, Search } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { CatalogueItem, Unit, VatRate } from '@/types'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]
const CAT_DATALIST_ID = 'cat-options'

interface Props { initialItems: CatalogueItem[] }
interface AddingState { category: string | null }
type Draft = Partial<CatalogueItem>
type PendingDelete = { kind: 'item'; id: string } | { kind: 'category'; cat: string; count: number }

const fieldCls = 'w-full h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500'
const iconBtn = 'h-10 w-10 sm:h-7 sm:w-7 flex items-center justify-center rounded-md transition-colors'

// Trimmed names, or null when both are empty; a missing translation falls back to the other.
function draftNames(d: Draft): { name_de: string; name_en: string } | null {
  const de = (d.name_de ?? '').trim()
  const en = (d.name_en ?? '').trim()
  if (!de && !en) return null
  return { name_de: de || en, name_en: en || de }
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
  const price = typeof d.default_price === 'number' && !isNaN(d.default_price) ? d.default_price : 0
  return (
    <div className="px-4 py-4 bg-neutral-50 dark:bg-neutral-800/60 border-t border-neutral-100 dark:border-neutral-800">
      <datalist id={CAT_DATALIST_ID}>{categories.map(c => <option key={c} value={c} />)}</datalist>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-de`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name (DE)</label>
          <input id={`${id}-de`} autoFocus={autoFocusName} value={d.name_de ?? ''} onChange={e => setD(p => ({ ...p, name_de: e.target.value }))} placeholder="Servicename…" className={fieldCls} aria-invalid={!!error || undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-en`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name (EN)</label>
          <input id={`${id}-en`} value={d.name_en ?? ''} onChange={e => setD(p => ({ ...p, name_en: e.target.value }))} placeholder="Service name…" className={fieldCls} aria-invalid={!!error || undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-price`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Default price</label>
          <MoneyInput id={`${id}-price`} value={price} onValueChange={n => setD(p => ({ ...p, default_price: n ?? 0 }))} className={fieldCls} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-unit`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Unit</label>
          <select id={`${id}-unit`} value={d.unit ?? 'flat'} onChange={e => setD(p => ({ ...p, unit: e.target.value as Unit }))} className={fieldCls}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-vat`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">VAT rate</label>
          <select id={`${id}-vat`} value={d.vat_rate ?? 20} onChange={e => setD(p => ({ ...p, vat_rate: parseInt(e.target.value) as VatRate }))} className={fieldCls}>{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-section`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Section</label>
          <input id={`${id}-section`} value={(d.category as string) ?? ''} onChange={e => setD(p => ({ ...p, category: e.target.value || null }))} list={CAT_DATALIST_ID} placeholder="e.g. Studio" className={fieldCls} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onSave} className="h-8 px-4 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">
          Save
        </button>
        <button type="button" onClick={onCancel} className="h-8 px-3 rounded-lg text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function CatalogueManager({ initialItems }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [adding, setAdding] = useState<AddingState | null>(null)
  const [addDraft, setAddDraft] = useState<Draft>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [catRenameVal, setCatRenameVal] = useState('')
  const [pendingCats, setPendingCats] = useState<string[]>([])
  const [newCatInput, setNewCatInput] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleting, setDeleting] = useState(false)
  const dragId = useRef<string | null>(null)
  const renameInFlight = useRef(false)
  const supabase = createClient()

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))) as string[]
  const allCatNames = Array.from(new Set([...categories, ...pendingCats]))
  const groupKeys: (string | null)[] = [...allCatNames, null]

  const query = search.trim().toLowerCase()
  const hiddenCount = items.filter(i => !i.active).length
  const isVisible = (i: CatalogueItem) =>
    (showHidden || i.active) &&
    (!query || [i.name_de, i.name_en, i.category ?? ''].some(s => s.toLowerCase().includes(query)))
  const anyVisible = items.some(isVisible)

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
    if (!names) { setFormError('Enter a name in at least one language.'); return }
    const payload = { ...draft, ...names, default_price: Number(draft.default_price) || 0 }
    const { error } = await supabase.from('catalogue_items').update(payload).eq('id', editingId)
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.id === editingId ? { ...i, ...payload } as CatalogueItem : i))
    setEditingId(null)
    setFormError(null)
  }

  async function deleteItem(id: string) {
    setDeleting(true)
    const { error: unlinkError } = await supabase.from('document_items').update({ catalogue_item_id: null }).eq('catalogue_item_id', id)
    if (unlinkError) { toast.error(unlinkError.message); setDeleting(false); return }
    const { error } = await supabase.from('catalogue_items').delete().eq('id', id)
    setDeleting(false)
    if (error) { toast.error(error.message); return }
    setItems(items.filter(i => i.id !== id))
    setPendingDelete(null)
    toast.success('Deleted.')
  }

  async function duplicateItem(item: CatalogueItem) {
    const payload = { name_de: item.name_de + ' (copy)', name_en: item.name_en + ' (copy)', default_price: item.default_price, unit: item.unit, vat_rate: item.vat_rate, category: item.category, sort_order: items.length * 10, active: item.active }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setItems([...items, data])
    startEdit(data)
  }

  async function addItem() {
    const names = draftNames(addDraft)
    if (!names) { setFormError('Enter a name in at least one language.'); return }
    const payload = { ...names, default_price: Number(addDraft.default_price) || 0, unit: addDraft.unit ?? 'flat', vat_rate: addDraft.vat_rate ?? 20, category: addDraft.category || null, sort_order: items.length * 10, active: true }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setItems([...items, data])
    cancelAdd()
    toast.success('Item added.')
  }

  async function toggleActive(item: CatalogueItem) {
    const { error } = await supabase.from('catalogue_items').update({ active: !item.active }).eq('id', item.id)
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.id === item.id ? { ...i, active: !item.active } : i))
  }

  async function handleDrop(targetId: string) {
    const sourceId = dragId.current
    dragId.current = null
    setDragOver(null)
    if (!sourceId || sourceId === targetId) return
    const from = items.findIndex(i => i.id === sourceId)
    const to = items.findIndex(i => i.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const withOrder = next.map((item, idx) => ({ ...item, sort_order: idx * 10 }))
    const previous = items
    setItems(withOrder)
    // One statement for the whole order, so a failure leaves the database as it was.
    const { error } = await supabase.from('catalogue_items').upsert(withOrder)
    if (error) { setItems(previous); toast.error(`Could not save the new order: ${error.message}`) }
  }

  function startRenameCat(cat: string) { setRenamingCat(cat); setCatRenameVal(cat) }
  function cancelRenameCat() { setRenamingCat(null) }

  async function saveCatRename() {
    if (!renamingCat || renameInFlight.current) return
    const newName = catRenameVal.trim()
    if (!newName) { toast.error('Section name cannot be empty.'); return }
    if (newName === renamingCat) { setRenamingCat(null); return }
    if (allCatNames.includes(newName)) { toast.error('That section already exists.'); return }
    renameInFlight.current = true
    const { error } = await supabase.from('catalogue_items').update({ category: newName }).eq('category', renamingCat)
    renameInFlight.current = false
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.category === renamingCat ? { ...i, category: newName } : i))
    setPendingCats(p => p.map(c => c === renamingCat ? newName : c))
    setRenamingCat(null)
    toast.success('Section renamed.')
  }

  async function deleteCategory(cat: string, count: number) {
    setDeleting(true)
    if (count > 0) {
      const { error } = await supabase.from('catalogue_items').update({ category: null }).eq('category', cat)
      if (error) { toast.error(error.message); setDeleting(false); return }
      setItems(items.map(i => i.category === cat ? { ...i, category: null } : i))
    }
    setDeleting(false)
    setPendingCats(p => p.filter(c => c !== cat))
    setPendingDelete(null)
    toast.success(count > 0 ? 'Section removed, items moved to Uncategorised.' : 'Section deleted.')
  }

  function confirmNewCat() {
    const name = newCatName.trim()
    if (!name) return
    if (allCatNames.includes(name)) { toast.error('That section already exists.'); return }
    setPendingCats(p => [...p, name])
    setNewCatInput(false)
    setNewCatName('')
    startAdd(name)
  }

  const deleteTitle = pendingDelete?.kind === 'item'
    ? 'Delete this item?'
    : pendingDelete && pendingDelete.count > 0
      ? `Remove section "${pendingDelete.cat}"?`
      : pendingDelete ? `Delete empty section "${pendingDelete.cat}"?` : ''
  const deleteDescription = pendingDelete?.kind === 'item'
    ? 'Lines on existing documents keep their text and price; only the catalogue entry is removed.'
    : pendingDelete && pendingDelete.count > 0
      ? `${pendingDelete.count} item${pendingDelete.count === 1 ? '' : 's'} move${pendingDelete.count === 1 ? 's' : ''} to Uncategorised.`
      : undefined

  return (
    <div className="space-y-3">

      {/* Search + hidden toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400 pointer-events-none" />
          <input
            type="search"
            aria-label="Search items"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search items…"
            className={`${fieldCls} pl-9`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 cursor-pointer select-none">
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600" />
          Show hidden{hiddenCount ? ` (${hiddenCount})` : ''}
        </label>
      </div>

      {!anyVisible && items.length > 0 && !adding && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 px-1">
          {query ? 'No items match your search.' : 'All items are hidden.'}
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
                      aria-label="Section name"
                      value={catRenameVal}
                      onChange={e => setCatRenameVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') cancelRenameCat() }}
                      className="text-base md:text-xs font-semibold uppercase tracking-widest bg-transparent border-b border-neutral-400 dark:border-neutral-500 outline-none focus:border-neutral-700 dark:focus:border-neutral-200 text-neutral-700 dark:text-neutral-200 w-40 pb-0.5"
                    />
                    <button type="submit" title="Save" aria-label="Save section name" className={`${iconBtn} text-green-600 hover:text-green-700 dark:text-green-400`}><Check size={14} /></button>
                    <button type="button" title="Cancel" aria-label="Cancel renaming" onClick={cancelRenameCat} className={`${iconBtn} text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200`}><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <span className="text-xs font-semibold tracking-widest uppercase text-neutral-500 dark:text-neutral-400">{cat}</span>
                    <span className="text-xs text-neutral-400 dark:text-neutral-600 font-medium">{group.length}</span>
                    <div className="flex items-center gap-0.5 ml-1 sm:opacity-0 sm:group-hover/header:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button type="button" onClick={() => startRenameCat(cat)} title="Rename" aria-label={`Rename section ${cat}`} className={`${iconBtn} text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200`}><Pencil size={12} /></button>
                      <button type="button" onClick={() => setPendingDelete({ kind: 'category', cat, count: items.filter(i => i.category === cat).length })} title="Delete section" aria-label={`Delete section ${cat}`} className={`${iconBtn} text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400`}><Trash2 size={12} /></button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Items */}
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800/80">
              {group.map(item => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => { dragId.current = item.id }}
                  onDragOver={e => { e.preventDefault(); setDragOver(item.id) }}
                  onDrop={() => handleDrop(item.id)}
                  onDragEnd={() => { dragId.current = null; setDragOver(null) }}
                  className={dragOver === item.id ? 'border-t-2 border-blue-400' : ''}
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
                    className={`flex items-center gap-3 px-4 py-3.5 cursor-pointer group/row transition-colors
                      ${editingId === item.id ? 'bg-neutral-50 dark:bg-neutral-800/60' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40'}
                      ${!item.active ? 'opacity-50' : ''}`}
                  >
                    {/* Drag handle */}
                    <GripVertical
                      size={15}
                      aria-hidden="true"
                      className="shrink-0 text-neutral-300 dark:text-neutral-600 group-hover/row:text-neutral-500 dark:group-hover/row:text-neutral-400 cursor-grab transition-colors"
                      onClick={e => e.stopPropagation()}
                    />

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium leading-snug ${!item.active ? 'line-through' : 'text-neutral-900 dark:text-neutral-100'}`}>
                        {item.name_de}
                      </p>
                      {item.name_en && item.name_en !== item.name_de && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5 leading-snug">{item.name_en}</p>
                      )}
                    </div>

                    {/* Price + meta */}
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-100 min-w-[72px] text-right">
                        {formatMoney(item.default_price)}
                      </span>
                      <span className="hidden sm:inline-block text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 rounded-md px-2 py-0.5 font-medium">
                        {item.unit}
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
                        <button type="button" onClick={() => duplicateItem(item)} title="Duplicate" aria-label={`Duplicate ${item.name_de}`} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700`}>
                          <Copy size={13} />
                        </button>
                        <button type="button" onClick={() => toggleActive(item)} title={item.active ? 'Hide' : 'Show'} aria-label={`${item.active ? 'Hide' : 'Show'} ${item.name_de}`} aria-pressed={!item.active} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700`}>
                          {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <button type="button" onClick={() => setPendingDelete({ kind: 'item', id: item.id })} title="Delete" aria-label={`Delete ${item.name_de}`} className={`${iconBtn} text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30`}>
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
                <span>Add item{cat ? ` to ${cat}` : ''}</span>
              </button>
            )}
          </div>
        )
      })}

      {/* New section / global controls */}
      <div className="pt-1 flex items-center gap-4">
        {newCatInput ? (
          <form onSubmit={e => { e.preventDefault(); confirmNewCat() }} className="flex items-center gap-2 flex-wrap">
            <input
              autoFocus
              aria-label="New section name"
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              placeholder="Section name…"
              className="h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-base md:text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-400 w-44"
            />
            <button type="submit" className="h-8 px-3 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">
              Create
            </button>
            <button type="button" onClick={() => { setNewCatInput(false); setNewCatName('') }} className="h-8 px-2 text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNewCatInput(true)}
            className="flex items-center gap-1.5 text-sm py-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            <Plus size={14} /> New section
          </button>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel={deleting ? 'Deleting…' : pendingDelete?.kind === 'category' && pendingDelete.count > 0 ? 'Remove section' : 'Delete'}
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
