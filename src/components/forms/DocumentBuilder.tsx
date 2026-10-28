'use client'

import { useState, useRef, useEffect, useCallback, useId } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Plus, Trash2, Download, X, GripVertical, Calendar, Mail, HardDrive, Eye, ChevronRight, Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Dialog, ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { calcTotals, formatMoney, addDays, today, getTaxNote, orderItems } from '@/lib/utils/document'
import type { DocReference } from '@/lib/utils/document-reference'
import { pdf } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import { generateEpcQr } from '@/lib/utils/epc-qr'
import { catalogueLineText } from '@/lib/utils/catalogue'
import type { Client, CatalogueItem, Document, DocumentItem, DocumentType, Language, TaxTreatment, Currency, Unit, VatRate, LineType } from '@/types'
import type { PublicSettings } from '@/lib/public-settings'
import { toastApiError } from '@/lib/google/toast'
import { fetchIssuedPdf, blobToBase64, archiveErrorMessage, FLUSH_EDITS_EVENT, type FlushEditsDetail } from '@/lib/issued-pdf'
import { logEvent } from '@/lib/events'
import { useT } from '@/lib/i18n/client'
import type { DictKey, TFn } from '@/lib/i18n'

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
  discount_type: 'percent' | 'fixed' | null
  discount_value: number
}

interface Props {
  type: DocumentType
  settings: PublicSettings
  clients: Client[]
  catalogue: CatalogueItem[]
  document?: Document & { items?: DocumentItem[]; payments?: { id: string; date: string; amount: number; note: string | null }[] }
  defaultClientId?: string
  reference?: DocReference | null
}

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]

const SELECT_CLS = 'w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-2 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100'
const LINE_SELECT_CLS = 'h-9 sm:h-8 min-w-0 border border-neutral-200 dark:border-neutral-700 rounded-md px-2 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100'

function makeId() { return Math.random().toString(36).slice(2) }

function blankLine(settings: PublicSettings): LineItem {
  return { id: makeId(), line_type: 'item', description: '', service_date: null, quantity: 1, unit: settings.default_unit ?? 'flat', unit_price: 0, vat_rate: settings.default_vat_rate ?? 20, catalogue_item_id: null, discount_type: null, discount_value: 0 }
}

// Quotes carry their validity period in due_date; invoices and credit notes a payment term.
function termDays(type: DocumentType, settings: PublicSettings, client?: Client | null): number {
  if (type === 'quote') return settings.default_quote_validity_days ?? 14
  return client?.payment_days ?? settings.default_payment_days
}

function blankSpecial(type: LineType): LineItem {
  return { id: makeId(), line_type: type, description: '', service_date: null, quantity: 0, unit: 'flat', unit_price: 0, vat_rate: 0, catalogue_item_id: null, discount_type: null, discount_value: 0 }
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

const PATHS: Record<DocumentType, string> = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit-notes' }

async function postJson<T = Record<string, unknown>>(url: string, body?: object): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data as T
}

function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

function notifyDriveUpload(t: TFn, webViewLink?: string | null, existing = false) {
  toast.success(
    webViewLink
      ? <span>{t(existing ? 'archive.driveExisting' : 'builder.driveUploaded')}<a href={webViewLink} target="_blank" rel="noopener" className="underline">{t('common.open')}</a></span>
      : t(existing ? 'archive.driveExistingPlain' : 'builder.driveUploadedPlain'),
    { duration: 5000 }
  )
}

