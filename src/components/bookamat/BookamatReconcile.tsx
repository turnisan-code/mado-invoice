'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { bookamatErrorMessage, requestBookamatAdopt } from '@/lib/bookamat-client'
import { describeCandidate, type BookingCandidate } from '@/lib/bookamat-search'
import type { ReconcileReport } from '@/lib/bookamat-reconcile'

const docHref = (type: string, id: string) => `/${type === 'credit_note' ? 'credit-notes' : 'invoices'}/${id}`

// Settings → Bookamat → „Mit Bookamat abgleichen“: reads Mado's documents against this and last
// year's bookings in Bookamat and lists what does not fit (src/lib/bookamat-reconcile.ts). Writes
// nothing, except a booking the owner takes over with „übernehmen“ (production only).
export function BookamatReconcile() {
  const { t, lang } = useT()
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/bookamat/reconcile', { cache: 'no-store' }).catch(() => null)
      const payload: unknown = res ? await res.json().catch(() => ({})) : { code: 'network' }
      if (!res?.ok) { setReport(null); setError(bookamatErrorMessage(t, payload)); return }
      setReport(payload as ReconcileReport)
    } finally {
      setRunning(false)
    }
  }

  async function adopt(documentId: string, c: BookingCandidate) {
    setAdopting(`${documentId}:${c.year}:${c.bookingId}`)
    const res = await requestBookamatAdopt(documentId, { year: c.year, bookingId: c.bookingId })
    setAdopting(null)
    if (!res.ok) { toast.error(bookamatErrorMessage(t, res.payload)); return }
    toast.success(t('books.duplicates.adopted', { id: c.bookingId }))
    void run()
  }

  const years = report?.years.join(', ') ?? ''
  const problems = report ? report.recorded.filter(r => r.status !== 'ok') : []
  const clean = !!report && !problems.length && !report.unbooked.length && !report.doubles.length && !report.unknown.length

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="button" variant="outline" onClick={() => void run()} disabled={running}>
          {running ? t('books.reconcile.running') : t('books.reconcile.run')}
        </Button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('books.reconcile.hint')}</span>
      </div>
      {error && <p role="status" className="text-xs text-red-600 dark:text-red-400 break-words">{t('books.reconcile.failed', { error })}</p>}
      {report && (
        <div role="status" className="space-y-2 text-xs">
          <p className={clean ? 'text-green-700 dark:text-green-400' : 'text-neutral-600 dark:text-neutral-300'}>
            {clean
              ? t('books.reconcile.allGood', { years, count: report.recorded.length })
              : t('books.reconcile.summary', { years, count: report.recorded.length, read: report.bookingsRead })}
          </p>
          {problems.map(r => (
            <p key={`${r.year}:${r.bookingId}`} className="text-red-600 dark:text-red-400 break-words">
              <Link href={docHref(r.type, r.documentId)} className="underline underline-offset-2">{r.number}</Link>{' '}
              {r.status === 'missing'
                ? t('books.reconcile.missing', { id: r.bookingId, year: r.year })
                : t('books.reconcile.differs', {
                  id: r.bookingId,
                  mado: `${formatMoney(Math.abs(r.amount), 'EUR')}, ${r.bookedOn ? formatDate(r.bookedOn, lang) : '—'}`,
                  bookamat: r.bookamat ? `${formatMoney(r.bookamat.total, 'EUR')}, ${formatDate(r.bookamat.date, lang)}` : '—',
                })}
            </p>
          ))}
          {report.unbooked.map(u => (
            <div key={`${u.documentId}:${u.year}`} className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-2 space-y-1">
              <p className="break-words">
                <Link href={docHref(u.type, u.documentId)} className="underline underline-offset-2">{u.number}</Link>{' '}
                {t('books.reconcile.unbooked', { client: u.client, amount: formatMoney(u.amount, 'EUR'), date: formatDate(u.date, lang) })}
              </p>
              {!u.candidates.length && <p className="text-neutral-500 dark:text-neutral-400">{t('books.reconcile.unbookedNone')}</p>}
              {u.candidates.map(c => {
                const key = `${u.documentId}:${c.year}:${c.bookingId}`
                return (
                  <div key={key} className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-700 dark:text-amber-400 break-words">{t('books.reconcile.unbookedFound', { booking: describeCandidate(c) })}</span>
                    <Button type="button" size="xs" variant="outline" disabled={!!adopting} onClick={() => void adopt(u.documentId, c)}>
                      {adopting === key ? t('books.duplicates.adopting') : t('books.duplicates.adopt')}
                    </Button>
                  </div>
                )
              })}
            </div>
          ))}
          {report.doubles.map(d => (
            <p key={`${d.booking.year}:${d.booking.bookingId}`} className="text-red-600 dark:text-red-400 break-words">
              <Link href={docHref(d.type, d.documentId)} className="underline underline-offset-2">{d.number}</Link>{' '}
              {t('books.reconcile.double', { booking: describeCandidate(d.booking) })}
            </p>
          ))}
          {report.unknown.map(u => (
            <p key={`${u.booking.year}:${u.booking.bookingId}`} className="text-amber-700 dark:text-amber-400 break-words">
              {t('books.reconcile.unknown', { booking: describeCandidate(u.booking), number: u.number })}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
