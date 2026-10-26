'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { X } from 'lucide-react'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import type { Client } from '@/types'

interface Props { client?: Client; onSaved?: () => void }

type FieldErrors = Partial<Record<'country' | 'email' | 'uid_number' | 'payment_days', string>>

const TAX_OPTIONS = [
  { value: 'at_vat', label: 'Austrian VAT (20%)' },
  { value: 'eu_reverse_charge', label: 'EU Reverse Charge' },
  { value: 'non_eu', label: 'Non-EU (no VAT)' },
]

const SELECT_CLS = 'w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400'

// Postgres foreign_key_violation: documents.client_id is "on delete restrict".
const FK_VIOLATION = '23503'

function TagInput({ initialTags }: { initialTags: string[] }) {
  const [tags, setTags] = useState<string[]>(initialTags)
  const [input, setInput] = useState('')

  function addTag(val: string) {
    const trimmed = val.trim().replace(/,$/, '')
    if (trimmed && !tags.includes(trimmed)) setTags(t => [...t, trimmed])
    setInput('')
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input) }
    if (e.key === 'Backspace' && !input && tags.length) setTags(t => t.slice(0, -1))
  }

  return (
    <div className="space-y-1.5">
      <Label>Tags</Label>
      <input type="hidden" name="tags" value={tags.join(', ')} />
      <div
        className="flex flex-wrap gap-1.5 min-h-9 px-2 py-1.5 border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-900 cursor-text"
        onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}
      >
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            {tag}
            <button type="button" onClick={() => setTags(t => t.filter(x => x !== tag))} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-100">
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => { if (input.trim()) addTag(input) }}
          placeholder={tags.length ? '' : 'Add tag…'}
          className="flex-1 min-w-20 text-sm bg-transparent outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
        />
      </div>
      <p className="text-xs text-neutral-400 dark:text-neutral-500">Press Enter or comma to add</p>
    </div>
  )
}

