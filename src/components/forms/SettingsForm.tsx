'use client'

import { useState, useRef, useEffect, useId } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import type { DictKey, UiLang } from '@/lib/i18n'
import { toast } from 'sonner'
import { CheckCircle, Mail, HardDrive, ChevronRight, X, Building2, MapPin, CreditCard, Hash, FileText, Plug, SlidersHorizontal, FileCode } from 'lucide-react'
import { reminderFigures, reminderTitle, reminderVariables } from '@/lib/utils/reminder-templates'
import { defaultTemplate, documentVariables, fillSubject, fillTemplate, portalUrl, sampleDocument, starterTemplate, variablesFor } from '@/lib/templates'
import type { PublicSettings } from '@/lib/public-settings'
import { toastApiError } from '@/lib/google/toast'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { isValidBic, isValidEmail, isValidIban, isValidVatId, normalizeBic, normalizeIban, normalizeVatId } from '@/lib/utils/validation'
import { formatDate, viennaDate } from '@/lib/utils/document'
import { NUMBER_TOKENS, formatDocumentNumber, hasYearToken, nextCounter, numberFormatIssue, numberPrefixIssue } from '@/lib/utils/numbering'
import type { EmailTemplateKind, TaxTreatment, Unit, VatRate } from '@/types'

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
const TAX_TREATMENTS: TaxTreatment[] = ['at_vat', 'eu_reverse_charge', 'non_eu']

type CounterKey = 'next_invoice_number' | 'next_quote_number' | 'next_credit_note_number'

const NUMBER_ROWS = [
  { labelKey: 'settings.numbering.invoice',    prefixKey: 'invoice_prefix',     fmtKey: 'invoice_number_format',     numKey: 'next_invoice_number',     resetKey: 'invoice_number_reset_yearly',     yearKey: 'invoice_counter_year' },
  { labelKey: 'settings.numbering.quote',      prefixKey: 'quote_prefix',       fmtKey: 'quote_number_format',       numKey: 'next_quote_number',       resetKey: 'quote_number_reset_yearly',       yearKey: 'quote_counter_year' },
  { labelKey: 'settings.numbering.creditNote', prefixKey: 'credit_note_prefix', fmtKey: 'credit_note_number_format', numKey: 'next_credit_note_number', resetKey: 'credit_note_number_reset_yearly', yearKey: 'credit_note_counter_year' },
] as const

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

// The preview's portal link; a real one is created per document when an email uses it.
const SAMPLE_PORTAL_TOKEN = '3f0c9a2e-5b1d-4c7a-9e60-2d8f4b1a7c55'
const PREVIEW_LEVELS = [1, 2, 3] as const

// ── Doc type config ────────────────────────────────────────────────────────────
type DocType = EmailTemplateKind

const DOC_TABS: DocType[] = ['invoice', 'quote', 'credit_note', 'reminder']
const DOC_TAB_LABEL: Record<DocType, DictKey> = {
  invoice:     'settings.templates.invoice',
  quote:       'settings.templates.quote',
  credit_note: 'settings.templates.creditNote',
  reminder:    'settings.templates.reminder',
}

