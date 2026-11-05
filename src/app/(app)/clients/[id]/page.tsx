import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ClientRates from '@/components/layout/ClientRates'
import ClientEditSection from '@/components/layout/ClientEditSection'
import ClientProjects from '@/components/projects/ClientProjects'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate, formatMoney, today } from '@/lib/utils/document'
import { countryName, countryOptions } from '@/lib/utils/country'
import { CLIENT_DEFAULTS_COLUMNS, clientDisplayName, toClientDefaults } from '@/lib/utils/clients'
import { getT } from '@/lib/i18n/server'
import type { DictKey } from '@/lib/i18n'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { statusLabelKey } from '@/lib/status'
import { getClientDetail } from '@/lib/services/queries'

const typeRoute: Record<string, string> = {
  invoice: 'invoices',
  quote: 'quotes',
  credit_note: 'credit-notes',
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { t, lang } = await getT()
  const statusLabel = (status: string) => t(`status.${status}` as DictKey)
  const now = today()

  const detail = await getClientDetail<Parameters<typeof toClientDefaults>[0]>(supabase, id, now, CLIENT_DEFAULTS_COLUMNS)
  if (!detail) notFound()
  const { client, documents: allDocs, totalRevenue, openBalance, invoiceCount, settings, catalogue, rates } = detail

  const displayName = clientDisplayName(client)
  const subtitle = [client.client_number, client.company && client.name ? client.name : null].filter(Boolean).join(' · ')
  const initials = displayName.split(' ').map((w: string) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/clients" aria-label={t('clients.backToClients')} className="h-11 w-11 -mx-3.5 -mb-3.5 -mt-2.5 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors shrink-0">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-neutral-900 dark:bg-neutral-100 flex items-center justify-center shrink-0">
            <span className="text-sm font-semibold text-white dark:text-neutral-900">{initials}</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight break-words">{displayName}</h1>
            {subtitle && <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{subtitle}</p>}
          </div>
          <StatusBadge status={client.status} label={statusLabel(client.status)} className="ml-auto shrink-0" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('clients.totalRevenue')}</p>
          <p className="text-lg font-semibold">{formatMoney(totalRevenue, client.currency)}</p>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('clients.openBalance')}</p>
          <p className={`text-lg font-semibold ${openBalance > 0 ? 'text-amber-600' : ''}`}>
            {formatMoney(openBalance, client.currency)}
          </p>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{t('clients.invoices')}</p>
          <p className="text-lg font-semibold">{invoiceCount}</p>
        </div>
      </div>

      {/* Projects (unbilled time and expenses) and the statement of account */}
      <ClientProjects client={client} />

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Client details and rate card */}
        <div className="space-y-6 min-w-0">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-5">
            <ClientEditSection client={client} countryLabel={countryName(client.country, lang)} defaults={toClientDefaults(settings)} countries={countryOptions(lang)} />
          </div>
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-5">
            <ClientRates clientId={id} catalogue={catalogue ?? []} initialRates={(rates ?? []).map(r => ({ ...r, price: Number(r.price) }))} />
          </div>
        </div>

        {/* Documents */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <span className="text-sm font-medium">{t('clients.documents')}</span>
            <div className="flex gap-2">
              <Link href={`/quotes/new?client=${id}`} className={cn(buttonVariants({ variant: 'outline' }), 'text-xs')}>
                <Plus size={12} /> {t('clients.quote')}
              </Link>
              <Link href={`/invoices/new?client=${id}`} className={cn(buttonVariants(), 'text-xs')}>
                <Plus size={12} /> {t('clients.invoice')}
              </Link>
            </div>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {allDocs.length === 0 && (
              <div className="px-5 py-12 text-center">
                <p className="text-sm text-neutral-500 dark:text-neutral-500">{t('clients.noDocuments')}</p>
                <Link href={`/invoices/new?client=${id}`} className="mt-2 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  {t('clients.createFirstInvoice')}
                </Link>
              </div>
            )}
            {allDocs.map(({ doc, total, shown }) => {
              return (
                <Link
                  key={doc.id}
                  href={`/${typeRoute[doc.type] ?? 'invoices'}/${doc.id}`}
                  className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {doc.number ?? <span className="text-neutral-500 dark:text-neutral-500 font-normal">{t('common.draft')}</span>}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-500 mt-0.5">{t(`docTypes.${doc.type}` as DictKey)} · {formatDate(doc.date, lang)}</div>
                  </div>
                  <span className="text-sm font-medium shrink-0">{formatMoney(total, doc.currency)}</span>
                  <StatusBadge status={shown} label={t(statusLabelKey(shown))} className="shrink-0" />
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
