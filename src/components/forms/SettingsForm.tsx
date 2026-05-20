'use client'

import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle, Mail, HardDrive } from 'lucide-react'
import type { Settings } from '@/types'

interface Props { settings: Settings | null }

const TABS = ['Business', 'Numbering', 'Templates'] as const
type Tab = typeof TABS[number]

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

export default function SettingsForm({ settings }: Props) {
  const [tab, setTab] = useState<Tab>('Business')
  const [saving, setSaving] = useState(false)
  const [logoUrl, setLogoUrl] = useState(settings?.logo_url ?? '')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [footerDe, setFooterDe] = useState(settings?.invoice_footer_de ?? '')
  const [footerEn, setFooterEn] = useState(settings?.invoice_footer_en ?? '')
  const [gmailEmail, setGmailEmail] = useState(settings?.gmail_email ?? null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [driveFolder, setDriveFolder] = useState(settings?.drive_folder_id ?? '')
  const [driveFolderName, setDriveFolderName] = useState(settings?.drive_folder_name ?? '')
  const [savingDrive, setSavingDrive] = useState(false)
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
    vatAccounts: { id: number; title: string }[]
  } | null>(null)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [savingBookamat, setSavingBookamat] = useState(false)
  const footerDeRef = useRef<HTMLTextAreaElement>(null)
  const footerEnRef = useRef<HTMLTextAreaElement>(null)

  type DocType = 'invoice' | 'quote' | 'credit_note'
  const [emailTpl, setEmailTpl] = useState({
    invoice:     { subject_de: settings?.email_subject_invoice_de ?? '',     body_de: settings?.email_body_invoice_de ?? '',     subject_en: settings?.email_subject_invoice_en ?? '',     body_en: settings?.email_body_invoice_en ?? '' },
    quote:       { subject_de: settings?.email_subject_quote_de ?? '',       body_de: settings?.email_body_quote_de ?? '',       subject_en: settings?.email_subject_quote_en ?? '',       body_en: settings?.email_body_quote_en ?? '' },
    credit_note: { subject_de: settings?.email_subject_credit_note_de ?? '', body_de: settings?.email_body_credit_note_de ?? '', subject_en: settings?.email_subject_credit_note_en ?? '', body_en: settings?.email_body_credit_note_en ?? '' },
  })
  function setTpl(docType: DocType, field: string, value: string) {
    setEmailTpl(t => ({ ...t, [docType]: { ...t[docType], [field]: value } }))
  }

  // Tracks the last-focused template input/textarea and its setter
  const lastFocused = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; setter: (v: string) => void } | null>(null)
  function onTplFocus(el: HTMLTextAreaElement | HTMLInputElement, setter: (v: string) => void) {
    lastFocused.current = { el, setter }
  }

  const supabase = createClient()
  const searchParams = useSearchParams()

  useEffect(() => {
    const status = searchParams.get('gmail')
    if (status === 'connected') toast.success('Gmail connected successfully.')
    if (status === 'error') toast.error('Gmail connection failed. Please try again.')
  }, [searchParams])

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
    // Accept full URL or bare folder ID
    const match = driveFolder.match(/[-\w]{25,}/)
    const folderId = match ? match[0] : driveFolder.trim()
    await supabase.from('settings').update({
      drive_folder_id: folderId || null,
      drive_folder_name: folderId ? (driveFolderName || folderId) : null,
    }).eq('id', settings.id)
    setDriveFolder(folderId)
    setSavingDrive(false)
    toast.success(folderId ? 'Drive folder saved.' : 'Drive folder removed.')
  }

  function insertVar(token: string) {
    const target = lastFocused.current
    if (!target) return
    const { el, setter } = target
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    setter(el.value.slice(0, start) + token + el.value.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
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
    toast.success('Accounts loaded.')
  }

  async function saveBookamat() {
    if (!settings) return
    setSavingBookamat(true)
    await supabase.from('settings').update({
      bookamat_username: bookamatUsername || null,
      bookamat_api_key: bookamatApiKey || null,
      bookamat_country: bookamatCountry,
      bookamat_bank_account_id: bookamatBankId || null,
      bookamat_cost_account_id: bookamatCostId || null,
      bookamat_vat_account_0: bookamatVat0 || null,
      bookamat_vat_account_10: bookamatVat10 || null,
      bookamat_vat_account_13: bookamatVat13 || null,
      bookamat_vat_account_20: bookamatVat20 || null,
    }).eq('id', settings.id)
    setSavingBookamat(false)
    toast.success('Bookamat settings saved.')
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    const fd = new FormData(e.currentTarget)
    const payload = {
      company_name: fd.get('company_name') as string,
      owner_name: fd.get('owner_name') as string,
      address_line1: fd.get('address_line1') as string,
      address_line2: (fd.get('address_line2') as string) || null,
      zip: fd.get('zip') as string,
      city: fd.get('city') as string,
      country: fd.get('country') as string,
      email: fd.get('email') as string,
      phone: (fd.get('phone') as string) || null,
      website: (fd.get('website') as string) || null,
      uid_number: fd.get('uid_number') as string,
      iban: fd.get('iban') as string,
      bic: fd.get('bic') as string,
      bank_name: (fd.get('bank_name') as string) || null,
      invoice_prefix: fd.get('invoice_prefix') as string,
      quote_prefix: fd.get('quote_prefix') as string,
      credit_note_prefix: fd.get('credit_note_prefix') as string,
      next_invoice_number: parseInt(fd.get('next_invoice_number') as string, 10),
      next_quote_number: parseInt(fd.get('next_quote_number') as string, 10),
      next_credit_note_number: parseInt(fd.get('next_credit_note_number') as string, 10),
      default_payment_days: parseInt(fd.get('default_payment_days') as string, 10),
      default_language: fd.get('default_language') as string,
      invoice_footer_de: footerDe || null,
      invoice_footer_en: footerEn || null,
      email_subject_invoice_de: emailTpl.invoice.subject_de || null,
      email_body_invoice_de: emailTpl.invoice.body_de || null,
      email_subject_invoice_en: emailTpl.invoice.subject_en || null,
      email_body_invoice_en: emailTpl.invoice.body_en || null,
      email_subject_quote_de: emailTpl.quote.subject_de || null,
      email_body_quote_de: emailTpl.quote.body_de || null,
      email_subject_quote_en: emailTpl.quote.subject_en || null,
      email_body_quote_en: emailTpl.quote.body_en || null,
      email_subject_credit_note_de: emailTpl.credit_note.subject_de || null,
      email_body_credit_note_de: emailTpl.credit_note.body_de || null,
      email_subject_credit_note_en: emailTpl.credit_note.subject_en || null,
      email_body_credit_note_en: emailTpl.credit_note.body_en || null,
    }

    const { error } = await supabase.from('settings').update(payload).eq('id', settings!.id)
    if (error) { toast.error(error.message) } else { toast.success('Settings saved.') }
    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Tabs */}
      <div className="flex border-b border-neutral-200 dark:border-neutral-700">
        {TABS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100'
                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Business' && (
        <div className="space-y-6">
          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Logo</p>
            <div className="flex items-center gap-4">
              {logoUrl && (
                <img src={logoUrl} alt="Logo" className="h-14 w-auto object-contain border border-neutral-100 dark:border-neutral-800 rounded-md p-1" />
              )}
              <div>
                <label className="cursor-pointer text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                  {uploadingLogo ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} />
                </label>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1.5">PNG or SVG, transparent background recommended</p>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Business details</p>
            <div className="grid grid-cols-2 gap-3">
              <F label="Business name *" name="company_name" defaultValue={settings?.company_name} required />
              <F label="Owner name" name="owner_name" defaultValue={settings?.owner_name} />
            </div>
            <F label="Address *" name="address_line1" defaultValue={settings?.address_line1} required />
            <F label="Address line 2" name="address_line2" defaultValue={settings?.address_line2 ?? ''} />
            <div className="grid grid-cols-3 gap-3">
              <F label="ZIP" name="zip" defaultValue={settings?.zip} />
              <F label="City" name="city" defaultValue={settings?.city} className="col-span-2" />
            </div>
            <F label="Country" name="country" defaultValue={settings?.country ?? 'Austria'} />
            <div className="grid grid-cols-2 gap-3">
              <F label="Email" name="email" type="email" defaultValue={settings?.email} />
              <F label="Phone" name="phone" defaultValue={settings?.phone ?? ''} />
            </div>
            <F label="Website" name="website" defaultValue={settings?.website ?? ''} />
            <F label="UID-Nummer *" name="uid_number" defaultValue={settings?.uid_number} required placeholder="ATU…" />
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Bank details</p>
            <F label="IBAN *" name="iban" defaultValue={settings?.iban} required />
            <div className="grid grid-cols-2 gap-3">
              <F label="BIC" name="bic" defaultValue={settings?.bic} />
              <F label="Bank name" name="bank_name" defaultValue={settings?.bank_name ?? ''} />
            </div>
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Gmail integration</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Send invoices directly from your Gmail account with the PDF auto-attached.</p>
            {gmailEmail ? (
              <div className="flex items-center justify-between p-3 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30">
                <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle size={15} />
                  <span>Connected as <strong>{gmailEmail}</strong></span>
                </div>
                <button type="button" onClick={disconnectGmail} disabled={disconnecting}
                  className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            ) : (
              <a href="/api/gmail/auth"
                className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                <Mail size={14} /> Connect Gmail account
              </a>
            )}
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Google Drive</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              Auto-upload PDFs to a Drive folder when you send or download an invoice.
              {!gmailEmail && <span className="text-amber-600 dark:text-amber-500"> Connect Gmail first to enable Drive.</span>}
            </p>
            {gmailEmail && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">Folder URL or ID</label>
                  <input
                    type="text"
                    value={driveFolder}
                    onChange={e => setDriveFolder(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/…"
                    className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                  />
                </div>
                {driveFolder && (
                  <div className="space-y-1.5">
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">Folder label (for display)</label>
                    <input
                      type="text"
                      value={driveFolderName}
                      onChange={e => setDriveFolderName(e.target.value)}
                      placeholder="e.g. Invoices 2026"
                      className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                    />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={saveDriveFolder}
                    disabled={savingDrive}
                    className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
                  >
                    <HardDrive size={14} /> {savingDrive ? 'Saving…' : driveFolder ? 'Save folder' : 'Remove folder'}
                  </button>
                  {settings?.drive_folder_id && (
                    <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle size={13} />
                      {settings.drive_folder_name || settings.drive_folder_id}
                    </span>
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
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Bookamat</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Automatically sync paid invoices to your Bookamat bookkeeping.</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">Username</label>
                  <input type="text" value={bookamatUsername} onChange={e => setBookamatUsername(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">API Key</label>
                  <input type="password" value={bookamatApiKey} onChange={e => setBookamatApiKey(e.target.value)}
                    placeholder="From Mein Account → API"
                    className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600" />
                </div>
              </div>
              <button type="button" onClick={loadBookamatAccounts} disabled={loadingAccounts}
                className="text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50">
                {loadingAccounts ? 'Loading…' : 'Load accounts from Bookamat'}
              </button>
              {bookamatAccounts && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">Bank account (receives payments)</label>
                    <select value={bookamatBankId} onChange={e => setBookamatBankId(Number(e.target.value))}
                      className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none">
                      <option value="">Select…</option>
                      {bookamatAccounts.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">Income account (Erlöskonto)</label>
                    <select value={bookamatCostId} onChange={e => setBookamatCostId(Number(e.target.value))}
                      className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none">
                      <option value="">Select…</option>
                      {bookamatAccounts.costAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-neutral-500 dark:text-neutral-400">VAT accounts (Umsatzsteuerkonten)</label>
                    {([
                      [0, bookamatVat0, setBookamatVat0],
                      [10, bookamatVat10, setBookamatVat10],
                      [13, bookamatVat13, setBookamatVat13],
                      [20, bookamatVat20, setBookamatVat20],
                    ] as [number, number | '', (v: number) => void][]).map(([rate, val, setter]) => (
                      <div key={rate} className="flex items-center gap-3">
                        <span className="text-xs text-neutral-400 dark:text-neutral-500 w-8 shrink-0">{rate}%</span>
                        <select value={val} onChange={e => setter(Number(e.target.value))}
                          className="flex-1 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none">
                          <option value="">Not used</option>
                          {bookamatAccounts.vatAccounts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={saveBookamat} disabled={savingBookamat}
                    className="text-sm px-3 py-2 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50">
                    {savingBookamat ? 'Saving…' : 'Save Bookamat settings'}
                  </button>
                </div>
              )}
              {settings?.bookamat_username && !bookamatAccounts && (
                <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle size={13} /> Connected as {settings.bookamat_username}
                </div>
              )}
            </div>
          </section>

          {/* Hidden fields for other tabs so form data is complete */}
          <HiddenNumberingFields settings={settings} />
          <HiddenTemplateFields footerDe={footerDe} footerEn={footerEn} />
        </div>
      )}

      {tab === 'Numbering' && (
        <div className="space-y-6">
          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Document prefixes</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Invoice prefix" name="invoice_prefix" defaultValue={settings?.invoice_prefix ?? 'R'} />
              <F label="Quote prefix" name="quote_prefix" defaultValue={settings?.quote_prefix ?? 'A'} />
              <F label="Credit note prefix" name="credit_note_prefix" defaultValue={settings?.credit_note_prefix ?? 'G'} />
            </div>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Numbers will look like: R-2026-001, A-2026-001, G-2026-001</p>
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Next numbers</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Next invoice #" name="next_invoice_number" type="number" defaultValue={String(settings?.next_invoice_number ?? 1)} />
              <F label="Next quote #" name="next_quote_number" type="number" defaultValue={String(settings?.next_quote_number ?? 1)} />
              <F label="Next credit note #" name="next_credit_note_number" type="number" defaultValue={String(settings?.next_credit_note_number ?? 1)} />
            </div>
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Defaults</p>
            <div className="grid grid-cols-2 gap-3">
              <F label="Default payment days" name="default_payment_days" type="number" defaultValue={String(settings?.default_payment_days ?? 14)} />
              <div className="space-y-1.5">
                <Label>Default language</Label>
                <select name="default_language" defaultValue={settings?.default_language ?? 'de'}
                  className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400">
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
          </section>

          <HiddenBusinessFields settings={settings} logoUrl={logoUrl} />
          <HiddenTemplateFields footerDe={footerDe} footerEn={footerEn} />
        </div>
      )}

      {tab === 'Templates' && (
        <div className="space-y-6">
          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Invoice footer text</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Printed at the bottom of every invoice and quote. Click a variable to insert it at the cursor.</p>
            <div className="flex flex-wrap gap-1.5">
              {FOOTER_VARS.map(v => (
                <button
                  key={v.token}
                  type="button"
                  onClick={() => insertVar(v.token)}
                  className="text-xs px-2 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-500 transition-colors"
                >
                  <span className="font-mono">{v.token}</span>
                  <span className="ml-1.5 text-neutral-400 dark:text-neutral-500 text-[10px]">{v.label}</span>
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>Footer (Deutsch)</Label>
              <Textarea ref={footerDeRef} name="invoice_footer_de" value={footerDe} onChange={e => setFooterDe(e.target.value)} onFocus={e => onTplFocus(e.currentTarget, setFooterDe)} rows={4} className="resize-none text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Footer (English)</Label>
              <Textarea ref={footerEnRef} name="invoice_footer_en" value={footerEn} onChange={e => setFooterEn(e.target.value)} onFocus={e => onTplFocus(e.currentTarget, setFooterEn)} rows={4} className="resize-none text-sm" />
            </div>
          </section>

          <section className="space-y-4">
            <p className="text-xs font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Email templates</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">Pre-filled subject and body for "Send via Gmail". Same variables as footer. Click a field first, then a variable chip.</p>
            {(
              [
                { type: 'invoice' as DocType,     label: 'Invoice' },
                { type: 'quote' as DocType,       label: 'Quote' },
                { type: 'credit_note' as DocType, label: 'Credit Note' },
              ] as const
            ).map(({ type: dt, label }) => (
              <div key={dt} className="space-y-3 border border-neutral-100 dark:border-neutral-800 rounded-lg p-4">
                <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</p>
                <div className="grid grid-cols-2 gap-4">
                  {(['de', 'en'] as const).map(lang => (
                    <div key={lang} className="space-y-2">
                      <p className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 uppercase">{lang === 'de' ? 'Deutsch' : 'English'}</p>
                      <div className="space-y-1">
                        <Label className="text-xs">Subject</Label>
                        <input
                          value={emailTpl[dt][`subject_${lang}`]}
                          onChange={e => setTpl(dt, `subject_${lang}`, e.target.value)}
                          onFocus={e => onTplFocus(e.currentTarget, v => setTpl(dt, `subject_${lang}`, v))}
                          className="w-full text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Body</Label>
                        <textarea
                          value={emailTpl[dt][`body_${lang}`]}
                          onChange={e => setTpl(dt, `body_${lang}`, e.target.value)}
                          onFocus={e => onTplFocus(e.currentTarget, v => setTpl(dt, `body_${lang}`, v))}
                          rows={5}
                          className="w-full text-sm px-3 py-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 resize-none"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <HiddenBusinessFields settings={settings} logoUrl={logoUrl} />
          <HiddenNumberingFields settings={settings} />
        </div>
      )}

      <Button type="submit" disabled={saving} className="w-full">
        {saving ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  )
}

function F({ label, name, defaultValue, type = 'text', required = false, placeholder = '', className = '' }: {
  label: string; name: string; defaultValue?: string; type?: string; required?: boolean; placeholder?: string; className?: string
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? ''} required={required} placeholder={placeholder} className="text-sm" />
    </div>
  )
}

function HiddenBusinessFields({ settings, logoUrl }: { settings: Settings | null; logoUrl: string }) {
  return (
    <>
      <input type="hidden" name="company_name" value={settings?.company_name ?? ''} />
      <input type="hidden" name="owner_name" value={settings?.owner_name ?? ''} />
      <input type="hidden" name="address_line1" value={settings?.address_line1 ?? ''} />
      <input type="hidden" name="address_line2" value={settings?.address_line2 ?? ''} />
      <input type="hidden" name="zip" value={settings?.zip ?? ''} />
      <input type="hidden" name="city" value={settings?.city ?? ''} />
      <input type="hidden" name="country" value={settings?.country ?? ''} />
      <input type="hidden" name="email" value={settings?.email ?? ''} />
      <input type="hidden" name="phone" value={settings?.phone ?? ''} />
      <input type="hidden" name="website" value={settings?.website ?? ''} />
      <input type="hidden" name="uid_number" value={settings?.uid_number ?? ''} />
      <input type="hidden" name="iban" value={settings?.iban ?? ''} />
      <input type="hidden" name="bic" value={settings?.bic ?? ''} />
      <input type="hidden" name="bank_name" value={settings?.bank_name ?? ''} />
    </>
  )
}

function HiddenNumberingFields({ settings }: { settings: Settings | null }) {
  return (
    <>
      <input type="hidden" name="invoice_prefix" value={settings?.invoice_prefix ?? 'R'} />
      <input type="hidden" name="quote_prefix" value={settings?.quote_prefix ?? 'A'} />
      <input type="hidden" name="credit_note_prefix" value={settings?.credit_note_prefix ?? 'G'} />
      <input type="hidden" name="next_invoice_number" value={String(settings?.next_invoice_number ?? 1)} />
      <input type="hidden" name="next_quote_number" value={String(settings?.next_quote_number ?? 1)} />
      <input type="hidden" name="next_credit_note_number" value={String(settings?.next_credit_note_number ?? 1)} />
      <input type="hidden" name="default_payment_days" value={String(settings?.default_payment_days ?? 14)} />
      <input type="hidden" name="default_language" value={settings?.default_language ?? 'de'} />
    </>
  )
}

function HiddenTemplateFields({ footerDe, footerEn }: { footerDe: string; footerEn: string }) {
  return (
    <>
      <input type="hidden" name="invoice_footer_de" value={footerDe} />
      <input type="hidden" name="invoice_footer_en" value={footerEn} />
    </>
  )
}
