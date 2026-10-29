'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { HandCoins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { useT } from '@/lib/i18n/client'
import { formatMoney, roundCents } from '@/lib/utils/document'

type Mode = 'percent' | 'amount'

// Asks for part of the quote before the work starts: a draft advance invoice, opened in the editor.
export default function AdvanceInvoiceButton({ quoteId, quoteTotal, advanced }: { quoteId: string; quoteTotal: number; advanced: number }) {
  const router = useRouter()
  const { t } = useT()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>('percent')
  const [value, setValue] = useState<number | null>(30)

  const gross = value == null ? 0 : roundCents(mode === 'percent' ? quoteTotal * value / 100 : value)
  const invalid = value == null || value <= 0 || (mode === 'percent' && value > 100) || roundCents(advanced + gross) > quoteTotal + 0.005

  async function create() {
    if (invalid) { toast.error(t('deposits.errors.badAmount')); return }
    setBusy(true)
    try {
      await flushPendingEdits(quoteId)
      const res = await fetch(`/api/quotes/${quoteId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.invoiceId !== 'string') { toast.error(data.error ?? t('common.unknownError')); return }
      toast.success(t('deposits.quote.advanceCreated'))
      setOpen(false)
      router.push(`/invoices/${data.invoiceId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (m: Mode) =>
    `flex-1 h-9 sm:h-8 rounded-md text-sm transition-colors ${mode === m
      ? 'bg-white dark:bg-neutral-900 shadow-sm font-medium'
      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'}`

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={busy} className="flex items-center gap-1.5">
        <HandCoins size={14} />
        <span className="sr-only sm:not-sr-only">{t('deposits.quote.createAdvance')}</span>
      </Button>
      <ConfirmDialog
        open={open}
        title={t('deposits.quote.advanceTitle')}
        description={t('deposits.quote.advanceDesc')}
        confirmLabel={busy ? t('documents.creating') : t('deposits.quote.createAdvanceConfirm')}
        busy={busy}
        onConfirm={() => void create()}
        onCancel={() => setOpen(false)}
      >
        <div className="space-y-3">
          <div role="group" aria-label={t('deposits.quote.advanceTitle')} className="flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800">
            <button type="button" aria-pressed={mode === 'percent'} className={toggle('percent')} onClick={() => { setMode('percent'); setValue(30) }}>
              {t('deposits.quote.byPercent')}
            </button>
            <button type="button" aria-pressed={mode === 'amount'} className={toggle('amount')} onClick={() => { setMode('amount'); setValue(roundCents(quoteTotal * 0.3)) }}>
              {t('deposits.quote.byAmount')}
            </button>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-value`} className="text-sm font-medium">
              {mode === 'percent' ? t('deposits.quote.percentLabel') : t('deposits.quote.amountLabel')}
            </label>
            <MoneyInput id={`${uid}-value`} value={value} onValueChange={setValue} aria-invalid={invalid || undefined}
              aria-describedby={`${uid}-preview`} className="h-10" />
            <p id={`${uid}-preview`} className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('deposits.quote.preview', { amount: formatMoney(gross), total: formatMoney(quoteTotal) })}
              {advanced > 0 && <> {t('deposits.quote.alreadyAdvanced', { amount: formatMoney(advanced) })}</>}
            </p>
          </div>
        </div>
      </ConfirmDialog>
    </>
  )
}
