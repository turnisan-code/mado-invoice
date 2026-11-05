// Templates of recurring schedules that issue automatically: the recurring cron numbers what it
// copies from such a template without anyone approving it, so Claude never changes or deletes one,
// whether the schedule is active or paused. The database refuses it for every Claude session
// (MI045, 20261105_mcp_drafts.sql); the tools refuse first, with the schedule named.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecurringSchedule } from '@/types'

export type IssueSchedule = Pick<RecurringSchedule, 'id' | 'name' | 'active' | 'source_document_id'>

// The schedules in 'issue' mode, active or paused, that use one of these documents as their template.
export async function issueSchedules(supabase: SupabaseClient, documentIds: readonly string[]): Promise<IssueSchedule[]> {
  if (!documentIds.length) return []
  const { data, error } = await supabase.from('recurring_schedules')
    .select('id, name, active, source_document_id')
    .in('source_document_id', [...documentIds])
    .eq('mode', 'issue')
  if (error) throw error
  return ((data ?? []) as IssueSchedule[]).sort((a, b) => a.id.localeCompare(b.id))
}

// The refusal as the database words it (errors.ts maps MI045), naming the schedule.
export function templateLocked(schedule: IssueSchedule): Error {
  return Object.assign(new Error('MI045'), { code: 'MI045', details: schedule.id })
}

export async function refuseIssueTemplate(supabase: SupabaseClient, documentId: string): Promise<void> {
  const [schedule] = await issueSchedules(supabase, [documentId])
  if (schedule) throw templateLocked(schedule)
}
