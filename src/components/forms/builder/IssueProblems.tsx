'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { issueProblemMessage } from '@/lib/utils/issue-checks'
import { n, type TFn } from '@/lib/i18n'
import { useT } from '@/lib/i18n/client'
import type { IssueProblem } from '@/types'

export function isIssueProblems(value: unknown): value is IssueProblem[] {
  return Array.isArray(value) && value.every(p => p && typeof p === 'object' && typeof (p as IssueProblem).code === 'string')
}

// Why a document cannot be issued, one reason per line, with a way to Settings when the company
// details are what is missing.
export function IssueProblemList({ problems, className = 'mt-1.5 list-disc pl-5 space-y-1' }: { problems: IssueProblem[]; className?: string }) {
  const { t } = useT()
  return (
    <ul className={className}>
      {problems.map((p, i) => (
        <li key={`${p.code}-${i}`}>
          {issueProblemMessage(p, t)}
          {p.code === 'settingsIncomplete' && (
            <> <Link href="/settings" className="underline underline-offset-2 font-medium">{t('issueChecks.openSettings')}</Link></>
          )}
        </li>
      ))}
    </ul>
  )
}

// A bulk "Mark sent"/"Mark paid" stops at the first draft that cannot be issued (422): say which
// one and why, and how many were issued before it.
export function toastBulkIssueProblems(t: TFn, data: { error?: unknown; problems?: unknown; issued?: unknown }): boolean {
  if (!isIssueProblems(data.problems)) return false
  const issued = typeof data.issued === 'number' ? data.issued : 0
  toast.error(typeof data.error === 'string' && data.error ? data.error : t('issueChecks.title'), {
    description: (
      <div className="space-y-1">
        <ul className="list-disc pl-4 space-y-0.5">
          {data.problems.map((p, i) => <li key={`${p.code}-${i}`}>{issueProblemMessage(p, t)}</li>)}
        </ul>
        {issued > 0 && <p>{n(issued, t('editor.bulk.issuedBeforeOne', { count: issued }), t('editor.bulk.issuedBeforeOther', { count: issued }))}</p>}
      </div>
    ),
    duration: 12000,
  })
  return true
}
