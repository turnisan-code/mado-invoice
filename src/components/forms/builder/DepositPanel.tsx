'use client'

import { useId } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { useT } from '@/lib/i18n/client'
import { deductibleAmount, depositOpen, depositTotals, type DepositInvoice } from '@/lib/deposits'
import { invoiceKindLabel } from '@/lib/document-labels'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { Currency, InvoiceKind } from '@/types'
import { SELECT_CLS } from './ClientPicker'
import type { useDeposits } from './useDeposits'

const STANDARD_KINDS: InvoiceKind[] = ['standard', 'advance', 'partial']

// The invoice's kind and, for a final invoice, the advance and partial invoices it deducts. An
// invoice becomes a final invoice by deducting one; its kind is fixed while it deducts any, and
// an advance invoice's while a final invoice deducts it.
export function DepositPanel({ deposits, kind, onKind, docId, issued, currency }: {
  deposits: ReturnType<typeof useDeposits>
  kind: InvoiceKind
  onKind: (kind: InvoiceKind) => void
  docId: string | null
  issued: boolean
  currency: Currency
}) {
  const { t, lang } = useT()
  const uid = useId()
  if (!deposits.enabled) return null

  const { self, linked, free, busy } = deposits
  const locked = (kind === 'final' && linked.length > 0) || !!self?.final_invoice_id
  const kinds = kind === 'final' ? [...STANDARD_KINDS, 'final' as const] : STANDARD_KINDS
  const showDeductions = kind === 'final' || (kind === 'standard' && free.length > 0)
  const money = (n: number) => formatMoney(n, currency)
  const describe = (d: DepositInvoice) => `${d.number} · ${invoiceKindLabel(t, d.invoice_kind)} · ${formatDate(d.date, lang)}`

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start gap-x-4 gap-y-1.5">
        <div className="space-y-1.5 sm:w-56 shrink-0">
          <Label htmlFor={`${uid}-kind`}>{t('deposits.builder.kindLabel')}</Label>
          <select id={`${uid}-kind`} value={kind} disabled={locked || busy} aria-describedby={`${uid}-kind-hint`}
            onChange={e => onKind(e.target.value as InvoiceKind)} className={`${SELECT_CLS} disabled:opacity-60`}>
            {kinds.map(k => <option key={k} value={k} disabled={k === 'final'}>{invoiceKindLabel(t, k)}</option>)}
          </select>
        </div>
        <p id={`${uid}-kind-hint`} className="text-xs text-neutral-500 dark:text-neutral-400 sm:pt-7">
          {locked
            ? t(kind === 'final' ? 'deposits.builder.finalLocked' : 'deposits.builder.kindLocked')
            : t(`deposits.builder.kindHint.${kind}`)}
        </p>
      </div>

      {issued && self && (kind === 'advance' || kind === 'partial') && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300 flex flex-wrap gap-x-3 gap-y-1">
          {self.final
            ? <Link href={`/invoices/${self.final.id}`} className="underline underline-offset-2">
                {self.final.number ? t('deposits.builder.settledBy', { number: self.final.number }) : t('deposits.builder.settledByDraft')}
              </Link>
            : <span>{t('deposits.builder.notSettled')}</span>}
          {kind === 'advance' && <span className="text-neutral-500 dark:text-neutral-400">{t('deposits.builder.received', { amount: money(deductibleAmount(self)) })}</span>}
        </p>
      )}

      {showDeductions && (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2.5 space-y-2 text-sm">
          <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{t('deposits.builder.deductions')}</p>
          {linked.length > 0 && (
            <ul className="space-y-1.5">
              {linked.map(d => {
                const open = d.invoice_kind === 'advance' ? depositOpen(d) : 0
                return (
                  <li key={d.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/invoices/${d.id}`} className="font-medium hover:underline">{describe(d)}</Link>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {t('deposits.builder.deducts', { amount: money(deductibleAmount(d)) })}
                        {open > 0.005 && <span className="text-amber-600 dark:text-amber-400"> · {t('deposits.builder.open', { amount: money(open) })}</span>}
                      </p>
                    </div>
                    {!issued && (
                      <button type="button" onClick={() => void deposits.unlink(d)} disabled={busy}
                        aria-label={t('deposits.builder.remove', { number: d.number ?? '' })} title={t('deposits.builder.remove', { number: d.number ?? '' })}
                        className="h-9 w-9 sm:h-7 sm:w-7 -my-1 shrink-0 inline-flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50">
                        <X size={14} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {issued
            ? kind === 'final' && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('deposits.builder.issuedHint')}</p>
            : !docId
              ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('deposits.builder.saveFirst')}</p>
              : free.length > 0
                ? (
                  <div className="space-y-1">
                    <label htmlFor={`${uid}-add`} className="sr-only">{t('deposits.builder.add')}</label>
                    <select id={`${uid}-add`} value="" disabled={busy} className={SELECT_CLS}
                      onChange={e => { const d = free.find(x => x.id === e.target.value); if (d) void deposits.link(d) }}>
                      <option value="">{t('deposits.builder.add')}</option>
                      {free.map(d => <option key={d.id} value={d.id}>{describe(d)} · {money(depositTotals(d).total)}</option>)}
                    </select>
                  </div>
                )
                : <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('deposits.builder.none')}</p>}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('deposits.builder.deductionsHint')}</p>
        </div>
      )}
    </div>
  )
}
