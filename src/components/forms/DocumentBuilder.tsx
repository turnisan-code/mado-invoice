'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { calcTotals, formatMoney, addDays, today } from '@/lib/utils/document'
import { pdf } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import type { Client, CatalogueItem, Document, DocumentItem, Settings, DocumentType, Language, TaxTreatment, Currency, Unit, VatRate, LineType } from '@/types'

interface LineItem {
  id: string
  line_type: LineType
  description: string
  service_date: string | null
  quantity: number
  unit: Unit
  unit_price: number
  vat_rate: VatRate
  catalogue_item_id: string | null
}

interface Props {
  type: DocumentType
  settings: Settings
  clients: Client[]
  catalogue: CatalogueItem[]
  document?: Document & { items?: DocumentItem[]; payments?: { id: string; date: string; amount: number; note: string | null }[] }
  defaultClientId?: string
}

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]

function makeId() { return Math.random().toString(36).slice(2) }

function blankLine(): LineItem {
  return { id: makeId(), line_type: 'item', description: '', service_date: null, quantity: 1, unit: 'flat', unit_price: 0, vat_rate: 20, catalogue_item_id: null }
}

function blankSpecial(type: LineType): LineItem {
  return { id: makeId(), line_type: type, description: '', service_date: null, quantity: 0, unit: 'flat', unit_price: 0, vat_rate: 0, catalogue_item_id: null }
}

function calcSectionSubtotal(lines: LineItem[], upToIdx: number): number {
  let sum = 0
  for (let i = upToIdx - 1; i >= 0; i--) {
    if (lines[i].line_type === 'subtotal') break
    if (lines[i].line_type === 'item') sum += lines[i].quantity * lines[i].unit_price
  }
  return sum
}

const typeLabel: Record<DocumentType, { de: string; en: string }> = {
  invoice: { de: 'Rechnung', en: 'Invoice' },
  quote: { de: 'Angebot', en: 'Quote' },
  credit_note: { de: 'Gutschrift', en: 'Credit Note' },
}

