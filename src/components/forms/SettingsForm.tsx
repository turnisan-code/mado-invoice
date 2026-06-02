'use client'

import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { CheckCircle, Mail, HardDrive, ChevronRight, X, Building2, MapPin, CreditCard, Hash, FileText, Plug, SlidersHorizontal } from 'lucide-react'
import { DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE, DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN } from '@/lib/utils/reminder-templates'
import type { Settings } from '@/types'

interface Props { settings: Settings | null }

// ── Shared style tokens ────────────────────────────────────────────────────────
const inp = 'w-full h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500'
const lbl = 'text-xs font-medium text-neutral-500 dark:text-neutral-400'

// ── Variable chip sets ─────────────────────────────────────────────────────────
// Used in the PDF footer section (server-side substitution supports these)
const FOOTER_VARS = [
  { token: '{{invoice_number}}', label: 'Number' },
  { token: '{{date}}',           label: 'Date' },
  { token: '{{due_date}}',       label: 'Due date' },
  { token: '{{client}}',         label: 'Client' },
  { token: '{{subtotal}}',       label: 'Subtotal' },
  { token: '{{vat}}',            label: 'VAT' },
  { token: '{{total}}',          label: 'Total' },
  { token: '{{balance_due}}',    label: 'Balance due' },
]

// Used in email template sections (must match buildEmailContent vars exactly)
const EMAIL_VARS = [
  { token: '{{invoice_number}}', label: 'Invoice #' },
  { token: '{{client}}',         label: 'Client' },
  { token: '{{date}}',           label: 'Date' },
  { token: '{{due_date}}',       label: 'Due date' },
  { token: '{{total}}',          label: 'Total' },
  { token: '{{balance_due}}',    label: 'Balance due' },
  { token: '{{subtotal}}',       label: 'Subtotal' },
  { token: '{{company}}',        label: 'Your company' },
  { token: '{{owner}}',          label: 'Your name' },
]

const REMINDER_VARS = [
  { token: '{{invoice_number}}', label: 'Invoice #' },
  { token: '{{client}}',         label: 'Client' },
  { token: '{{date}}',           label: 'Invoice date' },
  { token: '{{due_date}}',       label: 'Due date' },
  { token: '{{balance_due}}',    label: 'Balance due' },
  { token: '{{days_overdue}}',   label: 'Days overdue' },
  { token: '{{iban}}',           label: 'IBAN' },
  { token: '{{company}}',        label: 'Your company' },
  { token: '{{owner}}',          label: 'Your name' },
]

// ── Doc type config ────────────────────────────────────────────────────────────
type DocType = 'invoice' | 'quote' | 'credit_note' | 'reminder'

const DOC_TABS: { type: DocType; label: string }[] = [
  { type: 'invoice',     label: 'Invoice' },
  { type: 'quote',       label: 'Quote' },
  { type: 'credit_note', label: 'Credit Note' },
  { type: 'reminder',    label: 'Reminder' },
]

// ── Sidebar nav items ──────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'company',      label: 'Company',      Icon: Building2 },
  { id: 'address',      label: 'Address',      Icon: MapPin },
  { id: 'banking',      label: 'Banking',      Icon: CreditCard },
  { id: 'numbering',    label: 'Numbering',    Icon: Hash },
  { id: 'defaults',     label: 'Defaults',     Icon: SlidersHorizontal },
  { id: 'footer',       label: 'PDF Footer',   Icon: FileText },
  { id: 'templates',    label: 'Email',        Icon: Mail },
  { id: 'integrations', label: 'Integrations', Icon: Plug },
] as const

