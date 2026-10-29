'use client'

import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { countryOptions, isCountryCode, suggestTaxTreatment } from '@/lib/utils/country'
import { clientDisplayName, clientWithNumber, findDuplicateClients, toClientDefaults, type ClientDuplicate } from '@/lib/utils/clients'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import { useT } from '@/lib/i18n/client'
import { dbErrorMessage } from '@/lib/api-errors'
import type { PublicSettings } from '@/lib/public-settings'
import type { Client, Language, TaxTreatment } from '@/types'

const TAX_OPTIONS: TaxTreatment[] = ['at_vat', 'eu_reverse_charge', 'non_eu']

type Errors = Partial<Record<'name' | 'country' | 'email' | 'uid', string>>

// A client created without leaving the editor: who it is, where (for the tax treatment) and the
// UID. The client number comes from the database like for every other new client; address and
// further details are added on the client's page later. A client that already has the email or
// UID is offered first, as ClientForm warns about it, so a known client is picked instead of
// created twice.
export function QuickAddClient({ open, initialName, settings, language, onClose, onCreated }: {
  open: boolean
  initialName: string
  settings: PublicSettings
  // The document's language becomes the client's.
  language: Language
  onClose: () => void
  onCreated: (client: Client) => void
}) {
  const { t, lang } = useT()
  const uid = useId()
  const defaults = toClientDefaults(settings)
  const countries = useMemo(() => (open ? countryOptions(lang) : []), [open, lang])
  const [company, setCompany] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState(defaults.country)
  const [vatId, setVatId] = useState('')
  const [tax, setTax] = useState<TaxTreatment>(defaults.tax_treatment)
  const [taxManual, setTaxManual] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  // The clients found for the email and UID entered; null until checked (again after an edit).
  const [duplicates, setDuplicates] = useState<ClientDuplicate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [wasOpen, setWasOpen] = useState(false)

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setCompany(initialName)
      setName('')
      setEmail('')
      setCountry(defaults.country)
      setVatId('')
      setTax(suggestTaxTreatment(defaults.country, false) ?? defaults.tax_treatment)
      setTaxManual(false)
      setErrors({})
      setDuplicates(null)
    }
  }

  const validUid = (v: string) => isValidVatId(normalizeVatId(v))
  const suggestion = suggestTaxTreatment(country, validUid(vatId))

  function follow(nextCountry: string, nextUid: string) {
    if (taxManual) return
    const next = suggestTaxTreatment(nextCountry, validUid(nextUid))
    if (next) setTax(next)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const found: Errors = {}
    if (!name.trim() && !company.trim()) found.name = t('clients.form.nameRequired')
    if (!isCountryCode(country)) found.country = t('clients.form.countryRequired')
    if (email.trim() && !isValidEmail(email)) found.email = t('clients.form.emailInvalid')
    if (normalizeVatId(vatId) && !validUid(vatId)) found.uid = t('clients.form.uidInvalid')
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true)
    const supabase = createClient()
    if (!duplicates) {
      const existing = await findDuplicateClients(supabase, { email, uid: normalizeVatId(vatId) || null })
      if (existing.length) {
        setBusy(false)
        setDuplicates(existing)
        return
      }
    }
    const { data, error } = await supabase.from('clients').insert({
      name: name.trim(),
      company: company.trim() || null,
      email: email.trim(),
      country,
      uid_number: normalizeVatId(vatId) || null,
      tax_treatment: tax,
      language,
      currency: 'EUR',
      payment_days: null,
      status: 'active',
    }).select('*').single()
    setBusy(false)
    if (error) {
      console.error('[editor] client not created:', error.code, error.message)
      toast.error(dbErrorMessage(t, error))
      return
    }
    toast.success(t('editor.client.created', { name: clientDisplayName(data) }))
    onCreated(data as Client)
  }

  function pickExisting(client: Client) {
    toast.success(t('views.quickAdd.selected', { name: clientDisplayName(client) }))
    onCreated(client)
  }

  const field = (key: keyof Errors) => ({
    'aria-invalid': !!errors[key] || undefined,
    'aria-describedby': errors[key] ? `${uid}-${key}-error` : undefined,
  })
  const errorText = (key: keyof Errors) => errors[key] && (
    <p id={`${uid}-${key}-error`} className="text-xs text-red-600 dark:text-red-400">{errors[key]}</p>
  )

  return (
    <Dialog open={open} onClose={onClose} title={t('editor.client.title')} description={t('editor.client.description')} busy={busy} panelClassName="max-w-md">
      <form onSubmit={submit} noValidate className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-company`}>{t('clients.form.company')}</Label>
            <Input id={`${uid}-company`} value={company} onChange={e => setCompany(e.target.value)} placeholder={t('clients.form.companyPlaceholder')} {...field('name')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>{t('clients.form.name')}</Label>
            <Input id={`${uid}-name`} value={name} onChange={e => setName(e.target.value)} placeholder={t('clients.form.namePlaceholder')} {...field('name')} />
          </div>
        </div>
        {errorText('name') || <p className="text-xs text-neutral-500 dark:text-neutral-400 -mt-1">{t('clients.form.nameOrCompany')}</p>}
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-email`}>{t('clients.form.email')}</Label>
          <Input id={`${uid}-email`} type="email" inputMode="email" autoComplete="off" value={email} onChange={e => { setEmail(e.target.value); setDuplicates(null) }} {...field('email')} />
          {errorText('email')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-country`}>{t('clients.form.country')}</Label>
            <Select id={`${uid}-country`} value={country} onChange={e => { setCountry(e.target.value); follow(e.target.value, vatId) }} {...field('country')}>
              <optgroup label={t('clientData.form.countryEu')}>
                {countries.filter(c => c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
              <optgroup label={t('clientData.form.countryOther')}>
                {countries.filter(c => !c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
            </Select>
            {errorText('country')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-uid`}>{t('clients.form.uid')}</Label>
            <Input id={`${uid}-uid`} value={vatId} onChange={e => { setVatId(e.target.value); follow(country, e.target.value); setDuplicates(null) }} placeholder={t('clients.form.uidPlaceholder')} autoCapitalize="characters" {...field('uid')} />
            {errorText('uid')}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-tax`}>{t('clients.form.taxTreatment')}</Label>
          <Select id={`${uid}-tax`} value={tax} onChange={e => { setTax(e.target.value as TaxTreatment); setTaxManual(true) }}>
            {TAX_OPTIONS.map(o => <option key={o} value={o}>{t(`taxTreatments.${o}`)}</option>)}
          </Select>
          {suggestion && suggestion !== tax && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('clientData.form.taxSuggested', { treatment: t(`taxTreatments.${suggestion}`) })}{' '}
              <button type="button" onClick={() => { setTax(suggestion); setTaxManual(false) }} className="underline underline-offset-2 font-medium py-2 -my-2">{t('clientData.form.taxApply')}</button>
            </p>
          )}
        </div>
        {!!duplicates?.length && (
          <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200 space-y-2">
            <p className="font-medium">{t('views.quickAdd.duplicates')}</p>
            <ul className="space-y-2">
              {duplicates.map(d => (
                <li key={d.client.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{clientWithNumber(d.client)}</span>
                    {' · '}{d.reasons.map(r => t(r === 'email' ? 'clientData.form.duplicateEmail' : 'clientData.form.duplicateUid')).join(', ')}
                  </span>
                  <Button type="button" variant="outline" onClick={() => pickExisting(d.client)} disabled={busy} className="bg-white dark:bg-neutral-900">
                    {t('views.quickAdd.useExisting')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2 justify-end pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : duplicates?.length ? t('views.quickAdd.createAnyway') : t('editor.client.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
