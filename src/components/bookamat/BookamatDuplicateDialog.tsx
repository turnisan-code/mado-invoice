'use client'

import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { n, type TFn } from '@/lib/i18n'
import { formatDate, formatMoney } from '@/lib/utils/document'
import type { BookingCandidate } from '@/lib/bookamat-search'

// Why a candidate cannot be taken over, and what to do instead (its `fit`, from the server).
function fitNote(t: TFn, c: BookingCandidate): string | null {
  const vars = { year: c.year, years: (c.plannedYears ?? []).join(', '), planned: formatMoney(c.planned ?? 0, 'EUR'), other: c.other ?? '' }
  switch (c.fit) {
    case 'part': return t('books.duplicates.fitPart', vars)
    case 'more': return t('books.duplicates.fitMore', vars)
    case 'year': return t('books.duplicates.fitYear', vars)
    case 'kind': return t('books.duplicates.fitKind', vars)
    case 'other_number': return t('books.duplicates.fitOther', vars)
    default: return null
  }
}

// The sync found bookings in Bookamat that Mado did not make and that may be this money, and
// booked nothing ('external_duplicate'). A booking that is exactly this money can be taken over
// („übernehmen“: recorded, nothing booked); for any other the dialog says what to do instead. The
// owner can still say none of them is this money („trotzdem buchen“: the sync runs again and
// ignores exactly these), warned when one names the document's number. `busy`: 'sync', or the
// key of the booking being taken over. `refund`: a credit note's money paid back.
export function BookamatDuplicateDialog({ open, candidates, busy, refund = false, onAdopt, onBookAnyway, onCancel }: {
  open: boolean
  candidates: BookingCandidate[]
  busy: string | null
  refund?: boolean
  onAdopt: (candidate: BookingCandidate) => void
  onBookAnyway: () => void
  onCancel: () => void
}) {
  const { t, lang } = useT()
  const count = candidates.length
  const namesNumber = candidates.some(c => c.reason === 'number' && c.fit !== 'other_number')
  return (
    <ConfirmDialog
      open={open}
      title={t('books.duplicates.title')}
      description={n(count, t('books.duplicates.descOne'), t('books.duplicates.descOther', { count }))}
      confirmLabel={busy === 'sync' ? t('payments.syncing') : n(count, t('books.duplicates.bookAnywayOne'), t('books.duplicates.bookAnywayOther'))}
      busy={!!busy}
      onConfirm={onBookAnyway}
      onCancel={onCancel}
    >
      <ul className="space-y-2 mb-3">
        {candidates.map(c => {
          const key = `${c.year}:${c.bookingId}`
          const note = fitNote(t, c)
          return (
            <li key={key} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 text-sm">
              <p className="font-medium break-words">{c.title.trim() || '—'}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                #{c.bookingId} · {formatDate(c.date, lang)} · {formatMoney(c.total, 'EUR')} · {t(c.reason === 'number' ? 'books.duplicates.byNumber' : 'books.duplicates.byAmount')}
              </p>
              {note ? (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1.5 break-words">{note}</p>
              ) : (
                <Button type="button" size="sm" variant="outline" className="mt-2 max-w-full whitespace-normal h-auto min-h-7 py-1 text-left" disabled={!!busy} onClick={() => onAdopt(c)}>
                  {busy === key ? t('books.duplicates.adopting') : t(refund ? 'books.duplicates.adoptRefund' : 'books.duplicates.adopt')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {namesNumber && <p className="text-xs text-red-600 dark:text-red-400 mb-4 break-words">{t('books.duplicates.caution')}</p>}
    </ConfirmDialog>
  )
}
