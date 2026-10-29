'use client'

import Link from 'next/link'
import { Dialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n/client'
import { n, type TFn, type UiLang } from '@/lib/i18n'
import { formatDate, formatMoney } from '@/lib/utils/document'
import { apiErrorMessage } from '@/lib/api-errors'
import { entriesLabel } from '@/lib/projects'
import { beforeLatest, hasIssueProblem, movesToToday, type IssuedNote, type LatestIssued } from '@/lib/utils/bulk-issue'

export type BulkDraftInfo = { id: string; date: string | null; total: number }

// The confirm dialog's part for the drafts a bulk action issues, as the issue dialog asks for one:
// today's date for drafts dated earlier (on by default), an order the numbers would no longer
// follow, zero totals, and for "Mark paid" a payment dated before its invoice.
export function BulkIssueNotice({ type, drafts, latest, today, redate, onRedate, paidDate, currency = 'EUR' }: {
  type: 'invoice' | 'quote'
  drafts: BulkDraftInfo[]
  latest: LatestIssued | null
  today: string
  redate: boolean
  onRedate: (redate: boolean) => void
  paidDate?: string
  currency?: string
}) {
  const { t, lang } = useT()
  if (!drafts.length) return null
  const stale = drafts.filter(d => movesToToday(d.date, today))
  const issuedOn = (d: BulkDraftInfo) => redate && movesToToday(d.date, today) ? today : d.date
  const earlier = drafts.some(d => beforeLatest(issuedOn(d), latest))
  const paidBefore = !!paidDate && /^\d{4}-\d{2}-\d{2}$/.test(paidDate) && drafts.some(d => (issuedOn(d) ?? '') > paidDate)
  const zero = drafts.filter(d => Math.abs(d.total) <= 0.005).length
  const amount = formatMoney(0, currency, lang)

  return (
    <div className="space-y-2 text-sm">
      {drafts.length > 1 && <p className="text-neutral-500 dark:text-neutral-400">{t('views.bulkIssue.order')}</p>}
      {stale.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-neutral-700 dark:text-neutral-300">
            {n(stale.length, t('views.bulkIssue.staleOne', { count: stale.length }), t('views.bulkIssue.staleOther', { count: stale.length }))}
          </p>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={redate} onChange={e => onRedate(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-neutral-900 dark:accent-white" />
            <span>{t(type === 'quote' ? 'views.bulkIssue.useTodayQuote' : 'views.bulkIssue.useToday', { date: formatDate(today, lang) })}</span>
          </label>
        </div>
      )}
      {latest && earlier && (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {t('views.bulkIssue.earlierThanLatest', { number: latest.number, date: formatDate(latest.date, lang) })}
        </p>
      )}
      {zero > 0 && (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {n(zero, t('views.bulkIssue.zeroOne', { count: zero, amount }), t('views.bulkIssue.zeroOther', { count: zero, amount }))}
        </p>
      )}
      {paidBefore && (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {t('views.bulkIssue.paidBefore', { date: formatDate(paidDate, lang) })}
        </p>
      )}
    </div>
  )
}

export function issueNoteLines(t: TFn, lang: UiLang, note: IssuedNote): string[] {
  const lines: string[] = []
  if (note.dateKept) lines.push(t('views.bulkIssue.dateKept'))
  if (note.beforeLatest) lines.push(t('views.bulkIssue.beforeLatest', { number: note.beforeLatest.number, date: formatDate(note.beforeLatest.date, lang) }))
  if (note.snapshotFailed) lines.push(t('views.bulkIssue.noArchive'))
  if (note.driveError) lines.push(t('views.bulkIssue.driveFailed', { error: apiErrorMessage(t, note.driveError) }))
  if (note.unlinked) lines.push(t('records.issue.unlinked', { entries: entriesLabel(t, note.unlinked.time, note.unlinked.expenses) }))
  return lines
}

// After a bulk action: the issued documents that need a look, each with what went wrong. Nothing
// is shown when every document was issued cleanly.
export function BulkIssueResult({ notes, path, onClose }: { notes: IssuedNote[] | null; path: 'invoices' | 'quotes'; onClose: () => void }) {
  const { t, lang } = useT()
  const shown = (notes ?? []).filter(hasIssueProblem)
  return (
    <Dialog open={shown.length > 0} onClose={onClose} title={t('views.bulkIssue.resultTitle')} description={t('views.bulkIssue.resultDesc')} panelClassName="max-w-md">
      <ul className="max-h-72 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
        {shown.map(note => (
          <li key={note.id} className="py-2 space-y-1">
            <Link href={`/${path}/${note.id}`} className="font-medium underline-offset-2 hover:underline">{note.number}</Link>
            <ul className="list-disc pl-5 space-y-0.5 text-neutral-600 dark:text-neutral-300 break-words">
              {issueNoteLines(t, lang, note).map(line => <li key={line}>{line}</li>)}
            </ul>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button type="button" onClick={onClose}>{t('common.close')}</Button>
      </div>
    </Dialog>
  )
}
