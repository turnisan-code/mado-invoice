'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/lib/i18n/client'
import { entriesLabel } from '@/lib/projects'
import { unlinkedEntries } from '@/lib/utils/issue-checks'

type Unlinked = { time: number; expenses: number; projects: { id: string; name: string }[] }
type BilledRow = { document_item_id: string | null; project_id: string; projects: { name: string } | null }

async function loadUnlinked(supabase: SupabaseClient, documentId: string): Promise<Unlinked> {
  const billed = (table: 'time_entries' | 'project_expenses') => supabase.from(table)
    .select('document_item_id, project_id, projects(name)').eq('invoiced_document_id', documentId)
  const [time, expenses, items] = await Promise.all([
    billed('time_entries'),
    billed('project_expenses'),
    supabase.from('document_items').select('id').eq('document_id', documentId),
  ])
  const failed = time.error ?? expenses.error ?? items.error
  if (failed) throw new Error(failed.message)
  const lineIds = (items.data ?? []).map(i => i.id as string)
  // Many-to-one: PostgREST returns the project as an object, the untyped client infers an array.
  const lostTime = unlinkedEntries((time.data ?? []) as unknown as BilledRow[], lineIds)
  const lostExpenses = unlinkedEntries((expenses.data ?? []) as unknown as BilledRow[], lineIds)
  const projects = new Map<string, string>()
  for (const row of [...lostTime, ...lostExpenses]) projects.set(row.project_id, row.projects?.name ?? '')
  return { time: lostTime.length, expenses: lostExpenses.length, projects: [...projects].map(([id, name]) => ({ id, name })) }
}

// In the issue dialog of an invoice: time entries and expenses billed on it that no longer sit on
// one of its lines (links lost before line ids were kept). Issuing would leave them billed on an
// invoice that does not list them. Nothing is shown while loading or when the check fails.
export default function ProjectLinkWarning({ documentId }: { documentId: string }) {
  const { t } = useT()
  const [result, setResult] = useState<{ documentId: string; unlinked: Unlinked } | null>(null)

  useEffect(() => {
    let live = true
    loadUnlinked(createClient(), documentId)
      .then(unlinked => { if (live) setResult({ documentId, unlinked }) })
      .catch(err => console.error('[ProjectLinkWarning]', err))
    return () => { live = false }
  }, [documentId])

  const unlinked = result?.documentId === documentId ? result.unlinked : null
  if (!unlinked || unlinked.time + unlinked.expenses === 0) return null

  return (
    <p role="alert" className="text-amber-700 dark:text-amber-300">
      {t('records.issue.unlinked', { entries: entriesLabel(t, unlinked.time, unlinked.expenses) })}
      {unlinked.projects.map(p => (
        <span key={p.id}>
          {' '}
          <Link href={`/projects/${p.id}`} className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100">
            {p.name ? t('records.issue.openProject', { project: p.name }) : t('records.history.openProject')}
          </Link>
        </span>
      ))}
    </p>
  )
}
