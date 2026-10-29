'use client'

import { useId, useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatDate, today } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'
import type { DocumentType, IssueProblem } from '@/types'
import { IssueProblemList } from './IssueProblems'

export interface IssueDialogProps {
  open: boolean
  type: DocumentType
  title?: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: React.ReactNode
  busy?: boolean
  // The draft's date when it lies before today: issuing offers today's date instead.
  staleDate: string | null
  // The date the document carries when it keeps its own.
  draftDate: string
  // Invoices: the due date that follows from today's date.
  todayDue: string | null
  latestIssued: { number: string; date: string } | null
  numberFor: (isoDate: string) => string
  // The formatted total when it is zero: issuing it is asked about, not refused.
  zeroTotal: string | null
  // What the server refused (422), shown until the dialog is closed.
  problems?: IssueProblem[] | null
  onConfirm: (useToday: boolean) => void
  onCancel: () => void
  children?: React.ReactNode
}

// The one confirmation before a number is taken, for the editor and the status menu alike.
export function IssueDialog({
  open, type, title, description, confirmLabel, busy, staleDate, draftDate, todayDue, latestIssued,
  numberFor, zeroTotal, problems, onConfirm, onCancel, children,
}: IssueDialogProps) {
  const { t, lang } = useT()
  const uid = useId()
  const [useToday, setUseToday] = useState(true)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setUseToday(true)
  }
  const issueDate = staleDate && useToday ? today() : draftDate
  const number = numberFor(issueDate)

  return (
    <ConfirmDialog
      open={open}
      title={title ?? t(`builder.issueTitle.${type}`)}
      description={description ?? t('builder.issueDesc', { number: t(`docTypeNumber.${type}`) })}
      confirmLabel={confirmLabel ?? t('builder.issueAndContinue')}
      busy={busy}
      onConfirm={() => onConfirm(useToday)}
      onCancel={onCancel}
    >
      <div className="space-y-3 text-sm">
        {staleDate && (
          <fieldset className="space-y-2">
            <legend className="text-neutral-700 dark:text-neutral-300 mb-2">{t('issueChecks.staleDate', { date: formatDate(staleDate, lang) })}</legend>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="radio" name={`${uid}-issue-date`} checked={useToday} onChange={() => setUseToday(true)} className="w-4 h-4 accent-neutral-900 dark:accent-white" />
              {todayDue
                ? t('issueChecks.useTodayDue', { date: formatDate(today(), lang), due: formatDate(todayDue, lang) })
                : t('issueChecks.useToday', { date: formatDate(today(), lang) })}
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="radio" name={`${uid}-issue-date`} checked={!useToday} onChange={() => setUseToday(false)} className="w-4 h-4 accent-neutral-900 dark:accent-white" />
              {t('issueChecks.keepDate', { date: formatDate(staleDate, lang) })}
            </label>
          </fieldset>
        )}
        {latestIssued && issueDate < latestIssued.date && (
          <p role="alert" className="text-amber-700 dark:text-amber-300">
            {t('issueChecks.earlierThanLatest', { number: latestIssued.number, date: formatDate(latestIssued.date, lang) })}
          </p>
        )}
        {zeroTotal && (
          <p role="alert" className="text-amber-700 dark:text-amber-300">{t('editor.zeroTotal', { amount: zeroTotal })}</p>
        )}
        {number && (
          <p className="text-neutral-500 dark:text-neutral-400">{t('issueChecks.expectedNumber', { number })}</p>
        )}
        {children}
        {!!problems?.length && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-3 py-2 text-red-800 dark:text-red-300">
            <p className="font-medium">{t('issueChecks.title')}</p>
            <IssueProblemList problems={problems} />
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}
