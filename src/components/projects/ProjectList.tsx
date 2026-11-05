'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FolderKanban, Plus, Timer } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'
import { formatDuration, PROJECT_STATUSES, type ProjectTotals } from '@/lib/projects'
import { ClickableRow } from '@/components/lists/ListParts'
import { useT } from '@/lib/i18n/client'
import { n } from '@/lib/i18n'
import type { ProjectStatus } from '@/types'
import ProjectDialog, { type ClientOption } from './ProjectDialog'
import TimeEntryDialog, { type ProjectOption } from './TimeEntryDialog'
import { TimerDot } from './ProjectTimer'
import { budgetBarColor, cardClass, inputClass, outlineButtonClass, primaryButtonClass, projectStatusColor } from './ui'

export interface ProjectRow {
  id: string
  name: string
  status: ProjectStatus
  clientId: string
  client: string
  hourly_rate: number | null
  totals: ProjectTotals
  // Larger share of the hours and the amount budget used; null without a budget.
  budgetShare: number | null
}

type StatusFilter = ProjectStatus | 'all'

export default function ProjectList({ projects, clients }: { projects: ProjectRow[]; clients: ClientOption[] }) {
  const { t, lang } = useT()
  const [status, setStatus] = useState<StatusFilter>('active')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [logging, setLogging] = useState(false)

  const query = q.trim().toLowerCase()
  const shown = projects.filter(p =>
    (status === 'all' || p.status === status) &&
    (!query || p.name.toLowerCase().includes(query) || p.client.toLowerCase().includes(query)))
  const timeTargets: ProjectOption[] = projects
    .filter(p => p.status === 'active')
    .map(p => ({ id: p.id, name: p.name, client: p.client, hourly_rate: p.hourly_rate }))
  const percent = (share: number) => new Intl.NumberFormat(lang === 'de' ? 'de-AT' : 'en-GB', { style: 'percent', maximumFractionDigits: 0 }).format(share)
  const count = n(shown.length, t('projects.countOne', { count: shown.length }), t('projects.countOther', { count: shown.length }))

  const statusBadge = (s: ProjectStatus) => (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${projectStatusColor[s]}`}>{t(`projects.statuses.${s}`)}</span>
  )
  const budget = (p: ProjectRow) => p.budgetShare === null ? <span className="text-neutral-400 dark:text-neutral-500">—</span> : (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span className="h-1.5 w-14 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden" aria-hidden>
        <span className={`block h-full rounded-full ${budgetBarColor(p.budgetShare)}`} style={{ width: `${Math.min(100, p.budgetShare * 100)}%` }} />
      </span>
      {percent(p.budgetShare)}
    </span>
  )

  const empty = (
    <div className="py-16 px-6 text-center">
      <FolderKanban size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{projects.length ? t('projects.noMatch') : t('projects.empty')}</p>
      {!projects.length && <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1 max-w-sm mx-auto">{t('projects.emptyHint')}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
        <div className="flex gap-2">
          <button type="button" onClick={() => setLogging(true)} className={outlineButtonClass}><Timer size={14} /> {t('projects.logTime')}</button>
          <button type="button" onClick={() => setCreating(true)} className={primaryButtonClass}><Plus size={14} /> {t('projects.new')}</button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('projects.searchPlaceholder')} aria-label={t('projects.searchLabel')} className={`${inputClass} flex-1 min-w-48 sm:max-w-sm`} />
        <select value={status} onChange={e => setStatus(e.target.value as StatusFilter)} aria-label={t('projects.columns.status')} className={`${inputClass} w-auto`}>
          {PROJECT_STATUSES.map(s => <option key={s} value={s}>{t(`projects.statuses.${s}`)}</option>)}
          <option value="all">{t('common.all')}</option>
        </select>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="sm:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
          {shown.length === 0 && empty}
          {shown.map(p => (
            <Link key={p.id} href={`/projects/${p.id}`} className="block px-4 py-3.5 space-y-1 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm flex items-center gap-2"><span className="truncate">{p.name}</span><TimerDot projectId={p.id} /></p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{p.client}</p>
                </div>
                {statusBadge(p.status)}
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                <span>{t('projects.unbilledLine', { hours: formatDuration(p.totals.unbilledMinutes), amount: formatMoney(p.totals.unbilledAmount) })}</span>
                {p.budgetShare !== null && budget(p)}
              </div>
            </Link>
          ))}
        </div>

        <table className="hidden sm:table w-full text-sm">
          <thead className="border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('projects.columns.project')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('projects.columns.client')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('projects.columns.status')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 text-right">{t('projects.columns.unbilledHours')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 text-right">{t('projects.columns.unbilledAmount')}</th>
              <th className="px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">{t('projects.columns.budget')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {shown.length === 0 && <tr><td colSpan={6}>{empty}</td></tr>}
            {shown.map(p => (
              <ClickableRow key={p.id} href={`/projects/${p.id}`} className="hover:bg-neutral-50 dark:hover:bg-neutral-800">
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline underline-offset-2">{p.name}</Link>
                    <TimerDot projectId={p.id} />
                  </span>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
                  <Link href={`/clients/${p.clientId}`} className="hover:underline underline-offset-2">{p.client}</Link>
                </td>
                <td className="px-4 py-3">{statusBadge(p.status)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{p.totals.unbilledMinutes ? formatDuration(p.totals.unbilledMinutes) : '—'}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${p.totals.unbilledAmount > 0 ? 'text-amber-600 font-medium' : ''}`}>{formatMoney(p.totals.unbilledAmount)}</td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{budget(p)}</td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">{count}</p>

      {creating && <ProjectDialog clients={clients} onClose={() => setCreating(false)} />}
      {logging && <TimeEntryDialog projects={timeTargets} onClose={() => setLogging(false)} />}
    </div>
  )
}
