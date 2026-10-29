'use client'

import Link from 'next/link'
import { useT } from '@/lib/i18n/client'
import type { PublicSettings } from '@/lib/public-settings'
import type { Client } from '@/types'

// What to keep in mind while billing this client: terms, tax treatment, notes, and a missing
// address (an invoice has to name it). The client page opens in a new tab, so the draft stays.
export function ClientInfo({ client, settings }: { client: Client; settings: PublicSettings }) {
  const { t } = useT()
  const days = client.payment_days ?? settings.default_payment_days
  const noAddress = !client.address_line1?.trim() || !client.city?.trim()
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300 space-y-1">
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        {client.client_number && <span>{client.client_number}</span>}
        <span>{client.payment_days == null ? t('editor.client.termsDefault', { days }) : t('editor.client.terms', { days })}</span>
        <span>{t(`taxTreatments.${client.tax_treatment}`)}</span>
      </p>
      {client.notes && (
        <p className="whitespace-pre-line"><span className="font-medium">{t('clients.form.notes')}:</span> {client.notes}</p>
      )}
      {noAddress && (
        <p className="text-amber-700 dark:text-amber-300">
          {t('editor.client.noAddress')}{' '}
          <Link href={`/clients/${client.id}`} target="_blank" rel="noopener" className="underline underline-offset-2 font-medium py-2 -my-2">{t('editor.client.open')}</Link>
        </p>
      )}
    </div>
  )
}
