'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import type { Settings } from '@/types'

interface Props { settings: Settings | null }

export default function SettingsForm({ settings }: Props) {
  const [saving, setSaving] = useState(false)
  const [logoUrl, setLogoUrl] = useState(settings?.logo_url ?? '')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const supabase = createClient()

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
      invoice_footer_de: (fd.get('invoice_footer_de') as string) || null,
      invoice_footer_en: (fd.get('invoice_footer_en') as string) || null,
    }

    const { error } = await supabase.from('settings').update(payload).eq('id', settings!.id)
    if (error) { toast.error(error.message) } else { toast.success('Settings saved.') }
    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Logo</h2>
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

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Business details</h2>
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

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Bank details</h2>
        <F label="IBAN *" name="iban" defaultValue={settings?.iban} required />
        <div className="grid grid-cols-2 gap-3">
          <F label="BIC" name="bic" defaultValue={settings?.bic} />
          <F label="Bank name" name="bank_name" defaultValue={settings?.bank_name ?? ''} />
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Document numbering</h2>
        <div className="grid grid-cols-3 gap-3">
          <F label="Invoice prefix" name="invoice_prefix" defaultValue={settings?.invoice_prefix ?? 'R'} />
          <F label="Quote prefix" name="quote_prefix" defaultValue={settings?.quote_prefix ?? 'A'} />
          <F label="Credit note prefix" name="credit_note_prefix" defaultValue={settings?.credit_note_prefix ?? 'G'} />
        </div>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">Numbers will look like: R-2026-001, A-2026-001, G-2026-001</p>
        <div className="grid grid-cols-3 gap-3">
          <F label="Next invoice #" name="next_invoice_number" type="number" defaultValue={String(settings?.next_invoice_number ?? 1)} />
          <F label="Next quote #" name="next_quote_number" type="number" defaultValue={String(settings?.next_quote_number ?? 1)} />
          <F label="Next credit note #" name="next_credit_note_number" type="number" defaultValue={String(settings?.next_credit_note_number ?? 1)} />
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Defaults</h2>
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

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Invoice footer text</h2>
        <div className="space-y-1.5">
          <Label>Footer (Deutsch)</Label>
          <Textarea name="invoice_footer_de" defaultValue={settings?.invoice_footer_de ?? ''} rows={3} className="resize-none text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label>Footer (English)</Label>
          <Textarea name="invoice_footer_en" defaultValue={settings?.invoice_footer_en ?? ''} rows={3} className="resize-none text-sm" />
        </div>
      </section>

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
