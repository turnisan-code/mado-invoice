'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { X } from 'lucide-react'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import type { Client, TaxTreatment } from '@/types'
import { useT } from '@/lib/i18n/client'

interface Props { client?: Client; onSaved?: () => void }

type FieldErrors = Partial<Record<'country' | 'email' | 'uid_number' | 'payment_days', string>>

const TAX_OPTIONS: TaxTreatment[] = ['at_vat', 'eu_reverse_charge', 'non_eu']

const SELECT_CLS = 'w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-1.5 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400'

// Postgres foreign_key_violation: documents.client_id is "on delete restrict".
const FK_VIOLATION = '23503'

function TagInput({ initialTags }: { initialTags: string[] }) {
  const [tags, setTags] = useState<string[]>(initialTags)
  const [input, setInput] = useState('')
  const inputId = useId()
  const { t } = useT()

  function addTag(val: string) {
    const trimmed = val.trim().replace(/,$/, '')
    if (trimmed && !tags.includes(trimmed)) setTags(list => [...list, trimmed])
    setInput('')
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input) }
    if (e.key === 'Backspace' && !input && tags.length) setTags(list => list.slice(0, -1))
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{t('clients.form.tags')}</Label>
      <input type="hidden" name="tags" value={tags.join(', ')} />
      <div
        className="flex flex-wrap gap-1.5 min-h-9 px-2 py-1.5 border border-neutral-200 dark:border-neutral-700 rounded-md bg-white dark:bg-neutral-900 cursor-text focus-within:ring-1 focus-within:ring-neutral-400"
        onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}
      >
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            {tag}
            <button type="button" onClick={() => setTags(list => list.filter(x => x !== tag))} aria-label={t('clients.form.removeTag', { tag })} className="h-5 w-5 -mr-1 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-100">
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => { if (input.trim()) addTag(input) }}
          placeholder={tags.length ? '' : t('clients.form.addTag')}
          className="flex-1 min-w-20 text-base md:text-sm bg-transparent outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
        />
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('clients.form.tagHint')}</p>
    </div>
  )
}

