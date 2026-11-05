import { cache } from 'react'
import Link from 'next/link'
import { FileText } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getT } from '@/lib/i18n/server'
import { buttonVariants } from '@/components/ui/button'
import ConvertDocumentButton from '@/components/layout/ConvertDocumentButton'
import { billedAmount, depositOpen, depositTotals, loadQuoteDeposits, type DepositInvoice } from '@/lib/deposits'
import { invoiceKindLabel } from '@/lib/document-labels'
import { formatDate, formatMoney, roundCents } from '@/lib/utils/document'
import type { InvoiceKind } from '@/types'
import AdvanceInvoiceButton from './AdvanceInvoiceButton'

type Quote = Parameters<typeof depositTotals>[0] & { id: string; status: string; currency?: string | null }

// The quote's invoice (a plain conversion or the final invoice) and its advance and partial
// invoices, loaded once per request for the action area and the list.
const loadQuoteInvoicing = cache(async (quoteId: string) => {
  const supabase = await createClient()
  const [{ data: conversion }, deposits] = await Promise.all([
    supabase.from('documents').select('id, number, invoice_kind')
      .eq('converted_from_id', quoteId).eq('type', 'invoice').in('invoice_kind', ['standard', 'final']).neq('status', 'cancelled')
      .order('created_at').limit(1).maybeSingle(),
    loadQuoteDeposits(supabase, quoteId),
  ])
  return { conversion: conversion as { id: string; number: string | null; invoice_kind: InvoiceKind } | null, deposits }
})

const live = (d: DepositInvoice) => d.status !== 'cancelled'

// Once converted, the quote links to its invoice; until then it offers an advance invoice and the
// conversion, which becomes the final invoice once an advance or partial invoice is issued (a
// draft one is issued or deleted first, the issue checks say so).
export async function QuoteInvoicingActions({ quote }: { quote: Quote }) {
  const { t } = await getT()
  const { conversion, deposits } = await loadQuoteInvoicing(quote.id)
  if (conversion) {
    const final = conversion.invoice_kind === 'final'
    const label = conversion.number
      ? t(final ? 'deposits.quote.openFinal' : 'lifecycle.convert.openInvoice', { number: conversion.number })
      : t(final ? 'deposits.quote.openFinalDraft' : 'lifecycle.convert.openInvoiceDraft')
    return (
      <Link href={`/invoices/${conversion.id}`} title={t('lifecycle.convert.openInvoiceTitle')} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} flex items-center gap-1.5`}>
        <FileText size={14} />
        <span className="sr-only sm:not-sr-only">{label}</span>
      </Link>
    )
  }
  if (quote.status !== 'sent' && quote.status !== 'accepted') return null
  const advanced = roundCents(deposits.filter(d => live(d) && d.invoice_kind === 'advance').reduce((s, d) => s + billedAmount(d), 0))
  return (
    <>
      <AdvanceInvoiceButton quoteId={quote.id} quoteTotal={depositTotals(quote).total} advanced={advanced} />
      <ConvertDocumentButton kind={deposits.some(d => live(d) && d.number) ? 'final_invoice' : 'invoice'} sourceId={quote.id} />
    </>
  )
}

// What was invoiced from the quote ahead of the final invoice, and which final invoice deducts it.
export async function QuoteDepositList({ quote }: { quote: Quote }) {
  const { t, lang } = await getT()
  const { deposits } = await loadQuoteInvoicing(quote.id)
  if (!deposits.length) return null
  const currency = quote.currency ?? 'EUR'
  const invoiced = roundCents(deposits.filter(live).reduce((s, d) => s + billedAmount(d), 0))

  return (
    <section aria-labelledby={`deposits-${quote.id}`} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 sm:px-6 pt-4">
        <h2 id={`deposits-${quote.id}`} className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{t('deposits.quote.listTitle')}</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('deposits.quote.total', { amount: formatMoney(invoiced, currency), total: formatMoney(depositTotals(quote).total, currency) })}
        </p>
      </div>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 mt-2">
        {deposits.map(d => {
          const open = depositOpen(d)
          const state = !live(d) ? t('deposits.quote.cancelled')
            : !d.number ? t('deposits.quote.draft')
            : open > 0.005 ? t('deposits.quote.open', { amount: formatMoney(open, currency) })
            : t('deposits.quote.paid')
          return (
            <li key={d.id} className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/invoices/${d.id}`} className="font-medium hover:underline">
                  {d.number ?? <span className="text-neutral-500 dark:text-neutral-400">{t('common.draft')}</span>}
                </Link>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {invoiceKindLabel(t, d.invoice_kind)} · {formatDate(d.date, lang)}
                </p>
                {d.number && live(d) && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {d.final
                      ? <Link href={`/invoices/${d.final.id}`} className="underline underline-offset-2">
                          {d.final.number ? t('deposits.quote.settled', { number: d.final.number }) : t('deposits.quote.settledDraft')}
                        </Link>
                      : t('deposits.quote.notSettled')}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className={`font-medium ${live(d) ? '' : 'line-through text-neutral-400 dark:text-neutral-500'}`}>{formatMoney(depositTotals(d).total, currency)}</p>
                <p className={`text-xs ${live(d) && d.number && open > 0.005 ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400'}`}>{state}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
