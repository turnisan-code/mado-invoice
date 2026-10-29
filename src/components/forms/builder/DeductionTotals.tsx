'use client'

import { Separator } from '@/components/ui/separator'
import { useT } from '@/lib/i18n/client'
import { deductionSummary, discountOf } from '@/lib/deposits'
import { formatPercent } from '@/lib/document-labels'
import { formatMoney } from '@/lib/utils/document'
import type { Currency, DocumentTotals, TaxTreatment } from '@/types'
import type { DiscountKind, LineItem } from './model'

// Below the totals of the whole service: each deducted invoice with its Entgelt and VAT per rate,
// then what remains to be paid. The lines are written from the deducted invoices, never by hand;
// a credit note copied from a final invoice can drop them.
export function DeductionTotals({ lines, totals, currency, taxTreatment, discountType, discountValue, onRemove }: {
  lines: LineItem[]
  totals: DocumentTotals
  currency: Currency
  taxTreatment: TaxTreatment
  discountType: DiscountKind | null
  discountValue: number
  onRemove?: () => void
}) {
  const { t, lang } = useT()
  const summary = deductionSummary(lines, discountOf({ discount_type: discountType, discount_value: discountValue }), taxTreatment)
  if (!summary) return null
  const money = (n: number) => formatMoney(n, currency)
  const vatApplies = taxTreatment === 'at_vat'
  return (
    <div className="flex sm:justify-end">
      <div className="w-full sm:w-80 space-y-1.5 text-sm">
        {summary.rows.map((row, i) => (
          <div key={i} className="flex justify-between gap-3 text-neutral-600 dark:text-neutral-300">
            <div className="min-w-0">
              <p className="break-words">{row.label}</p>
              {row.parts.map(p => (
                <p key={p.rate} className="text-xs text-neutral-500 dark:text-neutral-400">
                  {vatApplies
                    ? t('deposits.doc.lessPart', { net: money(p.net), rate: formatPercent(t, p.rate, lang), vat: money(p.vat) })
                    : t('deposits.doc.lessPartNoVat', { net: money(p.net) })}
                </p>
              ))}
            </div>
            <span className="whitespace-nowrap">−{money(row.gross)}</span>
          </div>
        ))}
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 underline underline-offset-2 py-2 -my-2">
            {t('deposits.builder.removeAll')}
          </button>
        )}
        <Separator />
        <div className="flex justify-between font-semibold text-base">
          <span>{t('deposits.builder.remaining')}</span>
          <span>{money(totals.total)}</span>
        </div>
        {totals.total_paid > 0 && (
          <>
            <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
              <span>{t('builder.paid')}</span>
              <span>−{money(totals.total_paid)}</span>
            </div>
            <div className={`flex justify-between font-semibold ${totals.balance_due > 0.005 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
              <span>{t('builder.balanceDue')}</span>
              <span>{money(totals.balance_due)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
