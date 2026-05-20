'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X, Eye, EyeOff, Copy, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/utils/document'
import type { CatalogueItem, Unit, VatRate } from '@/types'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]
const SELECT_CLS = 'h-7 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-1 bg-white dark:bg-neutral-900 dark:text-neutral-100'

interface Props { initialItems: CatalogueItem[] }

interface AddingState { category: string | null }

export default function CatalogueManager({ initialItems }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CatalogueItem>>({})
  const [adding, setAdding] = useState<AddingState | null>(null)
  const [addDraft, setAddDraft] = useState<Partial<CatalogueItem>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [catRenameVal, setCatRenameVal] = useState('')
  const dragId = useRef<string | null>(null)
  const supabase = createClient()

  const [pendingCats, setPendingCats] = useState<string[]>([]) // new sections not yet saved
  const [newCatInput, setNewCatInput] = useState(false)
  const [newCatName, setNewCatName] = useState('')

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean))) as string[]

  function startEdit(item: CatalogueItem) { setEditingId(item.id); setDraft({ ...item }) }
  function cancelEdit() { setEditingId(null); setDraft({}) }

  function startAdd(category: string | null) {
    setAdding({ category })
    setAddDraft({ name_de: '', name_en: '', default_price: 0, unit: 'flat', vat_rate: 20, category: category ?? undefined })
  }

  async function saveEdit() {
    if (!editingId) return
    const { error } = await supabase.from('catalogue_items').update(draft).eq('id', editingId)
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.id === editingId ? { ...i, ...draft } as CatalogueItem : i))
    setEditingId(null)
    toast.success('Saved.')
  }

  async function deleteItem(id: string) {
    if (!confirm('Delete this item?')) return
    // Null out references in existing document line items first (FK constraint)
    await supabase.from('document_items').update({ catalogue_item_id: null }).eq('catalogue_item_id', id)
    const { error } = await supabase.from('catalogue_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems(items.filter(i => i.id !== id))
    toast.success('Deleted.')
  }

  async function duplicateItem(item: CatalogueItem) {
    const payload = {
      name_de: item.name_de + ' (copy)',
      name_en: item.name_en + ' (copy)',
      default_price: item.default_price,
      unit: item.unit,
      vat_rate: item.vat_rate,
      category: item.category,
      sort_order: items.length * 10,
      active: item.active,
    }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setItems([...items, data])
    toast.success('Duplicated.')
    startEdit(data)
  }

  async function addItem() {
    const payload = {
      name_de: addDraft.name_de || 'Neuer Eintrag',
      name_en: addDraft.name_en || 'New Item',
      default_price: addDraft.default_price ?? 0,
      unit: addDraft.unit ?? 'flat',
      vat_rate: addDraft.vat_rate ?? 20,
      category: (addDraft.category as string) || null,
      sort_order: items.length * 10,
      active: true,
    }
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
    await Promise.all(
      withOrder.map(item => supabase.from('catalogue_items').update({ sort_order: item.sort_order }).eq('id', item.id))
    )
  }

  function startRenameCat(cat: string) {
    setRenamingCat(cat)
    setCatRenameVal(cat)
  }

  async function saveCatRename() {
    if (!renamingCat) return
    const newName = catRenameVal.trim() || null
    if (newName === renamingCat) { setRenamingCat(null); return }
    const toUpdate = items.filter(i => i.category === renamingCat)
    const { error } = await Promise.all(
      toUpdate.map(i => supabase.from('catalogue_items').update({ category: newName }).eq('id', i.id))
    ).then(results => results.find(r => r.error) ?? { error: null })
    if (error) { toast.error(error.message); return }
    setItems(items.map(i => i.category === renamingCat ? { ...i, category: newName } : i))
    setRenamingCat(null)
    toast.success('Category renamed.')
  }

  async function deleteCategory(cat: string) {
    const count = items.filter(i => i.category === cat).length
    const msg = count > 0
      ? `Move ${count} item${count === 1 ? '' : 's'} from "${cat}" to Uncategorised and remove section?`
      : `Delete empty section "${cat}"?`
    if (!confirm(msg)) return
    if (count > 0) {
      const { error } = await Promise.all(
        items.filter(i => i.category === cat)
          .map(i => supabase.from('catalogue_items').update({ category: null }).eq('id', i.id))
      ).then(rs => rs.find(r => r.error) ?? { error: null })
      if (error) { toast.error(error.message); return }
      setItems(items.map(i => i.category === cat ? { ...i, category: null } : i))
    }
    setPendingCats(p => p.filter(c => c !== cat))
    toast.success(count > 0 ? 'Section removed, items moved to Uncategorised.' : 'Section deleted.')
  }

  function confirmNewCat() {
    const name = newCatName.trim()
    if (!name) return
    if (categories.includes(name) || pendingCats.includes(name)) {
      toast.error('A section with that name already exists.')
      return
    }
    setPendingCats(p => [...p, name])
    setNewCatInput(false)
    setNewCatName('')
    // Immediately open the add-item form for this new section
    startAdd(name)
  }

  // all category names for the datalist
  const catDatalistId = 'cat-options'

  // groups: named categories + any pending (empty) sections, then uncategorised
  const allCatNames = Array.from(new Set([...categories, ...pendingCats]))
  const groupKeys: (string | null)[] = [...allCatNames, null]

  return (
    <div className="space-y-6">
      <datalist id={catDatalistId}>
        {categories.map(c => <option key={c} value={c} />)}
      </datalist>

      {groupKeys.map(cat => {
        const group = items.filter(i => (i.category ?? null) === cat)
        const isPending = cat !== null && pendingCats.includes(cat)
        const isAddingHere = adding?.category === cat
        if (!group.length && !isPending && !isAddingHere) return null

        return (
          <div key={cat ?? '__none'} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">

            {/* Category header */}
            {cat !== null && (
              <div className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-100 dark:border-neutral-700 flex items-center gap-2">
                {renamingCat === cat ? (
                  <form onSubmit={e => { e.preventDefault(); saveCatRename() }} className="flex items-center gap-1.5 flex-1">
                    <input
                      autoFocus
                      value={catRenameVal}
                      onChange={e => setCatRenameVal(e.target.value)}
                      onBlur={saveCatRename}
                      className="text-xs font-semibold uppercase tracking-wide bg-transparent border-b border-neutral-400 dark:border-neutral-500 outline-none text-neutral-700 dark:text-neutral-300 w-40"
                    />
                    <button type="submit" className="text-green-600 hover:text-green-700"><Check size={12} /></button>
                    <button type="button" onClick={() => setRenamingCat(null)} className="text-neutral-400 hover:text-neutral-600"><X size={12} /></button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1.5 flex-1">
                    <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{cat}</span>
                    <button
                      onClick={() => startRenameCat(cat)}
                      className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors"
                      title="Rename section"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => deleteCategory(cat)}
                      className="text-neutral-300 dark:text-neutral-600 hover:text-red-500 transition-colors"
                      title="Delete section"
                    >
                      <Trash2 size={11} />
                    </button>
                    <span className="text-xs text-neutral-300 dark:text-neutral-600 ml-1">{group.length}</span>
                  </div>
                )}
              </div>
            )}

            {/* Mobile cards */}
            <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {group.map(item => (
                <div key={item.id} className={`${!item.active ? 'opacity-40' : ''} ${dragOver === item.id ? 'border-t-2 border-blue-400' : ''}`}>
                  {editingId === item.id ? (
                    <div className="p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className="text-xs text-neutral-400">DE</label><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-8 text-sm mt-0.5" /></div>
                        <div><label className="text-xs text-neutral-400">EN</label><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-8 text-sm mt-0.5" /></div>
                        <div><label className="text-xs text-neutral-400">Price</label><Input type="number" value={isNaN(draft.default_price as number) ? 0 : (draft.default_price ?? 0)} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} className="h-8 text-sm mt-0.5" /></div>
                        <div><label className="text-xs text-neutral-400">Category</label>
                          <Input value={draft.category ?? ''} onChange={e => setDraft(d => ({ ...d, category: e.target.value || null }))} list={catDatalistId} placeholder="e.g. Studio" className="h-8 text-sm mt-0.5" />
                        </div>
                        <div className="flex gap-2">
                          <div className="flex-1"><label className="text-xs text-neutral-400">Unit</label>
                            <select value={draft.unit ?? 'flat'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="mt-0.5 w-full h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-1.5 bg-white dark:bg-neutral-900">{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
                          </div>
                          <div className="flex-1"><label className="text-xs text-neutral-400">VAT</label>
                            <select value={draft.vat_rate ?? 20} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="mt-0.5 w-full h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-1.5 bg-white dark:bg-neutral-900">{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button onClick={saveEdit} className="flex-1 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-sm font-medium">Save</button>
                        <button onClick={cancelEdit} className="flex-1 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm text-neutral-500">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center px-3 py-3 gap-3" onClick={() => startEdit(item)}>
                      <GripVertical size={14} className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.name_de}</p>
                        <p className="text-xs text-neutral-400 dark:text-neutral-500 truncate">{item.name_en}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-medium">{formatMoney(item.default_price)}</p>
                        <p className="text-xs text-neutral-400 dark:text-neutral-500">{item.unit} · {item.vat_rate}%</p>
                      </div>
                      <button onClick={e => { e.stopPropagation(); toggleActive(item) }} className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 shrink-0">
                        {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>
                      <button onClick={e => { e.stopPropagation(); deleteItem(item.id) }} className="text-neutral-300 dark:text-neutral-600 hover:text-red-500 shrink-0">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
              <thead className="border-b border-neutral-100 dark:border-neutral-800">
                <tr>
                  <th className="w-6 px-3 py-2" />
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-44">DE</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-44">EN</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-28">Category</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-24">Price</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-20">Unit</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400 w-16">VAT</th>
                  <th className="px-3 py-2 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
                {group.map(item => (
                  <tr
                    key={item.id}
                    draggable
                    onDragStart={() => { dragId.current = item.id }}
                    onDragOver={e => { e.preventDefault(); setDragOver(item.id) }}
                    onDrop={() => handleDrop(item.id)}
                    onDragEnd={() => { dragId.current = null; setDragOver(null) }}
                    className={`${!item.active ? 'opacity-40' : ''} ${dragOver === item.id ? 'border-t-2 border-blue-400' : ''} transition-colors`}
                  >
                    <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-grab hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                      <GripVertical size={14} />
                    </td>
                    {editingId === item.id ? (
                      <>
                        <td className="px-1 py-1"><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-7 text-sm" /></td>
                        <td className="px-1 py-1"><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-7 text-sm" /></td>
                        <td className="px-1 py-1">
                          <Input
                            value={draft.category ?? ''}
                            onChange={e => setDraft(d => ({ ...d, category: e.target.value || null }))}
                            list={catDatalistId}
                            placeholder="Category…"
                            className="h-7 text-sm w-28"
                          />
                        </td>
                        <td className="px-1 py-1"><Input type="number" value={isNaN(draft.default_price as number) ? 0 : (draft.default_price ?? 0)} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} className="h-7 text-sm w-24" /></td>
                        <td className="px-1 py-1">
                          <select value={draft.unit ?? 'flat'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} className={SELECT_CLS}>{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
                        </td>
                        <td className="px-1 py-1">
                          <select value={draft.vat_rate ?? 20} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className={SELECT_CLS}>{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
                        </td>
                        <td className="px-2 py-1">
                          <div className="flex gap-1">
                            <button onClick={saveEdit} className="text-green-600 hover:text-green-700"><Check size={14} /></button>
                            <button onClick={cancelEdit} className="text-neutral-400 hover:text-neutral-600"><X size={14} /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 cursor-pointer dark:text-neutral-100" onClick={() => startEdit(item)}>{item.name_de}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.name_en}</td>
                        <td className="px-3 py-2 cursor-pointer" onClick={() => startEdit(item)}>
                          {item.category
                            ? <span className="text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded px-1.5 py-0.5">{item.category}</span>
                            : <span className="text-neutral-300 dark:text-neutral-600 text-xs">—</span>
                          }
                        </td>
                        <td className="px-3 py-2 cursor-pointer dark:text-neutral-100" onClick={() => startEdit(item)}>{formatMoney(item.default_price)}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.unit}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.vat_rate}%</td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1 items-center">
                            <button onClick={() => duplicateItem(item)} title="Duplicate" className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors"><Copy size={13} /></button>
                            <button onClick={() => toggleActive(item)} title={item.active ? 'Hide from search' : 'Show in search'} className="text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors">
                              {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                            </button>
                            <button onClick={() => deleteItem(item.id)} className="text-neutral-300 dark:text-neutral-600 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Per-category add item row */}
            {adding?.category === cat ? (
              <div className="border-t border-neutral-100 dark:border-neutral-800 px-4 py-3 bg-neutral-50 dark:bg-neutral-800/50">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
                  <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Name DE</label><Input value={addDraft.name_de ?? ''} onChange={e => setAddDraft(d => ({ ...d, name_de: e.target.value }))} className="h-8 text-sm mt-0.5" autoFocus /></div>
                  <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Name EN</label><Input value={addDraft.name_en ?? ''} onChange={e => setAddDraft(d => ({ ...d, name_en: e.target.value }))} className="h-8 text-sm mt-0.5" /></div>
                  <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Price</label><Input type="number" value={addDraft.default_price ?? 0} onChange={e => setAddDraft(d => ({ ...d, default_price: parseFloat(e.target.value) }))} className="h-8 text-sm mt-0.5" /></div>
                  <div>
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">Unit</label>
                    <select value={addDraft.unit ?? 'flat'} onChange={e => setAddDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="mt-0.5 w-full h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-2 bg-white dark:bg-neutral-900 dark:text-neutral-100">{UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
                  </div>
                  <div>
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">VAT</label>
                    <select value={addDraft.vat_rate ?? 20} onChange={e => setAddDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="mt-0.5 w-full h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-2 bg-white dark:bg-neutral-900 dark:text-neutral-100">{VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</select>
                  </div>
                  <div>
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">Category</label>
                    <Input value={(addDraft.category as string) ?? ''} onChange={e => setAddDraft(d => ({ ...d, category: e.target.value || null }))} list={catDatalistId} placeholder={cat ?? 'e.g. Studio'} className="h-8 text-sm mt-0.5" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={addItem}>Add item</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAdding(null); setAddDraft({}) }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="border-t border-neutral-100 dark:border-neutral-800 px-3 py-2">
                <button
                  onClick={() => startAdd(cat)}
                  className="flex items-center gap-1 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                >
                  <Plus size={12} /> Add item{cat ? ` to ${cat}` : ''}
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* New section */}
      {newCatInput ? (
        <form
          onSubmit={e => { e.preventDefault(); confirmNewCat() }}
          className="flex items-center gap-2"
        >
          <input
            autoFocus
            value={newCatName}
            onChange={e => setNewCatName(e.target.value)}
            placeholder="Section name…"
            className="text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 outline-none focus:ring-1 focus:ring-neutral-400 w-48"
          />
          <Button type="submit" size="sm">Create</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setNewCatInput(false); setNewCatName('') }}>Cancel</Button>
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
  )
}
