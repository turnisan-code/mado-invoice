'use client'

import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { countryOptions, isCountryCode, suggestTaxTreatment } from '@/lib/utils/country'
import { clientDisplayName, toClientDefaults } from '@/lib/utils/clients'
import { isValidEmail, isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import { useT } from '@/lib/i18n/client'
import { dbErrorMessage } from '@/lib/api-errors'
import type { PublicSettings } from '@/lib/public-settings'
import type { Client, Language, TaxTreatment } from '@/types'
import { SELECT_CLS } from './ClientPicker'

const TAX_OPTIONS: TaxTreatment[] = ['at_vat', 'eu_reverse_charge', 'non_eu']

type Errors = Partial<Record<'name' | 'country' | 'email' | 'uid', string>>

// A client created without leaving the editor: who it is, where (for the tax treatment) and the
// UID. The client number comes from the database like for every other new client; address and
// further details are added on the client's page later.
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
    const { data, error } = await createClient().from('clients').insert({
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
          <Input id={`${uid}-email`} type="email" inputMode="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} {...field('email')} />
          {errorText('email')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-country`}>{t('clients.form.country')}</Label>
            <select id={`${uid}-country`} value={country} onChange={e => { setCountry(e.target.value); follow(e.target.value, vatId) }} className={SELECT_CLS} {...field('country')}>
              <optgroup label={t('clientData.form.countryEu')}>
                {countries.filter(c => c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
              <optgroup label={t('clientData.form.countryOther')}>
                {countries.filter(c => !c.eu).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
            </select>
            {errorText('country')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-uid`}>{t('clients.form.uid')}</Label>
            <Input id={`${uid}-uid`} value={vatId} onChange={e => { setVatId(e.target.value); follow(country, e.target.value) }} placeholder={t('clients.form.uidPlaceholder')} autoCapitalize="characters" {...field('uid')} />
            {errorText('uid')}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-tax`}>{t('clients.form.taxTreatment')}</Label>
          <select id={`${uid}-tax`} value={tax} onChange={e => { setTax(e.target.value as TaxTreatment); setTaxManual(true) }} className={SELECT_CLS}>
            {TAX_OPTIONS.map(o => <option key={o} value={o}>{t(`taxTreatments.${o}`)}</option>)}
          </select>
          {suggestion && suggestion !== tax && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('clientData.form.taxSuggested', { treatment: t(`taxTreatments.${suggestion}`) })}{' '}
              <button type="button" onClick={() => { setTax(suggestion); setTaxManual(false) }} className="underline underline-offset-2 font-medium py-2 -my-2">{t('clientData.form.taxApply')}</button>
            </p>
          )}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('editor.client.create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
