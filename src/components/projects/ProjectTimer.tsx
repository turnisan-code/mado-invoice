'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
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
      <Button
        type="button"
        variant="outline"
        onClick={() => writeTimer(projectId, Date.now())}
        title={t('projects.timer.hint')}
      >
        <Play size={14} /> {t('projects.timer.start')}
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="destructive"
      onClick={() => void stop()}
      disabled={saving}
      aria-label={`${t('projects.timer.stop')} (${elapsedLabel(now - startedAt)})`}
      className="gap-2"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span className="tabular-nums" aria-hidden>{elapsedLabel(now - startedAt)}</span>
      <Square size={13} aria-hidden />
      <span className="sr-only sm:not-sr-only">{t('projects.timer.stop')}</span>
    </Button>
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
