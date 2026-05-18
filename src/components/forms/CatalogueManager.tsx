'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/utils/document'
import type { CatalogueItem, Unit, VatRate } from '@/types'

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]

interface Props { initialItems: CatalogueItem[] }

export default function CatalogueManager({ initialItems }: Props) {
  const [items, setItems] = useState<CatalogueItem[]>(initialItems)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CatalogueItem>>({})
  const [adding, setAdding] = useState(false)
  const supabase = createClient()

  function startEdit(item: CatalogueItem) {
    setEditingId(item.id)
    setDraft(item)
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

  const categories = Array.from(new Set(items.map(i => i.category).filter(Boolean)))

  return (
    <div className="space-y-6">
      {categories.concat([null]).map(cat => {
        const group = items.filter(i => (i.category ?? null) === cat)
        if (!group.length && cat !== null) return null
        return (
          <div key={cat ?? '__none'} className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
            {cat && (
              <div className="px-4 py-2.5 bg-neutral-50 border-b border-neutral-100">
                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">{cat}</span>
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-100">
                <tr>
                  <th className="w-6 px-3 py-2" />
                  <th className="text-left px-3 py-2 font-medium text-neutral-500">DE</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500">EN</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500">Price</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500">Unit</th>
                  <th className="text-left px-3 py-2 font-medium text-neutral-500">VAT</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {group.map(item => (
                  <tr key={item.id} className={`${!item.active ? 'opacity-40' : ''}`}>
                    <td className="px-3 py-2 text-neutral-300"><GripVertical size={14} /></td>
                    {editingId === item.id ? (
                      <>
                        <td className="px-1 py-1"><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-7 text-sm" /></td>
                        <td className="px-1 py-1"><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-7 text-sm" /></td>
                        <td className="px-1 py-1"><Input type="number" value={isNaN(draft.default_price as number) ? 0 : (draft.default_price ?? 0)} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} className="h-7 text-sm w-24" /></td>
                        <td className="px-1 py-1">
                          <select value={draft.unit ?? 'flat'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="h-7 text-sm border border-neutral-200 rounded px-1 bg-white">
                            {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </td>
                        <td className="px-1 py-1">
                          <select value={draft.vat_rate ?? 20} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="h-7 text-sm border border-neutral-200 rounded px-1 bg-white">
                            {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                          </select>
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
                        <td className="px-3 py-2 cursor-pointer" onClick={() => startEdit(item)}>{item.name_de}</td>
                        <td className="px-3 py-2 text-neutral-400 cursor-pointer" onClick={() => startEdit(item)}>{item.name_en}</td>
                        <td className="px-3 py-2 cursor-pointer" onClick={() => startEdit(item)}>{formatMoney(item.default_price)}</td>
                        <td className="px-3 py-2 text-neutral-400 cursor-pointer" onClick={() => startEdit(item)}>{item.unit}</td>
                        <td className="px-3 py-2 text-neutral-400 cursor-pointer" onClick={() => startEdit(item)}>{item.vat_rate}%</td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <button onClick={() => toggleActive(item)} className="text-xs text-neutral-300 hover:text-neutral-500">{item.active ? 'hide' : 'show'}</button>
                            <button onClick={() => deleteItem(item.id)} className="text-neutral-300 hover:text-red-500 ml-1"><Trash2 size={13} /></button>
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
        <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
          <p className="text-sm font-medium">New item</p>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-neutral-500">Name DE</label><Input value={draft.name_de ?? ''} onChange={e => setDraft(d => ({ ...d, name_de: e.target.value }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500">Name EN</label><Input value={draft.name_en ?? ''} onChange={e => setDraft(d => ({ ...d, name_en: e.target.value }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500">Default price (€)</label><Input type="number" value={draft.default_price ?? 0} onChange={e => setDraft(d => ({ ...d, default_price: parseFloat(e.target.value) }))} className="h-8 text-sm mt-1" /></div>
            <div><label className="text-xs text-neutral-500">Category</label><Input value={draft.category ?? ''} onChange={e => setDraft(d => ({ ...d, category: e.target.value || null }))} className="h-8 text-sm mt-1" placeholder="Studio, Recording…" /></div>
            <div>
              <label className="text-xs text-neutral-500">Unit</label>
              <select value={draft.unit ?? 'flat'} onChange={e => setDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="w-full mt-1 h-8 text-sm border border-neutral-200 rounded px-2 bg-white">
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-neutral-500">VAT rate</label>
              <select value={draft.vat_rate ?? 20} onChange={e => setDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="w-full mt-1 h-8 text-sm border border-neutral-200 rounded px-2 bg-white">
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
