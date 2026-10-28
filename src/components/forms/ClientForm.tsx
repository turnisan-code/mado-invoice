'use client'

import { useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button, buttonVariants } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { X } from 'lucide-react'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import { isCountryCode, suggestTaxTreatment, toCountryCode } from '@/lib/utils/country'
import { clientDisplayName } from '@/lib/utils/clients'
import type { Client, ClientDefaults, CountryOption, TaxTreatment } from '@/types'
import type { TFn } from '@/lib/i18n'
import { useT } from '@/lib/i18n/client'

interface Props {
  client?: Client
  defaults: ClientDefaults
  countries: CountryOption[]
  onSaved?: () => void
  /** Without it the form offers a link back to the client list. */
  onCancel?: () => void
}

const TAX_OPTIONS: TaxTreatment[] = ['at_vat', 'eu_reverse_charge', 'non_eu']

const SELECT_CLS = 'w-full h-8 border border-neutral-200 dark:border-neutral-700 rounded-lg px-2.5 text-base md:text-sm bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 aria-invalid:border-red-500'

// Postgres foreign_key_violation: documents.client_id is "on delete restrict".
const FK_VIOLATION = '23503'

function makeSchema(t: TFn) {
  return z.object({
    name: z.string(),
    company: z.string(),
    address_line1: z.string(),
    address_line2: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string().refine(isCountryCode, t('clients.form.countryRequired')),
    email: z.string().refine(v => !v.trim() || isValidEmail(v), t('clients.form.emailInvalid')),
    phone: z.string(),
    uid_number: z.string().refine(v => !normalizeVatId(v) || isValidVatId(v), t('clients.form.uidInvalid')),
    tax_treatment: z.enum(['at_vat', 'eu_reverse_charge', 'non_eu']),
    language: z.enum(['de', 'en']),
    payment_days: z.number().int(t('clients.form.paymentDaysInvalid')).min(0, t('clients.form.paymentDaysInvalid')).max(365, t('clients.form.paymentDaysInvalid')).nullable(),
    status: z.enum(['active', 'inactive', 'lead']),
    tags: z.array(z.string()),
    notes: z.string(),
    reminders_opt_out: z.boolean(),
  }).refine(v => v.name.trim() || v.company.trim(), { path: ['name'], message: t('clients.form.nameRequired') })
}

type Values = z.infer<ReturnType<typeof makeSchema>>

function toValues(client: Client | undefined, defaults: ClientDefaults): Values {
  return {
    name: client?.name ?? '',
    company: client?.company ?? '',
    address_line1: client?.address_line1 ?? '',
    address_line2: client?.address_line2 ?? '',
    zip: client?.zip ?? '',
    city: client?.city ?? '',
    // An old free-text country that maps to a code is corrected silently; anything else stays visible.
    country: client ? toCountryCode(client.country) ?? client.country : defaults.country,
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    uid_number: client?.uid_number ?? '',
    tax_treatment: client?.tax_treatment ?? defaults.tax_treatment,
    language: client?.language ?? defaults.language,
    payment_days: client ? client.payment_days : null,
    status: client?.status ?? 'active',
    tags: client?.tags ?? [],
    notes: client?.notes ?? '',
    reminders_opt_out: client?.reminders_opt_out ?? false,
  }
}

function toPayload(v: Values) {
  return {
    name: v.name.trim(),
    company: v.company.trim() || null,
    address_line1: v.address_line1.trim(),
    address_line2: v.address_line2.trim() || null,
    zip: v.zip.trim(),
    city: v.city.trim(),
    country: v.country,
    email: v.email.trim(),
    phone: v.phone.trim() || null,
    uid_number: normalizeVatId(v.uid_number) || null,
    tax_treatment: v.tax_treatment,
    language: v.language,
    currency: 'EUR' as const,
    payment_days: v.payment_days,
    status: v.status,
    tags: v.tags,
    notes: v.notes.trim() || null,
    reminders_opt_out: v.reminders_opt_out,
  }
}

type Payload = ReturnType<typeof toPayload>
type Duplicate = { id: string; label: string; reasons: string[] }

// ilike treats % and _ as wildcards; an email may contain both.
const escapeLike = (v: string) => v.replace(/[\\%_]/g, ch => `\\${ch}`)

function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState('')
  const inputId = useId()
  const { t } = useT()

  function addTag(val: string) {
    const trimmed = val.trim().replace(/,$/, '')
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed])
    setInput('')
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input) }
    if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{t('clients.form.tags')}</Label>
      <div
        className="flex flex-wrap gap-1.5 min-h-8 px-2 py-1 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 cursor-text focus-within:ring-1 focus-within:ring-neutral-400"
        onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}
      >
        {value.map(tag => (
          <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            {tag}
            <button type="button" onClick={() => onChange(value.filter(x => x !== tag))} aria-label={t('clients.form.removeTag', { tag })} className="h-5 w-5 -mr-1 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-100">
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
          placeholder={value.length ? '' : t('clients.form.addTag')}
          className="flex-1 min-w-20 text-base md:text-sm bg-transparent outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
        />
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('clients.form.tagHint')}</p>
    </div>
  )
}