// ── Sidebar nav items ──────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'company',      labelKey: 'settings.nav.company',      Icon: Building2 },
  { id: 'address',      labelKey: 'settings.nav.address',      Icon: MapPin },
  { id: 'banking',      labelKey: 'settings.nav.banking',      Icon: CreditCard },
  { id: 'numbering',    labelKey: 'settings.nav.numbering',    Icon: Hash },
  { id: 'defaults',     labelKey: 'settings.nav.defaults',     Icon: SlidersHorizontal },
  { id: 'footer',       labelKey: 'settings.nav.footer',       Icon: FileText },
  { id: 'templates',    labelKey: 'settings.nav.templates',    Icon: Mail },
  { id: 'einvoice',     labelKey: 'einvoice.settings.nav',     Icon: FileCode },
  { id: 'integrations', labelKey: 'settings.nav.integrations', Icon: Plug },
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
  const { t } = useT()
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
            {saving ? t('common.saving') : t('common.saveChanges')}
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
  const { t, lang } = useT()
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
  const [contactErrors, setContactErrors] = useState<{ uid_number?: string; email?: string }>({})

  // ── Banking state ────────────────────────────────────────────────────────────
  const [banking, setBanking] = useState({
    bank_account_holder: settings?.bank_account_holder ?? '',
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
    next_invoice_number:         (settings?.next_invoice_number ?? 1) as number | null,
    next_quote_number:           (settings?.next_quote_number ?? 1) as number | null,
    next_credit_note_number:     (settings?.next_credit_note_number ?? 1) as number | null,
    invoice_number_format:       settings?.invoice_number_format ?? '{prefix}-{YYYY}-{NNN}',
    quote_number_format:         settings?.quote_number_format ?? '{prefix}-{YYYY}-{NNN}',
    credit_note_number_format:   settings?.credit_note_number_format ?? '{prefix}-{YYYY}-{NNN}',
    invoice_number_reset_yearly:     settings?.invoice_number_reset_yearly ?? false,
    quote_number_reset_yearly:       settings?.quote_number_reset_yearly ?? false,
    credit_note_number_reset_yearly: settings?.credit_note_number_reset_yearly ?? false,
    invoice_counter_year:            settings?.invoice_counter_year ?? null,
    quote_counter_year:              settings?.quote_counter_year ?? null,
    credit_note_counter_year:        settings?.credit_note_counter_year ?? null,
  })
  // Only counters the user edited are written back, so a save never rolls back a number issued since page load.
  const [editedCounters, setEditedCounters] = useState<ReadonlySet<CounterKey>>(() => new Set())
  const [docsErrors, setDocsErrors] = useState<Partial<Record<string, string>>>({})
  // Numbers are previewed with today's date in Vienna, the date the next document most likely carries.
  const [todayIso] = useState(() => viennaDate(new Date()))
  const thisYear = Number(todayIso.slice(0, 4))

  // A counter typed in while the yearly restart is on and the series is still last year's starts
  // this year's series; otherwise the restart would set it straight back to 1.
  function startsThisYearsSeries(row: (typeof NUMBER_ROWS)[number], resetYearly: boolean): boolean {
    const cy = docs[row.yearKey]
    return editedCounters.has(row.numKey) && resetYearly && cy !== null && cy < thisYear
  }
  function counterYear(row: (typeof NUMBER_ROWS)[number]): number | null {
    return startsThisYearsSeries(row, docs[row.resetKey] && hasYearToken(docs[row.fmtKey])) ? thisYear : docs[row.yearKey]
  }

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
  // The sidebar toggle changes the UI language outside this form; follow it so a later Defaults save
  // never writes the language the page was loaded with back over the user's choice.
  const [seenLang, setSeenLang] = useState(lang)
  if (lang !== seenLang) {
    setSeenLang(lang)
    setDefaults(d => ({ ...d, ui_language: lang }))
  }

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
  const [previewLevel, setPreviewLevel] = useState<number>(1)

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
  const [bookamatCashId, setBookamatCashId] = useState<number | ''>(settings?.bookamat_cash_account_id ?? '')
  const [bookamatCostId, setBookamatCostId] = useState<number | ''>(settings?.bookamat_cost_account_id ?? '')
  const [bookamatVat0, setBookamatVat0] = useState<number | ''>(settings?.bookamat_vat_account_0 ?? '')
  const [bookamatVatRc, setBookamatVatRc] = useState<number | ''>(settings?.bookamat_vat_account_rc ?? '')
  const [bookamatVatNonEu, setBookamatVatNonEu] = useState<number | ''>(settings?.bookamat_vat_account_non_eu ?? '')
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
    if (status === 'connected') toast.success(t('settings.integrations.google.connectedToast'))
    if (status === 'error')     toast.error(t('settings.integrations.google.failedToast'))
    // `t` only changes with the UI language, and re-running then would repeat the toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    toast.success(t('settings.company.saved'))
  }

  async function saveContact() {
    if (!settings) return
    const uid = normalizeVatId(contact.uid_number)
    const errors: { uid_number?: string; email?: string } = {}
    if (uid && !isValidVatId(uid)) errors.uid_number = t('settings.address.uidError')
    if (contact.email.trim() && !isValidEmail(contact.email)) errors.email = t('clientData.address.emailInvalid')
    setContactErrors(errors)
    if (errors.uid_number || errors.email) return
    setSaving('contact')
    const { error } = await supabase.from('settings').update({
      email:         contact.email.trim(),
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
    toast.success(t('settings.address.saved'))
  }

  async function saveBankingSection() {
    if (!settings) return
    const iban = normalizeIban(banking.iban)
    const bic = normalizeBic(banking.bic)
    const errors: { iban?: string; bic?: string } = {}
    if (iban && !isValidIban(iban)) errors.iban = t('settings.banking.ibanError')
    if (bic && !isValidBic(bic)) errors.bic = t('settings.banking.bicError')
    setBankingErrors(errors)
    if (errors.iban || errors.bic) return
    setSaving('banking')
    const { error } = await supabase.from('settings').update({
      bank_account_holder: banking.bank_account_holder.trim() || null,
      iban,
      bic,
      bank_name: banking.bank_name || null,
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    setBanking(b => ({ ...b, iban, bic }))
    clearDirty('banking')
    toast.success(t('settings.banking.saved'))
  }

  async function saveDocsSection() {
    if (!settings) return
    const errors: Record<string, string> = {}
    const counters: Partial<Record<CounterKey, number>> = {}
    const rows = NUMBER_ROWS.map(row => ({ ...row, prefix: docs[row.prefixKey].trim(), fmt: docs[row.fmtKey].trim() }))
    for (const row of rows) {
      const prefixIssue = numberPrefixIssue(row.prefix, row.fmt)
      if (prefixIssue) errors[row.prefixKey] = t(prefixIssue === 'required' ? 'clientData.numbering.prefixRequired' : 'clientData.numbering.prefixInvalid')
      const fmtIssue = numberFormatIssue(row.fmt)
      if (fmtIssue) {
        errors[row.fmtKey] = fmtIssue.kind === 'unknownToken'
          ? t('clientData.numbering.formatUnknownToken', { token: fmtIssue.token })
          : t(fmtIssue.kind === 'tooLong' ? 'clientData.numbering.formatTooLong' : 'clientData.numbering.formatNoCounter')
      }
      if (editedCounters.has(row.numKey)) {
        const n = docs[row.numKey]
        if (n !== null && Number.isInteger(n) && n >= 1) counters[row.numKey] = n
        else errors[row.numKey] = t('settings.numbering.nextError')
      }
    }
    // A counter set back onto an issued number would only be skipped at issue time; refuse it here.
    if (!Object.keys(errors).length) {
      const taken = await Promise.all(rows.map(async row => {
        const n = counters[row.numKey]
        if (n === undefined) return null
        const number = formatDocumentNumber(row.fmt, row.prefix, n, todayIso)
        const { data } = await supabase.from('documents').select('id').eq('number', number).limit(1)
        return data?.length ? { key: row.numKey, number } : null
      }))
      for (const hit of taken) if (hit) errors[hit.key] = t('clientData.numbering.numberTaken', { number: hit.number })
    }
    setDocsErrors(errors)
    if (Object.keys(errors).length) return
    const [inv, quote, credit] = rows
    const config = {
      invoice_prefix:                  inv.prefix,
      quote_prefix:                    quote.prefix,
      credit_note_prefix:              credit.prefix,
      invoice_number_format:           inv.fmt,
      quote_number_format:             quote.fmt,
      credit_note_number_format:       credit.fmt,
      invoice_number_reset_yearly:     docs.invoice_number_reset_yearly && hasYearToken(inv.fmt),
      quote_number_reset_yearly:       docs.quote_number_reset_yearly && hasYearToken(quote.fmt),
      credit_note_number_reset_yearly: docs.credit_note_number_reset_yearly && hasYearToken(credit.fmt),
    }
    const years: Partial<Record<(typeof NUMBER_ROWS)[number]['yearKey'], number>> = {}
    for (const row of rows) if (startsThisYearsSeries(row, config[row.resetKey])) years[row.yearKey] = thisYear
    setSaving('docs')
    const { error } = await supabase.from('settings').update({ ...config, ...counters, ...years }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    setDocs(d => ({ ...d, ...config, ...years }))
    setEditedCounters(new Set())
    clearDirty('docs')
    toast.success(t('settings.numbering.saved'))
  }

  async function saveDefaults() {
    if (!settings) return
    const paymentDays = parseDays(defaults.default_payment_days)
    const validityDays = parseDays(defaults.default_quote_validity_days)
    const errors: { default_payment_days?: string; default_quote_validity_days?: string } = {}
    if (paymentDays === null) errors.default_payment_days = t('settings.defaults.daysError')
    if (validityDays === null) errors.default_quote_validity_days = t('settings.defaults.daysError')
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
      ...(defaults.ui_language !== lang ? { ui_language: defaults.ui_language } : {}),
    }).eq('id', settings.id)
    setSaving(null)
    if (error) { toast.error(error.message); return }
    clearDirty('defaults')
    toast.success(t('settings.defaults.saved'))
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
    toast.success(t('settings.terms.saved'))
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
    toast.success(t('settings.reminders.saved'))
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
    toast.success(t('settings.footer.saved'))
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
    toast.success(t('settings.taxNotes.saved'))
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
    toast.success(t('settings.templates.saved'))
  }

  // ── Integration handlers ─────────────────────────────────────────────────────
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)

  async function disconnectGoogle() {
    setDisconnecting(true)
    const res = await fetch('/api/gmail/auth', { method: 'DELETE' })
    setDisconnecting(false)
    if (!res.ok) {
      toastApiError(t, await res.json().catch(() => ({})), '', t('settings.integrations.google.couldNotDisconnect'))
      setConfirmDisconnect(false)
      return
    }
    setGoogle({ email: null, connected: false, connectedAt: null, scopes: null })
    setConfirmDisconnect(false)
    toast.success(t('settings.integrations.google.disconnected'))
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
      setDriveError(typeof data.error === 'string' ? data.error : t('settings.integrations.drive.couldNotVerify'))
      if (res.status === 401 && data.code) setGoogle(g => ({ ...g, connected: false }))
      return
    }
    setDriveFolder(data.id ?? '')
    setDriveSaved({ id: data.id ?? null, name: data.name ?? null })
    setDriveDirty(false)
    toast.success(data.id ? t('settings.integrations.drive.folderSaved', { name: data.name ?? data.id }) : t('settings.integrations.drive.folderRemoved'))
  }

  async function loadBookamatAccounts() {
    if (!bookamatUsername || (!bookamatApiKey && !bookamatKeySaved)) { toast.error(t('settings.integrations.bookamat.enterCredentials')); return }
    setLoadingAccounts(true)
    const res = await fetch('/api/bookamat/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: bookamatUsername, apiKey: bookamatApiKey, country: bookamatCountry }),
    })
    setLoadingAccounts(false)
    if (!res.ok) { const { error } = await res.json().catch(() => ({})); toast.error(error ?? t('settings.integrations.bookamat.loadFailed')); return }
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
      bookamat_cash_account_id: bookamatCashId   || null,
      bookamat_cost_account_id: bookamatCostId   || null,
      bookamat_vat_account_0:   bookamatVat0     || null,
      bookamat_vat_account_rc:  bookamatVatRc    || null,
      bookamat_vat_account_non_eu: bookamatVatNonEu || null,
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
    toast.success(t('settings.integrations.bookamat.connected'))
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
    toast.success(t('settings.integrations.bookamat.keyRemoved'))
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file || !settings) return
    const ext = LOGO_TYPES[file.type]
    if (!ext) { toast.error(t('settings.company.logoType')); return }
    if (file.size > LOGO_MAX_BYTES) { toast.error(t('settings.company.logoSize')); return }
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
    toast.success(t('settings.company.logoUploaded'))
  }

  async function removeLogo() {
    if (!settings) return
    await supabase.from('settings').update({ logo_url: null }).eq('id', settings.id)
    setLogoUrl('')
    toast.success(t('settings.company.logoRemoved'))
  }

  // ── Email template helpers ───────────────────────────────────────────────────
  function setTplField(docType: DocType, field: string, value: string) {
    setEmailTpl(t => ({ ...t, [docType]: { ...t[docType], [field]: value } }))
    markDirty('templates')
  }

  const tpl = emailTpl[activeDocTab]
  const subjectKey = `subject_${activeLang}` as 'subject_de' | 'subject_en'
  const bodyKey    = `body_${activeLang}`    as 'body_de'    | 'body_en'
  const builtIn = defaultTemplate(activeDocTab, activeLang, previewLevel)

  // Live preview from the unsaved values of every card, so a changed fee or IBAN shows at once.
  function emailPreview() {
    const issuer = {
      company_name: biz.company_name,
      owner_name: biz.owner_name,
      iban: banking.iban,
      reminder_fee: Number(reminders.reminder_fee) || 0,
      reminder_interest_rate: Number(reminders.reminder_interest_rate) || 0,
      reminder_grace_days: Number(reminders.reminder_grace_days) || 0,
    }
    const skonto = { percent: terms.default_skonto_percent ? Number(terms.default_skonto_percent) : null, days: terms.default_skonto_days ? Number(terms.default_skonto_days) : null }
    const { doc, client, totals } = sampleDocument(activeDocTab, activeLang, todayIso, skonto)
    const portalLink = portalUrl(process.env.NEXT_PUBLIC_APP_URL || (typeof window === 'undefined' ? '' : window.location.origin), SAMPLE_PORTAL_TOKEN)
    const vars = activeDocTab === 'reminder'
      ? reminderVariables({
          doc, client, issuer, totals, portalLink,
          figures: reminderFigures({ dueDate: doc.due_date, balance: totals.balance_due, issuer, level: previewLevel, lang: activeLang, issuedOn: todayIso }),
        })
      : documentVariables({ doc, client, issuer, totals, portalLink })
    return {
      subject: fillSubject(tpl[subjectKey] || builtIn.subject, vars),
      body: fillTemplate(tpl[bodyKey] || builtIn.body, vars),
    }
  }

  function prefillBuiltIn() {
    const starter = starterTemplate(activeDocTab, activeLang)
    if (!tpl[subjectKey]) setTplField(activeDocTab, subjectKey, starter.subject)
    setTplField(activeDocTab, bodyKey, starter.body)
  }

  const preview = activeSection === 'templates' ? emailPreview() : null

  // ── Number format live preview ───────────────────────────────────────────────
  function previewNumber(row: (typeof NUMBER_ROWS)[number]): string {
    const counter = nextCounter(docs[row.numKey] ?? 1, counterYear(row), docs[row.resetKey], docs[row.fmtKey], thisYear)
    return formatDocumentNumber(docs[row.fmtKey], docs[row.prefixKey] || '?', counter, todayIso)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-10 items-start">

      {/* ── Sticky left sidebar nav ── */}
      <nav className="hidden lg:flex flex-col gap-0.5 w-40 shrink-0 sticky top-8 self-start">
        {NAV_ITEMS.map(({ id, labelKey, Icon }) => (
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
            {t(labelKey)}
          </button>
        ))}
      </nav>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-5">

        {/* ── Mobile nav (horizontal scroll) ── */}
        <div className="lg:hidden overflow-x-auto -mx-1 px-1 pb-1">
          <div className="flex gap-1 w-max">
            {NAV_ITEMS.map(({ id, labelKey, Icon }) => (
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
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* ── 1. Company ── */}
        {activeSection === 'company' && <div>
          <SectionCard
            title={t('settings.company.title')}
            description={t('settings.company.description')}
            dirty={!!dirty.brand}
            saving={saving === 'brand'}
            onSave={saveBiz}
          >
            {/* Logo */}
            <div className="flex items-start gap-4">
              {logoUrl ? (
                <div className="relative shrink-0">
                  <div className="h-16 w-16 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex items-center justify-center overflow-hidden p-2">
                    <img src={logoUrl} alt={t('settings.company.logoAlt')} className="max-h-full max-w-full object-contain" />
                  </div>
                  <button
                    type="button"
                    onClick={removeLogo}
                    aria-label={t('settings.company.removeLogo')}
                    className="absolute -top-2.5 -right-2.5 h-7 w-7 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
                  >
                    <X size={12} className="text-neutral-600 dark:text-neutral-300" />
                  </button>
                </div>
              ) : (
                <div className="h-16 w-16 rounded-xl border-2 border-dashed border-neutral-200 dark:border-neutral-700 flex items-center justify-center shrink-0">
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500 text-center leading-tight px-1">{t('settings.company.noLogo')}</span>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="cursor-pointer inline-flex items-center text-xs font-medium px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus-within:ring-2 focus-within:ring-ring/60 transition-colors text-neutral-700 dark:text-neutral-300">
                  {uploadingLogo ? t('settings.company.uploading') : logoUrl ? t('settings.company.replaceLogo') : t('settings.company.uploadLogo')}
                  <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={handleLogoUpload} disabled={uploadingLogo} aria-label={logoUrl ? t('settings.company.replaceLogo') : t('settings.company.uploadLogo')} />
                </label>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.company.logoHint')}</p>
              </div>
            </div>

            {/* Company & owner name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-biz-company_name`}>{t('settings.company.companyName')}</label>
                <input id={`${uid}-biz-company_name`}
                  className={inp}
                  value={biz.company_name}
                  onChange={e => { setBiz(b => ({ ...b, company_name: e.target.value })); markDirty('brand') }}
                  placeholder={t('settings.company.companyPlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-biz-owner_name`}>{t('settings.company.ownerName')}</label>
                <input id={`${uid}-biz-owner_name`}
                  className={inp}
                  value={biz.owner_name}
                  onChange={e => { setBiz(b => ({ ...b, owner_name: e.target.value })); markDirty('brand') }}
                  placeholder={t('settings.company.ownerPlaceholder')}
                />
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 2. Address ── */}
        {activeSection === 'address' && <div>
          <SectionCard
            title={t('settings.address.title')}
            description={t('settings.address.description')}
            dirty={!!dirty.contact}
            saving={saving === 'contact'}
            onSave={saveContact}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-email`}>{t('settings.address.email')}</label>
                <input id={`${uid}-contact-email`} type="email" inputMode="email" className={inp} value={contact.email} aria-invalid={!!contactErrors.email || undefined}
                  onChange={e => { setContact(c => ({ ...c, email: e.target.value })); setContactErrors(er => ({ ...er, email: undefined })); markDirty('contact') }}
                  placeholder="billing@company.com" />
                {contactErrors.email && <p className={err}>{contactErrors.email}</p>}
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-phone`}>{t('settings.address.phone')}</label>
                <input id={`${uid}-contact-phone`} className={inp} value={contact.phone}
                  onChange={e => { setContact(c => ({ ...c, phone: e.target.value })); markDirty('contact') }}
                  placeholder="+43 1 234 5678" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-website`}>{t('settings.address.website')}</label>
              <input id={`${uid}-contact-website`} className={inp} value={contact.website}
                onChange={e => { setContact(c => ({ ...c, website: e.target.value })); markDirty('contact') }}
                placeholder="https://company.com" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-address_line1`}>{t('settings.address.address')}</label>
              <input id={`${uid}-contact-address_line1`} className={inp} value={contact.address_line1}
                onChange={e => { setContact(c => ({ ...c, address_line1: e.target.value })); markDirty('contact') }}
                placeholder="Musterstraße 1" />
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-contact-address_line2`}>{t('settings.address.addressLine2')}</label>
              <input id={`${uid}-contact-address_line2`} className={inp} value={contact.address_line2}
                onChange={e => { setContact(c => ({ ...c, address_line2: e.target.value })); markDirty('contact') }}
                placeholder="Top 5" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-zip`}>{t('settings.address.zip')}</label>
                <input id={`${uid}-contact-zip`} className={inp} value={contact.zip}
                  onChange={e => { setContact(c => ({ ...c, zip: e.target.value })); markDirty('contact') }}
                  placeholder="1010" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <label className={lbl} htmlFor={`${uid}-contact-city`}>{t('settings.address.city')}</label>
                <input id={`${uid}-contact-city`} className={inp} value={contact.city}
                  onChange={e => { setContact(c => ({ ...c, city: e.target.value })); markDirty('contact') }}
                  placeholder={t('settings.address.cityPlaceholder')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-country`}>{t('settings.address.country')}</label>
                <input id={`${uid}-contact-country`} className={inp} value={contact.country}
                  onChange={e => { setContact(c => ({ ...c, country: e.target.value })); markDirty('contact') }}
                  placeholder={t('settings.address.countryPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-contact-uid_number`}>{t('settings.address.uid')}</label>
                <input id={`${uid}-contact-uid_number`} className={inp} value={contact.uid_number} aria-invalid={!!contactErrors.uid_number || undefined}
                  onChange={e => { setContact(c => ({ ...c, uid_number: e.target.value })); setContactErrors(er => ({ ...er, uid_number: undefined })); markDirty('contact') }}
                  placeholder="ATU…" />
                {contactErrors.uid_number && <p className={err}>{contactErrors.uid_number}</p>}
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 3. Banking ── */}
        {activeSection === 'banking' && <div>
          <SectionCard
            title={t('settings.banking.title')}
            description={t('settings.banking.description')}
            dirty={!!dirty.banking}
            saving={saving === 'banking'}
            onSave={saveBankingSection}
          >
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-banking-holder`}>{t('pdfPortal.settings.accountHolder')}</label>
              <input id={`${uid}-banking-holder`} className={inp} value={banking.bank_account_holder} autoComplete="off"
                aria-describedby={`${uid}-banking-holder-hint`}
                onChange={e => { setBanking(b => ({ ...b, bank_account_holder: e.target.value })); markDirty('banking') }}
                placeholder={settings?.company_name || settings?.owner_name || ''} />
              <p id={`${uid}-banking-holder-hint`} className="text-xs text-neutral-500 dark:text-neutral-400">{t('pdfPortal.settings.accountHolderHint')}</p>
            </div>
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-banking-iban`}>{t('settings.banking.iban')}</label>
              <input id={`${uid}-banking-iban`} className={inp} value={banking.iban} aria-invalid={!!bankingErrors.iban || undefined}
                onChange={e => { setBanking(b => ({ ...b, iban: e.target.value })); setBankingErrors(er => ({ ...er, iban: undefined })); markDirty('banking') }}
                placeholder="AT12 3456 7890 1234 5678" />
              {bankingErrors.iban && <p className={err}>{bankingErrors.iban}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-banking-bic`}>{t('settings.banking.bic')}</label>
                <input id={`${uid}-banking-bic`} className={inp} value={banking.bic} aria-invalid={!!bankingErrors.bic || undefined}
                  onChange={e => { setBanking(b => ({ ...b, bic: e.target.value })); setBankingErrors(er => ({ ...er, bic: undefined })); markDirty('banking') }}
                  placeholder="RLNWATWW" />
                {bankingErrors.bic && <p className={err}>{bankingErrors.bic}</p>}
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-banking-bank_name`}>{t('settings.banking.bankName')}</label>
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
            title={t('settings.numbering.title')}
            description={t('settings.numbering.description')}
            dirty={!!dirty.docs}
            saving={saving === 'docs'}
            onSave={saveDocsSection}
          >
            {/* Token reference */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono text-neutral-500 dark:text-neutral-400 pb-1">
              <span className="text-neutral-500 dark:text-neutral-400 font-sans font-medium not-italic mr-1">{t('settings.numbering.tokens')}</span>
              {NUMBER_TOKENS.map(token => (
                <span key={token}>{token}</span>
              ))}
            </div>

            {/* Column headers */}
            <div className="hidden sm:grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center pb-1 border-b border-neutral-100 dark:border-neutral-800">
              <span className={lbl}></span>
              <span className={lbl}>{t('settings.numbering.prefix')}</span>
              <span className={lbl}>{t('settings.numbering.format')}</span>
              <span className={lbl}>{t('settings.numbering.next')}</span>
            </div>

            {/* One row per doc type */}
            {NUMBER_ROWS.map(row => {
              const yearInFormat = hasYearToken(docs[row.fmtKey])
              const cy = counterYear(row)
              const rowErrors = [docsErrors[row.prefixKey], docsErrors[row.fmtKey], docsErrors[row.numKey]].filter(Boolean)
              return (
                <div key={row.prefixKey} className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_2fr] sm:grid-cols-[100px_72px_1fr_72px] gap-3 items-center">
                    <span className="col-span-2 sm:col-span-1 text-sm font-medium sm:font-normal text-neutral-700 dark:text-neutral-300">{t(row.labelKey)}</span>
                    <div className="space-y-1 min-w-0">
                      <label htmlFor={`${uid}-${row.prefixKey}`} className={`${lbl} sm:sr-only`}>{t('settings.numbering.prefix')}</label>
                      <input id={`${uid}-${row.prefixKey}`} className={`${inp} min-w-0`} value={docs[row.prefixKey]} aria-invalid={!!docsErrors[row.prefixKey] || undefined}
                        onChange={e => { setDocs(d => ({ ...d, [row.prefixKey]: e.target.value })); markDirty('docs') }}
                        autoCapitalize="characters" maxLength={10} placeholder="R" />
                    </div>
                    <div className="space-y-1 min-w-0">
                      <label htmlFor={`${uid}-${row.fmtKey}`} className={`${lbl} sm:sr-only`}>{t('settings.numbering.format')}</label>
                      <input id={`${uid}-${row.fmtKey}`} className={`${inp} min-w-0 font-mono`} value={docs[row.fmtKey]} aria-invalid={!!docsErrors[row.fmtKey] || undefined}
                        onChange={e => { setDocs(d => ({ ...d, [row.fmtKey]: e.target.value })); markDirty('docs') }}
                        autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="{prefix}-{YYYY}-{NNN}" />
                    </div>
                    <div className="space-y-1 min-w-0 col-span-2 sm:col-span-1">
                      <label htmlFor={`${uid}-${row.numKey}`} className={`${lbl} sm:sr-only`}>{t('settings.numbering.next')}</label>
                      <MoneyInput id={`${uid}-${row.numKey}`} integer className={`${inp} min-w-0 sm:w-full w-24`} value={docs[row.numKey]} aria-invalid={!!docsErrors[row.numKey] || undefined}
                        onValueChange={n => { setEditedCounters(s => new Set(s).add(row.numKey)); setDocs(d => ({ ...d, [row.numKey]: n })); markDirty('docs') }} />
                    </div>
                  </div>
                  <div className="sm:pl-[112px] space-y-1">
                    <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400 break-all">
                      → {previewNumber(row)}
                    </span>
                    {rowErrors.map(e => <p key={e} className={err}>{e}</p>)}
                    <label className={`flex items-start gap-2 text-xs py-1 ${yearInFormat ? 'cursor-pointer text-neutral-700 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-500'}`}>
                      <input type="checkbox" className="mt-0.5 accent-neutral-900 dark:accent-white"
                        checked={docs[row.resetKey] && yearInFormat}
                        disabled={!yearInFormat}
                        onChange={e => { setDocs(d => ({ ...d, [row.resetKey]: e.target.checked })); markDirty('docs') }} />
                      <span>
                        {t('clientData.numbering.resetYearly')}
                        <span className="block text-neutral-500 dark:text-neutral-400">
                          {!yearInFormat
                            ? t('clientData.numbering.resetYearlyNeedsYear')
                            : !docs[row.resetKey]
                              ? null
                              : cy !== null && cy < thisYear
                                ? t('clientData.numbering.restartsNext')
                                : t('clientData.numbering.restartsAt', { year: Math.max(cy ?? thisYear, thisYear) + 1 })}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              )
            })}

          </SectionCard>
        </div>}

        {/* ── 5. Defaults ── */}
        {activeSection === 'defaults' && <div>
          <SectionCard
            title={t('settings.defaults.title')}
            description={t('settings.defaults.description')}
            dirty={!!dirty.defaults}
            saving={saving === 'defaults'}
            onSave={saveDefaults}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_payment_days`}>{t('settings.defaults.paymentDays')}</label>
                <input id={`${uid}-defaults-default_payment_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={defaults.default_payment_days} aria-invalid={!!defaultsErrors.default_payment_days || undefined}
                  onChange={e => { setDefaults(d => ({ ...d, default_payment_days: e.target.value })); markDirty('defaults') }} />
                {defaultsErrors.default_payment_days
                  ? <p className={err}>{defaultsErrors.default_payment_days}</p>
                  : <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.paymentDaysHint')}</p>}
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_quote_validity_days`}>{t('settings.defaults.quoteValidity')}</label>
                <input id={`${uid}-defaults-default_quote_validity_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={defaults.default_quote_validity_days} aria-invalid={!!defaultsErrors.default_quote_validity_days || undefined}
                  onChange={e => { setDefaults(d => ({ ...d, default_quote_validity_days: e.target.value })); markDirty('defaults') }} />
                {defaultsErrors.default_quote_validity_days
                  ? <p className={err}>{defaultsErrors.default_quote_validity_days}</p>
                  : <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.quoteValidityHint')}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_language`}>{t('settings.defaults.language')}</label>
                <select id={`${uid}-defaults-default_language`}
                  value={defaults.default_language}
                  onChange={e => { setDefaults(d => ({ ...d, default_language: e.target.value as 'de' | 'en' })); markDirty('defaults') }}
                  className={inp}
                >
                  <option value="de">{t('common.german')}</option>
                  <option value="en">{t('common.english')}</option>
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.languageHint')}</p>
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
                <label className={lbl} htmlFor={`${uid}-defaults-default_tax_treatment`}>{t('settings.defaults.taxTreatment')}</label>
                <select id={`${uid}-defaults-default_tax_treatment`}
                  value={defaults.default_tax_treatment}
                  onChange={e => { setDefaults(d => ({ ...d, default_tax_treatment: e.target.value as TaxTreatment })); markDirty('defaults') }}
                  className={inp}
                >
                  {TAX_TREATMENTS.map(v => <option key={v} value={v}>{t(`taxTreatments.${v}`)}</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.taxHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_vat_rate`}>{t('settings.defaults.vatRate')}</label>
                <select id={`${uid}-defaults-default_vat_rate`}
                  value={defaults.default_vat_rate}
                  onChange={e => { setDefaults(d => ({ ...d, default_vat_rate: e.target.value })); markDirty('defaults') }}
                  className={inp}
                >
                  {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.vatHint')}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-defaults-default_unit`}>{t('settings.defaults.unit')}</label>
                <select id={`${uid}-defaults-default_unit`}
                  value={defaults.default_unit}
                  onChange={e => { setDefaults(d => ({ ...d, default_unit: e.target.value as Unit })); markDirty('defaults') }}
                  className={inp}
                >
                  {UNITS.map(u => <option key={u} value={u}>{t(`units.${u}`)}</option>)}
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.defaults.unitHint')}</p>
              </div>
            </div>
          </SectionCard>

          <div className="h-5" />

          <SectionCard
            title={t('settings.terms.title')}
            description={t('settings.terms.description')}
            dirty={!!dirty.terms}
            saving={saving === 'terms'}
            onSave={saveTerms}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-terms-default_skonto_percent`}>{t('settings.terms.skontoPercent')}</label>
                <MoneyInput id={`${uid}-terms-default_skonto_percent`} className={inp} value={terms.default_skonto_percent === '' ? null : Number(terms.default_skonto_percent)} placeholder={t('settings.terms.none')}
                  onValueChange={n => { setTerms(t => ({ ...t, default_skonto_percent: n === null ? '' : String(n) })); markDirty('terms') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.terms.skontoHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-terms-default_skonto_days`}>{t('settings.terms.skontoDays')}</label>
                <input id={`${uid}-terms-default_skonto_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={terms.default_skonto_days}
                  onChange={e => { setTerms(t => ({ ...t, default_skonto_days: e.target.value })); markDirty('terms') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.terms.skontoDaysHint')}</p>
              </div>
            </div>
          </SectionCard>

          <div className="h-5" />

          <SectionCard
            title={t('settings.reminders.title')}
            description={t('settings.reminders.description')}
            dirty={!!dirty.reminders}
            saving={saving === 'reminders'}
            onSave={saveReminders}
          >
            <label className="flex items-center gap-2.5 text-sm cursor-pointer">
              <input type="checkbox" checked={reminders.reminders_enabled}
                onChange={e => { setReminders(r => ({ ...r, reminders_enabled: e.target.checked })); markDirty('reminders') }}
                className="accent-neutral-900 dark:accent-white" />
              <span className="text-neutral-800 dark:text-neutral-200">{t('settings.reminders.enabled')}</span>
            </label>
            {reminders.reminders_enabled && !google.connected && (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('dunning.settings.noGmail')}</p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_grace_days`}>{t('settings.reminders.grace')}</label>
                <input id={`${uid}-reminders-reminder_grace_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_grace_days}
                  onChange={e => { setReminders(r => ({ ...r, reminder_grace_days: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.reminders.graceHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_interval_days`}>{t('settings.reminders.interval')}</label>
                <input id={`${uid}-reminders-reminder_interval_days`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_interval_days}
                  onChange={e => { setReminders(r => ({ ...r, reminder_interval_days: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.reminders.intervalHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_max_level`}>{t('settings.reminders.maxLevel')}</label>
                <input id={`${uid}-reminders-reminder_max_level`} type="text" inputMode="numeric" pattern="[0-9]*" className={inp} value={reminders.reminder_max_level}
                  onChange={e => { setReminders(r => ({ ...r, reminder_max_level: e.target.value })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.reminders.maxLevelHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_fee`}>{t('settings.reminders.fee')}</label>
                <MoneyInput id={`${uid}-reminders-reminder_fee`} className={inp} value={reminders.reminder_fee === '' ? null : Number(reminders.reminder_fee)}
                  onValueChange={n => { setReminders(r => ({ ...r, reminder_fee: n === null ? '' : String(n) })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.reminders.feeHint', { token: '{{fee}}' })}</p>
              </div>
              <div className="space-y-1.5">
                <label className={lbl} htmlFor={`${uid}-reminders-reminder_interest_rate`}>{t('settings.reminders.interest')}</label>
                <MoneyInput id={`${uid}-reminders-reminder_interest_rate`} className={inp} value={reminders.reminder_interest_rate === '' ? null : Number(reminders.reminder_interest_rate)}
                  onValueChange={n => { setReminders(r => ({ ...r, reminder_interest_rate: n === null ? '' : String(n) })); markDirty('reminders') }} />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.reminders.interestHint', { token: '{{interest}}' })}</p>
              </div>
            </div>
          </SectionCard>
        </div>}

        {/* ── 6. PDF Footer ── */}

        {activeSection === 'footer' && <div>
          <SectionCard
            title={t('settings.footer.title')}
            description={t('settings.footer.description')}
            dirty={!!dirty.footer}
            saving={saving === 'footer'}
            onSave={saveFooter}
          >
            {/* Doc type tabs */}
            <div className="flex gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg w-fit">
              {(['invoice', 'quote', 'credit_note'] as const).map(type => (
                <button key={type} type="button"
                  aria-pressed={footerDocTab === type}
                  onClick={() => { forgetFocused(); setFooterDocTab(type) }}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${footerDocTab === type ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`}>
                  {type === 'invoice' ? t('settings.footer.invoice') : type === 'quote' ? t('settings.footer.quote') : t('settings.footer.creditNote')}
                </button>
              ))}
            </div>
            <VarChips vars={FOOTER_VARS} onInsert={insertVar} />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-1">
              {t('settings.footer.insertHint')}
            </p>
            {footerDocTab === 'invoice' ? (
              <div key="invoice" className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-footerDe`}>{t('common.german')}</label>
                  <textarea id={`${uid}-footerDe`}
                    value={footerDe}
                    onChange={e => { setFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-footerEn`}>{t('common.english')}</label>
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
                  <label className={lbl} htmlFor={`${uid}-quoteFooterDe`}>{t('common.german')}</label>
                  <textarea id={`${uid}-quoteFooterDe`}
                    value={quoteFooterDe}
                    onChange={e => { setQuoteFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setQuoteFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-quoteFooterEn`}>{t('common.english')}</label>
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
                  <label className={lbl} htmlFor={`${uid}-creditNoteFooterDe`}>{t('common.german')}</label>
                  <textarea id={`${uid}-creditNoteFooterDe`}
                    value={creditNoteFooterDe}
                    onChange={e => { setCreditNoteFooterDe(e.target.value); markDirty('footer') }}
                    onFocus={e => onFieldFocus(e.currentTarget, v => { setCreditNoteFooterDe(v); markDirty('footer') })}
                    rows={4}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-creditNoteFooterEn`}>{t('common.english')}</label>
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
            title={t('settings.taxNotes.title')}
            description={t('settings.taxNotes.description')}
            dirty={!!dirty.taxnotes}
            saving={saving === 'taxnotes'}
            onSave={saveTaxNotes}
          >
            <div className="space-y-4">
              <div>
                <p className={`${lbl} mb-2`}>{t('settings.taxNotes.reverseCharge')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-reverse_charge_de`}>{t('common.german')}</label>
                    <input id={`${uid}-taxNotes-reverse_charge_de`}
                      type="text"
                      className={inp}
                      placeholder="Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)"
                      value={taxNotes.reverse_charge_de}
                      onChange={e => { setTaxNotes(n => ({ ...n, reverse_charge_de: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-reverse_charge_en`}>{t('common.english')}</label>
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
                <p className={`${lbl} mb-2`}>{t('settings.taxNotes.nonEu')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-non_eu_de`}>{t('common.german')}</label>
                    <input id={`${uid}-taxNotes-non_eu_de`}
                      type="text"
                      className={inp}
                      placeholder="Nicht steuerbar (Leistungsort außerhalb der EU)"
                      value={taxNotes.non_eu_de}
                      onChange={e => { setTaxNotes(n => ({ ...n, non_eu_de: e.target.value })); markDirty('taxnotes') }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-taxNotes-non_eu_en`}>{t('common.english')}</label>
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
            title={t('settings.templates.title')}
            description={t('settings.templates.description')}
            dirty={!!dirty.templates}
            saving={saving === 'templates'}
            onSave={saveTemplates}
          >
            {/* Doc type tabs */}
            <div className="flex flex-wrap gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg w-fit max-w-full">
              {DOC_TABS.map(type => (
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
                  {t(DOC_TAB_LABEL[type])}
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
              vars={variablesFor(activeDocTab).map(name => ({ token: `{{${name}}}`, label: t(`dunning.vars.${name}`) }))}
              onInsert={insertVar}
            />
            <details className="text-xs text-neutral-500 dark:text-neutral-400">
              <summary className="cursor-pointer py-1 w-fit hover:text-neutral-700 dark:hover:text-neutral-200">{t('dunning.settings.variables')}</summary>
              <dl className="mt-2 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {variablesFor(activeDocTab).map(name => (
                  <div key={name} className="contents">
                    <dt className="font-mono break-all">{`{{${name}}}`}</dt>
                    <dd className="mb-1 sm:mb-0">{t(`dunning.vars.${name}`)}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {activeDocTab === 'reminder' ? `${t('dunning.settings.reminderHint', { fee: '{{fee}}', interest: '{{interest}}', total: '{{total_due}}' })} ` : ''}
              {t('settings.templates.reminderHint', { token: '{{fee}}' })}
            </p>

            {/* Context label */}
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-t border-neutral-100 dark:border-neutral-800">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {t(DOC_TAB_LABEL[activeDocTab])} · {activeLang === 'de' ? t('common.german') : t('common.english')}
              </span>
              {!tpl[bodyKey] && (
                <button type="button" onClick={prefillBuiltIn}
                  className="text-xs py-1 underline underline-offset-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">
                  {activeDocTab === 'reminder' ? t('dunning.settings.useDefaultReminder') : t('dunning.settings.useDefault')}
                </button>
              )}
            </div>
            {activeDocTab === 'reminder' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('dunning.settings.level')}</span>
                <div className="flex flex-wrap gap-1 p-0.5 bg-neutral-100 dark:bg-neutral-800 rounded-lg">
                  {PREVIEW_LEVELS.map(level => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={previewLevel === level}
                      onClick={() => setPreviewLevel(level)}
                      className={`px-3 h-6 text-xs font-medium rounded-md transition-colors ${
                        previewLevel === level
                          ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm'
                          : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
                      }`}
                    >
                      {reminderTitle(level, activeLang)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Subject */}
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-tpl-subjectKey`}>{t('settings.templates.subject')}</label>
              <input id={`${uid}-tpl-subjectKey`}
                key={`${activeDocTab}-${activeLang}`}
                className={inp}
                value={tpl[subjectKey]}
                onChange={e => setTplField(activeDocTab, subjectKey, e.target.value)}
                onFocus={e => onFieldFocus(e.currentTarget, v => setTplField(activeDocTab, subjectKey, v))}
                placeholder={builtIn.subject}
              />
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <label className={lbl} htmlFor={`${uid}-tpl-bodyKey`}>{t('settings.templates.body')}</label>
              <textarea id={`${uid}-tpl-bodyKey`}
                key={`${activeDocTab}-${activeLang}`}
                value={tpl[bodyKey]}
                onChange={e => setTplField(activeDocTab, bodyKey, e.target.value)}
                onFocus={e => onFieldFocus(e.currentTarget, v => setTplField(activeDocTab, bodyKey, v))}
                rows={activeDocTab === 'reminder' ? 14 : 10}
                placeholder={builtIn.body}
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-base md:text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-500 resize-y"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('dunning.settings.defaultHint')}</p>
            </div>

            {/* Live preview */}
            {preview && (
              <section aria-label={t('dunning.settings.preview')} className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4 space-y-2 min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{t('dunning.settings.preview')}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('dunning.settings.previewNote')}</p>
                </div>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 break-words">{preview.subject}</p>
                <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-words">{preview.body}</p>
              </section>
            )}
          </SectionCard>
        </div>}

        {/* ── 7. Integrations ── */}
        {activeSection === 'integrations' && <div className="space-y-3">
          <div className="px-1 pb-1">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.integrations.title')}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.integrations.description')}</p>
          </div>

          {/* Google account (Gmail + Drive grant) */}
          <IntegrationCard
            title={t('settings.integrations.google.title')}
            description={t('settings.integrations.google.description')}
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
                    {disconnecting ? t('settings.integrations.google.disconnecting') : t('settings.integrations.google.disconnect')}
                  </button>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {google.connectedAt
                    ? t('settings.integrations.google.connectedOn', { date: formatDate(google.connectedAt, lang) })
                    : t('settings.integrations.google.connected')}
                  {' · '}
                  {driveScopeGranted
                    ? t('settings.integrations.google.driveGranted')
                    : <>{t('settings.integrations.google.driveNotConfirmed')}<a href="/api/gmail/auth" className="underline">{t('settings.integrations.google.reconnect')}</a>{t('settings.integrations.google.driveNotConfirmedTail')}</>}
                </p>
              </div>
            ) : google.email ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
                  <span className="text-sm text-amber-700 dark:text-amber-400">
                    {t('settings.integrations.google.expired', { email: google.email })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={disconnecting}
                    className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
                  >
                    {disconnecting ? t('common.removing') : t('settings.integrations.google.remove')}
                  </button>
                </div>
                <a
                  href="/api/gmail/auth"
                  className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300"
                >
                  <Mail size={14} /> {t('settings.integrations.google.reconnectGoogle')}
                </a>
              </div>
            ) : (
              <a
                href="/api/gmail/auth"
                className="inline-flex items-center gap-2 text-sm px-3 h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-neutral-700 dark:text-neutral-300"
              >
                <Mail size={14} /> {t('settings.integrations.google.connectGoogle')}
              </a>
            )}
          </IntegrationCard>

          {/* Google Drive */}
          <IntegrationCard
            title={t('settings.integrations.drive.title')}
            description={t('settings.integrations.drive.description')}
          >
            {!google.connected ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.integrations.drive.connectFirst')}</p>
            ) : (
              <div className="space-y-3">
                {!driveScopeGranted && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t('settings.integrations.drive.notConfirmed')}
                    <a href="/api/gmail/auth" className="underline">{t('settings.integrations.drive.reconnectLink')}</a>
                  </p>
                )}
                <div className="space-y-1.5">
                  <label className={lbl} htmlFor={`${uid}-driveFolder`}>{t('settings.integrations.drive.folder')}</label>
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
                      <HardDrive size={13} /> {savingDrive ? t('settings.integrations.drive.checking') : driveFolder.trim() ? t('settings.integrations.drive.verifySave') : t('settings.integrations.drive.removeFolder')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </IntegrationCard>

          {/* Bookamat */}
          <IntegrationCard
            title={t('settings.integrations.bookamat.title')}
            description={t('settings.integrations.bookamat.description')}
          >
            {bookamatUsername && !bookamatAccounts && !editingBookamat ? (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle size={14} />
                  <span>{bookamatUsername}</span>
                  {bookamatBankId && <span className="text-green-600/60 dark:text-green-400/60">{t('settings.integrations.bookamat.accountsConfigured')}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingBookamat(true)}
                    className="text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
                  >
                    {t('settings.integrations.bookamat.change')}
                  </button>
                  {bookamatKeySaved && (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveKey(true)}
                      disabled={savingBookamat}
                      className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      {t('settings.integrations.bookamat.removeKey')}
                    </button>
                  )}
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-bookamatUsername`}>{t('settings.integrations.bookamat.username')}</label>
                    <input id={`${uid}-bookamatUsername`}
                      type="text"
                      value={bookamatUsername}
                      onChange={e => setBookamatUsername(e.target.value)}
                      placeholder="your@email.com"
                      className={inp}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={lbl} htmlFor={`${uid}-bookamatApiKey`}>{t('settings.integrations.bookamat.apiKey')}</label>
                    <input id={`${uid}-bookamatApiKey`}
                      type="password"
                      value={bookamatApiKey}
                      onChange={e => setBookamatApiKey(e.target.value)}
                      placeholder={bookamatKeySaved ? t('settings.integrations.bookamat.keySavedPlaceholder') : t('settings.integrations.bookamat.keyPlaceholder')}
                      className={inp}
                    />
                    {bookamatKeySaved && (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveKey(true)}
                        disabled={savingBookamat}
                        className="text-xs px-2 py-2 -my-2 -mr-2 rounded-md text-neutral-500 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                      >
                        {t('settings.integrations.bookamat.removeSavedKey')}
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
                    {loadingAccounts ? t('common.loading') : <><ChevronRight size={14} /> {t('settings.integrations.bookamat.loadAccounts')}</>}
                  </button>
                ) : (
                  <div className="space-y-4 pt-1 border-t border-neutral-100 dark:border-neutral-800">
                    <div className="space-y-1.5 pt-1">
                      <label className={lbl} htmlFor={`${uid}-bookamatBankId`}>{t('settings.integrations.bookamat.bankAccount')}</label>
                      <select id={`${uid}-bookamatBankId`}
                        value={bookamatBankId}
                        onChange={e => setBookamatBankId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">{t('common.selectPlaceholder')}</option>
                        {bookamatAccounts.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className={lbl} htmlFor={`${uid}-bookamatCashId`}>{t('settings.integrations.bookamat.cashAccount')}</label>
                      <select id={`${uid}-bookamatCashId`}
                        value={bookamatCashId}
                        onChange={e => setBookamatCashId(e.target.value ? Number(e.target.value) : '')}
                        className={inp}
                      >
                        <option value="">{t('common.notUsed')}</option>
                        {bookamatAccounts.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.integrations.bookamat.cashAccountHint')}</p>
                    </div>
                    <div className="space-y-1.5">
                      <label className={lbl} htmlFor={`${uid}-bookamatCostId`}>{t('settings.integrations.bookamat.incomeAccount')}</label>
                      <select id={`${uid}-bookamatCostId`}
                        value={bookamatCostId}
                        onChange={e => setBookamatCostId(Number(e.target.value))}
                        className={inp}
                      >
                        <option value="">{t('common.selectPlaceholder')}</option>
                        {bookamatAccounts.costAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <p className={lbl}>{t('settings.integrations.bookamat.vatAccounts')}</p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.integrations.bookamat.vatAccountsHint')}</p>
                      {([
                        ['rc',    0,  t('settings.integrations.bookamat.vatAccountRc'),    bookamatVatRc,    setBookamatVatRc],
                        ['nonEu', 0,  t('settings.integrations.bookamat.vatAccountNonEu'), bookamatVatNonEu, setBookamatVatNonEu],
                        ['0',     0,  t('settings.integrations.bookamat.vatAccount0'),     bookamatVat0,     setBookamatVat0],
                        ['10',    10, null, bookamatVat10, setBookamatVat10],
                        ['13',    13, null, bookamatVat13, setBookamatVat13],
                        ['20',    20, null, bookamatVat20, setBookamatVat20],
                      ] as [string, number, string | null, number | '', (v: number | '') => void][]).map(([key, rate, hint, val, setter]) => (
                        <div key={key} className="flex items-start gap-3">
                          <span className="text-xs text-neutral-500 dark:text-neutral-400 w-7 shrink-0 text-right pt-2">{rate}%</span>
                          <div className="flex-1 min-w-0 space-y-1">
                            <select
                              aria-label={hint ? `${t('settings.integrations.bookamat.vatAccountFor', { rate })} – ${hint}` : t('settings.integrations.bookamat.vatAccountFor', { rate })}
                              value={val}
                              onChange={e => setter(e.target.value ? Number(e.target.value) : '')}
                              className={inp}
                            >
                              <option value="">{t('common.notUsed')}</option>
                              {bookamatAccounts.vatAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                            </select>
                            {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={saveBookamat}
                      disabled={savingBookamat}
                      className="w-full h-9 text-sm rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50 font-medium"
                    >
                      {savingBookamat ? t('common.saving') : t('settings.integrations.bookamat.save')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </IntegrationCard>
        </div>}

        {activeSection === 'einvoice' && <EInvoiceCard settings={settings} />}

      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title={t('settings.integrations.google.disconnectTitle')}
        description={t('settings.integrations.google.disconnectDesc')}
        confirmLabel={disconnecting ? t('settings.integrations.google.disconnecting') : t('settings.integrations.google.disconnect')}
        destructive
        busy={disconnecting}
        onConfirm={disconnectGoogle}
        onCancel={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmRemoveKey}
        title={t('settings.integrations.bookamat.removeKeyTitle')}
        description={t('settings.integrations.bookamat.removeKeyDesc')}
        confirmLabel={savingBookamat ? t('common.removing') : t('settings.integrations.bookamat.removeKey')}
        destructive
        busy={savingBookamat}
        onConfirm={removeBookamatKey}
        onCancel={() => setConfirmRemoveKey(false)}
      />
    </div>
  )
}

// ── E-invoice ─────────────────────────────────────────────────────────────────
// The studio's Peppol address; empty sends 9914 (Austrian VAT number) with the UID.
function EInvoiceCard({ settings }: { settings: PublicSettings | null }) {
  const supabase = createClient()
  const { t } = useT()
  const uid = useId()
  const [peppol, setPeppol] = useState({ scheme: settings?.peppol_scheme ?? '', id: settings?.peppol_id ?? '' })
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const ownUid = normalizeVatId(settings?.uid_number ?? '')

  function change(field: 'scheme' | 'id', value: string) {
    setPeppol(p => ({ ...p, [field]: value }))
    setError(null)
    setDirty(true)
  }

  async function save() {
    if (!settings) return
    const scheme = peppol.scheme.trim()
    const id = peppol.id.trim()
    if (scheme && !/^\d{4}$/.test(scheme)) { setError(t('einvoice.settings.schemeInvalid')); return }
    if (!scheme !== !id) { setError(t('einvoice.settings.incomplete')); return }
    setSaving(true)
    const { error: saveError } = await supabase.from('settings').update({ peppol_scheme: scheme || null, peppol_id: id || null }).eq('id', settings.id)
    setSaving(false)
    if (saveError) { toast.error(saveError.message); return }
    setPeppol({ scheme, id })
    setDirty(false)
    toast.success(t('einvoice.settings.saved'))
  }

  return (
    <SectionCard title={t('einvoice.settings.title')} description={t('einvoice.settings.description')} dirty={dirty} saving={saving} onSave={save}>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label className={lbl} htmlFor={`${uid}-peppol-scheme`}>{t('einvoice.settings.scheme')}</label>
          <input id={`${uid}-peppol-scheme`} className={inp} value={peppol.scheme} inputMode="numeric" autoComplete="off" placeholder="9914"
            aria-invalid={!!error || undefined} aria-describedby={`${uid}-peppol-hint`}
            onChange={e => change('scheme', e.target.value)} />
        </div>
        <div className="space-y-1.5 col-span-2">
          <label className={lbl} htmlFor={`${uid}-peppol-id`}>{t('einvoice.settings.id')}</label>
          <input id={`${uid}-peppol-id`} className={inp} value={peppol.id} autoComplete="off" autoCapitalize="none" placeholder={ownUid || 'ATU12345678'}
            aria-invalid={!!error || undefined} aria-describedby={`${uid}-peppol-hint`}
            onChange={e => change('id', e.target.value)} />
        </div>
      </div>
      {error
        ? <p id={`${uid}-peppol-hint`} className={err}>{error}</p>
        : <p id={`${uid}-peppol-hint`} className="text-xs text-neutral-500 dark:text-neutral-400">
            {ownUid ? t('einvoice.settings.defaultHint', { uid: ownUid }) : t('einvoice.settings.defaultHintNoUid')}
          </p>}
    </SectionCard>
  )
}
