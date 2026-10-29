'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileText, Plus } from 'lucide-react'
import { formatMoney } from '@/lib/utils/document'
import { formatDuration } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { ProjectStatus } from '@/types'
import ProjectDialog, { type ClientOption } from './ProjectDialog'
import StatementDialog from './StatementDialog'
import { TimerDot } from './ProjectTimer'
import { cardClass, projectStatusColor } from './ui'

export type ClientProjectRow = { id: string; name: string; status: ProjectStatus; unbilledMinutes: number; unbilledAmount: number }

const buttonClass = 'flex items-center gap-1 text-xs px-2.5 h-9 sm:h-auto sm:py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors dark:text-neutral-300'

// The client page's projects (with what is still unbilled) and its statement of account.
export default function ClientProjectsPanel({ client, projects }: { client: ClientOption; projects: ClientProjectRow[] }) {
  const { t } = useT()
  const [creating, setCreating] = useState(false)
  const [statement, setStatement] = useState(false)
  const unbilled = projects.reduce((s, p) => s + p.unbilledAmount, 0)

  return (
    <div className={`${cardClass} overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
        <div className="min-w-0">
          <span className="text-sm font-medium">{t('projects.client.title')}</span>
          {unbilled > 0 && <span className="ml-2 text-xs text-amber-600 tabular-nums">{t('projects.client.unbilled', { amount: formatMoney(unbilled) })}</span>}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setStatement(true)} className={buttonClass}>
            <FileText size={11} /> {t('projects.statement.button')}
          </button>
          <button type="button" onClick={() => setCreating(true)} className={buttonClass}>
            <Plus size={11} /> {t('projects.new')}
          </button>
        </div>
      </div>
      {projects.length === 0
        ? <p className="px-5 py-6 text-sm text-neutral-400 dark:text-neutral-500">{t('projects.client.none')}</p>
        : (
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {projects.map(p => (
              <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                <span className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  <TimerDot projectId={p.id} />
                </span>
                {p.unbilledAmount > 0 && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums shrink-0">
                    {t('projects.unbilledLine', { hours: formatDuration(p.unbilledMinutes), amount: formatMoney(p.unbilledAmount) })}
                  </span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${projectStatusColor[p.status]}`}>{t(`projects.statuses.${p.status}`)}</span>
              </Link>
            ))}
          </div>
        )}
      {creating && <ProjectDialog clients={[client]} defaultClientId={client.id} lockClient onClose={() => setCreating(false)} />}
      {statement && <StatementDialog clientId={client.id} onClose={() => setStatement(false)} />}
    </div>
  )
}