export default function ClientForm({ client, defaults, countries, onSaved, onCancel }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const uid = useId()
  const { t } = useT()
  const schema = useMemo(() => makeSchema(t), [t])
  const initial = useMemo(() => toValues(client, defaults), [client, defaults])
  const { register, control, handleSubmit, setValue, getValues, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initial,
  })
  // A saved client's treatment counts as chosen: editing its country or UID only shows the suggestion.
  const [taxManual, setTaxManual] = useState(!!client)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState<{ payload: Payload; duplicates: Duplicate[] } | null>(null)

  const [country, uidNumber, taxTreatment] = useWatch({ control, name: ['country', 'uid_number', 'tax_treatment'] })
  const hasValidUid = (v: string) => isValidVatId(normalizeVatId(v))
  const suggestion = suggestTaxTreatment(country, hasValidUid(uidNumber))
  // Stored free text from before country codes, kept selectable until the user picks a code.
  const legacyCountry = initial.country && !isCountryCode(initial.country) ? initial.country : null

  function applySuggestion(nextCountry: string, nextUid: string) {
    if (taxManual) return
    const next = suggestTaxTreatment(nextCountry, hasValidUid(nextUid))
    if (next) setValue('tax_treatment', next, { shouldDirty: true })
  }

  // Only a warning, and only when the email or UID is new or changed: a failed lookup never blocks saving.
  async function findDuplicates(p: Payload): Promise<Duplicate[]> {
    async function lookup(column: 'email' | 'uid_number', value: string, reason: string) {
      let q = supabase.from('clients').select('id, name, company, client_number')
      q = column === 'email' ? q.ilike('email', escapeLike(value)) : q.eq('uid_number', value)
      if (client) q = q.neq('id', client.id)
      const { data } = await q.limit(5)
      return (data ?? []).map(row => ({ row, reason }))
    }
    const lookups = []
    if (p.email && p.email.toLowerCase() !== (client?.email ?? '').toLowerCase()) {
      lookups.push(lookup('email', p.email, t('clientData.form.duplicateEmail')))
    }
    if (p.uid_number && p.uid_number !== client?.uid_number) {
      lookups.push(lookup('uid_number', p.uid_number, t('clientData.form.duplicateUid')))
    }
    const found = new Map<string, Duplicate>()
    for (const { row, reason } of (await Promise.all(lookups)).flat()) {
      const entry: Duplicate = found.get(row.id) ?? { id: row.id, label: [row.client_number, clientDisplayName(row)].filter(Boolean).join(' · '), reasons: [] }
      entry.reasons.push(reason)
      found.set(row.id, entry)
    }
    return [...found.values()]
  }

  async function save(payload: Payload) {
    setSaving(true)
    if (client) {
      const { error } = await supabase.from('clients').update(payload).eq('id', client.id)
      setSaving(false)
      if (error) { toast.error(error.message); return }
      toast.success(t('clients.form.updated'))
      onSaved?.()
      router.refresh()
    } else {
      const { data, error } = await supabase.from('clients').insert(payload).select('id').single()
      if (error) { setSaving(false); toast.error(error.message); return }
      toast.success(t('clients.form.created'))
      router.push(`/clients/${data.id}`)
    }
  }

  async function onValid(values: Values) {
    const payload = toPayload(values)
    const duplicates = await findDuplicates(payload)
    if (duplicates.length) { setPending({ payload, duplicates }); return }
    await save(payload)
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

  const busy = isSubmitting || saving
  const id = (field: keyof Values) => `${uid}-${field}`
  const errorOf = (field: keyof Values) => errors[field]?.message

  return (
    <form onSubmit={handleSubmit(onValid)} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field id={id('name')} label={t('clients.form.name')} error={errorOf('name')}>
          <Input id={id('name')} {...register('name')} placeholder={t('clients.form.namePlaceholder')} aria-invalid={!!errors.name || undefined} />
        </Field>
        <Field id={id('company')} label={t('clients.form.company')}>
          <Input id={id('company')} {...register('company')} placeholder={t('clients.form.companyPlaceholder')} />
        </Field>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-2">{t('clients.form.nameOrCompany')}</p>
      <Field id={id('address_line1')} label={t('clients.form.address')}>
        <Input id={id('address_line1')} {...register('address_line1')} autoComplete="address-line1" />
      </Field>
      <Field id={id('address_line2')} label={t('clients.form.addressLine2')}>
        <Input id={id('address_line2')} {...register('address_line2')} autoComplete="address-line2" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field id={id('zip')} label={t('clients.form.zip')}>
          <Input id={id('zip')} {...register('zip')} autoComplete="postal-code" />
        </Field>
        <Field id={id('city')} label={t('clients.form.city')} className="col-span-2">
          <Input id={id('city')} {...register('city')} autoComplete="address-level2" />
        </Field>
      </div>
      <Field id={id('country')} label={t('clients.form.country')} error={errorOf('country')}>
        <select
          id={id('country')}
          {...register('country', { onChange: e => applySuggestion(e.target.value, getValues('uid_number')) })}
          className={SELECT_CLS}
          aria-invalid={!!errors.country || undefined}
        >
          {legacyCountry && <option value={legacyCountry}>{legacyCountry}</option>}
          <optgroup label={t('clientData.form.countryEu')}>
            {countries.filter(c => c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </optgroup>
          <optgroup label={t('clientData.form.countryOther')}>
            {countries.filter(c => !c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </optgroup>
        </select>
        {legacyCountry && country === legacyCountry && !errors.country && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('clientData.form.countryUnknown', { value: legacyCountry })}</p>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id={id('email')} label={t('clients.form.email')} error={errorOf('email')}>
          <Input id={id('email')} type="email" inputMode="email" autoComplete="email" {...register('email')} aria-invalid={!!errors.email || undefined} />
        </Field>
        <Field id={id('phone')} label={t('clients.form.phone')}>
          <Input id={id('phone')} type="tel" autoComplete="tel" {...register('phone')} />
        </Field>
      </div>
      <Field id={id('uid_number')} label={t('clients.form.uid')} error={errorOf('uid_number')}>
        <Input
          id={id('uid_number')}
          {...register('uid_number', { onChange: e => applySuggestion(getValues('country'), e.target.value) })}
          placeholder={t('clients.form.uidPlaceholder')}
          autoCapitalize="characters"
          aria-invalid={!!errors.uid_number || undefined}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id={id('tax_treatment')} label={t('clients.form.taxTreatment')}>
          <select id={id('tax_treatment')} {...register('tax_treatment', { onChange: () => setTaxManual(true) })} className={SELECT_CLS}>
            {TAX_OPTIONS.map(o => <option key={o} value={o}>{t(`taxTreatments.${o}`)}</option>)}
          </select>
          {suggestion && suggestion !== taxTreatment && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('clientData.form.taxSuggested', { treatment: t(`taxTreatments.${suggestion}`) })}{' '}
              <button type="button" onClick={() => setValue('tax_treatment', suggestion, { shouldDirty: true })} className="underline underline-offset-2 font-medium py-1">
                {t('clientData.form.taxApply')}
              </button>
            </p>
          )}
        </Field>
        <Field id={id('language')} label={t('clients.form.language')}>
          <select id={id('language')} {...register('language')} className={SELECT_CLS}>
            <option value="de">{t('common.german')}</option>
            <option value="en">{t('common.english')}</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field id={id('payment_days')} label={t('clients.form.paymentDays')} error={errorOf('payment_days')} hint={t('clientData.form.paymentDaysHint')}>
          <Controller
            control={control}
            name="payment_days"
            render={({ field }) => (
              <MoneyInput
                id={id('payment_days')}
                integer
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                placeholder={t('clientData.form.paymentDaysPlaceholder', { days: defaults.payment_days })}
                aria-invalid={!!errors.payment_days || undefined}
              />
            )}
          />
        </Field>
        <Field id={id('status')} label={t('clients.form.status')}>
          <select id={id('status')} {...register('status')} className={SELECT_CLS}>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
            <option value="lead">{t('status.lead')}</option>
          </select>
        </Field>
      </div>

      <Controller control={control} name="tags" render={({ field }) => <TagInput value={field.value} onChange={field.onChange} />} />

      <Field id={id('notes')} label={t('clients.form.notes')}>
        <Textarea id={id('notes')} {...register('notes')} rows={3} className="resize-none" />
      </Field>

      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" {...register('reminders_opt_out')} className="mt-0.5 accent-neutral-900 dark:accent-white" />
        <span>
          <span className="font-medium text-neutral-800 dark:text-neutral-200">{t('clients.form.noReminders')}</span>
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('clients.form.noRemindersHint')}</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        {client && (
          <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} disabled={deleting || busy}>
            {deleting ? t('common.deleting') : t('clients.form.deleteClient')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onCancel
            ? <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
            : <Link href="/clients" className={buttonVariants({ variant: 'outline' })}>{t('common.cancel')}</Link>}
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : client ? t('clients.form.saveChanges') : t('clients.form.createClient')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!pending}
        title={t('clientData.form.duplicateTitle')}
        description={t('clientData.form.duplicateDesc')}
        confirmLabel={saving ? t('common.saving') : t('clientData.form.saveAnyway')}
        busy={saving}
        onConfirm={() => {
          if (!pending) return
          const { payload } = pending
          void save(payload).then(() => setPending(null))
        }}
        onCancel={() => setPending(null)}
      >
        <ul className="text-sm space-y-1">
          {pending?.duplicates.map(d => (
            <li key={d.id}>
              <Link href={`/clients/${d.id}`} target="_blank" className="font-medium underline underline-offset-2">{d.label}</Link>
              <span className="text-muted-foreground"> · {d.reasons.join(', ')}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      {client && (
        <ConfirmDialog
          open={confirmDelete}
          title={t('clients.form.deleteTitle', { name: clientDisplayName(client) })}
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

function Field({ id, label, error, hint, className = '', children }: {
  id: string; label: string; error?: string; hint?: string; className?: string; children: React.ReactNode
}) {
  return (
    <div className={`space-y-1.5 min-w-0 ${className}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error
        ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        : hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
    </div>
  )
}
