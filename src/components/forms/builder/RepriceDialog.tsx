'use client'

import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatMoney } from '@/lib/utils/document'
import { n } from '@/lib/i18n'
import { useT } from '@/lib/i18n/client'
import type { Currency } from '@/types'
import type { RepriceOffer } from './useClientRates'

// Offered after the client changed: the catalogue lines that have another price for the new client.
export function RepriceDialog({ offer, currency, onApply, onCancel }: {
  offer: RepriceOffer | null
  currency: Currency
  onApply: () => void
  onCancel: () => void
}) {
  const { t } = useT()
  const count = offer?.changes.length ?? 0
  return (
    <ConfirmDialog
      open={!!offer}
      title={t('rates.repriceTitle', { name: offer?.clientName ?? '' })}
      description={n(count, t('rates.repriceDescOne'), t('rates.repriceDescOther', { count }))}
      confirmLabel={t('rates.repriceConfirm')}
      cancelLabel={t('rates.repriceKeep')}
      onConfirm={onApply}
      onCancel={onCancel}
    >
      <ul className="text-sm divide-y divide-neutral-100 dark:divide-neutral-800 max-h-60 overflow-auto -my-1">
        {offer?.changes.map(c => (
          <li key={c.id} className="py-2 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{c.description}</span>
            <span className="shrink-0 tabular-nums text-xs">
              <span aria-hidden="true">
                <span className="line-through text-neutral-500 dark:text-neutral-400">{formatMoney(c.from, currency)}</span>
                {' → '}
                <span className="font-medium">{formatMoney(c.to, currency)}</span>
              </span>
              <span className="sr-only">{t('rates.repriceChange', { from: formatMoney(c.from, currency), to: formatMoney(c.to, currency) })}</span>
            </span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