export default function DocumentBuilder({ type, settings, clients, catalogue, document: doc, defaultClientId }: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [clientId, setClientId] = useState(doc?.client_id ?? defaultClientId ?? '')
  const [date, setDate] = useState(doc?.date ?? today())
  const [serviceDate, setServiceDate] = useState(doc?.service_date ?? '')
  const [dueDate, setDueDate] = useState(doc?.due_date ?? '')
  const [language, setLanguage] = useState<Language>(doc?.language ?? settings.default_language as Language ?? 'de')
  const [currency, setCurrency] = useState<Currency>(doc?.currency ?? 'EUR')
  const [taxTreatment, setTaxTreatment] = useState<TaxTreatment>(doc?.tax_treatment as TaxTreatment ?? 'at_vat')
  const [notes, setNotes] = useState(doc?.notes ?? '')
  const [notesInternal, setNotesInternal] = useState(doc?.notes_internal ?? '')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed' | null>(doc?.discount_type ?? null)
  const [discountValue, setDiscountValue] = useState(doc?.discount_value ?? 0)
  const [lines, setLines] = useState<LineItem[]>(
    doc?.items?.length
      ? doc.items.map(i => ({
          id: makeId(),
          line_type: (i.line_type ?? 'item') as LineType,
          description: i.description,
          service_date: i.service_date ?? null,
          quantity: i.quantity ?? 1,
          unit: (i.unit ?? 'flat') as Unit,
          unit_price: i.unit_price ?? 0,
          vat_rate: (i.vat_rate ?? 20) as VatRate,
          catalogue_item_id: i.catalogue_item_id,
        }))
      : [blankLine()]
  )
  const [saving, setSaving] = useState(false)
  const [showCatalogue, setShowCatalogue] = useState(false)
  const [activeLine, setActiveLine] = useState<string | null>(null)
  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[]>(catalogue)
  const [addingItem, setAddingItem] = useState(false)
  const [newItemDraft, setNewItemDraft] = useState({ name_de: '', name_en: '', default_price: 0, unit: 'flat' as Unit, vat_rate: 20 as VatRate, category: '' })

  const client = clients.find(c => c.id === clientId)
  const discount = discountType && discountValue > 0 ? { type: discountType, value: discountValue } : null

  function handleClientChange(id: string) {
    const c = clients.find(cl => cl.id === id)
    setClientId(id)
    if (c) {
      setLanguage(c.language)
      setCurrency(c.currency)
      setTaxTreatment(c.tax_treatment as TaxTreatment)
      if (!dueDate) setDueDate(addDays(date, c.payment_days))
    }
  }

  function updateLine(id: string, patch: Partial<LineItem>) {
    setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  function removeLine(id: string) {
    setLines(ls => ls.filter(l => l.id !== id))
  }

  function addLine(lt: LineType) {
    setShowCatalogue(false)
    setLines(ls => [...ls, lt === 'item' ? blankLine() : blankSpecial(lt)])
  }

  async function saveNewCatalogueItem(lineId: string) {
    const payload = {
      name_de: newItemDraft.name_de || newItemDraft.name_en,
      name_en: newItemDraft.name_en || newItemDraft.name_de,
      default_price: newItemDraft.default_price,
      unit: newItemDraft.unit,
      vat_rate: newItemDraft.vat_rate,
      category: newItemDraft.category || null,
      sort_order: catalogueItems.length * 10,
      active: true,
    }
    const { data, error } = await supabase.from('catalogue_items').insert(payload).select().single()
    if (error) { toast.error(error.message); return }
    setCatalogueItems(prev => [...prev, data])
    pickCatalogueItem(data, lineId)
    setAddingItem(false)
    setNewItemDraft({ name_de: '', name_en: '', default_price: 0, unit: 'flat', vat_rate: 20, category: '' })
    toast.success('Item added to catalogue.')
  }

  function pickCatalogueItem(item: CatalogueItem, lineId: string) {
    updateLine(lineId, {
      description: language === 'de' ? item.name_de : item.name_en,
      unit_price: item.default_price,
      unit: item.unit as Unit,
      vat_rate: item.vat_rate as VatRate,
      catalogue_item_id: item.id,
    })
    setShowCatalogue(false)
    setActiveLine(null)
  }

  const totals = calcTotals(
    lines.map(l => ({
      id: l.id, document_id: '', sort_order: 0, line_type: l.line_type, service_date: null,
      description: l.description, quantity: l.quantity, unit: l.unit,
      unit_price: l.unit_price, vat_rate: l.vat_rate, catalogue_item_id: l.catalogue_item_id,
    })),
    doc?.payments,
    discount
  )

  const taxNote = taxTreatment === 'eu_reverse_charge'
    ? (language === 'de' ? 'Steuerschuldnerschaft des Leistungsempfängers' : 'VAT liability transfers to the recipient (Reverse Charge)')
    : taxTreatment === 'non_eu'
    ? (language === 'de' ? 'Nicht steuerbar gem. § 3a UStG' : 'Not subject to Austrian VAT (§ 3a UStG)')
    : null

  function buildItemsPayload(docId: string) {
    return lines.map((l, i) => ({
      document_id: docId,
      sort_order: i,
      line_type: l.line_type,
      description: l.description,
      service_date: l.line_type === 'item' ? (l.service_date || null) : null,
      quantity: l.line_type === 'item' ? l.quantity : null,
      unit: l.line_type === 'item' ? l.unit : null,
      unit_price: l.line_type === 'item' ? l.unit_price : null,
      vat_rate: l.line_type === 'item' ? l.vat_rate : null,
      catalogue_item_id: l.line_type === 'item' ? l.catalogue_item_id : null,
    }))
  }

  async function save(status: 'draft' | 'sent') {
    if (!clientId) { toast.error('Select a client.'); return }
    if (!lines.some(l => l.line_type === 'item')) { toast.error('Add at least one line item.'); return }
    setSaving(true)

    const docFields = {
      client_id: clientId, date, service_date: serviceDate || null,
      due_date: dueDate || null, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, notes_internal: notesInternal || null, status,
      discount_type: discountType, discount_value: discountValue || null,
    }

    if (doc) {
      const { error } = await supabase.from('documents').update(docFields).eq('id', doc.id)
      if (error) { toast.error(error.message); setSaving(false); return }
      await supabase.from('document_items').delete().eq('document_id', doc.id)
      const { error: itemsErr } = await supabase.from('document_items').insert(buildItemsPayload(doc.id))
      if (itemsErr) { toast.error(`Items: ${itemsErr.message}`); setSaving(false); return }
      toast.success('Saved.')
      router.refresh()
    } else {
      const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })
      if (numErr) { toast.error(numErr.message); setSaving(false); return }
      const { data: newDoc, error } = await supabase.from('documents').insert({
        type, number: numData, exchange_rate: 1, ...docFields,
      }).select().single()
      if (error) { toast.error(error.message); setSaving(false); return }
      const { error: itemsErr } = await supabase.from('document_items').insert(buildItemsPayload(newDoc.id))
      if (itemsErr) { toast.error(`Items: ${itemsErr.message}`); setSaving(false); return }
      toast.success('Created.')
      router.push(`/${type === 'invoice' ? 'invoices' : type === 'quote' ? 'quotes' : 'invoices'}/${newDoc.id}`)
    }
    setSaving(false)
  }

  async function downloadPdf() {
    if (!client) { toast.error('Select a client first.'); return }
    const docData = {
      number: doc?.number ?? 'DRAFT',
      date, service_date: serviceDate || null, due_date: dueDate || null,
      type, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, tax_note: taxNote,
      discount_type: discountType, discount_value: discountValue || null,
      items: lines.map(l => ({ ...l })),
      totals,
    }
    const blob = await pdf(
      <InvoiceDocument settings={settings} client={client} document={docData} />
    ).toBlob()
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: `${docData.number}.pdf` })
    a.click()
    URL.revokeObjectURL(url)
  }

  async function openInEmail() {
    if (!client) { toast.error('Select a client first.'); return }
    const num = doc?.number ?? 'DRAFT'
    const isDE = language === 'de'
    const subject = isDE
      ? `${typeLabel[type].de} ${num} – ${settings.company_name}`
      : `${typeLabel[type].en} ${num} – ${settings.company_name}`
    const body = isDE
      ? `Guten Tag,\n\nanbei übermittle ich Ihnen ${typeLabel[type].de} ${num}.\n\nBei Fragen stehe ich Ihnen gerne zur Verfügung.\n\nMit freundlichen Grüßen\n${settings.owner_name}`
      : `Dear ${client.name},\n\nPlease find attached ${typeLabel[type].en} ${num}.\n\nDo not hesitate to contact me if you have any questions.\n\nKind regards,\n${settings.owner_name}`
    await downloadPdf()
    window.open(`mailto:${client.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
  }

  const deleteBtn = (id: string) => (
    <button type="button" onClick={() => removeLine(id)}
      className="h-9 w-8 flex items-center justify-center text-neutral-300 hover:text-red-500 transition-colors shrink-0">
      <Trash2 size={14} />
    </button>
  )

  return (
    <div className="space-y-6">
      {/* Header fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Client *</Label>
          <select value={clientId} onChange={e => handleClientChange(e.target.value)}
            className="w-full border border-neutral-200 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-neutral-400">
            <option value="">Select client…</option>
            {clients.sort((a, b) => a.name.localeCompare(b.name)).map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label>{type === 'invoice' ? 'Due date' : 'Valid until'}</Label>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="text-sm" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="space-y-1.5">
          <Label>Language</Label>
          <select value={language} onChange={e => setLanguage(e.target.value as Language)}
            className="w-full border border-neutral-200 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none">
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Currency</Label>
          <select value={currency} onChange={e => setCurrency(e.target.value as Currency)}
            className="w-full border border-neutral-200 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none">
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Tax treatment</Label>
          <select value={taxTreatment} onChange={e => setTaxTreatment(e.target.value as TaxTreatment)}
            className="w-full border border-neutral-200 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none">
            <option value="at_vat">Austrian VAT</option>
            <option value="eu_reverse_charge">Reverse Charge (EU)</option>
            <option value="non_eu">Non-EU (no VAT)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Service date</Label>
          <Input type="date" value={serviceDate} onChange={e => setServiceDate(e.target.value)} className="text-sm" />
        </div>
      </div>

      {taxNote && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          {taxNote}
        </div>
      )}

      <Separator />

      {/* Line items */}
      <div className="space-y-1.5">
        <div className="grid gap-2 text-xs font-medium text-neutral-400 px-1" style={{ gridTemplateColumns: '1fr 110px 70px 80px 90px 60px 32px' }}>
          <span>Description</span><span>Service date</span><span>Qty</span><span>Unit</span><span>Price</span><span>VAT</span><span />
        </div>

        <div className="space-y-1">
          {lines.map((line, idx) => {
            if (line.line_type === 'separator') {
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-neutral-200" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'page_break') {
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-dashed border-neutral-300" />
                  <span className="text-xs text-neutral-400 shrink-0 px-1">Page break</span>
                  <div className="flex-1 border-t border-dashed border-neutral-300" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'heading') {
              return (
                <div key={line.id} className="flex items-center gap-2">
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder="Section heading…"
                    className="flex-1 text-sm font-semibold bg-transparent border-0 border-b border-neutral-200 px-1 py-1.5 focus:outline-none focus:border-neutral-400"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'text') {
              return (
                <div key={line.id} className="flex items-center gap-2">
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder="Note…"
                    className="flex-1 text-sm text-neutral-500 bg-transparent border-0 border-b border-neutral-100 px-1 py-1.5 focus:outline-none focus:border-neutral-300"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'subtotal') {
              const amount = calcSectionSubtotal(lines, idx)
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <div className="flex-1 flex justify-end items-center gap-3 pr-1">
                    <span className="text-xs text-neutral-400 uppercase tracking-wide">Subtotal</span>
                    <span className="text-sm font-medium">{formatMoney(amount, currency)}</span>
                  </div>
                  {deleteBtn(line.id)}
                </div>
              )
            }

            // item
            return (
              <div key={line.id} className="grid gap-2 items-start" style={{ gridTemplateColumns: '1fr 110px 70px 80px 90px 60px 32px' }}>
                <div className="relative">
                  <Input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder="Description…"
                    className="text-sm"
                    onFocus={() => { setActiveLine(line.id); setShowCatalogue(true) }}
                  />
                  {showCatalogue && activeLine === line.id && (
                    <div className="absolute top-full left-0 z-20 mt-1 w-96 bg-white border border-neutral-200 rounded-lg shadow-lg max-h-72 overflow-auto">
                      {catalogueItems.filter(i => i.active).map(item => (
                        <button key={item.id} type="button"
                          className="w-full text-left px-3 py-2 hover:bg-neutral-50 text-sm flex justify-between items-center"
                          onMouseDown={() => pickCatalogueItem(item, line.id)}>
                          <span>{language === 'de' ? item.name_de : item.name_en}</span>
                          <span className="text-xs text-neutral-400">{formatMoney(item.default_price)}/{item.unit}</span>
                        </button>
                      ))}
                      <div className="border-t border-neutral-100">
                        {addingItem ? (
                          <div className="p-3 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <input value={newItemDraft.name_de} onChange={e => setNewItemDraft(d => ({ ...d, name_de: e.target.value }))} placeholder="Name DE" className="text-xs border border-neutral-200 rounded px-2 py-1 w-full" />
                              <input value={newItemDraft.name_en} onChange={e => setNewItemDraft(d => ({ ...d, name_en: e.target.value }))} placeholder="Name EN" className="text-xs border border-neutral-200 rounded px-2 py-1 w-full" />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              <input type="number" value={newItemDraft.default_price} onChange={e => setNewItemDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} placeholder="Price" className="text-xs border border-neutral-200 rounded px-2 py-1 w-full" />
                              <select value={newItemDraft.unit} onChange={e => setNewItemDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="text-xs border border-neutral-200 rounded px-1 py-1 bg-white">
                                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                              </select>
                              <select value={newItemDraft.vat_rate} onChange={e => setNewItemDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="text-xs border border-neutral-200 rounded px-1 py-1 bg-white">
                                {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                              </select>
                            </div>
                            <input value={newItemDraft.category} onChange={e => setNewItemDraft(d => ({ ...d, category: e.target.value }))} placeholder="Category (optional)" className="text-xs border border-neutral-200 rounded px-2 py-1 w-full" />
                            <div className="flex gap-2">
                              <button type="button" onMouseDown={() => saveNewCatalogueItem(line.id)} className="text-xs px-2 py-1 bg-neutral-900 text-white rounded hover:bg-neutral-700">Add & use</button>
                              <button type="button" onMouseDown={() => setAddingItem(false)} className="text-xs px-2 py-1 border border-neutral-200 rounded hover:bg-neutral-50">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" onMouseDown={() => setAddingItem(true)} className="w-full text-left px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-50 flex items-center gap-1.5">
                            <Plus size={12} /> New catalogue item…
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <Input type="date" value={line.service_date ?? ''}
                  onChange={e => updateLine(line.id, { service_date: e.target.value || null })}
                  className="text-sm" />
                <Input type="number" value={line.quantity} min={0} step={0.25}
                  onChange={e => updateLine(line.id, { quantity: parseFloat(e.target.value) || 0 })}
                  className="text-sm" />
                <select value={line.unit} onChange={e => updateLine(line.id, { unit: e.target.value as Unit })}
                  className="h-9 border border-neutral-200 rounded-md px-2 text-sm bg-white focus:outline-none">
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <Input type="number" value={line.unit_price} min={0} step={0.01}
                  onChange={e => updateLine(line.id, { unit_price: parseFloat(e.target.value) || 0 })}
                  className="text-sm" />
                <select value={line.vat_rate}
                  onChange={e => updateLine(line.id, { vat_rate: parseInt(e.target.value) as VatRate })}
                  className="h-9 border border-neutral-200 rounded-md px-2 text-sm bg-white focus:outline-none">
                  {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
                {deleteBtn(line.id)}
              </div>
            )
          })}
        </div>

        {/* Add row controls */}
        <div className="flex items-center gap-3 pt-1 flex-wrap">
          <button type="button" onClick={() => addLine('item')}
            className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-700 transition-colors">
            <Plus size={14} /> Add line
          </button>
          <span className="text-neutral-200 text-xs">|</span>
          {(['heading', 'text', 'separator', 'subtotal', 'page_break'] as LineType[]).map(lt => (
            <button key={lt} type="button" onClick={() => addLine(lt)}
              className="text-xs text-neutral-400 hover:text-neutral-600 transition-colors">
              {lt === 'heading' ? 'Heading' : lt === 'text' ? 'Note' : lt === 'separator' ? 'Divider' : lt === 'subtotal' ? 'Subtotal' : 'Page break'}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      {/* Totals + discount */}
      <div className="flex justify-end">
        <div className="w-72 space-y-1.5 text-sm">
          <div className="flex justify-between text-neutral-500">
            <span>{language === 'de' ? 'Netto' : 'Subtotal'}</span>
            <span>{formatMoney(totals.subtotal, currency)}</span>
          </div>

          {/* Discount */}
          {discountType ? (
            <div className="flex items-center justify-between gap-2 text-neutral-500">
              <div className="flex items-center gap-1.5">
                <span>{language === 'de' ? 'Rabatt' : 'Discount'}</span>
                <select value={discountType} onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}
                  className="text-xs border border-neutral-200 rounded px-1 py-0.5 bg-white focus:outline-none">
                  <option value="percent">%</option>
                  <option value="fixed">{currency}</option>
                </select>
                <input type="number" value={discountValue} min={0} step={discountType === 'percent' ? 1 : 0.01}
                  onChange={e => setDiscountValue(parseFloat(e.target.value) || 0)}
                  className="w-16 text-xs border border-neutral-200 rounded px-1.5 py-0.5 focus:outline-none" />
                <button type="button" onClick={() => { setDiscountType(null); setDiscountValue(0) }}
                  className="text-neutral-300 hover:text-neutral-500"><X size={12} /></button>
              </div>
              <span>−{formatMoney(totals.discount_amount, currency)}</span>
            </div>
          ) : (
            <button type="button" onClick={() => setDiscountType('percent')}
              className="text-xs text-neutral-400 hover:text-neutral-600 transition-colors">
              + {language === 'de' ? 'Rabatt hinzufügen' : 'Add discount'}
            </button>
          )}

          {totals.vat_groups.map(g => (
            <div key={g.rate} className="flex justify-between text-neutral-500">
              <span>USt. {g.rate}%</span>
              <span>{formatMoney(g.amount, currency)}</span>
            </div>
          ))}
          <Separator />
          <div className="flex justify-between font-semibold text-base">
            <span>{language === 'de' ? 'Gesamt' : 'Total'}</span>
            <span>{formatMoney(totals.total, currency)}</span>
          </div>
          {totals.total_paid > 0 && (
            <>
              <div className="flex justify-between text-neutral-500">
                <span>{language === 'de' ? 'Bezahlt' : 'Paid'}</span>
                <span>−{formatMoney(totals.total_paid, currency)}</span>
              </div>
              <div className="flex justify-between font-semibold text-green-700">
                <span>{language === 'de' ? 'Offen' : 'Balance due'}</span>
                <span>{formatMoney(totals.balance_due, currency)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>{language === 'de' ? 'Anmerkungen (auf Dokument)' : 'Notes (on document)'}</Label>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="resize-none text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label>Internal notes</Label>
          <Textarea value={notesInternal} onChange={e => setNotesInternal(e.target.value)} rows={3} className="resize-none text-sm" placeholder="Not printed on PDF…" />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button type="button" variant="outline" onClick={downloadPdf} className="flex items-center gap-1.5">
          <Download size={14} /> PDF preview
        </Button>
        <Button type="button" variant="outline" onClick={openInEmail} className="flex items-center gap-1.5">
          Open in email
        </Button>
        <div className="flex-1" />
        <Button type="button" variant="ghost" onClick={() => save('draft')} disabled={saving}>
          Save draft
        </Button>
        <Button type="button" onClick={() => save('sent')} disabled={saving}>
          {saving ? 'Saving…' : 'Mark as sent'}
        </Button>
      </div>
    </div>
  )
}
