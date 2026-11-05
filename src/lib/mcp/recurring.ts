// Templates of recurring schedules: the recurring cron copies what such a template bills into every
// period's invoice, and a schedule that creates drafts today may be switched to issue them
// automatically in Mado later, without the template being looked at again. So Claude never changes
// or deletes the template of any schedule, whatever its mode, active or paused. The database
// refuses it for every Claude session (MI045, 20261105_mcp_drafts.sql); the tools refuse first,
// with the schedule named.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecurringSchedule } from '@/types'

export type TemplateSchedule = Pick<RecurringSchedule, 'id' | 'name' | 'active' | 'source_document_id'>

// The schedules, of either mode, active or paused, that use one of these documents as their
// template.
export async function templateSchedules(supabase: SupabaseClient, documentIds: readonly string[]): Promise<TemplateSchedule[]> {
  if (!documentIds.length) return []
  const { data, error } = await supabase.from('recurring_schedules')
    .select('id, name, active, source_document_id')
    .in('source_document_id', [...documentIds])
  if (error) throw error
  return ((data ?? []) as TemplateSchedule[]).sort((a, b) => a.id.localeCompare(b.id))
}

// The schedules in 'issue' mode, active or paused, whose template bills this client. While a
// Claude session's change to the client is not saved by the owner in Mado (clients.mcp_written_at),
// they create the client's invoices as drafts (src/lib/utils/recurring.ts).
export async function issueSchedulesOfClient(supabase: SupabaseClient, clientId: string): Promise<TemplateSchedule[]> {
  const { data, error } = await supabase.from('recurring_schedules')
    .select('id, name, active, source_document_id')
    .eq('mode', 'issue')
  if (error) throw error
  const schedules = (data ?? []) as TemplateSchedule[]
  if (!schedules.length) return []
  const { data: templates, error: templatesErr } = await supabase.from('documents')
    .select('id')
    .in('id', schedules.map(s => s.source_document_id))
    .eq('client_id', clientId)
  if (templatesErr) throw templatesErr
  const ids = new Set(((templates ?? []) as { id: string }[]).map(d => d.id))
  return schedules.filter(s => ids.has(s.source_document_id)).sort((a, b) => a.id.localeCompare(b.id))
}

// The refusal as the database words it (errors.ts maps MI045), naming the schedule.
export function templateLocked(schedule: TemplateSchedule): Error {
  return Object.assign(new Error('MI045'), { code: 'MI045', details: schedule.id })
}

export async function refuseScheduleTemplate(supabase: SupabaseClient, documentId: string): Promise<void> {
  const [schedule] = await templateSchedules(supabase, [documentId])
  if (schedule) throw templateLocked(schedule)
}
