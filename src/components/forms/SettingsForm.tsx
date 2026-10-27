'use client'

import { useState, useRef, useEffect, useId } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import type { UiLang } from '@/lib/i18n'
import { toast } from 'sonner'
import { CheckCircle, Mail, HardDrive, ChevronRight, X, Building2, MapPin, CreditCard, Hash, FileText, Plug, SlidersHorizontal } from 'lucide-react'
import { DEFAULT_SUBJECT_DE, DEFAULT_BODY_DE, DEFAULT_SUBJECT_EN, DEFAULT_BODY_EN } from '@/lib/utils/reminder-templates'
import type { PublicSettings } from '@/lib/public-settings'
import { toastApiError } from '@/lib/google/toast'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { isValidBic, isValidIban, isValidVatId, normalizeBic, normalizeIban, normalizeVatId } from '@/lib/utils/validation'
import type { TaxTreatment, Unit, VatRate } from '@/types'

interface Props { settings: PublicSettings | null }

// ── Shared style tokens ────────────────────────────────────────────────────────
const inp = 'w-full h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500'
const lbl = 'text-xs font-medium text-neutral-500 dark:text-neutral-400'
const err = 'text-xs text-red-600 dark:text-red-400'

// @react-pdf/image decodes only PNG and JPEG; a WebP, GIF or HEIC logo would break every PDF.
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }
const LOGO_MAX_BYTES = 2 * 1024 * 1024

const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']
const VAT_RATES: VatRate[] = [0, 10, 13, 20]
const TAX_TREATMENTS: { value: TaxTreatment; label: string }[] = [
  { value: 'at_vat',            label: 'Austrian VAT' },
  { value: 'eu_reverse_charge', label: 'EU Reverse Charge' },
  { value: 'non_eu',            label: 'Non-EU (no VAT)' },
]

type CounterKey = 'next_invoice_number' | 'next_quote_number' | 'next_credit_note_number'

// Whole days 0–365, or null when the input is not one.
function parseDays(value: string): number | null {
  const n = /^\d{1,3}$/.test(value.trim()) ? Number(value) : NaN
  return n >= 0 && n <= 365 ? n : null
}

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

