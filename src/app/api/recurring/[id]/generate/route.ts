import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateDueSchedules } from '@/lib/utils/recurring'
import { today } from '@/lib/utils/document'

export const maxDuration = 60

// "Generate now": creates the schedule's upcoming invoice before its date (plus any missed
// periods) and answers with the newest document id.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: schedule } = await supabase.from('recurring_schedules').select('id, active').eq('id', id).single()
  if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
  if (!schedule.active) return NextResponse.json({ error: 'Schedule is paused or ended', code: 'inactive' }, { status: 409 })

  const { generated, errors } = await generateDueSchedules(supabase, today(), { scheduleId: id, force: true })
  if (!generated.length) {
    // The template was cancelled (Storno) in the meantime; the generator has just paused the schedule.
    if (errors.some(e => e.code === 'template_cancelled')) return NextResponse.json({ error: 'Template invoice is cancelled', code: 'template_cancelled' }, { status: 409 })
    if (errors.length) return NextResponse.json({ error: errors.map(e => e.message).join('; ') }, { status: 500 })
    return NextResponse.json({ documentId: null, generated: 0 })
  }
  const newest = generated[generated.length - 1]
  return NextResponse.json({
    documentId: newest.documentId,
    date: newest.date,
    generated: generated.length,
    ...(errors.length ? { warning: errors.map(e => e.message).join('; ') } : {}),
  })
}
