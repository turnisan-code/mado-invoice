'use client'

import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { BookingCandidate } from '@/lib/bookamat-search'

// The sync found bookings in Bookamat that Mado did not make and that may be this money, and
// booked nothing ('external_duplicate'). The owner takes one over („übernehmen“: recorded, nothing
// booked) or says none of them is this money („trotzdem buchen“: the sync runs again and ignores
// exactly these). `busy`: 'sync', or the key of the booking being taken over.
export function BookamatDuplicateDialog({ open, candidates, busy, onAdopt, onBookAnyway, onCancel }: {
  open: boolean
  candidates: BookingCandidate[]
  busy: string | null
  onAdopt: (candidate: BookingCandidate) => void
  onBookAnyway: () => void
  onCancel: () => void
}) {
  const { t, lang } = useT()
  return (
    <ConfirmDialog
      open={open}
      title={t('books.duplicates.title')}
      description={t('books.duplicates.desc')}
      confirmLabel={busy === 'sync' ? t('payments.syncing') : t('books.duplicates.bookAnyway')}
      busy={!!busy}
      onConfirm={onBookAnyway}
      onCancel={onCancel}
    >
      <ul className="space-y-2 mb-4">
        {candidates.map(c => {
          const key = `${c.year}:${c.bookingId}`
          return (
            <li key={key} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 text-sm">
              <p className="font-medium break-words">{c.title.trim() || '—'}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                #{c.bookingId} · {formatDate(c.date, lang)} · {formatMoney(c.total, 'EUR')} · {t(c.reason === 'number' ? 'books.duplicates.byNumber' : 'books.duplicates.byAmount')}
              </p>
              <Button type="button" size="sm" variant="outline" className="mt-2" disabled={!!busy} onClick={() => onAdopt(c)}>
                {busy === key ? t('books.duplicates.adopting') : t('books.duplicates.adopt')}
              </Button>
            </li>
          )
        })}
      </ul>
    </ConfirmDialog>
  )
}
