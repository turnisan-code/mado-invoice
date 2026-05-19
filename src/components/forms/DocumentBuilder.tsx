'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, Download, X, GripVertical, Calendar, Mail } from 'lucide-react'
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
  const [activeDateLine, setActiveDateLine] = useState<string | null>(null)
  const [showSentConfirm, setShowSentConfirm] = useState(false)
  const [gmailPreview, setGmailPreview] = useState<{ to: string; subject: string; body: string; pdfBase64: string; filename: string } | null>(null)
  const [gmailSending, setGmailSending] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)
  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[]>(catalogue)
  const [addingItem, setAddingItem] = useState(false)
  const [newItemDraft, setNewItemDraft] = useState({ name_de: '', name_en: '', default_price: 0, unit: 'flat' as Unit, vat_rate: 20 as VatRate, category: '' })
  const [dragOver, setDragOver] = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function handleDragStart(idx: number) { dragIdx.current = idx }
  function handleDragOver(e: React.DragEvent, idx: number) { e.preventDefault(); setDragOver(idx) }
  function handleDrop(idx: number) {
    if (dragIdx.current === null || dragIdx.current === idx) { setDragOver(null); return }
    const next = [...lines]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(idx, 0, moved)
    setLines(next)
    dragIdx.current = null
    setDragOver(null)
  }
  function handleDragEnd() { dragIdx.current = null; setDragOver(null) }

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

    const basePath = type === 'invoice' ? 'invoices' : type === 'quote' ? 'quotes' : 'invoices'

    const docFields = {
      client_id: clientId, date, service_date: serviceDate || null,
      due_date: dueDate || null, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, notes_internal: notesInternal || null, status,
      discount_type: discountType, discount_value: discountValue || null,
    }

    if (doc) {
      // Existing doc: assign number only when first marking as sent
      let numberUpdate: { number?: string } = {}
      if (status === 'sent' && !doc.number) {
        const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })
        if (numErr) { toast.error(numErr.message); setSaving(false); return }
        numberUpdate = { number: numData }
      }
      const { error } = await supabase.from('documents').update({ ...docFields, ...numberUpdate }).eq('id', doc.id)
      if (error) { toast.error(error.message); setSaving(false); return }
      await supabase.from('document_items').delete().eq('document_id', doc.id)
      const { error: itemsErr } = await supabase.from('document_items').insert(buildItemsPayload(doc.id))
      if (itemsErr) { toast.error(`Items: ${itemsErr.message}`); setSaving(false); return }
      toast.success(status === 'sent' && !doc.number ? 'Issued & saved.' : 'Saved.')
      router.refresh()
    } else {
      // New doc: only get a number if sending immediately
      let number: string | null = null
      if (status === 'sent') {
        const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })
        if (numErr) { toast.error(numErr.message); setSaving(false); return }
        number = numData
      }
      const { data: newDoc, error } = await supabase.from('documents').insert({
        type, number, exchange_rate: 1, ...docFields,
      }).select().single()
      if (error) { toast.error(error.message); setSaving(false); return }
      const { error: itemsErr } = await supabase.from('document_items').insert(buildItemsPayload(newDoc.id))
      if (itemsErr) { toast.error(`Items: ${itemsErr.message}`); setSaving(false); return }
      toast.success(status === 'draft' ? 'Draft saved.' : 'Created.')
      router.push(`/${basePath}/${newDoc.id}`)
    }
    setSaving(false)
  }

  async function buildPdfBlob() {
    if (!client) { toast.error('Select a client first.'); return null }
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
    return { blob, number: docData.number }
  }

  async function downloadPdf() {
    const result = await buildPdfBlob()
    if (!result) return
    const url = URL.createObjectURL(result.blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  function buildEmailContent() {
    if (!client) return null
    const num = doc?.number ?? 'DRAFT'
    const lang = language as 'de' | 'en'
    const typeKey = type === 'credit_note' ? 'credit_note' : type

    const vars: Record<string, string> = {
      invoice_number: num,
      client: client.company ?? client.name,
      total: formatMoney(totals.total, currency),
      due_date: dueDate ?? '',
      date,
      company: settings.company_name,
      owner: settings.owner_name,
    }
    function sub(tpl: string) {
      return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
    }

    const subjectKey = `email_subject_${typeKey}_${lang}` as keyof typeof settings
    const bodyKey    = `email_body_${typeKey}_${lang}`    as keyof typeof settings

    const defaultSubject = lang === 'de'
      ? `${typeLabel[type].de} ${num} – ${settings.company_name}`
      : `${typeLabel[type].en} ${num} – ${settings.company_name}`
    const defaultBody = lang === 'de'
      ? `Guten Tag,\n\nanbei übermittle ich Ihnen ${typeLabel[type].de} ${num}.\n\nBei Fragen stehe ich Ihnen gerne zur Verfügung.\n\nMit freundlichen Grüßen\n${settings.owner_name}`
      : `Dear ${client.name},\n\nPlease find attached ${typeLabel[type].en} ${num}.\n\nDo not hesitate to contact me if you have any questions.\n\nKind regards,\n${settings.owner_name}`

    const subject = settings[subjectKey] ? sub(settings[subjectKey] as string) : defaultSubject
    const body    = settings[bodyKey]    ? sub(settings[bodyKey]    as string) : defaultBody

    return { subject, body, num }
  }

  async function openInEmail() {
    if (!client) { toast.error('Select a client first.'); return }
    const content = buildEmailContent()
    if (!content) return
    const mailLink = Object.assign(document.createElement('a'), {
      href: `mailto:${client.email}?subject=${encodeURIComponent(content.subject)}&body=${encodeURIComponent(content.body)}`
    })
    mailLink.click()
    await downloadPdf()
  }

  async function sendViaGmail() {
    if (!client) { toast.error('Select a client first.'); return }
    if (!client.email) { toast.error('Client has no email address.'); return }
    const content = buildEmailContent()
    if (!content) return
    const pdfResult = await buildPdfBlob()
    if (!pdfResult) return

    const reader = new FileReader()
    const pdfBase64 = await new Promise<string>((resolve) => {
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.readAsDataURL(pdfResult.blob)
    })

    setGmailPreview({ to: client.email, subject: content.subject, body: content.body, pdfBase64, filename: `${content.num}.pdf` })
  }

  async function confirmSendViaGmail() {
    if (!gmailPreview) return
    setGmailSending(true)
    const res = await fetch('/api/gmail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gmailPreview),
    })
    setGmailSending(false)
    setGmailPreview(null)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? 'Failed to send email.')
      return
    }

    toast.success('Email sent via Gmail.')
    if (doc?.status === 'draft') requestSent()
  }

  function requestSent() {
    if (!clientId) { toast.error('Select a client.'); return }
    if (!lines.some(l => l.line_type === 'item')) { toast.error('Add at least one line item.'); return }
    setShowSentConfirm(true)
  }

  const autoSave = useCallback(async () => {
    if (!doc || !clientId || saving) return
    setAutoSaving(true)
    const { error } = await supabase.from('documents').update({
      client_id: clientId, date, service_date: serviceDate || null,
      due_date: dueDate || null, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, notes_internal: notesInternal || null,
      discount_type: discountType, discount_value: discountValue || null,
    }).eq('id', doc.id)
    if (!error) {
      await supabase.from('document_items').delete().eq('document_id', doc.id)
      await supabase.from('document_items').insert(buildItemsPayload(doc.id))
      setLastSaved(new Date())
    }
    setAutoSaving(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, clientId, date, serviceDate, dueDate, language, currency, taxTreatment, notes, notesInternal, discountType, discountValue, lines, saving])

  useEffect(() => {
    if (!doc) return
    if (isFirstRender.current) { isFirstRender.current = false; return }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(autoSave, 2000)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [autoSave, doc])

  const deleteBtn = (id: string) => (
    <button type="button" onClick={() => removeLine(id)}
      className="h-9 w-8 flex items-center justify-center text-neutral-300 hover:text-red-500 transition-colors shrink-0">
      <Trash2 size={14} />
    </button>
  )

  return (
    <div className="space-y-6">
      {/* Gmail send preview */}
      {gmailPreview && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xl p-6 w-full max-w-lg space-y-4">
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">Review email</h3>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">To</label>
                <input
                  value={gmailPreview.to}
                  onChange={e => setGmailPreview(p => p ? { ...p, to: e.target.value } : p)}
                  className="w-full text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Subject</label>
                <input
                  value={gmailPreview.subject}
                  onChange={e => setGmailPreview(p => p ? { ...p, subject: e.target.value } : p)}
                  className="w-full text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Body</label>
                <textarea
                  value={gmailPreview.body}
                  onChange={e => setGmailPreview(p => p ? { ...p, body: e.target.value } : p)}
                  rows={7}
                  className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 resize-none"
                />
              </div>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">PDF attached: {gmailPreview.filename}</p>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setGmailPreview(null)} disabled={gmailSending}>Cancel</Button>
              <Button type="button" onClick={confirmSendViaGmail} disabled={gmailSending}>
                {gmailSending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Mark as sent confirmation */}
      {showSentConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xl p-6 max-w-sm w-full space-y-4">
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">Mark as sent?</h3>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {!doc?.number
                ? `This will issue a new ${type} number and mark it as sent. This cannot be undone.`
                : `This will mark ${type} ${doc.number} as sent.`}
            </p>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setShowSentConfirm(false)}>Cancel</Button>
              <Button type="button" onClick={() => { setShowSentConfirm(false); save('sent') }}>Confirm</Button>
            </div>
          </div>
        </div>
      )}

      {/* Client & dates */}
      <div>
        <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-3">Client & Dates</p>
        <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Client *</Label>
          <select value={clientId} onChange={e => handleClientChange(e.target.value)}
            className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400">
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

        <div className="grid grid-cols-4 gap-3 mt-4">
          <div className="space-y-1.5">
            <Label>Language</Label>
          <select value={language} onChange={e => setLanguage(e.target.value as Language)}
            className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Currency</Label>
          <select value={currency} onChange={e => setCurrency(e.target.value as Currency)}
            className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Tax treatment</Label>
          <select value={taxTreatment} onChange={e => setTaxTreatment(e.target.value as TaxTreatment)}
            className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
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
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mt-3">
          {taxNote}
        </div>
      )}
      </div>{/* end Client & Dates */}

      <Separator />

      {/* Line items */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-3">Line Items</p>
        <div className="grid gap-2 text-xs font-medium text-neutral-400 dark:text-neutral-500 px-1" style={{ gridTemplateColumns: '16px 1fr 70px 80px 90px 60px 24px 32px' }}>
          <span /><span>Description</span><span>Qty</span><span>Unit</span><span>Price</span><span>VAT</span><span /><span />
        </div>

        <div className="space-y-1">
          {lines.map((line, idx) => {
            const dragProps = {
              draggable: true,
              onDragStart: () => handleDragStart(idx),
              onDragOver: (e: React.DragEvent) => handleDragOver(e, idx),
              onDrop: () => handleDrop(idx),
              onDragEnd: handleDragEnd,
            }
            const dragOverClass = dragOver === idx ? 'border-t-2 border-blue-400' : ''
            const handle = (
              <GripVertical size={14} className="text-neutral-300 cursor-grab shrink-0 mt-2.5" />
            )

            if (line.line_type === 'separator') {
              return (
                <div key={line.id} {...dragProps} className={`flex items-center gap-2 py-1 ${dragOverClass}`}>
                  {handle}
                  <div className="flex-1 border-t border-neutral-200 dark:border-neutral-700" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'page_break') {
              return (
                <div key={line.id} {...dragProps} className={`flex items-center gap-2 py-1 ${dragOverClass}`}>
                  {handle}
                  <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
                  <span className="text-xs text-neutral-400 dark:text-neutral-500 shrink-0 px-1">Page break</span>
                  <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'heading') {
              return (
                <div key={line.id} {...dragProps} className={`flex items-center gap-2 ${dragOverClass}`}>
                  {handle}
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder="Section heading…"
                    className="flex-1 text-sm font-semibold bg-transparent border-0 border-b border-neutral-200 dark:border-neutral-700 px-1 py-1.5 focus:outline-none focus:border-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'text') {
              return (
                <div key={line.id} {...dragProps} className={`flex items-center gap-2 ${dragOverClass}`}>
                  {handle}
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder="Note…"
                    className="flex-1 text-sm text-neutral-500 dark:text-neutral-400 bg-transparent border-0 border-b border-neutral-100 dark:border-neutral-800 px-1 py-1.5 focus:outline-none focus:border-neutral-300 dark:placeholder:text-neutral-600"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'subtotal') {
              const amount = calcSectionSubtotal(lines, idx)
              return (
                <div key={line.id} {...dragProps} className={`flex items-center gap-2 py-1 ${dragOverClass}`}>
                  {handle}
                  <div className="flex-1 flex justify-end items-center gap-3 pr-1">
                    <span className="text-xs text-neutral-400 dark:text-neutral-500 uppercase tracking-wide">Subtotal</span>
                    <span className="text-sm font-medium">{formatMoney(amount, currency)}</span>
                  </div>
                  {deleteBtn(line.id)}
                </div>
              )
            }

            // item
            return (
              <div key={line.id} className={dragOverClass}>
                <div {...dragProps} className="grid gap-2 items-start" style={{ gridTemplateColumns: '16px 1fr 70px 80px 90px 60px 24px 32px' }}>
                  {handle}
                  <div className="relative">
                    <Input
                      value={line.description}
                      onChange={e => updateLine(line.id, { description: e.target.value })}
                      placeholder="Description…"
                      className="text-sm"
                      onFocus={() => { setActiveLine(line.id); setShowCatalogue(true) }}
                    />
                    {showCatalogue && activeLine === line.id && (
                      <div className="absolute top-full left-0 z-20 mt-1 w-96 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg max-h-72 overflow-auto">
                        {catalogueItems.filter(i => i.active).map(item => (
                          <button key={item.id} type="button"
                            className="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-sm flex justify-between items-center"
                            onMouseDown={() => pickCatalogueItem(item, line.id)}>
                            <span>{language === 'de' ? item.name_de : item.name_en}</span>
                            <span className="text-xs text-neutral-400 dark:text-neutral-500">{formatMoney(item.default_price)}/{item.unit}</span>
                          </button>
                        ))}
                        <div className="border-t border-neutral-100 dark:border-neutral-800">
                          {addingItem ? (
                            <div className="p-3 space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <input value={newItemDraft.name_de} onChange={e => setNewItemDraft(d => ({ ...d, name_de: e.target.value }))} placeholder="Name DE" className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100" />
                                <input value={newItemDraft.name_en} onChange={e => setNewItemDraft(d => ({ ...d, name_en: e.target.value }))} placeholder="Name EN" className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100" />
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                <input type="number" value={newItemDraft.default_price} onChange={e => setNewItemDraft(d => ({ ...d, default_price: parseFloat(e.target.value) || 0 }))} placeholder="Price" className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100" />
                                <select value={newItemDraft.unit} onChange={e => setNewItemDraft(d => ({ ...d, unit: e.target.value as Unit }))} className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-1 py-1 bg-white dark:bg-neutral-900 dark:text-neutral-100">
                                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                                </select>
                                <select value={newItemDraft.vat_rate} onChange={e => setNewItemDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-1 py-1 bg-white dark:bg-neutral-900 dark:text-neutral-100">
                                  {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                                </select>
                              </div>
                              <input value={newItemDraft.category} onChange={e => setNewItemDraft(d => ({ ...d, category: e.target.value }))} placeholder="Category (optional)" className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100" />
                              <div className="flex gap-2">
                                <button type="button" onMouseDown={() => saveNewCatalogueItem(line.id)} className="text-xs px-2 py-1 bg-neutral-900 text-white rounded hover:bg-neutral-700">Add & use</button>
                                <button type="button" onMouseDown={() => setAddingItem(false)} className="text-xs px-2 py-1 border border-neutral-200 dark:border-neutral-700 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" onMouseDown={() => setAddingItem(true)} className="w-full text-left px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center gap-1.5">
                              <Plus size={12} /> New catalogue item…
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <Input type="number" value={line.quantity} min={0} step={0.25}
                    onChange={e => updateLine(line.id, { quantity: parseFloat(e.target.value) || 0 })}
                    className="text-sm" />
                  <select value={line.unit} onChange={e => updateLine(line.id, { unit: e.target.value as Unit })}
                    className="h-9 border border-neutral-200 dark:border-neutral-700 rounded-md px-2 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <Input type="number" value={line.unit_price} min={0} step={0.01}
                    onChange={e => updateLine(line.id, { unit_price: parseFloat(e.target.value) || 0 })}
                    className="text-sm" />
                  <select value={line.vat_rate}
                    onChange={e => updateLine(line.id, { vat_rate: parseInt(e.target.value) as VatRate })}
                    className="h-9 border border-neutral-200 dark:border-neutral-700 rounded-md px-2 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
                    {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => setActiveDateLine(activeDateLine === line.id ? null : line.id)}
                    title={line.service_date ?? 'Set service date'}
                    className={`h-9 w-6 flex items-center justify-center transition-colors ${line.service_date ? 'text-blue-500' : 'text-neutral-300 hover:text-neutral-500'}`}
                  >
                    <Calendar size={13} />
                  </button>
                  {deleteBtn(line.id)}
                </div>
                {(activeDateLine === line.id || line.service_date) && (
                  <div className="ml-6 mt-1 flex items-center gap-2">
                    <Input type="date" value={line.service_date ?? ''}
                      onChange={e => updateLine(line.id, { service_date: e.target.value || null })}
                      className="text-xs w-40" />
                    {line.service_date && (
                      <button type="button" onClick={() => { updateLine(line.id, { service_date: null }); setActiveDateLine(null) }}
                        className="text-neutral-300 hover:text-neutral-500"><X size={12} /></button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Add row controls */}
        <div className="flex items-center gap-2 pt-2 flex-wrap">
          <button type="button" onClick={() => addLine('item')}
            className="flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            <Plus size={13} /> Add line
          </button>
          <div className="flex items-center gap-1">
            {([['heading', 'H'], ['text', 'T'], ['separator', '—'], ['subtotal', '∑'], ['page_break', '⋯']] as [LineType, string][]).map(([lt, icon]) => (
              <button key={lt} type="button" onClick={() => addLine(lt)}
                title={lt === 'heading' ? 'Heading' : lt === 'text' ? 'Note' : lt === 'separator' ? 'Divider' : lt === 'subtotal' ? 'Subtotal' : 'Page break'}
                className="w-7 h-7 flex items-center justify-center rounded border border-neutral-200 dark:border-neutral-700 text-xs text-neutral-400 dark:text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Separator />

      {/* Totals + discount */}
      <div className="flex justify-end">
        <div className="w-72 space-y-1.5 text-sm">
          <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
            <span>{language === 'de' ? 'Netto' : 'Subtotal'}</span>
            <span>{formatMoney(totals.subtotal, currency)}</span>
          </div>

          {/* Discount */}
          {discountType ? (
            <div className="flex items-center justify-between gap-2 text-neutral-500 dark:text-neutral-400">
              <div className="flex items-center gap-1.5">
                <span>{language === 'de' ? 'Rabatt' : 'Discount'}</span>
                <select value={discountType} onChange={e => setDiscountType(e.target.value as 'percent' | 'fixed')}
                  className="text-xs border border-neutral-200 dark:border-neutral-700 rounded px-1 py-0.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none">
                  <option value="percent">%</option>
                  <option value="fixed">{currency}</option>
                </select>
                <input type="number" value={discountValue} min={0} step={discountType === 'percent' ? 1 : 0.01}
                  onChange={e => setDiscountValue(parseFloat(e.target.value) || 0)}
                  className="w-16 text-xs border border-neutral-200 dark:border-neutral-700 rounded px-1.5 py-0.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none" />
                <button type="button" onClick={() => { setDiscountType(null); setDiscountValue(0) }}
                  className="text-neutral-300 hover:text-neutral-500"><X size={12} /></button>
              </div>
              <span>−{formatMoney(totals.discount_amount, currency)}</span>
            </div>
          ) : (
            <button type="button" onClick={() => setDiscountType('percent')}
              className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
              + {language === 'de' ? 'Rabatt hinzufügen' : 'Add discount'}
            </button>
          )}

          {totals.vat_groups.map(g => (
            <div key={g.rate} className="flex justify-between text-neutral-500 dark:text-neutral-400">
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
              <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
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
      <div>
        <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-3">Notes</p>
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
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-4 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t border-neutral-200 dark:border-neutral-700 flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={downloadPdf} className="flex items-center gap-1.5">
          <Download size={13} /> Preview PDF
        </Button>
        {settings.gmail_email ? (
          <Button type="button" variant="outline" size="sm" onClick={sendViaGmail} className="flex items-center gap-1.5">
            <Mail size={13} /> Send via Gmail
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={openInEmail} className="flex items-center gap-1.5">
            <Mail size={13} /> Send via Superhuman
          </Button>
        )}
        <div className="flex-1" />
        {doc && (
          <span className="text-xs text-neutral-400 dark:text-neutral-500 mr-1">
            {autoSaving ? 'Saving…' : lastSaved ? `Saved ${lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        )}
        {!doc && (
          <Button type="button" variant="ghost" size="sm" onClick={() => save('draft')} disabled={saving}>
            Save draft
          </Button>
        )}
        <Button type="button" size="sm" onClick={requestSent} disabled={saving}>
          {saving ? 'Saving…' : 'Mark as sent'}
        </Button>
      </div>
    </div>
  )
}
