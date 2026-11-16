'use client'

import { useId, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/lib/i18n/client'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { bookamatErrorMessage, requestBookamatForget, type BookingRow } from '@/lib/bookamat-client'
import type { Currency } from '@/types'

// „Buchung vergessen“ (D7): forgets one Bookamat booking of a document once the owner deleted it in
// Bookamat, so its payment can be changed or removed again (payments_booking_guard) and the next
// sync books it anew. With `mode` 'unsettled' it discards the attempts a sync could not settle,
// once the owner checked Bookamat for them. Nothing is sent to Bookamat.
export function BookamatForgetDialog({ mode, documentId, bookings, unsettled, currency, onClose, onDone }: {
  mode: 'booking' | 'unsettled' | null
  documentId: string
  bookings: BookingRow[]
  // The open attempts as worded for the owner („#123 (2026)“, „“title” (2026)“).
  unsettled: string[]
  currency: Currency
  onClose: () => void
  onDone: () => void
}) {
  const { t, lang } = useT()
  const uid = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyOf = (b: BookingRow) => `${b.year}:${b.booking_id}`
  const label = (b: BookingRow) => t('books.sync.booking', { id: b.booking_id, year: b.year })
  const list = [...bookings].sort((a, b) => (a.booked_on ?? '').localeCompare(b.booked_on ?? '') || a.year - b.year)
  // The latest booking, unless the owner picks another.
  const booking = list.find(b => keyOf(b) === chosen) ?? list[list.length - 1] ?? null

  function close() {
    setChosen(null)
    onClose()
  }

  async function confirm() {
    if (mode === 'booking' && !booking) return
    setBusy(true)
    const res = await requestBookamatForget(documentId, mode === 'unsettled' ? 'unsettled' : { year: booking!.year, bookingId: booking!.booking_id })
    setBusy(false)
    if (!res.ok) {
      toast.error(bookamatErrorMessage(t, res.payload))
      // Forgotten meanwhile (another window): the page shows the bookings as they are now.
      const code = res.payload && typeof res.payload === 'object' ? (res.payload as { code?: unknown }).code : null
      if (code === 'forget_not_found') { setChosen(null); onDone() }
      return
    }
    toast.success(mode === 'unsettled' ? t('payments.discarded') : t('payments.forgotten', { booking: label(booking!) }))
    setChosen(null)
    onDone()
  }

  return (
    <ConfirmDialog
      open={mode === 'unsettled' || (mode === 'booking' && !!booking)}
      title={mode === 'unsettled' ? t('payments.discardTitle') : t('payments.forgetTitle')}
      description={mode === 'unsettled'
        ? t('books.sync.resetPendingDesc', { bookings: unsettled.join(', ') })
        : booking ? t('payments.forgetDesc', { booking: label(booking) }) : undefined}
      confirmLabel={busy ? t('payments.forgetting') : mode === 'unsettled' ? t('payments.discardConfirm') : t('payments.forgetConfirm')}
      destructive
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={close}
    >
      {mode === 'booking' && list.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">{t('payments.forgetChoose')}</legend>
          {list.map(b => (
            <label key={keyOf(b)} className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name={`${uid}-forget`}
                className="mt-1 shrink-0"
                checked={!!booking && keyOf(booking) === keyOf(b)}
                onChange={() => setChosen(keyOf(b))}
              />
              <span className="tabular-nums">
                {t('payments.forgetOption', { booking: label(b), amount: formatMoney(Math.abs(Number(b.amount)), currency), date: b.booked_on ? formatDate(b.booked_on, lang) : '—' })}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </ConfirmDialog>
  )
}
