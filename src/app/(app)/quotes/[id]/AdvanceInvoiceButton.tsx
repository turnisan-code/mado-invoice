'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { HandCoins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { useT } from '@/lib/i18n/client'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import { formatMoney, roundCents } from '@/lib/utils/document'

type Mode = 'percent' | 'amount'

// Asks for part of the quote before the work starts: a draft advance invoice, opened in the editor.
// It starts at 30 % of the quote, or what is left of it when earlier advance invoices took more.
export default function AdvanceInvoiceButton({ quoteId, quoteTotal, advanced }: { quoteId: string; quoteTotal: number; advanced: number }) {
  const router = useRouter()
  const { t, lang } = useT()
  const uid = useId()
  const left = Math.max(0, roundCents(quoteTotal - advanced))
  const initial = (m: Mode) => m === 'percent'
    ? (quoteTotal > 0 ? Math.min(30, Math.floor((left / quoteTotal) * 10000) / 100) : 0)
    : Math.min(roundCents(quoteTotal * 0.3), left)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>('percent')
  const [value, setValue] = useState<number | null>(() => initial('percent'))

  const gross = value == null ? 0 : roundCents(mode === 'percent' ? quoteTotal * value / 100 : value)
  const exceeds = roundCents(advanced + gross) > quoteTotal + 0.005
  const badValue = value == null || value <= 0 || (mode === 'percent' && value > 100)
  const money = (amount: number) => formatMoney(amount, 'EUR', lang)
  // The same sentences as the route's refusals (messages.api.*), so both read alike.
  const problem = badValue ? t('messages.api.deposit_bad_amount')
    : exceeds ? t('messages.api.exceeds_quote', { amount: money(roundCents(advanced + gross)), total: money(quoteTotal) })
    : null

  async function create() {
    if (problem) return
    setBusy(true)
    try {
      await flushPendingEdits(quoteId)
      const res = await fetch(`/api/quotes/${quoteId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.invoiceId !== 'string') { toast.error(apiErrorMessage(t, data)); return }
      toast.success(t('deposits.quote.advanceCreated'))
      setOpen(false)
      router.push(`/invoices/${data.invoiceId}`)
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setBusy(false)
    }
  }

  const switchTo = (m: Mode) => { setMode(m); setValue(initial(m)) }
  const toggle = (m: Mode) =>
    `flex-1 h-9 sm:h-8 rounded-md text-sm transition-colors ${mode === m
      ? 'bg-white dark:bg-neutral-900 shadow-sm font-medium'
      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={busy}>
        <HandCoins size={14} />
        <span className="sr-only sm:not-sr-only">{t('deposits.quote.createAdvance')}</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('deposits.quote.advanceTitle')} description={t('deposits.quote.advanceDesc')} busy={busy}>
        <div className="space-y-3">
          <div role="group" aria-label={t('deposits.quote.advanceTitle')} className="flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800">
            <button type="button" aria-pressed={mode === 'percent'} className={toggle('percent')} onClick={() => switchTo('percent')}>
              {t('deposits.quote.byPercent')}
            </button>
            <button type="button" aria-pressed={mode === 'amount'} className={toggle('amount')} onClick={() => switchTo('amount')}>
              {t('deposits.quote.byAmount')}
            </button>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-value`} className="text-sm font-medium">
              {mode === 'percent' ? t('deposits.quote.percentLabel') : t('deposits.quote.amountLabel')}
            </label>
            <MoneyInput id={`${uid}-value`} value={value} onValueChange={setValue} aria-invalid={!!problem || undefined}
              aria-describedby={`${uid}-preview`} />
            <p id={`${uid}-preview`} className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('deposits.quote.preview', { amount: money(gross), total: money(quoteTotal) })}
              {advanced > 0 && <> {t('deposits.quote.alreadyAdvanced', { amount: money(advanced) })}</>}
              {problem && <span className="block mt-1 text-red-600 dark:text-red-400">{problem}</span>}
            </p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t('dialogs.cancel')}</Button>
          <Button type="button" onClick={() => void create()} disabled={busy || !!problem}>
            {busy ? t('documents.creating') : t('deposits.quote.createAdvanceConfirm')}
          </Button>
        </div>
      </Dialog>
    </>
  )
}