export default function DocumentBuilder({ type, settings, clients, catalogue, document: doc, defaultClientId, reference }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()

  const [clientId, setClientId] = useState(doc?.client_id ?? defaultClientId ?? '')
  const [date, setDate] = useState(doc?.date ?? today())
  const [serviceDate, setServiceDate] = useState(doc?.service_date ?? '')
  const [serviceDateEnd, setServiceDateEnd] = useState(doc?.service_date_end ?? '')
  const [dueDate, setDueDate] = useState(doc?.due_date ?? addDays(today(), termDays(type, settings)))
  const [language, setLanguage] = useState<Language>(doc?.language ?? settings.default_language as Language ?? 'de')
  const [currency, setCurrency] = useState<Currency>(doc?.currency ?? 'EUR')
  const [taxTreatment, setTaxTreatment] = useState<TaxTreatment>((doc?.tax_treatment as TaxTreatment | undefined) ?? settings.default_tax_treatment ?? 'at_vat')
  const [notes, setNotes] = useState(doc?.notes ?? '')
  const [notesInternal, setNotesInternal] = useState(doc?.notes_internal ?? '')
  const [discountType, setDiscountType] = useState<'percent' | 'fixed' | null>(doc?.discount_type ?? null)
  const [discountValue, setDiscountValue] = useState(doc?.discount_value ?? 0)
  // Skonto only exists on invoices; new ones start from the settings defaults.
  const [skontoPercent, setSkontoPercent] = useState<number | ''>(
    doc ? (doc.skonto_percent ?? '') : type === 'invoice' ? (settings.default_skonto_percent ?? '') : ''
  )
  const [skontoDays, setSkontoDays] = useState<number | ''>(
    doc ? (doc.skonto_days ?? '') : type === 'invoice' ? (settings.default_skonto_days ?? '') : ''
  )
  const [lines, setLines] = useState<LineItem[]>(
    doc?.items?.length
      ? orderItems(doc.items).map(i => ({
          id: makeId(),
          line_type: (i.line_type ?? 'item') as LineType,
          description: i.description,
          service_date: i.service_date ?? null,
          quantity: i.quantity ?? 1,
          unit: (i.unit ?? 'flat') as Unit,
          unit_price: i.unit_price ?? 0,
          vat_rate: (i.vat_rate ?? 20) as VatRate,
          catalogue_item_id: i.catalogue_item_id,
          discount_type: (i.discount_type as 'percent' | 'fixed' | null) ?? null,
          discount_value: i.discount_value ?? 0,
        }))
      : [blankLine(settings)]
  )
  const [saving, setSaving] = useState(false)
  const [showCatalogue, setShowCatalogue] = useState(false)
  const [cataloguePos, setCataloguePos] = useState<{ top?: number; bottom?: number; left: number }>({ top: 0, left: 0 })
  const [activeLine, setActiveLine] = useState<string | null>(null)
  const [catalogueHighlight, setCatalogueHighlight] = useState(-1)
  const uid = useId()
  const listboxId = `${uid}-catalogue`
  const [activeDateLine, setActiveDateLine] = useState<string | null>(null)
  const [datePop, setDatePop] = useState<{ top?: number; bottom?: number; right: number } | null>(null)
  const [gmailPreview, setGmailPreview] = useState<{ to: string; subject: string; body: string; pdfBase64: string; filename: string; documentId: string; newDocId?: string; uploadToDrive: boolean; driveArchived: boolean } | null>(null)
  const [gmailSending, setGmailSending] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const issuingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingIssue, setPendingIssue] = useState<(() => Promise<void>) | null>(null)
  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[]>(catalogue)
  const [addingItem, setAddingItem] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [newItemDraft, setNewItemDraft] = useState({ name_de: '', name_en: '', default_price: 0, unit: 'flat' as Unit, vat_rate: 20 as VatRate, category: '' })
  const [dragOver, setDragOver] = useState<number | null>(null)
  const dragIdx = useRef<number | null>(null)

  function toggleDatePop(lineId: string, e: React.MouseEvent<HTMLButtonElement>) {
    if (activeDateLine === lineId) {
      setActiveDateLine(null)
      setDatePop(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const flipUp = rect.bottom + 100 > window.innerHeight
    setDatePop(flipUp
      ? { bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right }
      : { top: rect.bottom + 4, right: window.innerWidth - rect.right }
    )
    setActiveDateLine(lineId)
  }

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
  const saveStatus = saveError
    ? { text: t('builder.notSaved', { error: saveError }), cls: 'text-red-500' }
    : autoSaving ? { text: t('common.saving'), cls: '' }
    : lastSaved ? { text: t('builder.saved', { time: lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), cls: '' }
    : null

  function applyClientDefaults(c: Client) {
    if (c.language) setLanguage(c.language)
    if (c.currency) setCurrency(c.currency as Currency)
    setTaxTreatment(c.tax_treatment as TaxTreatment)
    if (!doc?.number) setDueDate(addDays(date || today(), termDays(type, settings, c)))
  }

  // Apply client defaults on mount when pre-selecting a client (e.g. navigating from client page)
  useEffect(() => {
    if (defaultClientId && !doc) {
      const c = clients.find(cl => cl.id === defaultClientId)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (c) applyClientDefaults(c)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleClientChange(id: string) {
    const c = clients.find(cl => cl.id === id)
    setClientId(id)
    if (c) applyClientDefaults(c)
  }

  function updateLine(id: string, patch: Partial<LineItem>) {
    setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  function removeLine(id: string) {
    setLines(ls => ls.filter(l => l.id !== id))
  }

  function addLine(lt: LineType) {
    setShowCatalogue(false)
    setLines(ls => [...ls, lt === 'item' ? blankLine(settings) : blankSpecial(lt)])
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
    toast.success(t('builder.itemAdded'))
  }

  function catalogueName(item: CatalogueItem): string {
    if (language === 'de') return item.name_de || item.name_en || ''
    return item.name_en || item.name_de || ''
  }

  function pickCatalogueItem(item: CatalogueItem, lineId: string) {
    updateLine(lineId, {
      description: catalogueLineText(item, language),
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
      discount_type: l.discount_type, discount_value: l.discount_value,
    })),
    doc?.payments,
    discount,
    taxTreatment
  )

const taxNote = getTaxNote(taxTreatment, language as 'de' | 'en', settings)

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
      discount_type: l.line_type === 'subtotal' ? (l.discount_type || null) : null,
      discount_value: l.line_type === 'subtotal' ? (l.discount_value || null) : null,
    }))
  }

  const skontoFields = type === 'invoice' && skontoPercent !== '' && skontoPercent > 0
    ? { skonto_percent: skontoPercent, skonto_days: skontoDays === '' ? null : skontoDays }
    : { skonto_percent: null, skonto_days: null }

  function currentDocFields(effectiveDate: string, effectiveDueDate: string | null) {
    return {
      client_id: clientId, date: effectiveDate, service_date: serviceDate || null,
      service_date_end: serviceDateEnd || null,
      due_date: effectiveDueDate, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, notes_internal: notesInternal || null,
      discount_type: discountType, discount_value: discountValue || null,
      ...skontoFields,
    }
  }

  // Runs writes strictly one after another so an autosave can never interleave with an explicit save.
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.current.then(fn, fn)
    writeChain.current = run.then(() => undefined, () => undefined)
    return run
  }

  // Writes header + items (inserting a draft for a new document) and returns the document id.
  async function persist(forIssue: boolean): Promise<string | null> {
    const effectiveDate = date || today()
    const effectiveDueDate = dueDate || (forIssue && client ? addDays(effectiveDate, termDays(type, settings, client)) : null)
    const fields = currentDocFields(effectiveDate, effectiveDueDate)
    let docId: string
    if (doc) {
      const { error } = await supabase.from('documents').update(fields).eq('id', doc.id)
      if (error) { toast.error(error.message); return null }
      docId = doc.id
    } else {
      const { data: newDoc, error } = await supabase.from('documents')
        .insert({ type, number: null, status: 'draft', exchange_rate: 1, ...fields })
        .select('id').single()
      if (error) { toast.error(error.message); return null }
      docId = newDoc.id
    }
    const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: docId, p_items: buildItemsPayload(docId) })
    if (itemsErr) { toast.error(t('builder.itemsError', { error: itemsErr.message })); return null }
    if (!date) setDate(effectiveDate)
    if (!dueDate && effectiveDueDate) setDueDate(effectiveDueDate)
    return docId
  }

  async function save(status: 'draft' | 'sent') {
    if (status === 'sent') { requestSent(); return }
    if (!clientId) { toast.error(t('builder.selectClient')); return }
    if (!lines.some(l => l.line_type === 'item')) { toast.error(t('builder.addLineItem')); return }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    setSaving(true)
    const id = await serialized(() => persist(false))
    setSaving(false)
    if (!id) return
    setSaveError(null)
    setLastSaved(new Date())
    toast.success(t('builder.draftSaved'))
    if (!doc) router.push(`/${PATHS[type]}/${id}`)
    else router.refresh()
  }

  async function buildPdfBlob(numOverride?: string, includeQr = false) {
    if (!client) { toast.error(t('builder.selectClientFirst')); return null }
    const docData = {
      number: numOverride ?? doc?.number ?? 'DRAFT',
      date, service_date: serviceDate || null, service_date_end: serviceDateEnd || null, due_date: dueDate || null,
      type, language, currency, tax_treatment: taxTreatment,
      notes: notes || null, tax_note: taxNote,
      discount_type: discountType, discount_value: discountValue || null,
      ...skontoFields,
      items: lines.map(l => ({ ...l })),
      totals,
      reference: reference ?? null,
    }

    // Generate EPC QR only for final PDFs (save/send), not preview
    let qrCodeDataUri: string | null = null
    if (includeQr && type === 'invoice' && settings.iban && totals.balance_due > 0) {
      qrCodeDataUri = await generateEpcQr({
        bic: settings.bic ?? '',
        name: settings.company_name,
        iban: settings.iban,
        amountEur: currency === 'EUR' ? totals.balance_due : undefined,
        reference: docData.number,
      })
    }

    try {
      const blob = await pdf(
        <InvoiceDocument settings={settings} client={client} document={docData} qrCodeDataUri={qrCodeDataUri} />
      ).toBlob()
      return { blob, number: docData.number }
    } catch (err) {
      console.error('PDF generation failed:', err)
      toast.error(t('builder.pdfFailed', { error: err instanceof Error ? err.message : String(err) }))
      return null
    }
  }

  // driveFailed: issuing tried Drive and already reported the error.
  type Issued = { number: string; id: string; isNew: boolean; driveArchived: boolean; driveFailed: boolean }
  type IssueResponse = {
    number: string
    snapshotError: string | null
    drive: { webViewLink: string | null; existing: boolean } | null
    driveError: { error: string; code?: string } | null
  }

  // Issuing froze the PDF and archived it to Drive on the server; a failure there never undoes
  // the issue, it is only reported (the page then offers to create the archive copy).
  function reportArchive(result: IssueResponse) {
    if (result.snapshotError) toast.error(t('builder.snapshotFailed', { error: result.snapshotError }))
    if (result.driveError) toastApiError(t, result.driveError, t('builder.driveFailedPrefix'))
    else if (result.drive) notifyDriveUpload(t, result.drive.webViewLink, result.drive.existing)
  }

  // Persists, then issues server-side: number + status 'sent' (issue_document), the frozen PDF
  // and the Drive archive. Re-entrant calls are ignored.
  async function issueDocument(): Promise<Issued | null> {
    if (doc?.number) return { number: doc.number, id: doc.id, isNew: false, driveArchived: false, driveFailed: false }
    if (issuingRef.current) return null
    issuingRef.current = true
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    setSaving(true)
    try {
      return await serialized(async () => {
        const id = await persist(true)
        if (!id) return null
        let result: IssueResponse
        try {
          result = await postJson<IssueResponse>(`/api/documents/${id}/issue`)
        } catch (e) {
          toast.error(errorMessage(e, t('common.unknownError')))
          if (!doc) router.push(`/${PATHS[type]}/${id}`)
          return null
        }
        setSaveError(null)
        setLastSaved(new Date())
        reportArchive(result)
        return { number: result.number, id, isNew: !doc, driveArchived: !!result.drive, driveFailed: !!result.driveError }
      })
    } finally {
      issuingRef.current = false
      setSaving(false)
    }
  }

  // For documents issued before archive copies existed: the server renders one from the stored data.
  function archiveNow() {
    if (!doc?.number) return
    const { id } = doc
    setSaving(true)
    void serialized(async () => {
      const res = await fetch(`/api/documents/${id}/snapshot`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(archiveErrorMessage(t, data, res.statusText))
    })
      .then(() => { toast.success(t('builder.issuedArchived')); router.refresh() })
      .catch(e => toast.error(t('builder.snapshotFailed', { error: errorMessage(e, t('common.unknownError')) })))
      .finally(() => setSaving(false))
  }

  // The stored issued copy; outgoing PDFs of a numbered document never come from the editor.
  async function issuedPdf(issued: Issued): Promise<Blob | null> {
    try {
      return await fetchIssuedPdf(issued.id, t)
    } catch (e) {
      toast.error(t('archive.pdfFailed', { error: errorMessage(e, t('common.unknownError')) }))
      return null
    }
  }

  // Issued documents run the action directly; drafts ask first, because issuing consumes
  // the next number and marks the document as sent.
  function withIssued(action: (issued: Issued) => Promise<void>) {
    if (!clientId) { toast.error(t('builder.selectClient')); return }
    if (!lines.some(l => l.line_type === 'item')) { toast.error(t('builder.addLineItem')); return }
    const run = async () => {
      const issued = await issueDocument()
      if (!issued) return
      // A freshly issued document navigates away when the action finishes; keep the toolbar
      // locked until then so a second click cannot create and issue another document.
      if (issued.isNew) setSaving(true)
      try { await action(issued) } finally { if (issued.isNew) setSaving(false) }
    }
    if (doc?.number) void run()
    else setPendingIssue(() => run)
  }

  function afterIssue(issued: Issued) {
    if (issued.isNew) router.push(`/${PATHS[type]}/${issued.id}`)
    else router.refresh()
  }

  // The server uploads the stored copy and never overwrites: an archived file comes back as is.
  async function saveIssuedToDrive(documentId: string) {
    const res = await fetch(`/api/documents/${documentId}/drive-pdf`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (res.ok) notifyDriveUpload(t, data.webViewLink, data.existing)
    else toastApiError(t, { ...data, error: archiveErrorMessage(t, data, t('common.unknownError')) }, t('builder.driveFailedPrefix'))
  }

  function saveToDrive() {
    if (!settings.drive_folder_id) { toast.error(t('builder.noDriveFolder')); return }
    withIssued(async issued => {
      // Issuing just archived it to Drive (or reported why it could not); the toast says which.
      if (!issued.driveArchived && !issued.driveFailed) await saveIssuedToDrive(issued.id)
      afterIssue(issued)
    })
  }

  // Preview of the editor's current state; it is never sent anywhere.
  async function downloadPdf() {
    const result = await buildPdfBlob(undefined, !!doc?.number)
    if (!result) return
    const url = URL.createObjectURL(result.blob)
    // Use a hidden <a> with target="_blank" — not blocked by popup blockers
    // unlike window.open() called after async work.
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: filename }).click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  function savePdf() {
    withIssued(async issued => {
      const blob = await issuedPdf(issued)
      if (!blob) { afterIssue(issued); return }
      const filename = `${issued.number}.pdf`

      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as Window & typeof globalThis & { showSaveFilePicker: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          afterIssue(issued)
          return
        } catch (e) {
          if ((e as Error).name === 'AbortError') { afterIssue(issued); return }
        }
      }

      triggerDownload(blob, filename)
      afterIssue(issued)
    })
  }

  function buildEmailContent(numOverride?: string) {
    if (!client) return null
    const num = numOverride ?? doc?.number ?? 'DRAFT'
    const lang = language as 'de' | 'en'
    const typeKey = type === 'credit_note' ? 'credit_note' : type

    const vars: Record<string, string> = {
      invoice_number: num,
      client: client.company ?? client.name,
      total: formatMoney(totals.total, currency),
      balance_due: formatMoney(totals.balance_due, currency),
      subtotal: formatMoney(totals.subtotal, currency),
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
      : `Dear ${client.name || client.company},\n\nPlease find attached ${typeLabel[type].en} ${num}.\n\nDo not hesitate to contact me if you have any questions.\n\nKind regards,\n${settings.owner_name}`

    const subject = settings[subjectKey] ? sub(settings[subjectKey] as string) : defaultSubject
    const body    = settings[bodyKey]    ? sub(settings[bodyKey]    as string) : defaultBody

    return { subject, body, num }
  }

  function openInEmail() {
    if (!client) { toast.error(t('builder.selectClientFirst')); return }
    if (!client.email) { toast.error(t('builder.clientNoEmail')); return }
    withIssued(async issued => {
      const content = buildEmailContent(issued.number)
      const blob = await issuedPdf(issued)
      if (!content || !blob) { afterIssue(issued); return }
      triggerDownload(blob, `${issued.number}.pdf`)
      Object.assign(document.createElement('a'), {
        href: `mailto:${client.email}?subject=${encodeURIComponent(content.subject)}&body=${encodeURIComponent(content.body)}`,
      }).click()
      await logEvent(supabase, issued.id, 'mailto_opened', { to: client.email, subject: content.subject })
      afterIssue(issued)
    })
  }

  function sendViaGmail() {
    if (!client) { toast.error(t('builder.selectClientFirst')); return }
    if (!client.email) { toast.error(t('builder.clientNoEmail')); return }
    withIssued(async issued => {
      const content = buildEmailContent(issued.number)
      const blob = await issuedPdf(issued)
      if (!content || !blob) { afterIssue(issued); return }
      const driveArchived = issued.driveArchived || !!doc?.drive_file_id
      setGmailPreview({
        to: client.email, subject: content.subject, body: content.body,
        pdfBase64: await blobToBase64(blob), filename: `${issued.number}.pdf`,
        documentId: issued.id, newDocId: issued.isNew ? issued.id : undefined,
        uploadToDrive: !!settings.drive_folder_id && !driveArchived, driveArchived,
      })
    })
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

    if (!res.ok) {
      toastApiError(t, await res.json().catch(() => ({})), '', t('builder.emailFailed'))
      return
    }

    toast.success(t('builder.emailSent'))
    if (gmailPreview.uploadToDrive) void saveIssuedToDrive(gmailPreview.documentId)
    closeGmailPreview()
  }

  // The document is already issued when the modal opens, so a new document must still land on its page.
  function closeGmailPreview() {
    const newDocId = gmailPreview?.newDocId
    setGmailPreview(null)
    if (newDocId) router.push(`/${PATHS[type]}/${newDocId}`)
    else router.refresh()
  }

  function requestSent() {
    withIssued(async issued => {
      toast.success(t('builder.issued', { number: issued.number }))
      afterIssue(issued)
    })
  }

  const autoSave = useCallback(async () => {
    if (!doc || !clientId || saving || issuingRef.current) return
    if (!date) { setSaveError(t('builder.dateRequired')); return }
    setAutoSaving(true)
    const failure = await serialized(async () => {
      const { error } = await supabase.from('documents').update(currentDocFields(date, dueDate || null)).eq('id', doc.id)
      if (error) return error.message
      const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: doc.id, p_items: buildItemsPayload(doc.id) })
      return itemsErr ? itemsErr.message : null
    })
    if (failure) {
      if (!saveError) toast.error(t('builder.notSavedToast', { error: failure }))
      setSaveError(failure)
    } else {
      setSaveError(null)
      setLastSaved(new Date())
    }
    setAutoSaving(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, clientId, date, serviceDate, serviceDateEnd, dueDate, language, currency, taxTreatment, notes, notesInternal, discountType, discountValue, skontoPercent, skontoDays, lines, saving, saveError])

  useEffect(() => {
    if (!doc) return
    if (isFirstRender.current) { isFirstRender.current = false; return }
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => { autoSaveTimer.current = null; void autoSave() }, 2000)
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }
  }, [autoSave, doc])

  // The status menu issues this document from outside the builder; edits still waiting for the
  // autosave are written first, so the frozen PDF the server renders includes them.
  useEffect(() => {
    if (!doc) return
    const docId = doc.id
    function onFlush(e: Event) {
      const { documentId, waitUntil } = (e as CustomEvent<FlushEditsDetail>).detail
      if (documentId !== docId) return
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = null
        waitUntil(autoSave())
      }
      waitUntil(writeChain.current)
    }
    window.addEventListener(FLUSH_EDITS_EVENT, onFlush)
    return () => window.removeEventListener(FLUSH_EDITS_EVENT, onFlush)
  }, [autoSave, doc])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (doc) autoSave()
        else save('draft')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [autoSave, doc, save])

  const deleteBtn = (id: string) => (
    <button type="button" onClick={() => removeLine(id)} aria-label={t('builder.removeLine')}
      className="h-11 w-11 sm:h-9 sm:w-8 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0">
      <Trash2 size={14} />
    </button>
  )

  function catalogueMatches(line: LineItem) {
    const q = line.description.toLowerCase()
    return catalogueItems.filter(i => {
      if (!i.active) return false
      const n = catalogueName(i).toLowerCase()
      return !q || n.includes(q) || i.name_de.toLowerCase().includes(q) || (i.name_en ?? '').toLowerCase().includes(q)
    })
  }

  function openCatalogue(line: LineItem, el: HTMLInputElement, mobile: boolean) {
    setActiveLine(line.id)
    setShowCatalogue(true)
    setCatalogueHighlight(-1)
    const rect = el.getBoundingClientRect()
    const flipUp = rect.bottom + 288 > window.innerHeight
    const left = mobile ? 16 : rect.left
    setCataloguePos(flipUp ? { bottom: window.innerHeight - rect.top + 4, left } : { top: rect.bottom + 4, left })
  }

  function closeCatalogue() {
    setShowCatalogue(false)
    setAddingItem(false)
  }

  const catalogueOpenFor = (line: LineItem) => showCatalogue && activeLine === line.id

  // The popup closes once focus has left both the description input and the popup itself.
  function handleCatalogueBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return
    closeCatalogue()
  }

  function handleCatalogueKeyDown(e: React.KeyboardEvent<HTMLInputElement>, line: LineItem, mobile: boolean) {
    if (!catalogueOpenFor(line)) {
      if (e.key === 'ArrowDown') { e.preventDefault(); openCatalogue(line, e.currentTarget, mobile) }
      return
    }
    const matches = catalogueMatches(line)
    const count = matches.length + 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setCatalogueHighlight(h => (h + 1) % count) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCatalogueHighlight(h => (h <= 0 ? count - 1 : h - 1)) }
    else if (e.key === 'Escape') { e.preventDefault(); closeCatalogue() }
    else if (e.key === 'Enter' && catalogueHighlight >= 0) {
      e.preventDefault()
      if (catalogueHighlight < matches.length) pickCatalogueItem(matches[catalogueHighlight], line.id)
      else setAddingItem(true)
    }
  }

  // The phone and desktop layouts both stay mounted, so each gets its own listbox ids.
  const catalogueListId = (mobile: boolean) => `${listboxId}-${mobile ? 'm' : 'd'}`

  function descriptionProps(line: LineItem, mobile: boolean) {
    const open = catalogueOpenFor(line)
    const lbId = catalogueListId(mobile)
    return {
      value: line.description,
      placeholder: t('builder.descriptionPlaceholder'),
      'aria-label': t('builder.description'),
      role: 'combobox' as const,
      'aria-expanded': open,
      'aria-controls': open ? lbId : undefined,
      'aria-autocomplete': 'list' as const,
      'aria-activedescendant': open && catalogueHighlight >= 0 && catalogueHighlight < catalogueMatches(line).length ? `${lbId}-${catalogueHighlight}` : undefined,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        updateLine(line.id, { description: e.target.value })
        setCatalogueHighlight(-1)
        if (!open) openCatalogue(line, e.currentTarget, mobile)
      },
      onFocus: (e: React.FocusEvent<HTMLInputElement>) => openCatalogue(line, e.currentTarget, mobile),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => handleCatalogueKeyDown(e, line, mobile),
    }
  }

  const popupFieldCls = 'text-base md:text-xs border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 w-full bg-white dark:bg-neutral-900 dark:text-neutral-100'

  function cataloguePopup(line: LineItem, mobile: boolean) {
    if (!catalogueOpenFor(line)) return null
    const matches = catalogueMatches(line)
    const newHighlighted = catalogueHighlight === matches.length
    const lbId = catalogueListId(mobile)
    return (
      <div
        className={`fixed z-50 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg max-h-72 overflow-auto ${mobile ? '' : 'w-96 max-w-[calc(100vw-2rem)]'}`}
        style={mobile ? { ...cataloguePos, width: 'calc(100vw - 2rem)' } : cataloguePos}
      >
        <div role="listbox" id={lbId} aria-label={t('builder.catalogueItems')}>
          {matches.length === 0 && (
            <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400 text-center">{t('builder.noItems')}</p>
          )}
          {matches.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              id={`${lbId}-${i}`}
              aria-selected={catalogueHighlight === i}
              tabIndex={-1}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setCatalogueHighlight(i)}
              onClick={() => pickCatalogueItem(item, line.id)}
              className={`w-full text-left px-3 ${mobile ? 'py-2.5' : 'py-2'} text-sm flex justify-between items-center gap-3 ${catalogueHighlight === i ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
            >
              <span className="min-w-0 truncate">{catalogueName(item)}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">{formatMoney(item.default_price)}/{t(`units.${item.unit}` as DictKey)}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-neutral-100 dark:border-neutral-800">
          {addingItem ? (
            <div className="p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input value={newItemDraft.name_de} onChange={e => setNewItemDraft(d => ({ ...d, name_de: e.target.value }))} placeholder={t('builder.nameDe')} aria-label={t('builder.nameDeLabel')} autoFocus className={popupFieldCls} />
                <input value={newItemDraft.name_en} onChange={e => setNewItemDraft(d => ({ ...d, name_en: e.target.value }))} placeholder={t('builder.nameEn')} aria-label={t('builder.nameEnLabel')} className={popupFieldCls} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MoneyInput value={newItemDraft.default_price} onValueChange={n => setNewItemDraft(d => ({ ...d, default_price: n ?? 0 }))} placeholder={t('builder.price')} aria-label={t('builder.price')} className="h-7 px-2 md:text-xs" />
                <select value={newItemDraft.unit} onChange={e => setNewItemDraft(d => ({ ...d, unit: e.target.value as Unit }))} aria-label={t('builder.unit')} className={`${popupFieldCls} px-1`}>
                  {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
                </select>
                <select value={newItemDraft.vat_rate} onChange={e => setNewItemDraft(d => ({ ...d, vat_rate: parseInt(e.target.value) as VatRate }))} aria-label={t('builder.vatRate')} className={`${popupFieldCls} px-1`}>
                  {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
              </div>
              <input value={newItemDraft.category} onChange={e => setNewItemDraft(d => ({ ...d, category: e.target.value }))} placeholder={t('builder.category')} aria-label={t('builder.category')} className={popupFieldCls} />
              <div className="flex gap-2">
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => saveNewCatalogueItem(line.id)} className="text-xs px-2.5 py-1.5 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:bg-neutral-700 dark:hover:bg-neutral-200">{t('builder.addAndUse')}</button>
                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => setAddingItem(false)} className="text-xs px-2.5 py-1.5 border border-neutral-200 dark:border-neutral-700 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800">{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setCatalogueHighlight(matches.length)}
              onClick={() => setAddingItem(true)}
              className={`w-full text-left px-3 py-2.5 text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5 ${newHighlighted ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
            >
              <Plus size={12} /> {t('builder.newCatalogueItem')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const discountToggle = (active: boolean) =>
    `px-2 py-1 sm:py-0.5 transition-colors ${active ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900' : 'bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400'}`
  const discountChip = (active: boolean) =>
    `text-xs px-2 py-1 sm:px-1.5 sm:py-0.5 rounded-full border transition-colors ${active ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 border-transparent' : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-500'}`
  const removeDiscountBtn = 'h-9 w-9 -my-2 sm:h-7 sm:w-7 sm:-my-1 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0'

  const sectionDiscount = (line: LineItem, idx: number) => {
    const gross = calcSectionSubtotal(lines, idx)
    const discAmt = line.discount_type && line.discount_value > 0
      ? line.discount_type === 'percent' ? gross * (line.discount_value / 100) : Math.min(line.discount_value, gross)
      : 0
    const net = gross - discAmt
    return (
      <div className="flex-1 space-y-1.5 pr-1 min-w-0">
        <div className="flex justify-end items-center gap-3">
          <span className="text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{t('builder.subtotal')}</span>
          <span className={`text-sm font-medium ${discAmt > 0 ? 'line-through text-neutral-500 dark:text-neutral-400' : ''}`}>{formatMoney(gross, currency)}</span>
        </div>
        {line.discount_type ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <div role="group" aria-label={t('builder.discountType')} className="flex rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden text-xs">
                <button type="button" aria-pressed={line.discount_type === 'percent'} onClick={() => updateLine(line.id, { discount_type: 'percent' })} className={discountToggle(line.discount_type === 'percent')}>%</button>
                <button type="button" aria-pressed={line.discount_type === 'fixed'} onClick={() => updateLine(line.id, { discount_type: 'fixed' })} className={discountToggle(line.discount_type === 'fixed')}>{currency}</button>
              </div>
              <MoneyInput
                value={line.discount_value}
                onValueChange={n => updateLine(line.id, { discount_value: n ?? 0 })}
                aria-label={t('builder.sectionDiscount')}
                className="w-20 h-8 sm:h-7 md:text-xs text-right"
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400 w-20 sm:w-24 text-right">−{formatMoney(discAmt, currency)}</span>
              <button type="button" aria-label={t('builder.removeDiscount')} onClick={() => updateLine(line.id, { discount_type: null, discount_value: 0 })} className={removeDiscountBtn}><X size={13} /></button>
            </div>
            {line.discount_type === 'percent' && (
              <div className="flex gap-1 justify-end flex-wrap">
                {[5, 10, 15, 20, 25].map(p => (
                  <button key={p} type="button" aria-pressed={line.discount_value === p} onClick={() => updateLine(line.id, { discount_value: p })} className={discountChip(line.discount_value === p)}>{p}%</button>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <span className="text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">{t('builder.net')}</span>
              <span className="text-sm font-semibold">{formatMoney(net, currency)}</span>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <button type="button" onClick={() => updateLine(line.id, { discount_type: 'percent', discount_value: 0 })}
              className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 border border-dashed border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 rounded px-2 py-1 sm:py-0.5 transition-colors">
              + {t('builder.discount')}
            </button>
          </div>
        )}
      </div>
    )
  }

  const captionCls = 'text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider'

  return (
    <div className="space-y-6">
      {/* Gmail send preview */}
      <Dialog
        open={!!gmailPreview}
        onClose={closeGmailPreview}
        title={t('builder.reviewEmail')}
        busy={gmailSending}
        panelClassName="max-w-lg"
      >
        {gmailPreview && (
          <>
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor={`${uid}-gmail-to`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.to')}</label>
                <input
                  id={`${uid}-gmail-to`}
                  type="email"
                  value={gmailPreview.to}
                  onChange={e => setGmailPreview(p => p ? { ...p, to: e.target.value } : p)}
                  className="w-full text-base md:text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-gmail-subject`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.subject')}</label>
                <input
                  id={`${uid}-gmail-subject`}
                  value={gmailPreview.subject}
                  onChange={e => setGmailPreview(p => p ? { ...p, subject: e.target.value } : p)}
                  className="w-full text-base md:text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-gmail-body`} className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.body')}</label>
                <textarea
                  id={`${uid}-gmail-body`}
                  value={gmailPreview.body}
                  onChange={e => setGmailPreview(p => p ? { ...p, body: e.target.value } : p)}
                  rows={7}
                  className="w-full text-base md:text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 resize-none"
                />
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('builder.pdfAttached', { filename: gmailPreview.filename })}</p>
            </div>
            {settings.drive_folder_id && (gmailPreview.driveArchived ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('builder.archivedToDrive')}</p>
            ) : (
              <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gmailPreview.uploadToDrive}
                  onChange={e => setGmailPreview(p => p ? { ...p, uploadToDrive: e.target.checked } : p)}
                  className="w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 accent-neutral-900 dark:accent-white"
                />
                {t('builder.alsoDrive')}
              </label>
            ))}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={closeGmailPreview} disabled={gmailSending}>{t('common.cancel')}</Button>
              <Button type="button" onClick={confirmSendViaGmail} disabled={gmailSending}>
                {gmailSending ? t('common.sending') : t('common.send')}
              </Button>
            </div>
          </>
        )}
      </Dialog>

      {/* Issue confirmation */}
      <ConfirmDialog
        open={!!pendingIssue}
        title={t(`builder.issueTitle.${type}`)}
        description={t('builder.issueDesc', { number: t(`docTypeNumber.${type}`) })}
        confirmLabel={t('builder.issueAndContinue')}
        onConfirm={() => { const run = pendingIssue; setPendingIssue(null); if (run) void run() }}
        onCancel={() => setPendingIssue(null)}
      />

      {doc?.number && doc.status !== 'draft' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <strong>{t('builder.issuedWarning', { number: doc.number })}</strong> {t('builder.issuedWarningBody')}
        </div>
      )}

      {doc?.number && !doc.pdf_path && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="flex-1"><strong>{t('archive.missingTitle')}</strong> {t('archive.missingBody')}</p>
          <Button type="button" variant="outline" size="sm" onClick={archiveNow} disabled={saving} className="shrink-0 self-start sm:self-auto flex items-center gap-1.5 h-9 sm:h-8 bg-white dark:bg-neutral-900">
            <Archive size={13} /> {t('archive.create')}
          </Button>
        </div>
      )}

      {doc?.number && doc.pdf_path && !doc.drive_file_id && settings.drive_folder_id && settings.gmail_connected && (
        <div role="status" className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3 text-sm text-neutral-600 dark:text-neutral-300 flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="flex-1"><strong>{t('archive.driveMissingTitle')}</strong> {t('archive.driveMissingBody')}</p>
          <Button type="button" variant="outline" size="sm" onClick={saveToDrive} disabled={saving} className="shrink-0 self-start sm:self-auto flex items-center gap-1.5 h-9 sm:h-8 bg-white dark:bg-neutral-900">
            <HardDrive size={13} /> {t('builder.saveToDrive')}
          </Button>
        </div>
      )}

      {/* Client & dates */}
      <div className="space-y-4">
        <p className={captionCls}>{t('builder.clientAndDates')}</p>

        {/* Client selector — full width always */}
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-client`}>{t('builder.client')}</Label>
          <select id={`${uid}-client`} value={clientId} onChange={e => handleClientChange(e.target.value)} className={SELECT_CLS}>
            <option value="">{t('builder.selectClientPlaceholder')}</option>
            {clients.sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name)).map(c => (
              <option key={c.id} value={c.id}>{c.company && c.name ? `${c.company} (${c.name})` : c.company || c.name}</option>
            ))}
          </select>
        </div>

        {/* Date + Due date */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${uid}-date`}>{t('builder.date')}</Label>
            <Input id={`${uid}-date`} type="date" value={date} onChange={e => setDate(e.target.value)} className="h-10 w-full" />
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${uid}-due`}>{type === 'invoice' ? t('builder.dueDate') : t('builder.validUntil')}</Label>
            <Input id={`${uid}-due`} type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="h-10 w-full" />
          </div>
        </div>

        {/* Details toggle (mobile) / always visible (desktop) */}
        <div>
          <button
            type="button"
            onClick={() => setShowDetails(d => !d)}
            aria-expanded={showDetails}
            className="sm:hidden flex items-center gap-1.5 text-xs py-2 -my-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors mb-3"
          >
            <ChevronRight size={13} className={`transition-transform ${showDetails ? 'rotate-90' : ''}`} />
            {showDetails ? t('builder.hideDetails') : t('builder.showDetails')}
          </button>

          <div className={`grid grid-cols-2 sm:grid-cols-5 gap-3 ${showDetails ? 'block' : 'hidden'} sm:grid`}>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-language`}>{t('builder.language')}</Label>
              <select id={`${uid}-language`} value={language} onChange={e => setLanguage(e.target.value as Language)} className={SELECT_CLS}>
                <option value="de">{t('common.german')}</option>
                <option value="en">{t('common.english')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-currency`}>{t('builder.currency')}</Label>
              <select id={`${uid}-currency`} value={currency} onChange={e => setCurrency(e.target.value as Currency)} className={SELECT_CLS}>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-tax`}>{t('builder.taxTreatment')}</Label>
              <select id={`${uid}-tax`} value={taxTreatment} onChange={e => setTaxTreatment(e.target.value as TaxTreatment)} className={SELECT_CLS}>
                <option value="at_vat">{t('taxTreatments.at_vat')}</option>
                <option value="eu_reverse_charge">{t('taxTreatments.eu_reverse_charge')}</option>
                <option value="non_eu">{t('taxTreatments.non_eu')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-service-from`}>{t('builder.serviceFrom')}</Label>
              <Input id={`${uid}-service-from`} type="date" value={serviceDate} onChange={e => setServiceDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-service-to`}>{t('builder.serviceTo')}</Label>
              <Input id={`${uid}-service-to`} type="date" value={serviceDateEnd} min={serviceDate || undefined} onChange={e => setServiceDateEnd(e.target.value)} />
            </div>
            {type === 'invoice' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-skonto-percent`}>{t('builder.skontoPercent')}</Label>
                  <MoneyInput id={`${uid}-skonto-percent`} value={skontoPercent === '' ? null : skontoPercent} placeholder={t('builder.skontoNone')}
                    onValueChange={n => setSkontoPercent(n === null ? '' : n)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-skonto-days`}>{t('builder.skontoDays')}</Label>
                  <MoneyInput id={`${uid}-skonto-days`} integer value={skontoDays === '' ? null : skontoDays} placeholder={t('builder.skontoFromDate')}
                    onValueChange={n => setSkontoDays(n === null ? '' : n)} />
                </div>
              </>
            )}
          </div>
        </div>

        {taxNote && (
          <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2">
            {taxNote}
          </div>
        )}
      </div>{/* end Client & Dates */}

      <Separator />

      {/* Line items */}
      <div className="space-y-1.5">
        <p className={`${captionCls} mb-3`}>{t('builder.lineItems')}</p>
        {/* Mobile card layout */}
        <div className="sm:hidden space-y-0">
          {lines.map((line, idx) => {
            if (line.line_type === 'separator') {
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  <div className="flex-1 border-t border-neutral-200 dark:border-neutral-700" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'page_break') {
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 px-1">{t('builder.pageBreak')}</span>
                  <div className="flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-600" />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'heading') {
              return (
                <div key={line.id} className="flex items-center gap-2">
                  <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder={t('builder.sectionHeadingPlaceholder')}
                    aria-label={t('builder.sectionHeading')}
                    className="flex-1 min-w-0 text-base md:text-sm font-semibold bg-transparent border-0 border-b border-neutral-200 dark:border-neutral-700 px-1 py-1.5 focus:outline-none focus:border-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'text') {
              return (
                <div key={line.id} className="flex items-center gap-2">
                  <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  <input
                    value={line.description}
                    onChange={e => updateLine(line.id, { description: e.target.value })}
                    placeholder={t('builder.notePlaceholder')}
                    aria-label={t('builder.note')}
                    className="flex-1 min-w-0 text-base md:text-sm text-neutral-500 dark:text-neutral-400 bg-transparent border-0 border-b border-neutral-100 dark:border-neutral-800 px-1 py-1.5 focus:outline-none focus:border-neutral-300 dark:placeholder:text-neutral-600"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'subtotal') {
              return (
                <div key={line.id} className="flex items-center gap-2 py-1">
                  <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 shrink-0" />
                  {sectionDiscount(line, idx)}
                  {deleteBtn(line.id)}
                </div>
              )
            }

            // item — mobile card
            return (
              <div key={line.id} className="rounded-xl border border-neutral-200 dark:border-neutral-700 p-3 space-y-3 mb-2">
                {/* Description + delete */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0" onBlur={handleCatalogueBlur}>
                    <Input {...descriptionProps(line, true)} className="w-full" />
                    {cataloguePopup(line, true)}
                  </div>
                  {deleteBtn(line.id)}
                </div>
                {/* Qty × Unit | Price */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor={`${uid}-qty-${line.id}`} className="block text-xs text-neutral-500 dark:text-neutral-400">{t('builder.qtyUnit')}</label>
                    <div className="flex gap-1.5">
                      <MoneyInput id={`${uid}-qty-${line.id}`} value={line.quantity} decimals={4}
                        onValueChange={n => updateLine(line.id, { quantity: n ?? 0 })}
                        className="w-16 shrink-0" />
                      <select value={line.unit} onChange={e => updateLine(line.id, { unit: e.target.value as Unit })} aria-label={t('builder.unit')}
                        className={`${LINE_SELECT_CLS} flex-1`}>
                        {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`${uid}-price-${line.id}`} className="block text-xs text-neutral-500 dark:text-neutral-400">{t('builder.price')}</label>
                    <MoneyInput id={`${uid}-price-${line.id}`} value={line.unit_price}
                      onValueChange={n => updateLine(line.id, { unit_price: n ?? 0 })}
                      className="w-full" />
                  </div>
                </div>
                {/* VAT + service date */}
                <div className="flex items-end gap-3">
                  <div className="space-y-1 flex-1">
                    <label htmlFor={`${uid}-vat-${line.id}`} className="block text-xs text-neutral-500 dark:text-neutral-400">{t('builder.vat')}</label>
                    <select id={`${uid}-vat-${line.id}`} value={line.vat_rate}
                      onChange={e => updateLine(line.id, { vat_rate: parseInt(e.target.value) as VatRate })}
                      className={`${LINE_SELECT_CLS} w-full`}>
                      {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => toggleDatePop(line.id, e)}
                    title={line.service_date ?? t('builder.setServiceDate')}
                    aria-label={line.service_date ? t('builder.serviceDateLabel', { date: line.service_date }) : t('builder.setServiceDate')}
                    aria-expanded={activeDateLine === line.id}
                    className={`h-11 w-11 flex items-center justify-center rounded-md border transition-colors ${line.service_date ? 'border-blue-300 dark:border-blue-700 text-blue-500' : 'border-neutral-200 dark:border-neutral-700 text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'}`}
                  >
                    <Calendar size={16} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Desktop grid layout */}
        <div className="hidden sm:block overflow-x-auto -mx-1 px-1">
        <div className="min-w-[560px]">
        <div className="grid gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 px-1" style={{ gridTemplateColumns: '16px 1fr 70px 80px 90px 60px 24px 32px' }}>
          <span /><span>{t('builder.description')}</span><span>{t('builder.qty')}</span><span>{t('builder.unit')}</span><span>{t('builder.price')}</span><span>{t('builder.vat')}</span><span /><span />
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
              <GripVertical size={14} aria-hidden="true" className="text-neutral-300 dark:text-neutral-600 cursor-grab shrink-0 mt-2.5" />
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
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 px-1">{t('builder.pageBreak')}</span>
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
                    placeholder={t('builder.sectionHeadingPlaceholder')}
                    aria-label={t('builder.sectionHeading')}
                    className="flex-1 min-w-0 text-base md:text-sm font-semibold bg-transparent border-0 border-b border-neutral-200 dark:border-neutral-700 px-1 py-1.5 focus:outline-none focus:border-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-600"
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
                    placeholder={t('builder.notePlaceholder')}
                    aria-label={t('builder.note')}
                    className="flex-1 min-w-0 text-base md:text-sm text-neutral-500 dark:text-neutral-400 bg-transparent border-0 border-b border-neutral-100 dark:border-neutral-800 px-1 py-1.5 focus:outline-none focus:border-neutral-300 dark:placeholder:text-neutral-600"
                  />
                  {deleteBtn(line.id)}
                </div>
              )
            }

            if (line.line_type === 'subtotal') {
              return (
                <div key={line.id} {...dragProps} className={`flex items-start gap-2 py-1.5 ${dragOverClass}`}>
                  {handle}
                  {sectionDiscount(line, idx)}
                  {deleteBtn(line.id)}
                </div>
              )
            }

            // item
            return (
              <div key={line.id} className={dragOverClass}>
                <div {...dragProps} className="grid gap-2 items-start" style={{ gridTemplateColumns: '16px 1fr 70px 80px 90px 60px 24px 32px' }}>
                  {handle}
                  <div className="relative min-w-0" onBlur={handleCatalogueBlur}>
                    <Input {...descriptionProps(line, false)} />
                    {cataloguePopup(line, false)}
                  </div>
                  <MoneyInput value={line.quantity} decimals={4} aria-label={t('builder.quantity')}
                    onValueChange={n => updateLine(line.id, { quantity: n ?? 0 })} />
                  <select value={line.unit} onChange={e => updateLine(line.id, { unit: e.target.value as Unit })} aria-label={t('builder.unit')} className={LINE_SELECT_CLS}>
                    {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
                  </select>
                  <MoneyInput value={line.unit_price} aria-label={t('builder.unitPrice')}
                    onValueChange={n => updateLine(line.id, { unit_price: n ?? 0 })} />
                  <select value={line.vat_rate} aria-label={t('builder.vatRate')}
                    onChange={e => updateLine(line.id, { vat_rate: parseInt(e.target.value) as VatRate })}
                    className={LINE_SELECT_CLS}>
                    {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={(e) => toggleDatePop(line.id, e)}
                    title={line.service_date ?? t('builder.setServiceDate')}
                    aria-label={line.service_date ? t('builder.serviceDateLabel', { date: line.service_date }) : t('builder.setServiceDate')}
                    aria-expanded={activeDateLine === line.id}
                    className={`h-9 w-6 flex items-center justify-center rounded-md transition-colors ${line.service_date ? 'text-blue-500' : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'}`}
                  >
                    <Calendar size={13} />
                  </button>
                  {deleteBtn(line.id)}
                </div>
              </div>
            )
          })}
        </div>
        </div>{/* end min-w */}
        </div>{/* end hidden sm:block overflow-x-auto */}

        {/* Add row controls */}
        <div className="flex items-center gap-1 pt-3 flex-wrap">
          <button type="button" onClick={() => addLine('item')}
            className="flex items-center gap-1.5 text-sm px-2.5 py-2 sm:py-1 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
            <Plus size={13} /> {t('builder.addLine')}
          </button>
          <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1.5" />
          {([
            ['heading', t('builder.heading')],
            ['text', t('builder.note')],
            ['separator', t('builder.divider')],
            ['subtotal', t('builder.subtotalLine')],
            ['page_break', t('builder.pageBreak')],
          ] as [LineType, string][]).map(([lt, label]) => (
            <button key={lt} type="button" onClick={() => addLine(lt as LineType)}
              className="text-xs px-2 py-2 sm:py-1 rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
              + {label}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      {/* Totals + discount */}
      <div className="flex sm:justify-end">
        <div className="w-full sm:w-72 space-y-1.5 text-sm">
          <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
            <span>{t('builder.net')}</span>
            <span>{formatMoney(totals.subtotal, currency)}</span>
          </div>

          {/* Discount */}
          {discountType ? (
            <div className="space-y-2 py-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-neutral-500 dark:text-neutral-400 text-xs shrink-0">{t('builder.discount')}</span>
                {/* % / flat toggle */}
                <div role="group" aria-label={t('builder.discountType')} className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden text-xs shrink-0">
                  <button type="button" aria-pressed={discountType === 'percent'} onClick={() => setDiscountType('percent')}
                    className={`px-2.5 py-1.5 sm:py-1 transition-colors ${discountType === 'percent' ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900' : 'bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'}`}>
                    %
                  </button>
                  <button type="button" aria-pressed={discountType === 'fixed'} onClick={() => setDiscountType('fixed')}
                    className={`px-2.5 py-1.5 sm:py-1 transition-colors ${discountType === 'fixed' ? 'bg-neutral-900 dark:bg-white text-white dark:text-neutral-900' : 'bg-white dark:bg-neutral-900 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'}`}>
                    {currency}
                  </button>
                </div>
                <MoneyInput value={discountValue} onValueChange={n => setDiscountValue(n ?? 0)} aria-label={t('builder.discountValue')} className="w-20 text-right" />
                <span className="flex-1 text-right text-neutral-500 dark:text-neutral-400">−{formatMoney(totals.discount_amount, currency)}</span>
                <button type="button" aria-label={t('builder.removeDiscount')} onClick={() => { setDiscountType(null); setDiscountValue(0) }} className={removeDiscountBtn}>
                  <X size={13} />
                </button>
              </div>
              {/* Quick % chips */}
              {discountType === 'percent' && (
                <div className="flex gap-1.5 justify-end flex-wrap">
                  {[5, 10, 15, 20, 25].map(p => (
                    <button key={p} type="button" aria-pressed={discountValue === p} onClick={() => setDiscountValue(p)} className={discountChip(discountValue === p)}>
                      {p}%
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => { setDiscountType('percent'); setDiscountValue(0) }}
              className="w-full text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 border border-dashed border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 rounded-md py-2 sm:py-1.5 transition-colors">
              + {t('builder.addDiscount')}
            </button>
          )}

          {taxTreatment === 'at_vat' && totals.vat_groups.map(g => (
            <div key={g.rate} className="flex justify-between text-neutral-500 dark:text-neutral-400">
              <span>{t('builder.vatLine', { rate: g.rate })}</span>
              <span>{formatMoney(g.amount, currency)}</span>
            </div>
          ))}
          <Separator />
          <div className="flex justify-between font-semibold text-base">
            <span>{t('builder.total')}</span>
            <span>{formatMoney(totals.total, currency)}</span>
          </div>
          {totals.total_paid > 0 && (
            <>
              <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
                <span>{t('builder.paid')}</span>
                <span>−{formatMoney(totals.total_paid, currency)}</span>
              </div>
              <div className={`flex justify-between font-semibold ${totals.balance_due > 0.005 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                <span>{t('builder.balanceDue')}</span>
                <span>{formatMoney(totals.balance_due, currency)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Notes */}
      <div>
        <p className={`${captionCls} mb-3`}>{t('builder.notes')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-notes`}>{t('builder.notesOnDocument')}</Label>
            <Textarea id={`${uid}-notes`} value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="resize-none" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-notes-internal`}>{t('builder.internalNotes')}</Label>
            <Textarea id={`${uid}-notes-internal`} value={notesInternal} onChange={e => setNotesInternal(e.target.value)} rows={3} className="resize-none" placeholder={t('builder.internalPlaceholder')} />
          </div>
        </div>
      </div>

      {/* Date popover */}
      {activeDateLine && datePop && (() => {
        const line = lines.find(l => l.id === activeDateLine && l.line_type === 'item')
        if (!line) return null
        const closeDatePop = () => { setActiveDateLine(null); setDatePop(null) }
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={closeDatePop} />
            <div
              role="dialog"
              aria-label={t('builder.serviceDate')}
              className="fixed z-50 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg p-3 space-y-2"
              style={datePop}
              onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeDatePop() } }}
            >
              <label htmlFor={`${uid}-service-date-${line.id}`} className="block text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('builder.serviceDate')}</label>
              <Input id={`${uid}-service-date-${line.id}`} type="date" value={line.service_date ?? ''}
                onChange={e => updateLine(line.id, { service_date: e.target.value || null })}
                className="w-44" autoFocus />
              {line.service_date && (
                <button type="button"
                  onClick={() => { updateLine(line.id, { service_date: null }); closeDatePop() }}
                  className="text-xs py-2 -my-1 text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                  {t('builder.clearDate')}
                </button>
              )}
            </div>
          </>
        )
      })()}

      {/* Sticky action bar — on phones it sits above the fixed bottom tab bar */}
      <div className="sticky bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] md:bottom-0 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t border-neutral-200 dark:border-neutral-700">
        {/* Mobile layout */}
        <div className="sm:hidden px-4 pt-3 pb-4 space-y-3">
          {/* Utility toolbar — segmented icon + label buttons */}
          <div className="flex rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden divide-x divide-neutral-200 dark:divide-neutral-700">
            <button type="button" onClick={downloadPdf}
              className="flex-1 flex flex-col items-center gap-1 py-2.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors">
              <Eye size={16} />
              <span className="text-[11px] font-medium">{t('builder.preview')}</span>
            </button>
            <button type="button" onClick={savePdf} disabled={saving}
              className="flex-1 flex flex-col items-center gap-1 py-2.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors disabled:opacity-50">
              <Download size={16} />
              <span className="text-[11px] font-medium">{t('builder.pdf')}</span>
            </button>
            {settings.gmail_connected && (
              <button type="button" onClick={saveToDrive} disabled={saving}
                className="flex-1 flex flex-col items-center gap-1 py-2.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors disabled:opacity-50">
                <HardDrive size={16} />
                <span className="text-[11px] font-medium">{t('builder.drive')}</span>
              </button>
            )}
            <button type="button" onClick={settings.gmail_connected ? sendViaGmail : openInEmail} disabled={saving}
              className="flex-1 flex flex-col items-center gap-1 py-2.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors disabled:opacity-50">
              <Mail size={16} />
              <span className="text-[11px] font-medium">{settings.gmail_connected ? t('builder.gmail') : t('builder.email')}</span>
            </button>
          </div>
          {/* Primary CTAs */}
          <div className="flex gap-2">
            {!doc && (
              <Button type="button" variant="outline" onClick={() => save('draft')} disabled={saving} className="flex-1 h-11 text-sm">
                {t('builder.saveDraft')}
              </Button>
            )}
            {(!doc || doc.status === 'draft') && (
              <Button type="button" onClick={requestSent} disabled={saving} className="flex-1 h-11 text-sm">
                {saving ? t('common.saving') : t('builder.markAsSent')}
              </Button>
            )}
          </div>
          {/* Auto-save status */}
          {doc && saveStatus && (
            <p aria-live="polite" className={`text-[11px] text-center -mt-1 ${saveStatus.cls || 'text-neutral-500 dark:text-neutral-400'}`}>
              {saveStatus.text}
            </p>
          )}
        </div>
        {/* Desktop layout */}
        <div className="hidden sm:flex items-center gap-3 px-6 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={downloadPdf} className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            <Eye size={13} /> {t('builder.preview')}
          </Button>
          <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700" />
          <Button type="button" variant="outline" size="sm" onClick={savePdf} disabled={saving} className="flex items-center gap-1.5">
            <Download size={13} /> {t('builder.downloadPdf')}
          </Button>
          {settings.gmail_connected && (
            <Button type="button" variant="outline" size="sm" onClick={saveToDrive} disabled={saving} className="flex items-center gap-1.5">
              <HardDrive size={13} /> {t('builder.saveToDrive')}
            </Button>
          )}
          {settings.gmail_connected ? (
            <Button type="button" variant="outline" size="sm" onClick={sendViaGmail} disabled={saving} className="flex items-center gap-1.5">
              <Mail size={13} /> {t('builder.sendViaGmail')}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={openInEmail} disabled={saving} className="flex items-center gap-1.5">
              <Mail size={13} /> {t('builder.sendViaSuperhuman')}
            </Button>
          )}
          <div className="flex-1" />
          {doc && saveStatus && (
            <span aria-live="polite" className={`text-xs mr-1 ${saveStatus.cls || 'text-neutral-500 dark:text-neutral-400'}`}>
              {saveStatus.text}
            </span>
          )}
          {!doc && (
            <Button type="button" variant="ghost" size="sm" onClick={() => save('draft')} disabled={saving}>
              {t('builder.saveDraft')}
            </Button>
          )}
          {(!doc || doc.status === 'draft') && (
            <Button type="button" size="sm" onClick={requestSent} disabled={saving}>
              {saving ? t('common.saving') : t('builder.markAsSent')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
