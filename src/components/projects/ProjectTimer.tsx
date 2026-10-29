'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { formatDuration, readTimer, timerEntry, timerKey } from '@/lib/projects'
import { useT } from '@/lib/i18n/client'
import type { TimeEntry } from '@/types'

// Same-tab changes; other tabs hear the storage event.
const TIMER_EVENT = 'mado-invoice:timer'

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(TIMER_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(TIMER_EVENT, onChange)
  }
}

function writeTimer(projectId: string, startedAt: number | null) {
  try {
    if (startedAt === null) window.localStorage.removeItem(timerKey(projectId))
    else window.localStorage.setItem(timerKey(projectId), String(startedAt))
  } catch { /* storage blocked: the timer simply does not run */ }
  window.dispatchEvent(new Event(TIMER_EVENT))
}

// A deleted project leaves no timer behind.
export function clearProjectTimer(projectId: string) {
  writeTimer(projectId, null)
}

// When the project's timer on this device was started, or null.
export function useProjectTimer(projectId: string): number | null {
  return useSyncExternalStore(subscribe, () => readTimer(projectId), () => null)
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${formatDuration(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

// Start/stop on the project page. Stopping saves the time as a billable entry dated the day the
// timer started and hands it over for a description.
export default function ProjectTimer({ projectId, onStopped }: { projectId: string; onStopped: (entry: TimeEntry) => void }) {
  const router = useRouter()
  const supabase = createClient()
  const { t } = useT()
  const startedAt = useProjectTimer(projectId)
  const now = useNow(startedAt !== null)
  const [saving, setSaving] = useState(false)

  async function stop() {
    if (startedAt === null) return
    setSaving(true)
    const { date, minutes, capped } = timerEntry(startedAt, Date.now())
    const { data, error } = await supabase
      .from('time_entries')
      .insert({ project_id: projectId, date, minutes, description: '', billable: true })
      .select('*')
      .single()
    setSaving(false)
    if (error || !data) { toast.error(t('projects.timer.failed')); return }
    writeTimer(projectId, null)
    if (capped) toast.warning(t('projects.timer.capped'))
    else toast.success(t('projects.timer.stopped', { duration: formatDuration(minutes) }))
    router.refresh()
    onStopped(data as TimeEntry)
  }

  if (startedAt === null) {
    return (
      <button
        type="button"
        onClick={() => writeTimer(projectId, Date.now())}
        title={t('projects.timer.hint')}
        className="flex items-center justify-center gap-1.5 text-sm px-3 h-10 sm:h-8 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
      >
        <Play size={14} /> {t('projects.timer.start')}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={saving}
      aria-label={`${t('projects.timer.stop')} (${elapsedLabel(now - startedAt)})`}
      className="flex items-center justify-center gap-2 text-sm px-3 h-10 sm:h-8 rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950 transition-colors disabled:opacity-50"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span className="tabular-nums" aria-hidden>{elapsedLabel(now - startedAt)}</span>
      <Square size={13} aria-hidden />
      <span className="sr-only sm:not-sr-only">{t('projects.timer.stop')}</span>
    </button>
  )
}

// A dot in the project list for a timer that is running on this device.
export function TimerDot({ projectId }: { projectId: string }) {
  const { t } = useT()
  const startedAt = useProjectTimer(projectId)
  if (startedAt === null) return null
  return (
    <span title={t('projects.timer.running')} className="relative inline-flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      <span className="sr-only">{t('projects.timer.running')}</span>
    </span>
  )
}
