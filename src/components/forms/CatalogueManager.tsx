'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/utils/document'
import type { CatalogueItem, Unit, VatRate } from '@/types'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]
const SELECT_CLS = 'h-7 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-1 bg-white dark:bg-neutral-900 dark:text-neutral-100'

interface Props { initialItems: CatalogueItem[] }

export default function CatalogueManager({ initialItems }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CatalogueItem>>({})
  const [adding, setAdding] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const dragId = useRef<string | null>(null)
  const supabase = createClient()

  function startEdit(item: CatalogueItem) { setEditingId(item.id); setDraft(item) }

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
    const { error } = await supabase.from('catalogue_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems(items.filter(i => i.id !== id))
    toast.success('Deleted.')
  }

  async function addItem() {
    const payload = {
      name_de: draft.name_de ?? 'Neuer Eintrag',
      name_en: draft.name_en ?? 'New Item',
      default_price: draft.default_price ?? 0,
      unit: draft.unit ?? 'flat',
      vat_rate: draft.vat_rate ?? 20,
      category: draft.category ?? null,
      sort_order: items.length * 10,
      active: true,
    }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setItems([...items, data])
    setAdding(false)
    setDraft({})
    setEditingId(data.id)
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
    // persist new sort_order for all items
    await Promise.all(
      withOrder.map(item => supabase.from('catalogue_items').update({ sort_order: item.sort_order }).eq('id', item.id))
    )
  }

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean)))

  return (
    <div className="space-y-6">
      {categories.concat([null]).map(cat => {
        const group = items.filter(i => (i.category ?? null) === cat)
        if (!group.length && cat !== null) return null
        return (
          <div key={cat ?? '__none'} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            {cat && (
              <div className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-100 dark:border-neutral-700">
                <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{cat}</span>
              </div>
            )}
            {/* Mobile cards */}
            <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {group.map(item => (
                <div
                  key={item.id}
                  className={`${!item.active ? 'opacity-40' : ''} ${dragOver === item.id ? 'border-t-2 border-blue-400' : ''}`}
                >
                  {editingId === item.id ? (
                    <div className="p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className="text-xs text-neutral-400">DE</label><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-8 text-sm mt-0.5" /></div>
                        <div><label className="text-xs text-neutral-400">EN</label><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-8 text-sm mt-0.5" /></div>
                        <div><label className="text-xs text-neutral-400">Price</label><Input type="number" value={isNaN(draft.default_price as number) ? 0 : (draft.default_price ?? 0)} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} className="h-8 text-sm mt-0.5" /></div>
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
                        <button onClick={() => setEditingId(null)} className="flex-1 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm text-neutral-500">Cancel</button>
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
                      <button onClick={e => { e.stopPropagation(); deleteItem(item.id) }} className="ml-1 text-neutral-300 dark:text-neutral-600 hover:text-red-500 shrink-0">
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
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400">DE</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400">EN</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400">Price</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400">Unit</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500 dark:text-neutral-400">VAT</th>
                  <th className="px-3 py-2" />
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
                            <button onClick={() => setEditingId(null)} className="text-neutral-400 hover:text-neutral-600"><X size={14} /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 cursor-pointer dark:text-neutral-100" onClick={() => startEdit(item)}>{item.name_de}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.name_en}</td>
                        <td className="px-3 py-2 cursor-pointer dark:text-neutral-100" onClick={() => startEdit(item)}>{formatMoney(item.default_price)}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.unit}</td>
                        <td className="px-3 py-2 text-neutral-400 dark:text-neutral-500 cursor-pointer" onClick={() => startEdit(item)}>{item.vat_rate}%</td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <button onClick={() => toggleActive(item)} className="text-xs text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400">{item.active ? 'hide' : 'show'}</button>
                            <button onClick={() => deleteItem(item.id)} className="text-neutral-300 dark:text-neutral-600 hover:text-red-500 ml-1"><Trash2 size={13} /></button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {adding ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 space-y-3">
          <p className="text-sm font-medium">New item</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Name DE</label><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Name EN</label><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Default price (€)</label><Input type="number" value={draft.default_price ?? 0} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500 dark:text-neutral-400">Category</label><Input value={draft.category ?? ''} onChange={e => setDraft(d => ({ ...d, category: e.target.value || null }))} className="h-8 text-sm mt-1" placeholder="Studio, Recording…" /></div>
            <div>
              <label className="text-xs text-neutral-500 dark:text-neutral-400">Unit</label>
              <select value={draft.unit ?? 'flat'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="w-full mt-1 h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-2 bg-white dark:bg-neutral-900 dark:text-neutral-100">
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-neutral-500 dark:text-neutral-400">VAT rate</label>
              <select value={draft.vat_rate ?? 20} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="w-full mt-1 h-8 text-sm border border-neutral-200 dark:border-neutral-700 rounded px-2 bg-white dark:bg-neutral-900 dark:text-neutral-100">
                {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={addItem}>Add item</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft({}) }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="flex items-center gap-1.5">
          <Plus size={14} /> Add item
        </Button>
      )}
    </div>
  )
}