export default function ClientForm({ client, onSaved }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const uid = useId()
  const { t } = useT()
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const nameVal = (fd.get('name') as string).trim()
    const companyVal = (fd.get('company') as string).trim()
    if (!nameVal && !companyVal) {
      toast.error(t('clients.form.nameRequired'))
      return
    }
    const country = (fd.get('country') as string).trim()
    const email = (fd.get('email') as string).trim()
    const uidNumber = normalizeVatId(fd.get('uid_number') as string)
    const paymentDaysRaw = (fd.get('payment_days') as string).trim()
    const paymentDays = paymentDaysRaw === '' || Number.isNaN(Number(paymentDaysRaw)) ? 14 : Number(paymentDaysRaw)

    const nextErrors: FieldErrors = {}
    if (!country) nextErrors.country = t('clients.form.countryRequired')
    if (email && !isValidEmail(email)) nextErrors.email = t('clients.form.emailInvalid')
    if (uidNumber && !isValidVatId(uidNumber)) nextErrors.uid_number = t('clients.form.uidInvalid')
    if (!Number.isInteger(paymentDays) || paymentDays < 0 || paymentDays > 365) nextErrors.payment_days = t('clients.form.paymentDaysInvalid')
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
      uid_number: uidNumber || null,
      tax_treatment: fd.get('tax_treatment') as string,
      language: fd.get('language') as string,
      currency: fd.get('currency') as string,
      payment_days: paymentDays,
      status: fd.get('status') as string,
      tags: tagsRaw ? tagsRaw.split(',').map(tag => tag.trim()).filter(Boolean) : [],
      notes: (fd.get('notes') as string) || null,
      reminders_opt_out: fd.get('reminders_opt_out') === 'on',
    }

    if (client) {
      const { error } = await supabase.from('clients').update(payload).eq('id', client.id)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success(t('clients.form.updated'))
      onSaved?.()
    } else {
      const { error } = await supabase.from('clients').insert(payload)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success(t('clients.form.created'))
      router.push('/clients')
    }
    setSaving(false)
    router.refresh()
  }

  async function handleDelete() {
    if (!client) return
    setDeleting(true)
    const { error } = await supabase.from('clients').delete().eq('id', client.id)
    if (error) {
      toast.error(error.code === FK_VIOLATION
        ? t('clients.form.hasDocuments')
        : error.message)
      setDeleting(false)
      setConfirmDelete(false)
      return
    }
    toast.success(t('clients.form.deleted'))
    router.push('/clients')
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('clients.form.name')} name="name" defaultValue={client?.name} placeholder={t('clients.form.namePlaceholder')} />
        <Field label={t('clients.form.company')} name="company" defaultValue={client?.company ?? ''} placeholder={t('clients.form.companyPlaceholder')} />
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-2">{t('clients.form.nameOrCompany')}</p>
      <Field label={t('clients.form.address')} name="address_line1" defaultValue={client?.address_line1} />
      <Field label={t('clients.form.addressLine2')} name="address_line2" defaultValue={client?.address_line2 ?? ''} />
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('clients.form.zip')} name="zip" defaultValue={client?.zip} />
        <Field label={t('clients.form.city')} name="city" defaultValue={client?.city} className="col-span-2" />
      </div>
      <Field label={t('clients.form.country')} name="country" defaultValue={client?.country ?? ''} placeholder={t('clients.form.countryPlaceholder')} error={errors.country} />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('clients.form.email')} name="email" type="email" defaultValue={client?.email} error={errors.email} />
        <Field label={t('clients.form.phone')} name="phone" type="tel" defaultValue={client?.phone ?? ''} />
      </div>
      <Field label={t('clients.form.uid')} name="uid_number" defaultValue={client?.uid_number ?? ''} placeholder={t('clients.form.uidPlaceholder')} error={errors.uid_number} />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-tax`}>{t('clients.form.taxTreatment')}</Label>
          <select id={`${uid}-tax`} name="tax_treatment" defaultValue={client?.tax_treatment ?? 'at_vat'} className={SELECT_CLS}>
            {TAX_OPTIONS.map(o => <option key={o} value={o}>{t(`taxTreatments.${o}`)}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-language`}>{t('clients.form.language')}</Label>
          <select id={`${uid}-language`} name="language" defaultValue={client?.language ?? 'de'} className={SELECT_CLS}>
            <option value="de">{t('common.german')}</option>
            <option value="en">{t('common.english')}</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-currency`}>{t('clients.form.currency')}</Label>
          <select id={`${uid}-currency`} name="currency" defaultValue={client?.currency ?? 'EUR'} className={SELECT_CLS}>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <Field label={t('clients.form.paymentDays')} name="payment_days" inputMode="numeric" defaultValue={String(client?.payment_days ?? 14)} error={errors.payment_days} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-status`}>{t('clients.form.status')}</Label>
          <select id={`${uid}-status`} name="status" defaultValue={client?.status ?? 'active'} className={SELECT_CLS}>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
            <option value="lead">{t('status.lead')}</option>
          </select>
        </div>
        <TagInput initialTags={client?.tags ?? []} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-notes`}>{t('clients.form.notes')}</Label>
        <Textarea id={`${uid}-notes`} name="notes" defaultValue={client?.notes ?? ''} rows={3} className="resize-none" />
      </div>

      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" name="reminders_opt_out" defaultChecked={client?.reminders_opt_out ?? false} className="mt-0.5 accent-neutral-900 dark:accent-white" />
        <span>
          <span className="font-medium text-neutral-800 dark:text-neutral-200">{t('clients.form.noReminders')}</span>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('clients.form.noRemindersHint')}</span>
        </span>
      </label>

      <div className="flex items-center justify-between pt-2">
        {client && (
          <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} disabled={deleting}>
            {deleting ? t('common.deleting') : t('clients.form.deleteClient')}
          </Button>
        )}
        <Button type="submit" disabled={saving} className="ml-auto">
          {saving ? t('common.saving') : client ? t('clients.form.saveChanges') : t('clients.form.createClient')}
        </Button>
      </div>

      {client && (
        <ConfirmDialog
          open={confirmDelete}
          title={t('clients.form.deleteTitle', { name: client.company ?? client.name })}
          description={t('clients.form.deleteDesc')}
          confirmLabel={deleting ? t('common.deleting') : t('clients.form.deleteClient')}
          destructive
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </form>
  )
}

function Field({ label, name, defaultValue, type = 'text', inputMode, placeholder = '', className = '', error }: {
  label: string; name: string; defaultValue?: string; type?: string; inputMode?: React.ComponentProps<'input'>['inputMode']; placeholder?: string; className?: string; error?: string
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} inputMode={inputMode} defaultValue={defaultValue ?? ''} placeholder={placeholder} aria-invalid={!!error || undefined} />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