// Must match fillTemplate in src/lib/utils/reminder-templates.ts
const REMINDER_VARS = [
  { token: '{{reminder_title}}', label: 'Zahlungserinnerung / 1. Mahnung / 2. Mahnung' },
  { token: '{{level}}',          label: 'Reminder level' },
  { token: '{{invoice_number}}', label: 'Invoice #' },
  { token: '{{client}}',         label: 'Client' },
  { token: '{{date}}',           label: 'Invoice date' },
  { token: '{{due_date}}',       label: 'Due date' },
  { token: '{{balance_due}}',    label: 'Balance due' },
  { token: '{{days_overdue}}',   label: 'Days overdue' },
  { token: '{{new_deadline}}',   label: 'New deadline' },
  { token: '{{fee}}',            label: 'Mahnspesen (from level 2)' },
  { token: '{{interest}}',       label: 'Verzugszinsen' },
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
        {description && <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</p>}
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
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</p>
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
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useT()
  const uid = useId()

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
  const [contactErrors, setContactErrors] = useState<{ uid_number?: string }>({})

  // ── Banking state ────────────────────────────────────────────────────────────
  const [banking, setBanking] = useState({
    iban:      settings?.iban ?? '',
    bic:       settings?.bic ?? '',
    bank_name: settings?.bank_name ?? '',
  })
  const [bankingErrors, setBankingErrors] = useState<{ iban?: string; bic?: string }>({})

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
  // Only counters the user edited are written back, so a save never rolls back a number issued since page load.
  const editedCounters = useRef(new Set<CounterKey>())
  const [docsErrors, setDocsErrors] = useState<Partial<Record<CounterKey, string>>>({})

  // ── Defaults state ───────────────────────────────────────────────────────────
  const [defaults, setDefaults] = useState({
    default_payment_days:        String(settings?.default_payment_days ?? 14),
    default_language:            settings?.default_language ?? 'de',
    default_vat_rate:            String(settings?.default_vat_rate ?? 20),
    default_unit:                (settings?.default_unit ?? 'flat') as Unit,
    default_tax_treatment:       (settings?.default_tax_treatment ?? 'at_vat') as TaxTreatment,
    default_quote_validity_days: String(settings?.default_quote_validity_days ?? 14),
    ui_language:                 (settings?.ui_language ?? 'en') as UiLang,
  })
  const [defaultsErrors, setDefaultsErrors] = useState<{ default_payment_days?: string; default_quote_validity_days?: string }>({})

  // ── Payment terms state ──────────────────────────────────────────────────────
  const [terms, setTerms] = useState({
    default_skonto_percent: settings?.default_skonto_percent != null ? String(settings.default_skonto_percent) : '',
    default_skonto_days:    settings?.default_skonto_days != null ? String(settings.default_skonto_days) : '',
  })

  // ── Reminders state ──────────────────────────────────────────────────────────
  const [reminders, setReminders] = useState({
    reminders_enabled:      settings?.reminders_enabled ?? true,
    reminder_grace_days:    String(settings?.reminder_grace_days ?? 7),
    reminder_interval_days: String(settings?.reminder_interval_days ?? 14),
    reminder_max_level:     String(settings?.reminder_max_level ?? 3),
    reminder_fee:           String(settings?.reminder_fee ?? 0),
    reminder_interest_rate: String(settings?.reminder_interest_rate ?? 0),
  })

  // ── Footer state ─────────────────────────────────────────────────────────────
  const [footerDocTab, setFooterDocTab] = useState<'invoice' | 'quote' | 'credit_note'>('invoice')
  const [footerDe, setFooterDe] = useState(settings?.invoice_footer_de ?? '')
  const [footerEn, setFooterEn] = useState(settings?.invoice_footer_en ?? '')
  const [quoteFooterDe, setQuoteFooterDe] = useState(settings?.quote_footer_de ?? '')
  const [quoteFooterEn, setQuoteFooterEn] = useState(settings?.quote_footer_en ?? '')
  const [creditNoteFooterDe, setCreditNoteFooterDe] = useState(settings?.credit_note_footer_de ?? '')
  const [creditNoteFooterEn, setCreditNoteFooterEn] = useState(settings?.credit_note_footer_en ?? '')

  // ── Tax note state ───────────────────────────────────────────────────────────
  const [taxNotes, setTaxNotes] = useState({
    reverse_charge_de: settings?.tax_note_reverse_charge_de ?? '',
    reverse_charge_en: settings?.tax_note_reverse_charge_en ?? '',
    non_eu_de: settings?.tax_note_non_eu_de ?? '',
    non_eu_en: settings?.tax_note_non_eu_en ?? '',
  })

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
  const [google, setGoogle] = useState({
    email: settings?.gmail_email ?? null,
    connected: !!settings?.gmail_connected,
    connectedAt: settings?.gmail_connected_at ?? null,
    scopes: settings?.gmail_scopes ?? null,
  })
  const driveScopeGranted = !!google.scopes?.includes('/auth/drive')
  const [disconnecting, setDisconnecting] = useState(false)
  const [driveFolder, setDriveFolder] = useState(settings?.drive_folder_id ?? '')
  const [driveSaved, setDriveSaved] = useState<{ id: string | null; name: string | null }>({
    id: settings?.drive_folder_id ?? null,
    name: settings?.drive_folder_name ?? null,
  })
  const [driveError, setDriveError] = useState<string | null>(null)
  const [savingDrive, setSavingDrive] = useState(false)
  const [driveDirty, setDriveDirty] = useState(false)
  const [bookamatUsername, setBookamatUsername] = useState(settings?.bookamat_username ?? '')
  const [bookamatApiKey, setBookamatApiKey] = useState('')
  const [bookamatKeySaved, setBookamatKeySaved] = useState(!!settings?.bookamat_configured)
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
  const [editingBookamat, setEditingBookamat] = useState(false)

  // ── Last focused ref (for variable insertion) ────────────────────────────────
  const lastFocused = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; setter: (v: string) => void } | null>(null)

  function onFieldFocus(el: HTMLTextAreaElement | HTMLInputElement, setter: (v: string) => void) {
    lastFocused.current = { el, setter }
  }

  // A chip must never land in a field that is no longer shown: forget the target whenever the view changes.
  function forgetFocused() {
    lastFocused.current = null
  }

  function selectSection(id: string) {
    forgetFocused()
    setActiveSection(id)
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
    if (status === 'connected') toast.success('Google account connected.')
    if (status === 'error')     toast.error('Google connection failed. Please try again.')
  }, [searchParams])

  // ── Save functions ───────────────────────────────────────────────────────────
  async function saveBiz() {
    if (!settings) return
    setSaving('brand')
    const { error } = await supabase.from('settings').update({
      company_name: biz.company_name,
      owner_name:   biz.owner_name,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('brand')
    toast.success('Brand saved.')
  }

  async function saveContact() {
    if (!settings) return
    const uid = normalizeVatId(contact.uid_number)
    if (uid && !isValidVatId(uid)) { setContactErrors({ uid_number: 'Enter a valid UID-Nummer, e.g. ATU12345678.' }); return }
    setContactErrors({})
    setSaving('contact')
    const { error } = await supabase.from('settings').update({
      email:         contact.email,
      phone:         contact.phone         || null,
      website:       contact.website       || null,
      address_line1: contact.address_line1,
      address_line2: contact.address_line2 || null,
      zip:           contact.zip,
      city:          contact.city,
      country:       contact.country,
      uid_number:    uid,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    setContact(c => ({ ...c, uid_number: uid }))
    clearDirty('contact')
    toast.success('Contact & address saved.')
  }

  async function saveBankingSection() {
    if (!settings) return
    const iban = normalizeIban(banking.iban)
    const bic = normalizeBic(banking.bic)
    const errors: { iban?: string; bic?: string } = {}
    if (iban && !isValidIban(iban)) errors.iban = 'This IBAN is not valid — check the country code, length and digits.'
    if (bic && !isValidBic(bic)) errors.bic = 'A BIC has 8 or 11 characters, e.g. RLNWATWW.'
    setBankingErrors(errors)
    if (errors.iban || errors.bic) return
    setSaving('banking')
    const { error } = await supabase.from('settings').update({
      iban,
      bic,
      bank_name: banking.bank_name || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    setBanking(b => ({ ...b, iban, bic }))
    clearDirty('banking')
    toast.success('Banking saved.')
  }

  async function saveDocsSection() {
    if (!settings) return
    const counters: Partial<Record<CounterKey, number>> = {}
    const errors: Partial<Record<CounterKey, string>> = {}
    for (const key of editedCounters.current) {
      const n = /^\d+$/.test(docs[key].trim()) ? Number(docs[key]) : NaN
      if (n >= 1) counters[key] = n
      else errors[key] = 'Next number must be a whole number of at least 1.'
    }
    setDocsErrors(errors)
    if (Object.keys(errors).length) return
    setSaving('docs')
    const { error } = await supabase.from('settings').update({
      invoice_prefix:              docs.invoice_prefix,
      quote_prefix:                docs.quote_prefix,
      credit_note_prefix:          docs.credit_note_prefix,
      invoice_number_format:       docs.invoice_number_format || '{prefix}-{YYYY}-{NNN}',
      quote_number_format:         docs.quote_number_format || '{prefix}-{YYYY}-{NNN}',
      credit_note_number_format:   docs.credit_note_number_format || '{prefix}-{YYYY}-{NNN}',
      ...counters,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    editedCounters.current.clear()
    clearDirty('docs')
    toast.success('Numbering saved.')
  }

  async function saveDefaults() {
    if (!settings) return
    const paymentDays = parseDays(defaults.default_payment_days)
    const validityDays = parseDays(defaults.default_quote_validity_days)
    const errors: { default_payment_days?: string; default_quote_validity_days?: string } = {}
    if (paymentDays === null) errors.default_payment_days = 'Enter a whole number of days between 0 and 365.'
    if (validityDays === null) errors.default_quote_validity_days = 'Enter a whole number of days between 0 and 365.'
    setDefaultsErrors(errors)
    if (paymentDays === null || validityDays === null) return
    setSaving('defaults')
    const { error } = await supabase.from('settings').update({
      default_payment_days:        paymentDays,
      default_language:            defaults.default_language,
      default_vat_rate:            Number(defaults.default_vat_rate),
      default_unit:                defaults.default_unit,
      default_tax_treatment:       defaults.default_tax_treatment,
      default_quote_validity_days: validityDays,
      ui_language:                 defaults.ui_language,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('defaults')
    toast.success('Defaults saved.')
    // The UI language is rendered server-side; refresh so the whole app switches.
    router.refresh()
  }

  async function saveTerms() {
    if (!settings) return
    setSaving('terms')
    const percent = parseFloat(terms.default_skonto_percent)
    const days = parseInt(terms.default_skonto_days, 10)
    const { error } = await supabase.from('settings').update({
      default_skonto_percent: percent > 0 ? Math.min(percent, 100) : null,
      default_skonto_days:    days >= 0 ? days : null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('terms')
    toast.success('Payment terms saved.')
  }

  async function saveReminders() {
    if (!settings) return
    setSaving('reminders')
    const { error } = await supabase.from('settings').update({
      reminders_enabled:      reminders.reminders_enabled,
      reminder_grace_days:    Math.max(0, parseInt(reminders.reminder_grace_days, 10) || 0),
      reminder_interval_days: Math.max(1, parseInt(reminders.reminder_interval_days, 10) || 14),
      reminder_max_level:     Math.max(1, parseInt(reminders.reminder_max_level, 10) || 3),
      reminder_fee:           Math.max(0, parseFloat(reminders.reminder_fee) || 0),
      reminder_interest_rate: Math.max(0, parseFloat(reminders.reminder_interest_rate) || 0),
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('reminders')
    toast.success('Reminder settings saved.')
  }

  async function saveFooter() {
    if (!settings) return
    setSaving('footer')
    const { error } = await supabase.from('settings').update({
      invoice_footer_de: footerDe || null,
      invoice_footer_en: footerEn || null,
      quote_footer_de: quoteFooterDe || null,
      quote_footer_en: quoteFooterEn || null,
      credit_note_footer_de: creditNoteFooterDe || null,
      credit_note_footer_en: creditNoteFooterEn || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('footer')
    toast.success('Footer saved.')
  }

  async function saveTaxNotes() {
    if (!settings) return
    setSaving('taxnotes')
    const { error } = await supabase.from('settings').update({
      tax_note_reverse_charge_de: taxNotes.reverse_charge_de || null,
      tax_note_reverse_charge_en: taxNotes.reverse_charge_en || null,
      tax_note_non_eu_de: taxNotes.non_eu_de || null,
      tax_note_non_eu_en: taxNotes.non_eu_en || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('taxnotes')
    toast.success('Tax notes saved.')
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)

  async function disconnectGoogle() {
    setDisconnecting(true)
    const res = await fetch('/api/gmail/auth', { method: 'DELETE' })
    setDisconnecting(false)
    if (!res.ok) {
      toastApiError(t, await res.json().catch(() => ({})), '', 'Could not disconnect.')
      setConfirmDisconnect(false)
      return
    }
    setGoogle({ email: null, connected: false, connectedAt: null, scopes: null })
    setConfirmDisconnect(false)
    toast.success('Google account disconnected.')
  }

  async function saveDriveFolder() {
    setSavingDrive(true)
    setDriveError(null)
    const res = await fetch('/api/drive/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: driveFolder.trim() || null }),
    })
    const data = await res.json().catch(() => ({}))
    setSavingDrive(false)
    if (!res.ok) {
      setDriveError(typeof data.error === 'string' ? data.error : 'Could not verify the folder.')
      if (res.status === 401 && data.code) setGoogle(g => ({ ...g, connected: false }))
      return
    }
    setDriveFolder(data.id ?? '')
    setDriveSaved({ id: data.id ?? null, name: data.name ?? null })
    setDriveDirty(false)
    toast.success(data.id ? `Drive folder "${data.name ?? data.id}" saved.` : 'Drive folder removed.')
  }

  async function loadBookamatAccounts() {
    if (!bookamatUsername || (!bookamatApiKey && !bookamatKeySaved)) { toast.error('Enter username and API key first.'); return }
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
      ...(bookamatApiKey ? { bookamat_api_key: bookamatApiKey } : {}),
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
    if (bookamatApiKey) setBookamatKeySaved(true)
    setBookamatApiKey('')
    setBookamatAccounts(null)
    setEditingBookamat(false)
    toast.success('Bookamat connected.')
  }

  async function removeBookamatKey() {
    if (!settings) return
    setSavingBookamat(true)
    const { error } = await supabase.from('settings').update({ bookamat_api_key: null }).eq('id', settings.id)
    setSavingBookamat(false)
    setConfirmRemoveKey(false)
    if (error) { toast.error(error.message); return }
    setBookamatKeySaved(false)
    setBookamatApiKey('')
    setBookamatAccounts(null)
    setEditingBookamat(true)
    toast.success('Bookamat API key removed.')
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file || !settings) return
    const ext = LOGO_TYPES[file.type]
    if (!ext) { toast.error('The logo must be a PNG or JPEG file — other formats cannot be embedded in the PDF.'); return }
    if (file.size > LOGO_MAX_BYTES) { toast.error('The logo must be 2 MB or smaller.'); return }
    setUploadingLogo(true)
    const path = `logo.${ext}`
    const { error } = await supabase.storage.from('logos').upload(path, file, { upsert: true, contentType: file.type })
    if (error) { toast.error(error.message); setUploadingLogo(false); return }
    const { data } = supabase.storage.from('logos').getPublicUrl(path)
    const url = `${data.publicUrl}?t=${Date.now()}`
    const { error: saveError } = await supabase.from('settings').update({ logo_url: url }).eq('id', settings.id)
    setUploadingLogo(false)
    if (saveError) { toast.error(saveError.message); return }
    setLogoUrl(url)
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
            onClick={() => selectSection(id)}
            aria-current={activeSection === id ? 'true' : undefined}
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
                onClick={() => selectSection(id)}
                aria-current={activeSection === id ? 'true' : undefined}
                className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
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
                    aria-label="Remove logo"
                    className="absolute -top-2.5 -right-2.5 h-7 w-7 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
                  >
                    <X size={12} className="text-neutral-600 dark:text-neutral-300" />
                  </button>
                </div>
              ) : (
                <div className="h-16 w-16 rounded-xl border-2 border-dashed border-neutral-200 dark:border-neutral-700 flex items-center justify-center shrink-0">
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500 text-center leading-tight px-1">No logo</span>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="cursor-pointer inline-flex items-center text-xs font-medium px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus-within:ring-2 focus-within:ring-ring/60 transition-colors text-neutral-700 dark:text-neutral-300">
                  {uploadingLogo ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={handleLogoUpload} disabled={uploadingLogo} aria-label={logoUrl ? 'Replace logo' : 'Upload logo'} />
                </label>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">PNG or JPEG up to 2 MB, transparent background</p>
              </div>
            </div>

            {/* Company & owner name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-biz-company_name`}>Company name</label>
                <input id={`${uid}-biz-company_name`}
                  className={inp}
                  value={biz.company_name}
                  onChange={e => { setBiz(b => ({ ...b, company_name: e.target.value })); markDirty('brand') }}
                  placeholder="Acme GmbH"
                />
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-biz-owner_name`}>Owner name</label>
                <input id={`${uid}-biz-owner_name`}
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
                <label className={lbl} htmlFor={`${uid}-contact-email`}>Email</label>
                <input id={`${uid}-contact-email`} type="email" className={inp} value={contact.email}
                  onChange={e => { setContact(c => ({ ...c, email: e.target.value })); markDirty('contact') }}
                  placeholder="billing@company.com" />
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-phone`}>Phone</label>
                <input id={`${uid}-contact-phone`} className={inp} value={contact.phone}
                  onChange={e => { setContact(c => ({ ...c, phone: e.target.value })); markDirty('contact') }}
                  placeholder="+43 1 234 5678" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-website`}>Website</label>
              <input id={`${uid}-contact-website`} className={inp} value={contact.website}
                onChange={e => { setContact(c => ({ ...c, website: e.target.value })); markDirty('contact') }}
                placeholder="https://company.com" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-address_line1`}>Address</label>
              <input id={`${uid}-contact-address_line1`} className={inp} value={contact.address_line1}
                onChange={e => { setContact(c => ({ ...c, address_line1: e.target.value })); markDirty('contact') }}
                placeholder="Musterstraße 1" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-address_line2`}>Address line 2</label>
              <input id={`${uid}-contact-address_line2`} className={inp} value={contact.address_line2}
                onChange={e => { setContact(c => ({ ...c, address_line2: e.target.value })); markDirty('contact') }}
                placeholder="Top 5" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-zip`}>ZIP</label>
                <input id={`${uid}-contact-zip`} className={inp} value={contact.zip}
                  onChange={e => { setContact(c => ({ ...c, zip: e.target.value })); markDirty('contact') }}
                  placeholder="1010" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <label className={lbl} htmlFor={`${uid}-contact-city`}>City</label>
                <input id={`${uid}-contact-city`} className={inp} value={contact.city}
                  onChange={e => { setContact(c => ({ ...c, city: e.target.value })); markDirty('contact') }}
                  placeholder="Vienna" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-country`}>Country</label>
                <input id={`${uid}-contact-country`} className={inp} value={contact.country}
                  onChange={e => { setContact(c => ({ ...c, country: e.target.value })); markDirty('contact') }}
                  placeholder="Austria" />
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-uid_number`}>UID-Nummer</label>
                <input id={`${uid}-contact-uid_number`} className={inp} value={contact.uid_number} aria-invalid={!!contactErrors.uid_number || undefined}
                  onChange={e => { setContact(c => ({ ...c, uid_number: e.target.value })); setContactErrors({}); markDirty('contact') }}
                  placeholder="ATU…" />
                {contactErrors.uid_number && <p className={err}>{contactErrors.uid_number}</p>}
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
              <label className={lbl} htmlFor={`${uid}-banking-iban`}>IBAN</label>
              <input id={`${uid}-banking-iban`} className={inp} value={banking.iban} aria-invalid={!!bankingErrors.iban || undefined}
                onChange={e => { setBanking(b => ({ ...b, iban: e.target.value })); setBankingErrors(er => ({ ...er, iban: undefined })); markDirty('banking') }}
                placeholder="AT12 3456 7890 1234 5678" />
              {bankingErrors.iban && <p className={err}>{bankingErrors.iban}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-banking-bic`}>BIC</label>
                <input id={`${uid}-banking-bic`} className={inp} value={banking.bic} aria-invalid={!!bankingErrors.bic || undefined}
                  onChange={e => { setBanking(b => ({ ...b, bic: e.target.value })); setBankingErrors(er => ({ ...er, bic: undefined })); markDirty('banking') }}
                  placeholder="RLNWATWW" />
                {bankingErrors.bic && <p className={err}>{bankingErrors.bic}</p>}
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-banking-bank_name`}>Bank name</label>
                <input id={`${uid}-banking-bank_name`} className={inp} value={banking.bank_name}
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
            description="Set the format for each document type. Use tokens to build the pattern. Next # is only written when you change it."
            dirty={!!dirty.docs}
            saving={saving === 'docs'}
            onSave={saveDocsSection}
          >
            {/* Token reference */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-neutral-500 dark:text-neutral-400 pb-1">
              <span className="text-neutral-500 dark:text-neutral-400 font-sans font-medium not-italic mr-1">Tokens:</span>
              {['{prefix}','{YYYY}','{YY}','{MM}','{NNN}','{NN}','{N}','{NNNN}'].map(t => (
                <span key={t}>{t}</span>
              ))}
            </div>

            {/* Column headers */}
            <div className="hidden sm:grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center pb-1 border-b border-neutral-100 dark:border-neutral-800">
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
                <div className="grid grid-cols-[1fr_2fr] sm:grid-cols-[100px_72px_1fr_72px] gap-3 items-center">
                  <span className="col-span-2 sm:col-span-1 text-sm font-medium sm:font-normal text-neutral-700 dark:text-neutral-300">{row.label}</span>
                  <div className="space-y-1 min-w-0">
                    <label htmlFor={`${uid}-${row.prefixKey}`} className={`${lbl} sm:sr-only`}>Prefix</label>
                    <input id={`${uid}-${row.prefixKey}`} className={`${inp} min-w-0`} value={docs[row.prefixKey]}
                      onChange={e => { setDocs(d => ({ ...d, [row.prefixKey]: e.target.value })); markDirty('docs') }}
                      placeholder="R" />
                  </div>
                  <div className="space-y-1 min-w-0">
                    <label htmlFor={`${uid}-${row.fmtKey}`} className={`${lbl} sm:sr-only`}>Format template</label>
                    <input id={`${uid}-${row.fmtKey}`} className={`${inp} min-w-0`} value={docs[row.fmtKey]}
                      onChange={e => { setDocs(d => ({ ...d, [row.fmtKey]: e.target.value })); markDirty('docs') }}
                      placeholder="{prefix}-{YYYY}-{NNN}" />
                  </div>
                  <div className="space-y-1 min-w-0 col-span-2 sm:col-span-1">
                    <label htmlFor={`${uid}-${row.numKey}`} className={`${lbl} sm:sr-only`}>Next #</label>
                    <input id={`${uid}-${row.numKey}`} type="text" inputMode="numeric" pattern="[0-9]*" className={`${inp} min-w-0 sm:w-full w-24`} value={docs[row.numKey]} aria-invalid={!!docsErrors[row.numKey] || undefined}
                      onChange={e => { editedCounters.current.add(row.numKey); setDocs(d => ({ ...d, [row.numKey]: e.target.value })); markDirty('docs') }} />
                  </div>
                </div>
                <div className="sm:pl-[112px]">
                  <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
                    → {previewFormat(docs[row.fmtKey], docs[row.prefixKey], docs[row.numKey])}
                  </span>
                  {docsErrors[row.numKey] && <p className={`${err} mt-1`}>{docsErrors[row.numKey]}</p>}
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
                <label className={lbl} htmlFor={`${uid}-defaults-default_payment_days`}>Payment days</label>
                <input id={`${uid}-defaults-default_payment_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={defaults.default_payment_days} aria-invalid={!!defaultsErrors.default_payment_days || undefined}
                  onChange={e => { setDefaults(d => ({ ...d, default_payment_days: e.target.value })); markDirty('defaults') }} />
                {defaultsErrors.default_payment_days
                  ? <p className={err}>{defaultsErrors.default_payment_days}</p>
                  : <p className="text-xs text-neutral-500 dark:text-neutral-400">Days until invoice is due</p>}
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_quote_validity_days`}>Quote validity</label>
                <input id={`${uid}-defaults-default_quote_validity_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={defaults.default_quote_validity_days} aria-invalid={!!defaultsErrors.default_quote_validity_days || undefined}
                  onChange={e => { setDefaults(d => ({ ...d, default_quote_validity_days: e.target.value })); markDirty('defaults') }} />
                {defaultsErrors.default_quote_validity_days
                  ? <p className={err}>{defaultsErrors.default_quote_validity_days}</p>
                  : <p className="text-xs text-neutral-500 dark:text-neutral-400">Days a new quote stays valid</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_language`}>Language</label>
                <select id={`${uid}-defaults-default_language`}
                  value={defaults.default_language}
                  onChange={e => { setDefaults(d => ({ ...d, default_language: e.target.value as 'de' | 'en' })); markDirty('defaults') }}
                  className={inp}
                >
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Language for new documents</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-ui_language`}>{t('settings.defaults.uiLanguage')}</label>
                <select id={`${uid}-defaults-ui_language`}
                  value={defaults.ui_language}
                  onChange={e => { setDefaults(d => ({ ...d, ui_language: e.target.value as UiLang })); markDirty('defaults') }}
                  className={inp}
                >
                  <option value="de">{t('common.german')}</option>
                  <option value="en">{t('common.english')}</option>
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.uiLanguageHint')}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_tax_treatment`}>Tax treatment</label>
                <select id={`${uid}-defaults-default_tax_treatment`}
                  value={defaults.default_tax_treatment}
                  onChange={e => { setDefaults(d => ({ ...d, default_tax_treatment: e.target.value as TaxTreatment })); markDirty('defaults') }}
                  className={inp}
                >
                  {TAX_TREATMENTS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Pre-selected on a new document until a client is chosen</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_vat_rate`}>VAT rate</label>
                <select id={`${uid}-defaults-default_vat_rate`}
                  value={defaults.default_vat_rate}
                  onChange={e => { setDefaults(d => ({ ...d, default_vat_rate: e.target.value })); markDirty('defaults') }}
                  className={inp}
                >
                  {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">VAT rate for new line items</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_unit`}>Unit</label>
                <select id={`${uid}-defaults-default_unit`}
                  value={defaults.default_unit}
                  onChange={e => { setDefaults(d => ({ ...d, default_unit: e.target.value as Unit })); markDirty('defaults') }}
                  className={inp}
                >
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Unit for new line items</p>
              </div>
            </div>
          </SectionCard>

          <div className="h-5" />

          <SectionCard
            title="Payment terms"
            description="Skonto pre-filled on new invoices and printed under the totals: “Bei Zahlung bis … x % Skonto”."
            dirty={!!dirty.terms}
            saving={saving === 'terms'}
            onSave={saveTerms}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-terms-default_skonto_percent`}>Skonto (%)</label>
                <MoneyInput id={`${uid}-terms-default_skonto_percent`} className={inp} value={terms.default_skonto_percent === '' ? null : Number(terms.default_skonto_percent)} placeholder="none"
                  onValueChange={n => { setTerms(t => ({ ...t, default_skonto_percent: n === null ? '' : String(n) })); markDirty('terms') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Off the gross total; leave empty for no Skonto</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-terms-default_skonto_days`}>Skonto period (days)</label>
                <input id={`${uid}-terms-default_skonto_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={terms.default_skonto_days}
                  onChange={e => { setTerms(t => ({ ...t, default_skonto_days: e.target.value })); markDirty('terms') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Counted from the invoice date</p>
              </div>
            </div>
          </SectionCard>

          <div className="h-5" />

          <SectionCard
            title="Reminders"
            description="The daily run escalates overdue invoices: Zahlungserinnerung, then 1. Mahnung, then 2. Mahnung. Clients can be excluded on their page."
            dirty={!!dirty.reminders}
            saving={saving === 'reminders'}
            onSave={saveReminders}
          >
            <label className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input type="checkbox" checked={reminders.reminders_enabled}
                onChange={e => { setReminders(r => ({ ...r, reminders_enabled: e.target.checked })); markDirty('reminders') }}
                className="accent-neutral-900 dark:accent-white" />
              <span className="text-neutral-800 dark:text-neutral-200">Send reminders automatically</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_grace_days`}>Grace period (days)</label>
                <input id={`${uid}-reminders-reminder_grace_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_grace_days}
                  onChange={e => { setReminders(r => ({ ...r, reminder_grace_days: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">After the due date before the first reminder; also the new deadline in each email</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_interval_days`}>Interval (days)</label>
                <input id={`${uid}-reminders-reminder_interval_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_interval_days}
                  onChange={e => { setReminders(r => ({ ...r, reminder_interval_days: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Between one level and the next</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_max_level`}>Highest level</label>
                <input id={`${uid}-reminders-reminder_max_level`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_max_level}
                  onChange={e => { setReminders(r => ({ ...r, reminder_max_level: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_fee`}>Mahnspesen (EUR)</label>
                <MoneyInput id={`${uid}-reminders-reminder_fee`} className={inp} value={reminders.reminder_fee === '' ? null : Number(reminders.reminder_fee)}
                  onValueChange={n => { setReminders(r => ({ ...r, reminder_fee: n === null ? '' : String(n) })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Charged from the 1. Mahnung on as {'{{fee}}'}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_interest_rate`}>Verzugszinsen (% p.a.)</label>
                <MoneyInput id={`${uid}-reminders-reminder_interest_rate`} className={inp} value={reminders.reminder_interest_rate === '' ? null : Number(reminders.reminder_interest_rate)}
                  onValueChange={n => { setReminders(r => ({ ...r, reminder_interest_rate: n === null ? '' : String(n) })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">On the open balance for the days overdue, as {'{{interest}}'}</p>
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
              {(['invoice', 'quote', 'credit_note'] as const).map(t => (
                <button key={t} type="button"
                  aria-pressed={footerDocTab === t}
                  onClick={() => { forgetFocused(); setFooterDocTab(t) }}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${footerDocTab === t ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}>
                  {t === 'invoice' ? 'Invoice' : t === 'quote' ? 'Quote' : 'Credit Note'}
                </button>
              ))}
            </div>
            <VarChips vars={FOOTER_VARS} onInsert={insertVar} />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-1">
              Focus a text field, then click a variable to insert it at the cursor.
            </p>
            {footerDocTab === 'invoice' ? (
              <div key="invoice" className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-footerDe`}>Deutsch</label>
                  <textarea id={`${uid}-footerDe`}
                    value={footerDe}
                    onChange={e => { setFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-footerEn`}>English</label>
                  <textarea id={`${uid}-footerEn`}
                    value={footerEn}
                    onChange={e => { setFooterEn(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterEn(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
              </div>
            ) : footerDocTab === 'quote' ? (
              <div key="quote" className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-quoteFooterDe`}>Deutsch</label>
                  <textarea id={`${uid}-quoteFooterDe`}
                    value={quoteFooterDe}
                    onChange={e => { setQuoteFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setQuoteFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-quoteFooterEn`}>English</label>
                  <textarea id={`${uid}-quoteFooterEn`}
                    value={quoteFooterEn}
                    onChange={e => { setQuoteFooterEn(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setQuoteFooterEn(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
              </div>
            ) : (
              <div key="credit_note" className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-creditNoteFooterDe`}>Deutsch</label>
                  <textarea id={`${uid}-creditNoteFooterDe`}
                    value={creditNoteFooterDe}
                    onChange={e => { setCreditNoteFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setCreditNoteFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-creditNoteFooterEn`}>English</label>
                  <textarea id={`${uid}-creditNoteFooterEn`}
                    value={creditNoteFooterEn}
                    onChange={e => { setCreditNoteFooterEn(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setCreditNoteFooterEn(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Tax Notes"
            description="Text printed below the totals when reverse charge or non-EU tax treatment applies. Leave blank to use the default."
            dirty={!!dirty.taxnotes}
            saving={saving === 'taxnotes'}
            onSave={saveTaxNotes}
          >
            <div className="space-y-4">
              <div>
                <p className={`${lbl} mb-2`}>Reverse Charge (EU)</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-reverse_charge_de`}>Deutsch</label>
                    <input id={`${uid}-taxNotes-reverse_charge_de`}
                      type="text"
                      className={inp}
                      placeholder="Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)"
                      value={taxNotes.reverse_charge_de}
                      onChange={e => { setTaxNotes(n => ({ ...n, reverse_charge_de: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-reverse_charge_en`}>English</label>
                    <input id={`${uid}-taxNotes-reverse_charge_en`}
                      type="text"
                      className={inp}
                      placeholder="Reverse charge — VAT to be accounted for by the recipient"
                      value={taxNotes.reverse_charge_en}
                      onChange={e => { setTaxNotes(n => ({ ...n, reverse_charge_en: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                </div>
              </div>
              <div>
                <p className={`${lbl} mb-2`}>Non-EU (not taxable)</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-non_eu_de`}>Deutsch</label>
                    <input id={`${uid}-taxNotes-non_eu_de`}
                      type="text"
                      className={inp}
                      placeholder="Nicht steuerbar (Leistungsort außerhalb der EU)"
                      value={taxNotes.non_eu_de}
                      onChange={e => { setTaxNotes(n => ({ ...n, non_eu_de: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-non_eu_en`}>English</label>
                    <input id={`${uid}-taxNotes-non_eu_en`}
                      type="text"
                      className={inp}
                      placeholder="Tax liability shifts to the recipient of the services."
                      value={taxNotes.non_eu_en}
                      onChange={e => { setTaxNotes(n => ({ ...n, non_eu_en: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                </div>
              </div>
            </div>
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
                  aria-pressed={activeDocTab === type}
                  onClick={() => { forgetFocused(); setActiveDocTab(type) }}
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
                  aria-pressed={activeLang === lang}
                  onClick={() => { forgetFocused(); setActiveLang(lang) }}
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
            {activeDocTab === 'reminder' && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                One template serves every level. A line whose variables are all empty (e.g. &quot;Mahnspesen: {'{{fee}}'}&quot; on a Zahlungserinnerung) is left out of the email.
              </p>
            )}

            {/* Context label */}
            <div className="flex items-center gap-2 py-2 border-t border-neutral-100 dark:border-neutral-800">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {DOC_TABS.find(t => t.type === activeDocTab)?.label} · {activeLang === 'de' ? 'Deutsch' : 'English'}
              </span>
            </div>

            {/* Subject */}
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-tpl-subjectKey`}>Subject</label>
              <input id={`${uid}-tpl-subjectKey`}
                key={`${activeDocTab}-${activeLang}`}
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
              <label className={lbl} htmlFor={`${uid}-tpl-bodyKey`}>Body</label>
              <textarea id={`${uid}-tpl-bodyKey`}
                key={`${activeDocTab}-${activeLang}`}
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
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
              />
            </div>
          </SectionCard>
        </div>}

        {/* ── 7. Integrations ── */}
        {activeSection === 'integrations' && <div className="space-y-3">
          <div className="px-1 pb-1">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Integrations</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">Connect external services to automate your workflow.</p>
          </div>

          {/* Google account (Gmail + Drive grant) */}
          <IntegrationCard
            title="Google account"
            description="Send invoices from your Gmail account with the PDF attached. The same connection is used for Drive."
          >
            {google.connected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                  <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                    <CheckCircle size={14} />
                    <span>{google.email}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={disconnecting}
                    className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {google.connectedAt
                    ? `Connected ${new Date(google.connectedAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
                    : 'Connected'}
                  {' · '}
                  {driveScopeGranted
                    ? 'Drive access granted'
                    : <>Drive access not confirmed — <a href="/api/gmail/auth" className="underline">re-connect</a> to grant it</>}
                </p>
              </div>
            ) : google.email ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
                  <span className="text-sm text-amber-700 dark:text-amber-400">
                    Connection to {google.email} expired or was revoked.
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={disconnecting}
                    className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
                  >
                    {disconnecting ? 'Removing…' : 'Remove'}
                  </button>
                </div>
                <a
                  href="/api/gmail/auth"
                  className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300"
                >
                  <Mail size={14} /> Reconnect Google
                </a>
              </div>
            ) : (
              <a
                href="/api/gmail/auth"
                className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300"
              >
                <Mail size={14} /> Connect Google
              </a>
            )}
          </IntegrationCard>

          {/* Google Drive */}
          <IntegrationCard
            title="Google Drive"
            description="Auto-upload PDFs to a Drive folder when you send or download an invoice."
          >
            {!google.connected ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Connect your Google account first to enable Drive.</p>
            ) : (
              <div className="space-y-3">
                {!driveScopeGranted && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    Drive access could not be confirmed for this connection.{' '}
                    <a href="/api/gmail/auth" className="underline">Re-connect →</a>
                  </p>
                )}
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-driveFolder`}>Folder URL or ID</label>
                  <input id={`${uid}-driveFolder`}
                    type="text"
                    value={driveFolder}
                    onChange={e => { setDriveFolder(e.target.value); setDriveDirty(true); setDriveError(null) }}
                    placeholder="https://drive.google.com/drive/folders/…"
                    className={inp}
                  />
                  {driveError && <p className="text-xs text-red-600 dark:text-red-400">{driveError}</p>}
                </div>
                <div className="flex items-center gap-3">
                  {driveSaved.id && !driveDirty && (
                    <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle size={13} />
                      {driveSaved.name || driveSaved.id}
                    </span>
                  )}
                  {driveDirty && (
                    <button
                      type="button"
                      onClick={saveDriveFolder}
                      disabled={savingDrive}
                      className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-700 dark:text-neutral-300"
                    >
                      <HardDrive size={13} /> {savingDrive ? 'Checking…' : driveFolder.trim() ? 'Verify & save' : 'Remove folder'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </IntegrationCard>

          {/* Bookamat */}
          <IntegrationCard
            title="Bookamat"
            description="Automatically sync paid invoices to your Bookamat bookkeeping."
          >
            {bookamatUsername && !bookamatAccounts && !editingBookamat ? (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle size={14} />
                  <span>{bookamatUsername}</span>
                  {bookamatBankId && <span className="text-green-600/60 dark:text-green-400/60">· accounts configured</span>}
                </span>
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingBookamat(true)}
                    className="text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
                  >
                    Change
                  </button>
                  {bookamatKeySaved && (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveKey(true)}
                      disabled={savingBookamat}
                      className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      Remove key
                    </button>
                  )}
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-bookamatUsername`}>Username</label>
                    <input id={`${uid}-bookamatUsername`}
                      type="text"
                      value={bookamatUsername}
                      onChange={e => setBookamatUsername(e.target.value)}
                      placeholder="your@email.com"
                      className={inp}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-bookamatApiKey`}>API Key</label>
                    <input id={`${uid}-bookamatApiKey`}
                      type="password"
                      value={bookamatApiKey}
                      onChange={e => setBookamatApiKey(e.target.value)}
                      placeholder={bookamatKeySaved ? '•••••••• (saved)' : 'From Mein Account → API'}
                      className={inp}
                    />
                    {bookamatKeySaved && (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveKey(true)}
                        disabled={savingBookamat}
                        className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                      >
                        Remove saved key
                      </button>
                    )}
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
                      <label className={lbl} htmlFor={`${uid}-bookamatBankId`}>Bank account (receives payments)</label>
                      <select id={`${uid}-bookamatBankId`}
                        value={bookamatBankId}
                        onChange={e => setBookamatBankId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">Select…</option>
                        {bookamatAccounts.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className={lbl} htmlFor={`${uid}-bookamatCostId`}>Income account (Erlöskonto)</label>
                      <select id={`${uid}-bookamatCostId`}
                        value={bookamatCostId}
                        onChange={e => setBookamatCostId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">Select…</option>
                        {bookamatAccounts.costAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <p className={lbl}>VAT accounts</p>
                      {([
                        [0,  bookamatVat0,  setBookamatVat0],
                        [10, bookamatVat10, setBookamatVat10],
                        [13, bookamatVat13, setBookamatVat13],
                        [20, bookamatVat20, setBookamatVat20],
                      ] as [number, number | '', (v: number) => void][]).map(([rate, val, setter]) => (
                        <div key={rate} className="flex items-center gap-3">
                          <span className="text-xs text-neutral-500 dark:text-neutral-400 w-7 shrink-0 text-right">{rate}%</span>
                          <select
                            aria-label={`VAT account for ${rate}%`}
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

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Google?"
        description="Sending via Gmail and saving to Drive stop until you connect the account again."
        confirmLabel={disconnecting ? 'Disconnecting…' : 'Disconnect'}
        destructive
        busy={disconnecting}
        onConfirm={disconnectGoogle}
        onCancel={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmRemoveKey}
        title="Remove the stored Bookamat API key?"
        description="Syncing stops until a new key is saved."
        confirmLabel={savingBookamat ? 'Removing…' : 'Remove key'}
        destructive
        busy={savingBookamat}
        onConfirm={removeBookamatKey}
        onCancel={() => setConfirmRemoveKey(false)}
      />
    </div>
  )
}