// ── SectionCard ────────────────────────────────────────────────────────────────
function SectionCard({
  title,
  description,
  dirty,
  saving,
  onSave,
  children,
}: {
  title: string
  description?: string
  dirty: boolean
  saving: boolean
  onSave: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</p>
        {description && <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{description}</p>}
      </div>
      <div className="px-6 py-5 space-y-4">
        {children}
      </div>
      {dirty && (
        <div className="px-6 py-3 border-t border-neutral-100 dark:border-neutral-800 flex justify-end bg-neutral-50 dark:bg-neutral-800/50">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="h-8 px-4 text-xs font-medium rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── IntegrationCard ────────────────────────────────────────────────────────────
function IntegrationCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</p>
        <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{description}</p>
      </div>
      <div className="px-6 py-5">
        {children}
      </div>
    </div>
  )
}

// ── VarChips ──────────────────────────────────────────────────────────────────
function VarChips({ vars, onInsert }: { vars: { token: string; label: string }[]; onInsert: (token: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {vars.map(v => (
        <button
          key={v.token}
          type="button"
          onClick={() => onInsert(v.token)}
          className="text-xs px-2 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors font-mono"
        >
          {v.token}
        </button>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function SettingsForm({ settings }: Props) {
  const supabase = createClient()
  const searchParams = useSearchParams()

  // Per-section dirty tracking
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)

  function markDirty(section: string) {
    setDirty(d => ({ ...d, [section]: true }))
  }
  function clearDirty(section: string) {
    setDirty(d => ({ ...d, [section]: false }))
  }

  // ── Sidebar active section (tab-driven, no scroll) ──────────────────────────
  const [activeSection, setActiveSection] = useState<string>('company')

  // ── Brand state ──────────────────────────────────────────────────────────────
  const [logoUrl, setLogoUrl] = useState(settings?.logo_url ?? '')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [biz, setBiz] = useState({
    company_name: settings?.company_name ?? '',
    owner_name:   settings?.owner_name ?? '',
  })

  // ── Contact & Address state ──────────────────────────────────────────────────
  const [contact, setContact] = useState({
    email:         settings?.email ?? '',
    phone:         settings?.phone ?? '',
    website:       settings?.website ?? '',
    address_line1: settings?.address_line1 ?? '',
    address_line2: settings?.address_line2 ?? '',
    zip:           settings?.zip ?? '',
    city:          settings?.city ?? '',
    country:       settings?.country ?? 'Austria',
    uid_number:    settings?.uid_number ?? '',
  })

  // ── Banking state ────────────────────────────────────────────────────────────
  const [banking, setBanking] = useState({
    iban:      settings?.iban ?? '',
    bic:       settings?.bic ?? '',
    bank_name: settings?.bank_name ?? '',
  })

  // ── Documents state ──────────────────────────────────────────────────────────
  const [docs, setDocs] = useState({
    invoice_prefix:              settings?.invoice_prefix ?? 'R',
    quote_prefix:                settings?.quote_prefix ?? 'A',
    credit_note_prefix:          settings?.credit_note_prefix ?? 'G',
    next_invoice_number:         String(settings?.next_invoice_number ?? 1),
    next_quote_number:           String(settings?.next_quote_number ?? 1),
    next_credit_note_number:     String(settings?.next_credit_note_number ?? 1),
    invoice_number_format:       settings?.invoice_number_format ?? '{prefix}-{YYYY}-{NNN}',
    quote_number_format:         settings?.quote_number_format ?? '{prefix}-{YYYY}-{NNN}',
    credit_note_number_format:   settings?.credit_note_number_format ?? '{prefix}-{YYYY}-{NNN}',
  })

  // ── Defaults state ───────────────────────────────────────────────────────────
  const [defaults, setDefaults] = useState({
    default_payment_days: String(settings?.default_payment_days ?? 14),
    default_language:     settings?.default_language ?? 'de',
  })

  // ── Footer state ─────────────────────────────────────────────────────────────
  const [footerDocTab, setFooterDocTab] = useState<'invoice' | 'quote'>('invoice')
  const [footerDe, setFooterDe] = useState(settings?.invoice_footer_de ?? '')
  const [footerEn, setFooterEn] = useState(settings?.invoice_footer_en ?? '')
  const [quoteFooterDe, setQuoteFooterDe] = useState(settings?.quote_footer_de ?? '')
  const [quoteFooterEn, setQuoteFooterEn] = useState(settings?.quote_footer_en ?? '')

  // ── Email templates state ────────────────────────────────────────────────────
  const [emailTpl, setEmailTpl] = useState({
    invoice:     { subject_de: settings?.email_subject_invoice_de ?? '',     body_de: settings?.email_body_invoice_de ?? '',     subject_en: settings?.email_subject_invoice_en ?? '',     body_en: settings?.email_body_invoice_en ?? '' },
    quote:       { subject_de: settings?.email_subject_quote_de ?? '',       body_de: settings?.email_body_quote_de ?? '',       subject_en: settings?.email_subject_quote_en ?? '',       body_en: settings?.email_body_quote_en ?? '' },
    credit_note: { subject_de: settings?.email_subject_credit_note_de ?? '', body_de: settings?.email_body_credit_note_de ?? '', subject_en: settings?.email_subject_credit_note_en ?? '', body_en: settings?.email_body_credit_note_en ?? '' },
    reminder:    { subject_de: settings?.email_subject_reminder_de ?? '',    body_de: settings?.email_body_reminder_de ?? '',    subject_en: settings?.email_subject_reminder_en ?? '',    body_en: settings?.email_body_reminder_en ?? '' },
  })
  const [activeDocTab, setActiveDocTab] = useState<DocType>('invoice')
  const [activeLang, setActiveLang] = useState<'de' | 'en'>('de')

  // ── Integration state ────────────────────────────────────────────────────────
  const [gmailEmail, setGmailEmail] = useState(settings?.gmail_email ?? null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [driveFolder, setDriveFolder] = useState(settings?.drive_folder_id ?? '')
  const [driveFolderName, setDriveFolderName] = useState(settings?.drive_folder_name ?? '')
  const [savingDrive, setSavingDrive] = useState(false)
  const [driveDirty, setDriveDirty] = useState(false)
  const [bookamatUsername, setBookamatUsername] = useState(settings?.bookamat_username ?? '')
  const [bookamatApiKey, setBookamatApiKey] = useState(settings?.bookamat_api_key ?? '')
  const [bookamatCountry, setBookamatCountry] = useState(settings?.bookamat_country ?? 'at')
  const [bookamatBankId, setBookamatBankId] = useState<number | ''>(settings?.bookamat_bank_account_id ?? '')
  const [bookamatCostId, setBookamatCostId] = useState<number | ''>(settings?.bookamat_cost_account_id ?? '')
  const [bookamatVat0, setBookamatVat0] = useState<number | ''>(settings?.bookamat_vat_account_0 ?? '')
  const [bookamatVat10, setBookamatVat10] = useState<number | ''>(settings?.bookamat_vat_account_10 ?? '')
  const [bookamatVat13, setBookamatVat13] = useState<number | ''>(settings?.bookamat_vat_account_13 ?? '')
  const [bookamatVat20, setBookamatVat20] = useState<number | ''>(settings?.bookamat_vat_account_20 ?? '')
  const [bookamatAccounts, setBookamatAccounts] = useState<{
    bankAccounts: { id: number; title: string }[]
    costAccounts: { id: number; title: string }[]
    vatAccounts:  { id: number; title: string }[]
  } | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [savingBookamat, setSavingBookamat] = useState(false)

  // ── Last focused ref (for variable insertion) ────────────────────────────────
  const lastFocused = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; setter: (v: string) => void } | null>(null)

  function onFieldFocus(el: HTMLTextAreaElement | HTMLInputElement, setter: (v: string) => void) {
    lastFocused.current = { el, setter }
  }

  function insertVar(token: string) {
    const target = lastFocused.current
    if (!target) return
    const { el, setter } = target
    const start = el.selectionStart ?? el.value.length
    const end   = el.selectionEnd ?? start
    setter(el.value.slice(0, start) + token + el.value.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  // ── URL param handling ───────────────────────────────────────────────────────
  useEffect(() => {
    const status = searchParams.get('gmail')
    if (status === 'connected') toast.success('Gmail connected successfully.')
    if (status === 'error')     toast.error('Gmail connection failed. Please try again.')
  }, [searchParams])

  // ── Save functions ───────────────────────────────────────────────────────────
  async function saveBiz() {
    if (!settings) return
    setSaving('brand')
    const { error } = await supabase.from('settings').update({
      company_name: biz.company_name || null,
      owner_name:   biz.owner_name   || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('brand')
    toast.success('Brand saved.')
  }

  async function saveContact() {
    if (!settings) return
    setSaving('contact')
    const { error } = await supabase.from('settings').update({
      email:         contact.email         || null,
      phone:         contact.phone         || null,
      website:       contact.website       || null,
      address_line1: contact.address_line1 || null,
      address_line2: contact.address_line2 || null,
      zip:           contact.zip           || null,
      city:          contact.city          || null,
      country:       contact.country       || null,
      uid_number:    contact.uid_number    || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('contact')
    toast.success('Contact & address saved.')
  }

  async function saveBankingSection() {
    if (!settings) return
    setSaving('banking')
    const { error } = await supabase.from('settings').update({
      iban:      banking.iban      || null,
      bic:       banking.bic       || null,
      bank_name: banking.bank_name || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('banking')
    toast.success('Banking saved.')
  }

  async function saveDocsSection() {
    if (!settings) return
    setSaving('docs')
    const { error } = await supabase.from('settings').update({
      invoice_prefix:              docs.invoice_prefix,
      quote_prefix:                docs.quote_prefix,
      credit_note_prefix:          docs.credit_note_prefix,
      next_invoice_number:         parseInt(docs.next_invoice_number, 10) || 1,
      next_quote_number:           parseInt(docs.next_quote_number, 10) || 1,
      next_credit_note_number:     parseInt(docs.next_credit_note_number, 10) || 1,
      invoice_number_format:       docs.invoice_number_format || '{prefix}-{YYYY}-{NNN}',
      quote_number_format:         docs.quote_number_format || '{prefix}-{YYYY}-{NNN}',
      credit_note_number_format:   docs.credit_note_number_format || '{prefix}-{YYYY}-{NNN}',
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('docs')
    toast.success('Numbering saved.')
  }

  async function saveDefaults() {
    if (!settings) return
    setSaving('defaults')
    const { error } = await supabase.from('settings').update({
      default_payment_days: parseInt(defaults.default_payment_days, 10) || 14,
      default_language:     defaults.default_language,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('defaults')
    toast.success('Defaults saved.')
  }

  async function saveFooter() {
    if (!settings) return
    setSaving('footer')
    const { error } = await supabase.from('settings').update({
      invoice_footer_de: footerDe || null,
      invoice_footer_en: footerEn || null,
      quote_footer_de: quoteFooterDe || null,
      quote_footer_en: quoteFooterEn || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('footer')
    toast.success('Footer saved.')
  }

  async function saveTemplates() {
    if (!settings) return
    setSaving('templates')
    const { error } = await supabase.from('settings').update({
      email_subject_invoice_de:     emailTpl.invoice.subject_de     || null,
      email_body_invoice_de:        emailTpl.invoice.body_de        || null,
      email_subject_invoice_en:     emailTpl.invoice.subject_en     || null,
      email_body_invoice_en:        emailTpl.invoice.body_en        || null,
      email_subject_quote_de:       emailTpl.quote.subject_de       || null,
      email_body_quote_de:          emailTpl.quote.body_de          || null,
      email_subject_quote_en:       emailTpl.quote.subject_en       || null,
      email_body_quote_en:          emailTpl.quote.body_en          || null,
      email_subject_credit_note_de: emailTpl.credit_note.subject_de || null,
      email_body_credit_note_de:    emailTpl.credit_note.body_de    || null,
      email_subject_credit_note_en: emailTpl.credit_note.subject_en || null,
      email_body_credit_note_en:    emailTpl.credit_note.body_en    || null,
      email_subject_reminder_de:    emailTpl.reminder.subject_de    || null,
      email_body_reminder_de:       emailTpl.reminder.body_de       || null,
      email_subject_reminder_en:    emailTpl.reminder.subject_en    || null,
      email_body_reminder_en:       emailTpl.reminder.body_en       || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('templates')
    toast.success('Email templates saved.')
  }

  // ── Integration handlers ─────────────────────────────────────────────────────
  async function disconnectGmail() {
    setDisconnecting(true)
    await supabase.from('settings').update({
      gmail_email: null, gmail_access_token: null,
      gmail_refresh_token: null, gmail_token_expiry: null,
    }).eq('id', settings!.id)
    setGmailEmail(null)
    setDisconnecting(false)
    toast.success('Gmail disconnected.')
  }

  async function saveDriveFolder() {
    if (!settings) return
    setSavingDrive(true)
    const match = driveFolder.match(/[-\w]{25,}/)
    const folderId = match ? match[0] : driveFolder.trim()
    await supabase.from('settings').update({
      drive_folder_id:   folderId || null,
      drive_folder_name: folderId ? (driveFolderName || folderId) : null,
    }).eq('id', settings.id)
    setDriveFolder(folderId)
    setSavingDrive(false)
    setDriveDirty(false)
    toast.success(folderId ? 'Drive folder saved.' : 'Drive folder removed.')
  }

  async function loadBookamatAccounts() {
    if (!bookamatUsername || !bookamatApiKey) { toast.error('Enter username and API key first.'); return }
    setLoadingAccounts(true)
    const res = await fetch('/api/bookamat/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: bookamatUsername, apiKey: bookamatApiKey, country: bookamatCountry }),
    })
    setLoadingAccounts(false)
    if (!res.ok) { const { error } = await res.json().catch(() => ({})); toast.error(error ?? 'Failed to load accounts.'); return }
    const data = await res.json()
    setBookamatAccounts(data)
  }

  async function saveBookamat() {
    if (!settings) return
    setSavingBookamat(true)
    const { error } = await supabase.from('settings').update({
      bookamat_username:        bookamatUsername || null,
      bookamat_api_key:         bookamatApiKey   || null,
      bookamat_country:         bookamatCountry,
      bookamat_bank_account_id: bookamatBankId   || null,
      bookamat_cost_account_id: bookamatCostId   || null,
      bookamat_vat_account_0:   bookamatVat0     || null,
      bookamat_vat_account_10:  bookamatVat10    || null,
      bookamat_vat_account_13:  bookamatVat13    || null,
      bookamat_vat_account_20:  bookamatVat20    || null,
    }).eq('id', settings.id)
    setSavingBookamat(false)
    if (error) { toast.error(error.message); return }
    setBookamatAccounts(null)
    toast.success('Bookamat connected.')
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingLogo(true)
    const ext = file.name.split('.').pop()
    const path = `logo.${ext}`
    const { error } = await supabase.storage.from('logos').upload(path, file, { upsert: true })
    if (error) { toast.error(error.message); setUploadingLogo(false); return }
    const { data } = supabase.storage.from('logos').getPublicUrl(path)
    const url = `${data.publicUrl}?t=${Date.now()}`
    await supabase.from('settings').update({ logo_url: url }).eq('id', settings!.id)
    setLogoUrl(url)
    setUploadingLogo(false)
    toast.success('Logo uploaded.')
  }

  async function removeLogo() {
    if (!settings) return
    await supabase.from('settings').update({ logo_url: null }).eq('id', settings.id)
    setLogoUrl('')
    toast.success('Logo removed.')
  }

  // ── Email template helpers ───────────────────────────────────────────────────
  function setTplField(docType: DocType, field: string, value: string) {
    setEmailTpl(t => ({ ...t, [docType]: { ...t[docType], [field]: value } }))
    markDirty('templates')
  }

  const tpl = emailTpl[activeDocTab]
  const subjectKey = `subject_${activeLang}` as 'subject_de' | 'subject_en'
  const bodyKey    = `body_${activeLang}`    as 'body_de'    | 'body_en'

  const subjectRef = useRef<HTMLInputElement>(null)
  const bodyRef    = useRef<HTMLTextAreaElement>(null)

  function insertTplVar(token: string) {
    const target = lastFocused.current
    if (!target) return
    const { el, setter } = target
    const start = el.selectionStart ?? el.value.length
    const end   = el.selectionEnd ?? start
    setter(el.value.slice(0, start) + token + el.value.slice(end))
    markDirty('templates')
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  // ── Number format live preview ───────────────────────────────────────────────
  function previewFormat(fmt: string, prefix: string, num: string): string {
    const n = parseInt(num) || 1
    const now = new Date()
    const YYYY = now.getFullYear().toString()
    const YY = YYYY.slice(2)
    const MM = String(now.getMonth() + 1).padStart(2, '0')
    return fmt
      .replace('{prefix}', prefix || '?')
      .replace('{YYYY}', YYYY)
      .replace('{YY}', YY)
      .replace('{MM}', MM)
      .replace('{NNNN}', String(n).padStart(4, '0'))
      .replace('{NNN}', String(n).padStart(3, '0'))
      .replace('{NN}', String(n).padStart(2, '0'))
      .replace('{N}', String(n))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-10 items-start">

      {/* ── Sticky left sidebar nav ── */}
      <nav className="hidden lg:flex flex-col gap-0.5 w-40 shrink-0 sticky top-8 self-start">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveSection(id)}
            className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors text-left w-full ${
              activeSection === id
                ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-5">

        {/* ── Mobile nav (horizontal scroll) ── */}
        <div className="lg:hidden overflow-x-auto -mx-1 px-1 pb-1">
          <div className="flex gap-1 w-max">
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveSection(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  activeSection === id
                    ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium'
                    : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── 1. Company ── */}
        {activeSection === 'company' && <div>
          <SectionCard
            title="Company"
            description="Logo and company identity shown on all documents."
            dirty={!!dirty.brand}
            saving={saving === 'brand'}
            onSave={saveBiz}
          >
            {/* Logo */}
            <div className="flex items-start gap-4">
              {logoUrl ? (
                <div className="relative shrink-0">
                  <div className="h-16 w-16 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex items-center justify-center overflow-hidden p-2">
                    <img src={logoUrl} alt="Logo" className="max-h-full max-w-full object-contain" />
                  </div>
                  <button
                    type="button"
                    onClick={removeLogo}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
                  >
                    <X size={10} className="text-neutral-600 dark:text-neutral-300" />
                  </button>
                </div>
              ) : (
                <div className="h-16 w-16 rounded-xl border-2 border-dashed border-neutral-200 dark:border-neutral-700 flex items-center justify-center shrink-0">
                  <span className="text-[10px] text-neutral-300 dark:text-neutral-600 text-center leading-tight px-1">No logo</span>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="cursor-pointer inline-flex items-center text-xs font-medium px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300">
                  {uploadingLogo ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} />
                </label>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">PNG or SVG, transparent background</p>
              </div>
            </div>

            {/* Company & owner name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>Company name</label>
                <input
                  className={inp}
                  value={biz.company_name}
                  onChange={e => { setBiz(b => ({ ...b, company_name: e.target.value })); markDirty('brand') }}
                  placeholder="Acme GmbH"
                />
              </div>
              <div className="space-y-1.5">
                <label className={lbl}>Owner name</label>
                <input
                  className={inp}
                  value={biz.owner_name}
                  onChange={e => { setBiz(b => ({ ...b, owner_name: e.target.value })); markDirty('brand') }}
                  placeholder="Jane Doe"
                />
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 2. Address ── */}
        {activeSection === 'address' && <div>
          <SectionCard
            title="Address"
            description="Printed on invoices and used as the sender address."
            dirty={!!dirty.contact}
            saving={saving === 'contact'}
            onSave={saveContact}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>Email</label>
                <input type="email" className={inp} value={contact.email}
                  onChange={e => { setContact(c => ({ ...c, email: e.target.value })); markDirty('contact') }}
                  placeholder="billing@company.com" />
              </div>
              <div className="space-y-1.5">
                <label className={lbl}>Phone</label>
                <input className={inp} value={contact.phone}
                  onChange={e => { setContact(c => ({ ...c, phone: e.target.value })); markDirty('contact') }}
                  placeholder="+43 1 234 5678" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={lbl}>Website</label>
              <input className={inp} value={contact.website}
                onChange={e => { setContact(c => ({ ...c, website: e.target.value })); markDirty('contact') }}
                placeholder="https://company.com" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl}>Address</label>
              <input className={inp} value={contact.address_line1}
                onChange={e => { setContact(c => ({ ...c, address_line1: e.target.value })); markDirty('contact') }}
                placeholder="Musterstraße 1" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl}>Address line 2</label>
              <input className={inp} value={contact.address_line2}
                onChange={e => { setContact(c => ({ ...c, address_line2: e.target.value })); markDirty('contact') }}
                placeholder="Top 5" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>ZIP</label>
                <input className={inp} value={contact.zip}
                  onChange={e => { setContact(c => ({ ...c, zip: e.target.value })); markDirty('contact') }}
                  placeholder="1010" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <label className={lbl}>City</label>
                <input className={inp} value={contact.city}
                  onChange={e => { setContact(c => ({ ...c, city: e.target.value })); markDirty('contact') }}
                  placeholder="Vienna" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>Country</label>
                <input className={inp} value={contact.country}
                  onChange={e => { setContact(c => ({ ...c, country: e.target.value })); markDirty('contact') }}
                  placeholder="Austria" />
              </div>
              <div className="space-y-1.5">
                <label className={lbl}>UID-Nummer</label>
                <input className={inp} value={contact.uid_number}
                  onChange={e => { setContact(c => ({ ...c, uid_number: e.target.value })); markDirty('contact') }}
                  placeholder="ATU…" />
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 3. Banking ── */}
        {activeSection === 'banking' && <div>
          <SectionCard
            title="Banking"
            description="Bank details printed on invoices for payment."
            dirty={!!dirty.banking}
            saving={saving === 'banking'}
            onSave={saveBankingSection}
          >
            <div className="space-y-1.5">
              <label className={lbl}>IBAN</label>
              <input className={inp} value={banking.iban}
                onChange={e => { setBanking(b => ({ ...b, iban: e.target.value })); markDirty('banking') }}
                placeholder="AT12 3456 7890 1234 5678" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>BIC</label>
                <input className={inp} value={banking.bic}
                  onChange={e => { setBanking(b => ({ ...b, bic: e.target.value })); markDirty('banking') }}
                  placeholder="RLNWATWW" />
              </div>
              <div className="space-y-1.5">
                <label className={lbl}>Bank name</label>
                <input className={inp} value={banking.bank_name}
                  onChange={e => { setBanking(b => ({ ...b, bank_name: e.target.value })); markDirty('banking') }}
                  placeholder="Raiffeisen" />
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 4. Numbering ── */}
        {activeSection === 'numbering' && <div>
          <SectionCard
            title="Numbering"
            description="Set the format for each document type. Use tokens to build the pattern."
            dirty={!!dirty.docs}
            saving={saving === 'docs'}
            onSave={saveDocsSection}
          >
            {/* Token reference */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-neutral-400 dark:text-neutral-500 pb-1">
              <span className="text-neutral-500 dark:text-neutral-400 font-sans font-medium not-italic mr-1">Tokens:</span>
              {['{prefix}','{YYYY}','{YY}','{MM}','{NNN}','{NN}','{N}','{NNNN}'].map(t => (
                <span key={t}>{t}</span>
              ))}
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center pb-1 border-b border-neutral-100 dark:border-neutral-800">
              <span className={lbl}></span>
              <span className={lbl}>Prefix</span>
              <span className={lbl}>Format template</span>
              <span className={lbl}>Next #</span>
            </div>

            {/* One row per doc type */}
            {([
              { label: 'Invoice',     prefixKey: 'invoice_prefix' as const,     fmtKey: 'invoice_number_format' as const,     numKey: 'next_invoice_number' as const },
              { label: 'Quote',       prefixKey: 'quote_prefix' as const,       fmtKey: 'quote_number_format' as const,       numKey: 'next_quote_number' as const },
              { label: 'Credit note', prefixKey: 'credit_note_prefix' as const, fmtKey: 'credit_note_number_format' as const, numKey: 'next_credit_note_number' as const },
            ]).map(row => (
              <div key={row.prefixKey} className="space-y-1.5">
                <div className="grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{row.label}</span>
                  <input className={inp} value={docs[row.prefixKey]}
                    onChange={e => { setDocs(d => ({ ...d, [row.prefixKey]: e.target.value })); markDirty('docs') }}
                    placeholder="R" />
                  <input className={inp} value={docs[row.fmtKey]}
                    onChange={e => { setDocs(d => ({ ...d, [row.fmtKey]: e.target.value })); markDirty('docs') }}
                    placeholder="{prefix}-{YYYY}-{NNN}" />
                  <input type="number" min="1" className={inp} value={docs[row.numKey]}
                    onChange={e => { setDocs(d => ({ ...d, [row.numKey]: e.target.value })); markDirty('docs') }} />
                </div>
                <div className="pl-[112px]">
                  <span className="text-xs font-mono text-neutral-400 dark:text-neutral-500">
                    → {previewFormat(docs[row.fmtKey], docs[row.prefixKey], docs[row.numKey])}
                  </span>
                </div>
              </div>
            ))}

          </SectionCard>
        </div>}

        {/* ── 5. Defaults ── */}
        {activeSection === 'defaults' && <div>
          <SectionCard
            title="Defaults"
            description="Pre-filled values when creating a new document."
            dirty={!!dirty.defaults}
            saving={saving === 'defaults'}
            onSave={saveDefaults}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl}>Payment days</label>
                <input type="number" className={inp} value={defaults.default_payment_days}
                  onChange={e => { setDefaults(d => ({ ...d, default_payment_days: e.target.value })); markDirty('defaults') }} />
                <p className="text-xs text-neutral-400 dark:text-neutral-500">Days until invoice is due</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl}>Language</label>
                <select
                  value={defaults.default_language}
                  onChange={e => { setDefaults(d => ({ ...d, default_language: e.target.value as 'de' | 'en' })); markDirty('defaults') }}
                  className={inp}
                >
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">Language for new documents</p>
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 6. PDF Footer ── */}

        {activeSection === 'footer' && <div>
          <SectionCard
            title="PDF Footer"
            description="Note printed below the totals on each document. Supports variables."
            dirty={!!dirty.footer}
            saving={saving === 'footer'}
            onSave={saveFooter}
          >
            {/* Doc type tabs */}
            <div className="flex gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg w-fit">
              {(['invoice', 'quote'] as const).map(t => (
                <button key={t} type="button"
                  onClick={() => setFooterDocTab(t)}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${footerDocTab === t ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}>
                  {t === 'invoice' ? 'Invoice' : 'Quote'}
                </button>
              ))}
            </div>
            <VarChips vars={FOOTER_VARS} onInsert={insertVar} />
            <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
              Focus a text field, then click a variable to insert it at the cursor.
            </p>
            {footerDocTab === 'invoice' ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl}>Deutsch</label>
                  <textarea
                    value={footerDe}
                    onChange={e => { setFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl}>English</label>
                  <textarea
                    value={footerEn}
                    onChange={e => { setFooterEn(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterEn(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl}>Deutsch</label>
                  <textarea
                    value={quoteFooterDe}
                    onChange={e => { setQuoteFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setQuoteFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl}>English</label>
                  <textarea
                    value={quoteFooterEn}
                    onChange={e => { setQuoteFooterEn(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setQuoteFooterEn(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
              </div>
            )}
          </SectionCard>
        </div>}

        {/* ── 6. Email Templates ── */}
        {activeSection === 'templates' && <div>
          <SectionCard
            title="Email Templates"
            description="Pre-filled subject and body for sending documents via Gmail."
            dirty={!!dirty.templates}
            saving={saving === 'templates'}
            onSave={saveTemplates}
          >
            {/* Doc type tabs */}
            <div className="flex gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg w-fit">
              {DOC_TABS.map(({ type, label }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setActiveDocTab(type)}
                  className={`px-3 h-7 text-xs font-medium rounded-md transition-colors ${
                    activeDocTab === type
                      ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Language toggle */}
            <div className="flex items-center gap-1 p-0.5 bg-neutral-100 dark:bg-neutral-800 rounded-lg w-fit">
              {(['de', 'en'] as const).map(lang => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setActiveLang(lang)}
                  className={`px-3 h-6 text-xs font-medium rounded-md transition-colors ${
                    activeLang === lang
                      ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
                  }`}
                >
                  {lang === 'de' ? 'DE' : 'EN'}
                </button>
              ))}
            </div>

            {/* Variable chips */}
            <VarChips
              vars={activeDocTab === 'reminder' ? REMINDER_VARS : EMAIL_VARS}
              onInsert={insertTplVar}
            />

            {/* Context label */}
            <div className="flex items-center gap-2 py-2 border-t border-neutral-100 dark:border-neutral-800">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {DOC_TABS.find(t => t.type === activeDocTab)?.label} · {activeLang === 'de' ? 'Deutsch' : 'English'}
              </span>
            </div>

            {/* Subject */}
            <div className="space-y-1.5">
              <label className={lbl}>Subject</label>
              <input
                ref={subjectRef}
                className={inp}
                value={tpl[subjectKey]}
                onChange={e => setTplField(activeDocTab, subjectKey, e.target.value)}
                onFocus={e => onFieldFocus(e.currentTarget, v => setTplField(activeDocTab, subjectKey, v))}
                placeholder={
                  activeDocTab === 'reminder' && activeLang === 'de' ? DEFAULT_SUBJECT_DE :
                  activeDocTab === 'reminder' && activeLang === 'en' ? DEFAULT_SUBJECT_EN :
                  undefined
                }
              />
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <label className={lbl}>Body</label>
              <textarea
                ref={bodyRef}
                value={tpl[bodyKey]}
                onChange={e => setTplField(activeDocTab, bodyKey, e.target.value)}
                onFocus={e => onFieldFocus(e.currentTarget, v => setTplField(activeDocTab, bodyKey, v))}
                rows={8}
                placeholder={
                  activeDocTab === 'reminder' && activeLang === 'de' ? DEFAULT_BODY_DE :
                  activeDocTab === 'reminder' && activeLang === 'en' ? DEFAULT_BODY_EN :
                  undefined
                }
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
              />
            </div>
          </SectionCard>
        </div>}

        {/* ── 7. Integrations ── */}
        {activeSection === 'integrations' && <div className="space-y-3">
          <div className="px-1 pb-1">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Integrations</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">Connect external services to automate your workflow.</p>
          </div>

          {/* Gmail */}
          <IntegrationCard
            title="Gmail"
            description="Send invoices directly from your Gmail account with the PDF attached."
          >
            {gmailEmail ? (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle size={14} />
                  <span>{gmailEmail}</span>
                </span>
                <button
                  type="button"
                  onClick={disconnectGmail}
                  disabled={disconnecting}
                  className="text-xs text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400 transition-colors"
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            ) : (
              <a
                href="/api/gmail/auth"
                className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300"
              >
                <Mail size={14} /> Connect Gmail
              </a>
            )}
          </IntegrationCard>

          {/* Google Drive */}
          <IntegrationCard
            title="Google Drive"
            description="Auto-upload PDFs to a Drive folder when you send or download an invoice."
          >
            {!gmailEmail ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">Connect Gmail first to enable Drive.</p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className={lbl}>Folder URL or ID</label>
                  <input
                    type="text"
                    value={driveFolder}
                    onChange={e => { setDriveFolder(e.target.value); setDriveDirty(true) }}
                    placeholder="https://drive.google.com/drive/folders/…"
                    className={inp}
                  />
                </div>
                {driveFolder && (
                  <div className="space-y-1.5">
                    <label className={lbl}>Display name</label>
                    <input
                      type="text"
                      value={driveFolderName}
                      onChange={e => { setDriveFolderName(e.target.value); setDriveDirty(true) }}
                      placeholder="e.g. Invoices 2026"
                      className={inp}
                    />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  {settings?.drive_folder_id && !driveDirty && (
                    <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle size={13} />
                      {settings.drive_folder_name || settings.drive_folder_id}
                    </span>
                  )}
                  {driveDirty && (
                    <button
                      type="button"
                      onClick={saveDriveFolder}
                      disabled={savingDrive}
                      className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-700 dark:text-neutral-300"
                    >
                      <HardDrive size={13} /> {savingDrive ? 'Saving…' : 'Save folder'}
                    </button>
                  )}
                </div>
                {!settings?.gmail_access_token?.includes('drive') && settings?.gmail_refresh_token && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    Re-connect your Google account to grant Drive access.{' '}
                    <a href="/api/gmail/auth" className="underline">Re-connect →</a>
                  </p>
                )}
              </div>
            )}
          </IntegrationCard>

          {/* Bookamat */}
          <IntegrationCard
            title="Bookamat"
            description="Automatically sync paid invoices to your Bookamat bookkeeping."
          >
            {bookamatUsername && !bookamatAccounts ? (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle size={14} />
                  <span>{bookamatUsername}</span>
                  {bookamatBankId && <span className="text-green-600/60 dark:text-green-400/60">· accounts configured</span>}
                </span>
                <button
                  type="button"
                  onClick={() => loadBookamatAccounts()}
                  disabled={loadingAccounts}
                  className="text-xs text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
                >
                  {loadingAccounts ? 'Loading…' : 'Change'}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={lbl}>Username</label>
                    <input
                      type="text"
                      value={bookamatUsername}
                      onChange={e => setBookamatUsername(e.target.value)}
                      placeholder="your@email.com"
                      className={inp}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl}>API Key</label>
                    <input
                      type="password"
                      value={bookamatApiKey}
                      onChange={e => setBookamatApiKey(e.target.value)}
                      placeholder="From Mein Account → API"
                      className={inp}
                    />
                  </div>
                </div>

                {!bookamatAccounts ? (
                  <button
                    type="button"
                    onClick={loadBookamatAccounts}
                    disabled={loadingAccounts}
                    className="inline-flex items-center gap-1.5 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-700 dark:text-neutral-300"
                  >
                    {loadingAccounts ? 'Loading…' : <><ChevronRight size={14} /> Load accounts</>}
                  </button>
                ) : (
                  <div className="space-y-4 pt-1 border-t border-neutral-100 dark:border-neutral-800">
                    <div className="space-y-1.5 pt-1">
                      <label className={lbl}>Bank account (receives payments)</label>
                      <select
                        value={bookamatBankId}
                        onChange={e => setBookamatBankId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">Select…</option>
                        {bookamatAccounts.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className={lbl}>Income account (Erlöskonto)</label>
                      <select
                        value={bookamatCostId}
                        onChange={e => setBookamatCostId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">Select…</option>
                        {bookamatAccounts.costAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className={lbl}>VAT accounts</label>
                      {([
                        [0,  bookamatVat0,  setBookamatVat0],
                        [10, bookamatVat10, setBookamatVat10],
                        [13, bookamatVat13, setBookamatVat13],
                        [20, bookamatVat20, setBookamatVat20],
                      ] as [number, number | '', (v: number) => void][]).map(([rate, val, setter]) => (
                        <div key={rate} className="flex items-center gap-3">
                          <span className="text-xs text-neutral-400 dark:text-neutral-500 w-7 shrink-0 text-right">{rate}%</span>
                          <select
                            value={val}
                            onChange={e => setter(Number(e.target.value))}
                            className={inp}
                          >
                            <option value="">Not used</option>
                            {bookamatAccounts.vatAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={saveBookamat}
                      disabled={savingBookamat}
                      className="w-full h-9 text-sm rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50 font-medium"
                    >
                      {savingBookamat ? 'Saving…' : 'Save Bookamat settings'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </IntegrationCard>
        </div>}

      </div>
    </div>
  )
}
