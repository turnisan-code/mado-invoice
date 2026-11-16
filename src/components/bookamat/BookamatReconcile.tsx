'use client'

import { useRef, useState } from 'react'
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
// nothing, except a booking the owner takes over with „übernehmen“, which only production offers
// (`writes`) and only for a booking that is exactly the money.
export function BookamatReconcile({ writes = true }: { writes?: boolean }) {
  const { t, lang } = useT()
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)
  // Only the latest check's answer is shown.
  const runId = useRef(0)

  async function run() {
    const id = ++runId.current
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/bookamat/reconcile', { cache: 'no-store' }).catch(() => null)
      const payload: unknown = res ? await res.json().catch(() => ({})) : { code: 'network' }
      if (id !== runId.current) return
      if (!res?.ok) { setReport(null); setError(bookamatErrorMessage(t, payload)); return }
      setReport(payload as ReconcileReport)
    } finally {
      if (id === runId.current) setRunning(false)
    }
  }

  // Taken over: that money is booked now, so its entry goes; no new check of two years.
  async function adopt(documentId: string, year: number, c: BookingCandidate) {
    setAdopting(`${documentId}:${c.year}:${c.bookingId}`)
    const res = await requestBookamatAdopt(documentId, { year: c.year, bookingId: c.bookingId })
    setAdopting(null)
    if (!res.ok) { toast.error(bookamatErrorMessage(t, res.payload)); return }
    toast.success(t('books.duplicates.adopted', { id: c.bookingId }))
    const booked = res.data.adopted.year
    setReport(r => r && { ...r, unbooked: r.unbooked.filter(u => !(u.documentId === documentId && (u.year === booked || u.year === year))) })
  }

  const years = report?.years.join(', ') ?? ''
  const problems = report ? report.recorded.filter(r => r.status !== 'ok') : []
  const clean = !!report && !problems.length && !report.unbooked.length && !report.doubles.length && !report.unknown.length
  const summary = !report ? ''
    : clean ? t('books.reconcile.allGood', { years, count: report.recorded.length })
    : t('books.reconcile.summary', { years, count: report.recorded.length, read: report.bookingsRead })
  const numberLink = (type: string, id: string, number: string) => (
    <><Link href={docHref(type, id)} className="underline underline-offset-2">{number}</Link>{' — '}</>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="button" variant="outline" onClick={() => void run()} disabled={running || !!adopting}>
          {running ? t('books.reconcile.running') : t('books.reconcile.run')}
        </Button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('books.reconcile.hint')}</span>
      </div>
      {/* Always present, so the result and a failure are announced. */}
      <p role="status" aria-live="polite" className={`text-xs break-words ${error ? 'text-red-600 dark:text-red-400' : clean ? 'text-green-700 dark:text-green-400' : 'text-neutral-600 dark:text-neutral-300'}`}>
        {error ? t('books.reconcile.failed', { error }) : running ? '' : summary}
      </p>
      {report && !running && (
        <div className="space-y-2 text-xs">
          {problems.map(r => (
            <p key={`${r.year}:${r.bookingId}`} className="text-red-600 dark:text-red-400 break-words">
              {numberLink(r.type, r.documentId, r.number)}
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
                {numberLink(u.type, u.documentId, u.number)}
                {t('books.reconcile.unbooked', { client: u.client || '—', amount: formatMoney(u.amount, 'EUR'), date: formatDate(u.date, lang) })}
              </p>
              {!u.candidates.length && <p className="text-neutral-500 dark:text-neutral-400">{t('books.reconcile.unbookedNone')}</p>}
              {u.candidates.map(c => {
                const key = `${u.documentId}:${c.year}:${c.bookingId}`
                return (
                  <div key={key} className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-700 dark:text-amber-400 break-words">{t('books.reconcile.unbookedFound', { booking: describeCandidate(c) })}</span>
                    {c.fit === 'exact' && writes && (
                      <Button type="button" size="xs" variant="outline" disabled={!!adopting || running} onClick={() => void adopt(u.documentId, u.year, c)}>
                        {adopting === key ? t('books.duplicates.adopting') : t(u.type === 'credit_note' ? 'books.duplicates.adoptRefund' : 'books.duplicates.adopt')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {report.doubles.map(d => (
            <p key={`${d.documentId}:${d.booking.year}:${d.booking.bookingId}`} className="text-red-600 dark:text-red-400 break-words">
              {numberLink(d.type, d.documentId, d.number)}
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
