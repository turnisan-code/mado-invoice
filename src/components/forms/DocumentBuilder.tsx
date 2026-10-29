'use client'

import { useState, useRef, useEffect, useId, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { HardDrive, ChevronRight, Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { calcTotals, formatMoney, addDays, today, getTaxNote } from '@/lib/utils/document'
import { documentVariables, fillSubject, fillTemplate, parseEmailList, portalUrl, resolveTemplate, templateLang, usesVariable } from '@/lib/templates'
import { invoiceEmailTemplate } from '@/lib/document-labels'
import type { DocReference } from '@/lib/utils/document-reference'
import { pdf } from '@react-pdf/renderer'
import InvoiceDocument from '@/components/pdf/InvoiceDocument'
import { preparePdfFonts } from '@/components/pdf/fonts'
import { epcBeneficiary, generateEpcQr } from '@/lib/utils/epc-qr'
import type { EInvoiceErrorCode } from '@/lib/einvoice/common'
import { numberingErrorMessage } from '@/lib/utils/numbering'
import { issueProblems, missingIssuerFields, type IssueCheckInput } from '@/lib/utils/issue-checks'
import type { Client, CatalogueItem, DocumentType, IssueProblem, Language, TaxTreatment } from '@/types'
import type { PublicSettings } from '@/lib/public-settings'
import { toastApiError } from '@/lib/google/toast'
import { fetchIssuedPdf, blobToBase64, archiveErrorMessage } from '@/lib/issued-pdf'
import { logEvent } from '@/lib/events'
import { clientDisplayName } from '@/lib/utils/clients'
import { useT } from '@/lib/i18n/client'
import type { DictKey, TFn } from '@/lib/i18n'
import { ActionBar } from './builder/ActionBar'
import { ClientInfo } from './builder/ClientInfo'
import { ClientPicker, SELECT_CLS } from './builder/ClientPicker'
import { DateInput } from './builder/DateInput'
import { DeductionTotals } from './builder/DeductionTotals'
import { DepositPanel } from './builder/DepositPanel'
import { GmailDialog, type GmailPreview } from './builder/GmailDialog'
import { IssueDialog } from './builder/IssueDialog'
import { IssueProblemList } from './builder/IssueProblems'
import { LineEditor } from './builder/LineEditor'
import type { LineIssues } from './builder/LineRow'
import { PATHS, clientChangeTerms, docFields, expectedNumber, termDays, type EditorDocument, type FormState, type LineItem } from './builder/model'
import { QuickAddClient } from './builder/QuickAddClient'
import { RepriceDialog } from './builder/RepriceDialog'
import { useClientRates } from './builder/useClientRates'
import { TotalsPanel } from './builder/TotalsPanel'
import { useDeposits } from './builder/useDeposits'
import { errorMessage, useDocumentForm } from './builder/useDocumentForm'

interface Props {
  type: DocumentType
  settings: PublicSettings
  clients: Client[]
  catalogue: CatalogueItem[]
  document?: EditorDocument
  defaultClientId?: string
  reference?: DocReference | null
}

const EINVOICE_ERRORS: readonly EInvoiceErrorCode[] = ['not_issued', 'unsupported_type', 'currency', 'client_country', 'buyer_reference', 'buyer_endpoint', 'seller_endpoint']

async function postJson<T = Record<string, unknown>>(url: string, body?: object): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data as T
}

function notifyDriveUpload(t: TFn, webViewLink?: string | null, existing = false) {
  toast.success(
    webViewLink
      ? <span>{t(existing ? 'archive.driveExisting' : 'builder.driveUploaded')}<a href={webViewLink} target="_blank" rel="noopener" className="underline">{t('common.open')}</a></span>
      : t(existing ? 'archive.driveExistingPlain' : 'builder.driveUploadedPlain'),
    { duration: 5000 }
  )
}

function documentDiscount(f: Pick<FormState, 'discountType' | 'discountValue'>) {
  return f.discountType && f.discountValue > 0 ? { type: f.discountType, value: f.discountValue } : null
}

export default function DocumentBuilder({ type, settings, clients: clientList, catalogue, document: doc, defaultClientId, reference }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const { t, lang } = useT()
  const uid = useId()

  // Clients created from the picker join the list without reloading the page.
  const [addedClients, setAddedClients] = useState<Client[]>([])
  const clients = useMemo(
    () => [...clientList, ...addedClients.filter(a => !clientList.some(c => c.id === a.id))],
    [clientList, addedClients],
  )
  const editor = useDocumentForm({ type, settings, clients, doc, defaultClientId })
  const { form, formKey, patch, setLines, updateLine, formRef, docIdRef, savedKeyRef, issuingRef, saving, setSaving, serialized, cancelAutoSave } = editor
  const { clientId, date, dueDate, language, currency, taxTreatment, notes, notesInternal, discountType, discountValue, skontoPercent, skontoDays, lines } = form

  const [catalogueItems, setCatalogueItems] = useState<CatalogueItem[]>(catalogue)
  const clientRates = useClientRates(clientId, catalogueItems, setLines)
  const [showDetails, setShowDetails] = useState(false)
  const [quickAdd, setQuickAdd] = useState<string | null>(null)
  const [gmailPreview, setGmailPreview] = useState<GmailPreview | null>(null)
  const [gmailSending, setGmailSending] = useState(false)
  const [pendingIssue, setPendingIssue] = useState<{ run: (overrides: Partial<FormState> | null) => Promise<void>; staleDate: string | null; zeroTotal: string | null } | null>(null)
  const [latestIssued, setLatestIssued] = useState<{ number: string; date: string } | null>(null)
  const [checking, setChecking] = useState(false)
  // What the server refused, for the form state it checked; any edit clears it.
  const [serverProblems, setServerProblems] = useState<{ key: string; problems: IssueProblem[] } | null>(null)
  const [revealTick, setRevealTick] = useState(0)
  const problemsRef = useRef<HTMLDivElement>(null)

  if (serverProblems && serverProblems.key !== formKey) setServerProblems(null)

  // A credit note without a reference of its own prints its invoice's (fetchBuyerReference).
  const sourceId = type === 'credit_note' ? doc?.cancels_document_id ?? doc?.converted_from_id ?? null : null
  const [sourceReference, setSourceReference] = useState<string | null>(null)
  useEffect(() => {
    if (!sourceId) return
    let live = true
    void createClient().from('documents').select('buyer_reference').eq('id', sourceId).maybeSingle()
      .then(({ data }) => { if (live) setSourceReference(data?.buyer_reference?.trim() || null) })
    return () => { live = false }
  }, [sourceId])

  const client = clients.find(c => c.id === clientId)
  // Printed while the field is empty, unless the reference was cleared on purpose ('').
  const defaultReference = sourceReference ?? (client?.buyer_reference?.trim() || null)
  const totals = calcTotals(lines, doc?.payments, documentDiscount(form), taxTreatment)
  const taxNote = getTaxNote(taxTreatment, language as 'de' | 'en', settings)
  // A final invoice's deduction lines stay below the lines being edited; the totals panel shows
  // the whole service, the deduction block what remains.
  const deposits = useDeposits({ type, doc, docId: editor.docId, form, setLines, setKind: k => editor.applyOverrides({ invoiceKind: k }), flush: editor.flush })
  // A final invoice and the invoices it deducts belong to one client.
  const clientLocked = deposits.linked.length > 0 || !!deposits.self?.final_invoice_id
  const isDeduction = (l: LineItem) => l.line_type === 'deduction'
  const scopeLines = lines.filter(l => !isDeduction(l))
  const hasDeductions = scopeLines.length < lines.length
  const setScopeLines = (fn: (ls: LineItem[]) => LineItem[]) => setLines(ls => [...fn(ls.filter(l => !isDeduction(l))), ...ls.filter(isDeduction)])
  const scopeTotals = hasDeductions ? calcTotals(scopeLines, [], documentDiscount(form), taxTreatment) : totals
  // Issued documents stay editable; a changed amount is pointed out, never blocked. The issued
  // total is the amount the PDF asks for, after any deductions.
  const issuedTotal = doc?.number && doc.issued_total != null ? Number(doc.issued_total) : null
  const issuedTotalChanged = issuedTotal != null && Math.abs(totals.total - issuedTotal) >= 0.005

  function handleClientChange(id: string, picked?: Client) {
    const c = picked ?? clients.find(cl => cl.id === id)
    // A new client brings its language, tax treatment and terms along.
    patch({
      clientId: id,
      ...(c?.language ? { language: c.language } : {}),
      ...(c ? { taxTreatment: c.tax_treatment as TaxTreatment } : {}),
      ...(c && !doc?.number ? clientChangeTerms(type, settings, form, client, c) : {}),
    })
    if (!doc?.number) void clientRates.clientChanged(clientId, id, clientDisplayName(c), lines)
  }

  // The actions that run after issuing read the latest render's email content.
  const emailContent = useRef(buildEmailContent)
  useEffect(() => { emailContent.current = buildEmailContent })

  useEffect(() => {
    if (revealTick) problemsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [revealTick])

  // ─── Issuing ───────────────────────────────────────────────────────────────

  function checkInput(f: FormState): IssueCheckInput {
    return {
      type,
      currency: f.currency,
      taxTreatment: f.taxTreatment,
      serviceDate: f.serviceDate || null,
      serviceDateEnd: f.serviceDateEnd || null,
      isStorno: !!doc?.cancels_document_id,
      client: clients.find(c => c.id === f.clientId) ?? null,
      items: f.lines,
      settings,
      deposit: deposits.check,
    }
  }

  const liveProblems = checking && !doc?.number ? issueProblems(checkInput(form)) : []
  const shownProblems = liveProblems.length ? liveProblems
    : checking && serverProblems?.key === formKey ? serverProblems.problems : []
  const missingIssuer = missingIssuerFields(settings)
  const issuerFieldList = (fields: string[]) => fields.map(f => t(`issueChecks.issuerFields.${f}` as DictKey)).join(', ')
  const periodProblem = (p: IssueProblem) => (p.code === 'periodStartMissing' || p.code === 'periodEndBeforeStart') && p.index == null

  function lineIssues(idx: number): LineIssues {
    const codes = new Set(shownProblems.filter(p => 'index' in p && p.index === idx).map(p => p.code))
    const undated = shownProblems.some(p => p.code === 'noServiceDate') && !lines[idx]?.service_date
    return {
      description: codes.has('blankDescription'),
      quantity: codes.has('badQuantity'),
      price: codes.has('missingPrice'),
      date: undated || codes.has('periodStartMissing') || codes.has('periodEndBeforeStart'),
      discount: codes.has('badDiscount'),
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

  async function buildPdfBlob(numOverride?: string, includeQr = false) {
    if (!client) { toast.error(t('builder.selectClientFirst')); return null }
    const f = formRef.current
    const { date: effectiveDate, skonto_percent, skonto_days } = docFields(type, f)
    const docData = {
      number: numOverride ?? doc?.number ?? 'DRAFT',
      date: effectiveDate, service_date: f.serviceDate || null, service_date_end: f.serviceDateEnd || null, due_date: f.dueDate || null,
      type, invoice_kind: f.invoiceKind, language: f.language, currency, tax_treatment: f.taxTreatment,
      notes: f.notes || null, tax_note: getTaxNote(f.taxTreatment, f.language, settings),
      discount_type: f.discountType, discount_value: f.discountValue || null,
      skonto_percent, skonto_days,
      items: f.lines.map(l => ({ ...l })),
      totals,
      // Names applied credit notes, Skonto and write-offs in the summary, as the issued PDF does.
      payments: doc?.payments ?? [],
      reference: reference ?? null,
      // As the server resolves it: its own, else the corrected invoice's, else the client's default.
      buyer_reference: f.buyerReference != null ? f.buyerReference.trim() || null : defaultReference,
    }

    // Generate EPC QR only for final PDFs (save/send), not preview
    let qrCodeDataUri: string | null = null
    // EUR only, with the account holder as beneficiary, exactly as the issued PDF (render.ts).
    if (includeQr && type === 'invoice' && currency === 'EUR' && settings.iban && totals.balance_due > 0) {
      qrCodeDataUri = await generateEpcQr({
        bic: settings.bic ?? '',
        name: epcBeneficiary(settings),
        iban: settings.iban,
        amountEur: totals.balance_due,
        reference: docData.number,
      })
    }

    try {
      await preparePdfFonts()
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

  // Issuing froze the PDF and archived it to Drive on the server; a failure there never undoes
  // the issue, it is only reported (the page then offers to create the archive copy).
  function reportArchive(result: IssueResponse) {
    if (result.snapshotError) toast.error(t('messages.archiveLater'))
    if (result.driveError) toastApiError(t, result.driveError, t('builder.driveFailedPrefix'))
    else if (result.drive) notifyDriveUpload(t, result.drive.webViewLink, result.drive.existing)
  }

  // Persists, then issues server-side: number + status 'sent' (issue_document), the frozen PDF
  // and the Drive archive. Re-entrant calls are ignored.
  async function issueDocument(overrides: Partial<FormState> | null): Promise<Issued | null> {
    if (doc?.number) return { number: doc.number, id: doc.id, isNew: false, driveArchived: false, driveFailed: false }
    if (issuingRef.current) return null
    issuingRef.current = true
    cancelAutoSave()
    if (overrides) editor.applyOverrides(overrides)
    const f = formRef.current
    setSaving(true)
    try {
      return await serialized(async () => {
        let id: string
        try {
          id = await editor.persist(f, 'issue')
        } catch (e) {
          toast.error(errorMessage(e, t('common.unknownError')))
          return null
        }
        const res = await fetch(`/api/documents/${id}/issue`, { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (res.status === 422 && Array.isArray(data.problems)) {
          setServerProblems({ key: savedKeyRef.current, problems: data.problems as IssueProblem[] })
          setChecking(true)
          setRevealTick(n => n + 1)
          return null
        }
        if (!res.ok) {
          toast.error(numberingErrorMessage({ code: data.code, message: typeof data.error === 'string' && data.error ? data.error : res.statusText, details: data.details }, t))
          return null
        }
        const result = data as IssueResponse
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

  async function loadLatestIssued() {
    let q = supabase.from('documents').select('number, date').eq('type', type).not('number', 'is', null)
    if (docIdRef.current) q = q.neq('id', docIdRef.current)
    const { data } = await q.order('date', { ascending: false }).limit(1).maybeSingle()
    if (data?.number) setLatestIssued({ number: data.number, date: data.date })
  }

  // Issued documents run the action directly. Drafts are checked first (problems are shown inline,
  // never issued), then confirmed, because issuing consumes the next number and marks them sent.
  function withIssued(action: (issued: Issued) => Promise<void>) {
    const run = async (overrides: Partial<FormState> | null) => {
      const issued = await issueDocument(overrides)
      if (!issued) return
      // A freshly issued document navigates away when the action finishes; keep the toolbar
      // locked until then so a second click cannot create and issue another document.
      if (issued.isNew) setSaving(true)
      try { await action(issued) } finally { if (issued.isNew) setSaving(false) }
    }
    if (doc?.number) { void run(null); return }
    const f = formRef.current
    const problems = issueProblems(checkInput(f))
    setServerProblems(null)
    setChecking(problems.length > 0)
    if (problems.length) {
      // On phones the document's service date sits in the collapsed details.
      if (problems.some(p => p.code === 'noServiceDate' || periodProblem(p))) setShowDetails(true)
      setRevealTick(n => n + 1)
      return
    }
    const effectiveDate = f.date || today()
    // A zero total is allowed but asked about; a negative one is refused above.
    const total = calcTotals(f.lines, [], documentDiscount(f), f.taxTreatment).total
    setLatestIssued(null)
    setPendingIssue({ run, staleDate: effectiveDate < today() ? effectiveDate : null, zeroTotal: total === 0 ? formatMoney(0, currency) : null })
    void loadLatestIssued()
  }

  // A stale draft is issued with today's date by default; an invoice's or quote's due date follows
  // the client's terms, a credit note keeps its own.
  function staleOverrides(): { date: string; dueDate?: string } {
    const d = today()
    return type === 'credit_note' ? { date: d } : { date: d, dueDate: addDays(d, termDays(type, settings, client)) }
  }

  function confirmIssue(useToday: boolean) {
    const p = pendingIssue
    if (!p) return
    setPendingIssue(null)
    void p.run(p.staleDate && useToday ? staleOverrides() : null)
  }

  function afterIssue(issued: Issued) {
    if (issued.isNew) router.replace(`/${PATHS[type]}/${issued.id}`)
    else router.refresh()
  }

  // The server uploads the stored copy and never overwrites: an archived file comes back as is.
  async function saveIssuedToDrive(documentId: string) {
    const res = await fetch(`/api/documents/${documentId}/drive-pdf`, { method: 'POST' }).catch(() => null)
    if (!res) { toast.error(`${t('builder.driveFailedPrefix')}${t('messages.network')}`); return }
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
      if (blob) triggerDownload(blob, `${issued.number}.pdf`)
      afterIssue(issued)
    })
  }

  // The document's template in its own language; {{portal_link}} creates the share link on first use.
  async function buildEmailContent(issued: { id: string; number: string }) {
    if (!client) return null
    const lang = templateLang(language)
    const tpl = type === 'invoice' ? invoiceEmailTemplate(settings, form.invoiceKind, lang) : resolveTemplate(settings, type, lang)
    let portalLink = ''
    if (usesVariable(tpl.subject, 'portal_link') || usesVariable(tpl.body, 'portal_link')) {
      try {
        const { token } = await postJson<{ token: string }>(`/api/documents/${issued.id}/share`)
        portalLink = portalUrl(window.location.origin, token)
      } catch {
        toast.error(t('dunning.portalLinkFailed'))
      }
    }
    const vars = documentVariables({
      doc: {
        type, number: issued.number, date, due_date: dueDate || null, language: lang, currency,
        skonto_percent: skontoPercent === '' ? null : skontoPercent,
        skonto_days: skontoDays === '' ? null : skontoDays,
      },
      client,
      issuer: settings,
      totals,
      portalLink,
    })
    return { subject: fillSubject(tpl.subject, vars), body: fillTemplate(tpl.body, vars) }
  }

  function openInEmail() {
    if (!client) { toast.error(t('builder.selectClientFirst')); return }
    if (!client.email) { toast.error(t('builder.clientNoEmail')); return }
    withIssued(async issued => {
      const content = await emailContent.current(issued)
      const blob = await issuedPdf(issued)
      if (!content || !blob) { afterIssue(issued); return }
      triggerDownload(blob, `${issued.number}.pdf`)
      const cc = parseEmailList(client.cc_emails).emails
      Object.assign(document.createElement('a'), {
        href: `mailto:${client.email}?${cc.length ? `cc=${encodeURIComponent(cc.join(','))}&` : ''}subject=${encodeURIComponent(content.subject)}&body=${encodeURIComponent(content.body)}`,
      }).click()
      await logEvent(supabase, issued.id, 'mailto_opened', { to: client.email, subject: content.subject })
      afterIssue(issued)
    })
  }

  function sendViaGmail() {
    if (!client) { toast.error(t('builder.selectClientFirst')); return }
    if (!client.email) { toast.error(t('builder.clientNoEmail')); return }
    withIssued(async issued => {
      const content = await emailContent.current(issued)
      const blob = await issuedPdf(issued)
      if (!content || !blob) { afterIssue(issued); return }
      const driveArchived = issued.driveArchived || !!doc?.drive_file_id
      // Invoices and credit notes in EUR can go out as e-invoices too, to clients who want them.
      const einvoiceFormat = type !== 'quote' && currency === 'EUR' ? client.einvoice_format ?? null : null
      // The PDF is the frozen one, the XML follows the current data: after a change they differ,
      // so the XML is only attached when the owner ticks it.
      const totalChange = einvoiceFormat && issuedTotal != null && issuedTotalChanged
        ? { issued: formatMoney(issuedTotal, currency), current: formatMoney(totals.total, currency) }
        : null
      setGmailPreview({
        to: client.email, cc: parseEmailList(client.cc_emails).emails.join(', '), bcc: '',
        subject: content.subject, body: content.body,
        pdfBase64: await blobToBase64(blob), filename: `${issued.number}.pdf`,
        documentId: issued.id, newDocId: issued.isNew ? issued.id : undefined,
        uploadToDrive: !!settings.drive_folder_id && !driveArchived, driveArchived,
        einvoiceFormat, attachEInvoice: !!einvoiceFormat && !totalChange, totalChange, einvoiceError: null,
      })
    })
  }

  async function confirmSendViaGmail() {
    if (!gmailPreview) return
    setGmailSending(true)
    // The e-invoice is built from the stored document: edits still waiting for the autosave first.
    if (gmailPreview.attachEInvoice) await editor.flush()
    const res = await fetch('/api/gmail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...gmailPreview, einvoice: gmailPreview.attachEInvoice ? gmailPreview.einvoiceFormat : null }),
    })
    setGmailSending(false)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      if (data.einvoice) {
        // Nothing was sent; the dialog says why next to the checkbox.
        const code = EINVOICE_ERRORS.find(c => c === data.code)
        const reason = code ? t(`einvoice.errors.${code}`) : String(data.error ?? '')
        setGmailPreview(p => p && { ...p, einvoiceError: reason })
      } else {
        toastApiError(t, data, '', t('builder.emailFailed'))
      }
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
    if (newDocId) router.replace(`/${PATHS[type]}/${newDocId}`)
    else router.refresh()
  }

  function requestSent() {
    withIssued(async issued => {
      toast.success(t('builder.issued', { number: issued.number }))
      afterIssue(issued)
    })
  }

  const captionCls = 'text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider'
  const nextNumber = doc?.number ? '' : expectedNumber(settings, type, date || today())
  const restoreTime = editor.restoreOffer
    ? new Date(editor.restoreOffer.savedAt).toLocaleString(lang === 'de' ? 'de-AT' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
    : ''

  return (
    <div className="space-y-6">
      <GmailDialog
        preview={gmailPreview}
        setPreview={setGmailPreview}
        sending={gmailSending}
        driveConfigured={settings.drive_configured}
        onClose={closeGmailPreview}
        onSend={() => void confirmSendViaGmail()}
      />

      <IssueDialog
        open={!!pendingIssue}
        type={type}
        staleDate={pendingIssue?.staleDate ?? null}
        draftDate={date || today()}
        todayDue={type === 'invoice' && pendingIssue?.staleDate ? staleOverrides().dueDate ?? null : null}
        latestIssued={latestIssued}
        numberFor={d => expectedNumber(settings, type, d)}
        zeroTotal={pendingIssue?.zeroTotal ?? null}
        onConfirm={confirmIssue}
        onCancel={() => setPendingIssue(null)}
      />

      <RepriceDialog offer={clientRates.offer} currency={currency} onApply={clientRates.applyOffer} onCancel={clientRates.dismissOffer} />

      <QuickAddClient
        open={quickAdd !== null}
        initialName={quickAdd ?? ''}
        settings={settings}
        language={language}
        onClose={() => setQuickAdd(null)}
        onCreated={c => {
          setAddedClients(list => [...list, c])
          setQuickAdd(null)
          handleClientChange(c.id, c)
        }}
      />

      {editor.restoreOffer && (
        <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900 px-4 py-3 text-sm text-blue-800 dark:text-blue-300 flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="flex-1">{t('issueChecks.restoreBody', { time: restoreTime })}</p>
          <div className="flex gap-2 shrink-0">
            <Button type="button" size="sm" onClick={editor.restoreBackup} className="h-9 sm:h-8">{t('issueChecks.restore')}</Button>
            <Button type="button" variant="outline" size="sm" onClick={editor.discardBackup} className="h-9 sm:h-8 bg-white dark:bg-neutral-900">{t('issueChecks.discard')}</Button>
          </div>
        </div>
      )}

      {!doc?.number && missingIssuer.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="flex-1">{t('issueChecks.settingsBanner', { fields: issuerFieldList(missingIssuer) })}</p>
          <Link href="/settings" className="shrink-0 self-start sm:self-auto text-sm font-medium underline underline-offset-2 py-2 -my-2">{t('issueChecks.openSettings')}</Link>
        </div>
      )}

      {doc?.number && doc.status !== 'draft' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <strong>{t('builder.issuedWarning', { number: doc.number })}</strong> {t('builder.issuedWarningBody')}
        </div>
      )}

      {issuedTotalChanged && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <strong>{t('print.issuedTotal.changed', { issued: formatMoney(issuedTotal, currency), current: formatMoney(totals.total, currency) })}</strong>{' '}
          {t(type === 'quote' ? 'print.issuedTotal.changedHintQuote' : 'print.issuedTotal.changedHint')}{type === 'invoice' && ` ${t('print.issuedTotal.stornoHint')}`}
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

        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-client`}>{t('builder.client')}</Label>
          <ClientPicker id={`${uid}-client`} clients={clients} value={clientId} onChange={id => handleClientChange(id)}
            onCreate={name => setQuickAdd(name)} invalid={shownProblems.some(p => p.code === 'noClient')}
            disabled={clientLocked} describedBy={clientLocked ? `${uid}-client-locked` : undefined} />
          {clientLocked && <p id={`${uid}-client-locked`} className="text-xs text-neutral-500 dark:text-neutral-400">{t('deposits.builder.clientLocked')}</p>}
          {client && <ClientInfo client={client} settings={settings} />}
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-col sm:flex-row gap-3">
            <div role="group" aria-labelledby={`${uid}-number`} className="flex-1 min-w-0 space-y-1.5">
              <span id={`${uid}-number`} className="block text-sm leading-none font-medium">{t('issueChecks.number')}</span>
              <p className={`h-10 flex items-center px-3 rounded-lg border border-dashed border-neutral-200 dark:border-neutral-700 text-sm ${doc?.number ? '' : 'text-neutral-500 dark:text-neutral-400'}`}>
                <span className="truncate">
                  {doc?.number ?? (nextNumber ? `${t('issueChecks.numberDraft')} · ${t('issueChecks.numberNext', { number: nextNumber })}` : t('issueChecks.numberDraft'))}
                </span>
              </p>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={`${uid}-date`}>{t('builder.date')}</Label>
              <DateInput id={`${uid}-date`} value={date} onValueChange={v => patch({ date: v })} className="h-10 w-full" />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={`${uid}-due`}>{type === 'invoice' ? t('builder.dueDate') : t('builder.validUntil')}</Label>
              <DateInput id={`${uid}-due`} value={dueDate} onValueChange={v => patch({ dueDate: v })} className="h-10 w-full" />
            </div>
          </div>
          {!doc?.number && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('issueChecks.numberHint')}</p>}
        </div>

        {/* Details: collapsed on phones, always shown from sm */}
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
              <select id={`${uid}-language`} value={language} onChange={e => patch({ language: e.target.value as Language })} className={SELECT_CLS}>
                <option value="de">{t('common.german')}</option>
                <option value="en">{t('common.english')}</option>
              </select>
            </div>
            <div role="group" aria-labelledby={`${uid}-currency`} aria-describedby={currency !== 'EUR' ? `${uid}-currency-note` : undefined} className="space-y-1.5">
              <span id={`${uid}-currency`} className="block text-sm leading-none font-medium">{t('builder.currency')}</span>
              <p className={`${SELECT_CLS} text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-800/50`}>
                {currency}
              </p>
              {currency !== 'EUR' && <p id={`${uid}-currency-note`} className="text-xs text-neutral-500 dark:text-neutral-400">{t('issueChecks.currencyLegacy')}</p>}
            </div>
            <div className="col-span-2 sm:col-span-1 space-y-1.5">
              <Label htmlFor={`${uid}-tax`}>{t('builder.taxTreatment')}</Label>
              <select id={`${uid}-tax`} value={taxTreatment} onChange={e => patch({ taxTreatment: e.target.value as TaxTreatment })} className={SELECT_CLS}>
                <option value="at_vat">{t('taxTreatments.at_vat')}</option>
                <option value="eu_reverse_charge">{t('taxTreatments.eu_reverse_charge')}</option>
                <option value="non_eu">{t('taxTreatments.non_eu')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-service-from`}>{t('builder.serviceFrom')}</Label>
              <DateInput id={`${uid}-service-from`} value={form.serviceDate} onValueChange={v => patch({ serviceDate: v })}
                aria-invalid={shownProblems.some(p => p.code === 'noServiceDate' || periodProblem(p)) || undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-service-to`}>{t('builder.serviceTo')}</Label>
              <DateInput id={`${uid}-service-to`} value={form.serviceDateEnd} min={form.serviceDate || undefined} onValueChange={v => patch({ serviceDateEnd: v })}
                aria-invalid={shownProblems.some(p => p.code === 'periodEndBeforeStart' && p.index == null) || undefined} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor={`${uid}-buyer-reference`}>{t('einvoice.buyerReference')}</Label>
              <Input id={`${uid}-buyer-reference`} value={form.buyerReference ?? ''} autoComplete="off"
                placeholder={form.buyerReference == null ? defaultReference ?? '' : ''}
                aria-describedby={`${uid}-buyer-reference-hint`}
                onChange={e => patch({ buyerReference: e.target.value.trim() ? e.target.value : null })} />
              <p id={`${uid}-buyer-reference-hint`} className="text-xs text-neutral-500 dark:text-neutral-400">
                {t(type === 'quote' ? 'print.builder.buyerReferenceHintQuote' : 'print.builder.buyerReferenceHint')}
                {/* null follows the default, '' prints none: both look empty, so the hint says which. */}
                {defaultReference && !form.buyerReference?.trim() && (
                  <>
                    {' '}{form.buyerReference == null ? t('print.builder.referenceDefault', { reference: defaultReference }) : t('print.builder.referenceNone')}{' '}
                    <button type="button" onClick={() => patch({ buyerReference: form.buyerReference == null ? '' : null })}
                      className="py-2 -my-2 underline underline-offset-2 text-neutral-700 dark:text-neutral-200 hover:text-neutral-900 dark:hover:text-white">
                      {form.buyerReference == null ? t('print.builder.printNone') : t('print.builder.useDefault')}
                    </button>
                  </>
                )}
              </p>
            </div>
            {type === 'invoice' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-skonto-percent`}>{t('builder.skontoPercent')}</Label>
                  <MoneyInput id={`${uid}-skonto-percent`} value={skontoPercent === '' ? null : skontoPercent} placeholder={t('builder.skontoNone')}
                    onValueChange={n => patch({ skontoPercent: n === null ? '' : n })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-skonto-days`}>{t('builder.skontoDays')}</Label>
                  <MoneyInput id={`${uid}-skonto-days`} integer value={skontoDays === '' ? null : skontoDays} placeholder={t('builder.skontoFromDate')}
                    onValueChange={n => patch({ skontoDays: n === null ? '' : n })} />
                </div>
              </>
            )}
          </div>
        </div>

        {taxNote && (
          <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2">
            <span className="font-medium">{t('issueChecks.taxNoteLabel')}</span> {taxNote}
          </div>
        )}

        <DepositPanel deposits={deposits} kind={form.invoiceKind} onKind={k => patch({ invoiceKind: k })}
          docId={editor.docId} issued={!!doc?.number} currency={currency} />
      </div>

      <Separator />

      <LineEditor
        lines={scopeLines}
        setLines={setScopeLines}
        updateLine={updateLine}
        settings={settings}
        currency={currency}
        language={language}
        vatApplies={taxTreatment === 'at_vat'}
        lineIssues={lineIssues}
        catalogue={catalogueItems}
        clientRates={clientRates.rates}
        onCatalogueItemCreated={item => setCatalogueItems(prev => [...prev, item])}
      />

      <Separator />

      <TotalsPanel
        totals={scopeTotals}
        currency={currency}
        taxTreatment={taxTreatment}
        discountType={discountType}
        discountValue={discountValue}
        onDiscount={(kind, value) => patch({ discountType: kind, discountValue: value })}
      />
      {hasDeductions && (
        <DeductionTotals lines={lines} totals={totals} currency={currency} taxTreatment={taxTreatment}
          discountType={discountType} discountValue={discountValue} creditNote={type === 'credit_note'}
          onRemove={type === 'credit_note' && !doc?.number ? () => setLines(ls => ls.filter(l => !isDeduction(l))) : undefined} />
      )}

      {/* Notes */}
      <div>
        <p className={`${captionCls} mb-3`}>{t('builder.notes')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-notes`}>{t('builder.notesOnDocument')}</Label>
            <Textarea id={`${uid}-notes`} value={notes} onChange={e => patch({ notes: e.target.value })} rows={3} className="resize-none" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-notes-internal`}>{t('builder.internalNotes')}</Label>
            <Textarea id={`${uid}-notes-internal`} value={notesInternal} onChange={e => patch({ notesInternal: e.target.value })} rows={3} className="resize-none" placeholder={t('builder.internalPlaceholder')} />
          </div>
        </div>
      </div>

      {/* Why the document cannot be issued yet; updates while the problems are fixed */}
      {shownProblems.length > 0 && (
        <div ref={problemsRef} role="alert" className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-4 py-3 text-sm text-red-800 dark:text-red-300">
          <p className="font-medium">{t('issueChecks.title')}</p>
          <IssueProblemList problems={shownProblems} />
        </div>
      )}

      <ActionBar
        saving={saving}
        gmailConnected={settings.gmail_connected}
        saveStatus={editor.saveStatus}
        canSaveDraft={!doc}
        canIssue={!doc || doc.status === 'draft'}
        onPreview={() => void downloadPdf()}
        onDownload={savePdf}
        onDrive={saveToDrive}
        onEmail={settings.gmail_connected ? sendViaGmail : openInEmail}
        onSaveDraft={() => void editor.saveDraft()}
        onIssue={requestSent}
      />
    </div>
  )
}
