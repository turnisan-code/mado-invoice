'use client'

import { Separator } from '@/components/ui/separator'
import { formatMoney } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'
import type { Currency, DocumentTotals, TaxTreatment } from '@/types'
import { DiscountControls } from './DiscountControls'
import { clampDiscount, type DiscountKind } from './model'

// Net, the document discount (clamped as calcTotals applies it), VAT per rate, total and payments.
export function TotalsPanel({ totals, currency, taxTreatment, discountType, discountValue, onDiscount }: {
  totals: DocumentTotals
  currency: Currency
  taxTreatment: TaxTreatment
  discountType: DiscountKind | null
  discountValue: number
  onDiscount: (kind: DiscountKind | null, value: number) => void
}) {
  const { t } = useT()
  const setDiscount = (kind: DiscountKind, value: number) => onDiscount(kind, clampDiscount(kind, value, totals.subtotal))
  return (
    <div className="flex sm:justify-end">
      <div className="w-full sm:w-80 space-y-1.5 text-sm">
        <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
          <span>{t('builder.net')}</span>
          <span>{formatMoney(totals.subtotal, currency)}</span>
        </div>

        {discountType ? (
          <div className="py-0.5">
            <DiscountControls
              kind={discountType}
              value={discountValue}
              amount={totals.discount_amount}
              currency={currency}
              label={t('builder.discountValue')}
              onChange={setDiscount}
              onRemove={() => onDiscount(null, 0)}
            >
              <span className="text-neutral-500 dark:text-neutral-400 text-xs shrink-0 mr-auto">{t('builder.discount')}</span>
            </DiscountControls>
          </div>
        ) : (
          <button type="button" onClick={() => onDiscount('percent', 0)}
            className="w-full text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 border border-dashed border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 rounded-md py-2 sm:py-1.5 transition-colors">
            + {t('builder.addDiscount')}
          </button>
        )}

        {taxTreatment === 'at_vat' && totals.vat_groups.map(g => (
          <div key={g.rate} className="flex justify-between text-neutral-500 dark:text-neutral-400">
            <span>{t('builder.vatLine', { rate: g.rate })}</span>
            <span>{formatMoney(g.amount, currency)}</span>
          </div>
        ))}
        <Separator />
        <div className="flex justify-between font-semibold text-base">
          <span>{t('builder.total')}</span>
          <span>{formatMoney(totals.total, currency)}</span>
        </div>
        {totals.total_paid > 0 && (
          <>
            <div className="flex justify-between text-neutral-500 dark:text-neutral-400">
              <span>{t('builder.paid')}</span>
              <span>−{formatMoney(totals.total_paid, currency)}</span>
            </div>
            <div className={`flex justify-between font-semibold ${totals.balance_due > 0.005 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
              <span>{t('builder.balanceDue')}</span>
              <span>{formatMoney(totals.balance_due, currency)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
