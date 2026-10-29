'use client'

import { useState } from 'react'
import { Pencil, Mail, Phone, MapPin, Building2 } from 'lucide-react'
import ClientForm from '@/components/forms/ClientForm'
import type { Client, ClientDefaults, CountryOption } from '@/types'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'
import { formatLocaleNumber } from '@/lib/utils/number'

// countryLabel comes from the server: Node's and the browser's ICU can name a region differently,
// which would break hydration.
export default function ClientEditSection({ client, countryLabel, defaults, countries }: {
  client: Client; countryLabel: string; defaults: ClientDefaults; countries: CountryOption[]
}) {
  const [editing, setEditing] = useState(false)
  const { t } = useT()

  if (editing) {
    return <ClientForm client={client} defaults={defaults} countries={countries} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
  }

  const ownSkonto = client.skonto_percent != null || client.skonto_days != null
  const skontoPercent = client.skonto_percent ?? defaults.skonto_percent
  const skontoDays = client.skonto_days ?? defaults.skonto_days
  const skontoLabel = !skontoPercent
    ? t('rates.skontoNoneLong')
    : skontoDays != null
      ? t('rates.skontoTerms', { percent: formatLocaleNumber(skontoPercent, 2), days: skontoDays })
      : `${formatLocaleNumber(skontoPercent, 2)} %`

  const address = [
    client.address_line1,
    client.address_line2,
    [client.zip, client.city].filter(Boolean).join(' '),
    countryLabel,
  ].filter(Boolean).join(', ')

  return (
    <div className="space-y-0">
      {/* Card header */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{t('clients.details')}</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors px-2 py-2 -my-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Pencil size={11} /> {t('clients.edit')}
        </button>
      </div>

      {/* Contact */}
      <div className="space-y-2.5">
        {client.email && (
          <a href={`mailto:${client.email}`} className="flex items-center gap-3 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors group min-w-0">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Mail size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            <span className="truncate">{client.email}</span>
          </a>
        )}
        {client.phone && (
          <a href={`tel:${client.phone}`} className="flex items-center gap-3 text-sm text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Phone size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            {client.phone}
          </a>
        )}
        {address && (
          <div className="flex items-start gap-3 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0 mt-0.5"><MapPin size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            <span className="leading-snug">{address}</span>
          </div>
        )}
        {client.uid_number && (
          <div className="flex items-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="p-1.5 rounded-md bg-neutral-100 dark:bg-neutral-800 shrink-0"><Building2 size={12} className="text-neutral-500 dark:text-neutral-400" /></span>
            {client.uid_number}
          </div>
        )}
      </div>

      {/* Billing settings */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5 pt-4 border-t border-neutral-100 dark:border-neutral-800">
        <Stat label={t('clients.tax')} value={t(`taxTreatments.${client.tax_treatment}` as DictKey)} />
        <Stat label={t('clientData.clientNumber')} value={client.client_number ?? '—'} />
        <Stat
          label={t('clients.payment')}
          value={client.payment_days != null
            ? t('clients.paymentDaysShort', { days: client.payment_days })
            : t('clientData.paymentDefault', { days: defaults.payment_days })}
        />
      </div>

      {/* Language */}
      <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('clients.language')}</span>
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{client.language === 'en' ? t('common.english') : t('common.german')}</span>
      </div>
      {ownSkonto && (
        <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('rates.skonto')}</span>
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300 text-right">{skontoLabel}</span>
        </div>
      )}
      {client.reminders_opt_out && (
        <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('clients.automaticReminders')}</span>
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('clients.off')}</span>
        </div>
      )}

      {/* Notes */}
      {client.notes && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-4 pt-4 border-t border-neutral-100 dark:border-neutral-800">{client.notes}</p>
      )}

      {/* Tags */}
      {client.tags?.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mt-4 pt-4 border-t border-neutral-100 dark:border-neutral-800">
          {client.tags.map((tag: string) => (
            <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">{tag}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-neutral-500 dark:text-neutral-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">{value}</p>
    </div>
  )
}
