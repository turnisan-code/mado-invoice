'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X, Eye, EyeOff, Copy, Pencil, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/utils/document'
import type { CatalogueItem, Unit, VatRate } from '@/types'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]

interface Props { initialItems: CatalogueItem[] }
interface AddingState { category: string | null }

const fieldCls = 'w-full h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500'

export default function CatalogueManager({ initialItems }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CatalogueItem>>({})
  const [adding, setAdding] = useState<AddingState | null>(null)
  const [addDraft, setAddDraft] = useState<Partial<CatalogueItem>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [catRenameVal, setCatRenameVal] = useState('')
  const [pendingCats, setPendingCats] = useState<string[]>([])
  const [newCatInput, setNewCatInput] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const dragId = useRef<string | null>(null)
  const supabase = createClient()

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))) as string[]
  const allCatNames = Array.from(new Set([...categories, ...pendingCats]))
  const groupKeys: (string | null)[] = [...allCatNames, null]
  const catDatalistId = 'cat-options'

  function startEdit(item: CatalogueItem) {
    setAdding(null)
    setEditingId(item.id)
    setDraft({ ...item })
  }
  function cancelEdit() { setEditingId(null); setDraft({}) }

  function startAdd(category: string | null) {
    setEditingId(null)
    setAdding({ category })
    setAddDraft({ name_de: '', name_en: '', default_price: 0, unit: 'flat', vat_rate: 20, category: category ?? undefined })
  }

  async function saveEdit() {
    if (!editingId) return
    const { error } = await supabase.from('catalogue_items').update(draft).eq('id', editingId)
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.id === editingId ? { ...i, ...draft } as CatalogueItem : i))
    setEditingId(null)
  }

  async function deleteItem(id: string) {
    if (!confirm('Delete this item?')) return
    await supabase.from('document_items').update({ catalogue_item_id: null }).eq('catalogue_item_id', id)
    const { error } = await supabase.from('catalogue_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems(items.filter(i => i.id !== id))
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
    const payload = { name_de: addDraft.name_de || 'Neuer Eintrag', name_en: addDraft.name_en || 'New Item', default_price: addDraft.default_price ?? 0, unit: addDraft.unit ?? 'flat', vat_rate: addDraft.vat_rate ?? 20, category: (addDraft.category as string) || null, sort_order: items.length * 10, active: true }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setItems([...items, data])
    setAdding(null)
    setAddDraft({})
    toast.success('Item added.')
  }

  async function toggleActive(item: CatalogueItem) {
    const { error } = await supabase.from('catalogue_items').update({ active: !item.active }).eq('id', item.id)
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.id === item.id ? { ...i, active: !item.active } : i))
  }

  async function handleDrop(targetId: string) {
    if (!dragId.current || dragId.current === targetId) { setDragOver(null); return }
    const from = items.findIndex(i => i.id === dragId.current)
    const to = items.findIndex(i => i.id === targetId)
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const withOrder = next.map((item, idx) => ({ ...item, sort_order: idx * 10 }))
    setItems(withOrder)
    dragId.current = null
    setDragOver(null)
    await Promise.all(withOrder.map(item => supabase.from('catalogue_items').update({ sort_order: item.sort_order }).eq('id', item.id)))
  }

  function startRenameCat(cat: string) { setRenamingCat(cat); setCatRenameVal(cat) }

  async function saveCatRename() {
    if (!renamingCat) return
    const newName = catRenameVal.trim() || null
    if (newName === renamingCat) { setRenamingCat(null); return }
    const toUpdate = items.filter(i => i.category === renamingCat)
    const { error } = await Promise.all(toUpdate.map(i => supabase.from('catalogue_items').update({ category: newName }).eq('id', i.id))).then(rs => rs.find(r => r.error) ?? { error: null })
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.category === renamingCat ? { ...i, category: newName } : i))
    setRenamingCat(null)
    toast.success('Section renamed.')
  }

  async function deleteCategory(cat: string) {
    const count = items.filter(i => i.category === cat).length
    const msg = count > 0 ? `Move ${count} item${count === 1 ? '' : 's'} to Uncategorised and remove "${cat}"?` : `Delete empty section "${cat}"?`
    if (!confirm(msg)) return
    if (count > 0) {
      const { error } = await Promise.all(items.filter(i => i.category === cat).map(i => supabase.from('catalogue_items').update({ category: null }).eq('id', i.id))).then(rs => rs.find(r => r.error) ?? { error: null })
      if (error) { toast.error(error.message); return }
      setItems(items.map(i => i.category === cat ? { ...i, category: null } : i))
    }
    setPendingCats(p => p.filter(c => c !== cat))
    toast.success(count > 0 ? 'Section removed, items moved to Uncategorised.' : 'Section deleted.')
  }

  function confirmNewCat() {
    const name = newCatName.trim()
    if (!name) return
    if (categories.includes(name) || pendingCats.includes(name)) { toast.error('That section already exists.'); return }
    setPendingCats(p => [...p, name])
    setNewCatInput(false)
    setNewCatName('')
    startAdd(name)
  }

  // Shared edit/add form
  function EditForm({ d, setD, onSave, onCancel, autoFocusName = true }: {
    d: Partial<CatalogueItem>
    setD: (fn: (prev: Partial<CatalogueItem>) => Partial<CatalogueItem>) => void
    onSave: () => void
    onCancel: () => void
    autoFocusName?: boolean
  }) {
    return (
      <div className="px-4 py-4 bg-neutral-50 dark:bg-neutral-800/60 border-t border-neutral-100 dark:border-neutral-800">
        <datalist id={catDatalistId}>{categories.map(c => <option key={c} value={c} />)}</datalist>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name (DE)</label>
            <input autoFocus={autoFocusName} value={d.name_de ?? ''} onChange={e => setD(p => ({ ...p, name_de: e.target.value }))} placeholder="Servicename…" className={fieldCls} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name (EN)</label>
            <input value={d.name_en ?? ''} onChange={e => setD(p => ({ ...p, name_en: e.target.value }))} placeholder="Service name…" className={fieldCls} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Default price</label>
            <input type="number" value={isNaN(d.default_price as number) ? 0 : (d.default_price ?? 0)} onChange={e => setD(p => ({ ...p, default_price: parseFloat(e.target.value) || 0 }))} className={fieldCls} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Unit</label>
            <select value={d.unit ?? 'flat'} onChange={e => setD(p => ({ ...p, unit: e.target.value as Unit }))} className={fieldCls}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">VAT rate</label>
            <select value={d.vat_rate ?? 20} onChange={e => setD(p => ({ ...p, vat_rate: parseInt(e.target.value) as VatRate }))} className={fieldCls}>{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Section</label>
            <input value={(d.category as string) ?? ''} onChange={e => setD(p => ({ ...p, category: e.target.value || null }))} list={catDatalistId} placeholder="e.g. Studio" className={fieldCls} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onSave} className="h-8 px-4 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">
            Save
          </button>
          <button onClick={onCancel} className="h-8 px-3 rounded-lg text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">

      {groupKeys.map(cat => {
        const group = items.filter(i => (i.category ?? null) === cat)
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
                      value={catRenameVal}
                      onChange={e => setCatRenameVal(e.target.value)}
                      onBlur={saveCatRename}
                      className="text-xs font-semibold uppercase tracking-widest bg-transparent border-b border-neutral-400 dark:border-neutral-500 outline-none text-neutral-700 dark:text-neutral-200 w-40 pb-0.5"
                    />
                    <button type="submit" className="text-green-500 hover:text-green-600"><Check size={13} /></button>
                    <button type="button" onClick={() => setRenamingCat(null)} className="text-neutral-400 hover:text-neutral-600"><X size={13} /></button>
                  </form>
                ) : (
                  <>
                    <span className="text-xs font-semibold tracking-widest uppercase text-neutral-400 dark:text-neutral-500">{cat}</span>
                    <span className="text-xs text-neutral-300 dark:text-neutral-700 font-medium">{group.length}</span>
                    <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover/header:opacity-100 transition-opacity">
                      <button onClick={() => startRenameCat(cat)} title="Rename" className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"><Pencil size={11} /></button>
                      <button onClick={() => deleteCategory(cat)} title="Delete section" className="p-1 rounded text-neutral-400 hover:text-red-500 transition-colors"><Trash2 size={11} /></button>
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
                    onClick={() => editingId === item.id ? cancelEdit() : startEdit(item)}
                    className={`flex items-center gap-3 px-4 py-3.5 cursor-pointer group/row transition-colors
                      ${editingId === item.id ? 'bg-neutral-50 dark:bg-neutral-800/60' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40'}
                      ${!item.active ? 'opacity-50' : ''}`}
                  >
                    {/* Drag handle */}
                    <GripVertical
                      size={15}
                      className="shrink-0 text-neutral-200 dark:text-neutral-700 group-hover/row:text-neutral-400 dark:group-hover/row:text-neutral-500 cursor-grab transition-colors"
                      onClick={e => e.stopPropagation()}
                    />

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium leading-snug ${!item.active ? 'line-through' : 'text-neutral-900 dark:text-neutral-100'}`}>
                        {item.name_de}
                      </p>
                      {item.name_en && item.name_en !== item.name_de && (
                        <p className="text-xs text-neutral-400 dark:text-neutral-500 truncate mt-0.5 leading-snug">{item.name_en}</p>
                      )}
                    </div>

                    {/* Price + meta */}
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-100 min-w-[72px] text-right">
                        {formatMoney(item.default_price)}
                      </span>
                      <span className="hidden sm:inline-block text-xs text-neutral-400 dark:text-neutral-500 bg-neutral-100 dark:bg-neutral-800 rounded-md px-2 py-0.5 font-medium">
                        {item.unit}
                      </span>
                      <span className="hidden sm:inline-block text-xs text-neutral-400 dark:text-neutral-500 w-8 text-right tabular-nums">
                        {item.vat_rate}%
                      </span>

                      {/* Actions — hidden by default, visible on row hover */}
                      <div
                        className="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity"
                        onClick={e => e.stopPropagation()}
                      >
                        <button onClick={() => duplicateItem(item)} title="Duplicate" className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors">
                          <Copy size={13} />
                        </button>
                        <button onClick={() => toggleActive(item)} title={item.active ? 'Hide' : 'Show'} className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors">
                          {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                        </button>
                        <button onClick={() => deleteItem(item.id)} title="Delete" className="p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>

                      {/* Chevron indicator */}
                      <ChevronRight
                        size={14}
                        className={`text-neutral-300 dark:text-neutral-600 transition-transform duration-150 ${editingId === item.id ? 'rotate-90' : ''}`}
                      />
                    </div>
                  </div>

                  {/* Inline edit form */}
                  {editingId === item.id && (
                    <EditForm d={draft} setD={setDraft} onSave={saveEdit} onCancel={cancelEdit} />
                  )}
                </div>
              ))}
            </div>

            {/* Add item row / form */}
            {isAddingHere ? (
              <EditForm d={addDraft} setD={setAddDraft} onSave={addItem} onCancel={() => { setAdding(null); setAddDraft({}) }} />
            ) : (
              <button
                onClick={() => startAdd(cat)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-neutral-400 dark:text-neutral-600 hover:text-neutral-600 dark:hover:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 border-t border-dashed border-neutral-200 dark:border-neutral-800 transition-colors"
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
          <form onSubmit={e => { e.preventDefault(); confirmNewCat() }} className="flex items-center gap-2">
            <input
              autoFocus
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              placeholder="Section name…"
              className="h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-400 w-44"
            />
            <button type="submit" className="h-8 px-3 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 transition-colors">
              Create
            </button>
            <button type="button" onClick={() => { setNewCatInput(false); setNewCatName('') }} className="h-8 px-2 text-sm text-neutral-400 hover:text-neutral-600 transition-colors">
              Cancel
            </button>
          </form>
        ) : (
          <button
            onClick={() => setNewCatInput(true)}
            className="flex items-center gap-1.5 text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <Plus size={14} /> New section
          </button>
        )}
      </div>
    </div>
  )
}