export default function ClientForm({ client, onSaved }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const nameVal = (fd.get('name') as string).trim()
    const companyVal = (fd.get('company') as string).trim()
    if (!nameVal && !companyVal) {
      toast.error('Enter a name or company name.')
      return
    }
    const country = (fd.get('country') as string).trim()
    const email = (fd.get('email') as string).trim()
    const uid = normalizeVatId(fd.get('uid_number') as string)
    const paymentDaysRaw = (fd.get('payment_days') as string).trim()
    const paymentDays = paymentDaysRaw === '' || Number.isNaN(Number(paymentDaysRaw)) ? 14 : Number(paymentDaysRaw)

    const nextErrors: FieldErrors = {}
    if (!country) nextErrors.country = 'Enter a country.'
    if (email && !isValidEmail(email)) nextErrors.email = 'Enter a valid email address.'
    if (uid && !isValidVatId(uid)) nextErrors.uid_number = 'Enter a valid VAT ID, e.g. ATU12345678 or DE123456789.'
    if (!Number.isInteger(paymentDays) || paymentDays < 0 || paymentDays > 365) nextErrors.payment_days = 'Payment days must be a whole number between 0 and 365.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    setSaving(true)
    const tagsRaw = (fd.get('tags') as string).trim()
    const payload = {
      name: nameVal,
      company: companyVal || null,
      address_line1: fd.get('address_line1') as string,
      address_line2: (fd.get('address_line2') as string) || null,
      zip: fd.get('zip') as string,
      city: fd.get('city') as string,
      country,
      email,
      phone: (fd.get('phone') as string) || null,
      uid_number: uid || null,
      tax_treatment: fd.get('tax_treatment') as string,
      language: fd.get('language') as string,
      currency: fd.get('currency') as string,
      payment_days: paymentDays,
      status: fd.get('status') as string,
      tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
      notes: (fd.get('notes') as string) || null,
      reminders_opt_out: fd.get('reminders_opt_out') === 'on',
    }

    if (client) {
      const { error } = await supabase.from('clients').update(payload).eq('id', client.id)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Client updated.')
      onSaved?.()
    } else {
      const { error } = await supabase.from('clients').insert(payload)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Client created.')
      router.push('/clients')
    }
    setSaving(false)
    router.refresh()
  }

  async function handleDelete() {
    if (!client) return
    if (!confirm(`Delete ${client.company ?? client.name}? This cannot be undone.`)) return
    setDeleting(true)
    const { error } = await supabase.from('clients').delete().eq('id', client.id)
    if (error) {
      toast.error(error.code === FK_VIOLATION
        ? 'This client has documents — set the client to inactive instead.'
        : error.message)
      setDeleting(false)
      return
    }
    toast.success('Client deleted.')
    router.push('/clients')
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" name="name" defaultValue={client?.name} placeholder="Contact name" />
        <Field label="Company" name="company" defaultValue={client?.company ?? ''} placeholder="Company name" />
      </div>
      <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2">At least one of Name or Company is required.</p>
      <Field label="Address" name="address_line1" defaultValue={client?.address_line1} />
      <Field label="Address line 2" name="address_line2" defaultValue={client?.address_line2 ?? ''} />
      <div className="grid grid-cols-3 gap-3">
        <Field label="ZIP" name="zip" defaultValue={client?.zip} />
        <Field label="City" name="city" defaultValue={client?.city} className="col-span-2" />
      </div>
      <Field label="Country" name="country" defaultValue={client?.country ?? ''} placeholder="Austria" error={errors.country} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email" name="email" type="email" defaultValue={client?.email} error={errors.email} />
        <Field label="Phone" name="phone" defaultValue={client?.phone ?? ''} />
      </div>
      <Field label="UID-Nummer" name="uid_number" defaultValue={client?.uid_number ?? ''} placeholder="ATU..." error={errors.uid_number} />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Tax treatment</Label>
          <select name="tax_treatment" defaultValue={client?.tax_treatment ?? 'at_vat'} className={SELECT_CLS}>
            {TAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Language</Label>
          <select name="language" defaultValue={client?.language ?? 'de'} className={SELECT_CLS}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Currency</Label>
          <select name="currency" defaultValue={client?.currency ?? 'EUR'} className={SELECT_CLS}>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <Field label="Payment days" name="payment_days" type="number" defaultValue={String(client?.payment_days ?? 14)} error={errors.payment_days} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Status</Label>
          <select name="status" defaultValue={client?.status ?? 'active'} className={SELECT_CLS}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="lead">Lead</option>
          </select>
        </div>
        <TagInput initialTags={client?.tags ?? []} />
      </div>

      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea name="notes" defaultValue={client?.notes ?? ''} rows={3} className="resize-none text-sm" />
      </div>

      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" name="reminders_opt_out" defaultChecked={client?.reminders_opt_out ?? false} className="mt-0.5 accent-neutral-900 dark:accent-white" />
        <span>
          <span className="font-medium text-neutral-800 dark:text-neutral-200">No automatic reminders</span>
          <span className="block text-xs text-neutral-400 dark:text-neutral-500">The daily reminder run skips this client&apos;s overdue invoices; you can still send reminders by hand.</span>
        </span>
      </label>

      <div className="flex items-center justify-between pt-2">
        {client && (
          <Button type="button" variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete client'}
          </Button>
        )}
        <Button type="submit" disabled={saving} className="ml-auto">
          {saving ? 'Saving…' : client ? 'Save changes' : 'Create client'}
        </Button>
      </div>
    </form>
  )
}

function Field({ label, name, defaultValue, type = 'text', placeholder = '', className = '', error }: {
  label: string; name: string; defaultValue?: string; type?: string; placeholder?: string; className?: string; error?: string
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? ''} placeholder={placeholder} className="text-sm" aria-invalid={!!error || undefined} />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
