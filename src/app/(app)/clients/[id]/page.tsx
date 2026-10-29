import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ClientEditSection from '@/components/layout/ClientEditSection'
import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'
import { calcTotals, formatDate, formatMoney, roundCents, today } from '@/lib/utils/document'
import { countryName, countryOptions } from '@/lib/utils/country'
import { CLIENT_DEFAULTS_COLUMNS, clientDisplayName, toClientDefaults } from '@/lib/utils/clients'
import { getT } from '@/lib/i18n/server'
import type { DictKey } from '@/lib/i18n'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { displayStatus, statusLabelKey } from '@/lib/status'

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

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single()
  if (!client) notFound()

  // The history list shows the 50 latest documents; the stats aggregate every invoice.
  const [{ data: documents }, { data: invoices }, { data: settings }, { data: refunds }] = await Promise.all([
    supabase
      .from('documents')
      .select('id, type, number, date, due_date, status, currency, tax_treatment, discount_type, discount_value, document_items(*), payments(*)')
      .eq('client_id', id)
      .order('date', { ascending: false })
      .limit(50),
    supabase
      .from('documents')
      .select('status, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
      .eq('client_id', id)
      .eq('type', 'invoice'),
    supabase.from('settings').select(CLIENT_DEFAULTS_COLUMNS).maybeSingle(),
    // Money paid back to the client on credit notes.
    supabase.from('payments').select('amount, documents!inner(client_id)').eq('kind', 'refund').eq('documents.client_id', id),
  ])

  const allDocs = documents ?? []
  const allInvoices = invoices ?? []
  const docTotals = (d: (typeof allInvoices)[number]) => calcTotals(
    d.document_items ?? [],
    d.payments ?? [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
  // Revenue is money: payments received less refunds. Skonto, write-offs, applied credit notes and
  // dunning fees are no revenue.
  const received = allInvoices.reduce((s, d) => s + (d.payments ?? []).filter(p => p.kind === 'payment').reduce((a, p) => a + Number(p.amount), 0), 0)
  const totalRevenue = roundCents(received - (refunds ?? []).reduce((s, r) => s + Number(r.amount), 0))
  const openBalance = allInvoices
    .filter(d => d.status === 'sent' || d.status === 'overdue')
    .reduce((s, d) => s + docTotals(d).balance_due, 0)
  const invoiceCount = allInvoices.length

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

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Client details */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-5">
          <ClientEditSection client={client} countryLabel={countryName(client.country, lang)} defaults={toClientDefaults(settings)} countries={countryOptions(lang)} />
        </div>

        {/* Documents */}
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <span className="text-sm font-medium">{t('clients.documents')}</span>
            <div className="flex gap-2">
              <Link href={`/quotes/new?client=${id}`} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors dark:text-neutral-300">
                <Plus size={11} /> {t('clients.quote')}
              </Link>
              <Link href={`/invoices/new?client=${id}`} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
                <Plus size={11} /> {t('clients.invoice')}
              </Link>
            </div>
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {allDocs.length === 0 && (
              <div className="px-5 py-12 text-center">
                <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('clients.noDocuments')}</p>
                <Link href={`/invoices/new?client=${id}`} className="mt-2 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-2">
                  {t('clients.createFirstInvoice')}
                </Link>
              </div>
            )}
            {allDocs.map(doc => {
              const totals = docTotals(doc)
              // As in the lists: partly paid / written off from the payments, expired from the date.
              const shown = displayStatus({ type: doc.type, status: doc.status, due_date: doc.due_date, total: totals.total, payments: doc.payments ?? [] }, now)
              return (
                <Link
                  key={doc.id}
                  href={`/${typeRoute[doc.type] ?? 'invoices'}/${doc.id}`}
                  className="flex items-center px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {doc.number ?? <span className="text-neutral-400 dark:text-neutral-500 font-normal">{t('common.draft')}</span>}
                    </div>
                    <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">{t(`docTypes.${doc.type}` as DictKey)} · {formatDate(doc.date, lang)}</div>
                  </div>
                  <span className="text-sm font-medium shrink-0">{formatMoney(totals.total, doc.currency)}</span>
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
