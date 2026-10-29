'use client'

import { useState } from 'react'
import Link from 'next/link'
import { FileText, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils/document'
import { formatDuration } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { ProjectStatus } from '@/types'
import ProjectDialog, { type ClientOption } from './ProjectDialog'
import StatementDialog from './StatementDialog'
import { TimerDot } from './ProjectTimer'
import { cardClass, projectStatusColor } from './ui'

export type ClientProjectRow = { id: string; name: string; status: ProjectStatus; unbilledMinutes: number; unbilledAmount: number }

// The client page's projects (with what is still unbilled) and its statement of account.
export default function ClientProjectsPanel({ client, projects }: { client: ClientOption; projects: ClientProjectRow[] }) {
  const { t } = useT()
  const [creating, setCreating] = useState(false)
  const [statement, setStatement] = useState(false)
  const unbilled = projects.reduce((s, p) => s + p.unbilledAmount, 0)

  return (
    <div className={`${cardClass} overflow-hidden`}>
      {/* Without projects the card stays a single row, so it costs little room on a phone. */}
      <div className={`flex items-center justify-between gap-3 flex-wrap px-5 py-4 ${projects.length ? 'border-b border-neutral-100 dark:border-neutral-800' : ''}`}>
        <div className="min-w-0">
          <span className="text-sm font-medium">{t('projects.client.title')}</span>
          {unbilled > 0 && <span className="ml-2 text-xs text-amber-600 tabular-nums">{t('projects.client.unbilled', { amount: formatMoney(unbilled) })}</span>}
          {!projects.length && <span className="block text-xs text-neutral-500 dark:text-neutral-500 mt-0.5">{t('projects.client.none')}</span>}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setStatement(true)} className="text-xs">
            <FileText size={12} /> {t('projects.statement.button')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setCreating(true)} className="text-xs">
            <Plus size={12} /> {t('projects.new')}
          </Button>
        </div>
      </div>
      {projects.length > 0 && (
        <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
          {projects.map(p => (
            <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
              {/* On a phone the unbilled line goes under the name, which keeps the room it needs. */}
              <span className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-3">
                <span className="flex items-center gap-2 min-w-0 sm:flex-1">
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  <TimerDot projectId={p.id} />
                </span>
                {p.unbilledAmount > 0 && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums sm:shrink-0">
                    {t('projects.unbilledLine', { hours: formatDuration(p.unbilledMinutes), amount: formatMoney(p.unbilledAmount) })}
                  </span>
                )}
              </span>
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
