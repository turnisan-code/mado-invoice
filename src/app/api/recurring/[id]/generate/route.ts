import { NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser } from '@/lib/auth'
import { generateDueSchedules } from '@/lib/utils/recurring'
import { formatDate, today } from '@/lib/utils/document'
import { issueDocument } from '@/lib/pdf/issue'
import { getT } from '@/lib/i18n/server'
import { asDbError, lifecycleErrorMessage } from '@/lib/status'
import { IssueCheckError, issueProblemMessage } from '@/lib/utils/issue-checks'

export const maxDuration = 60

// "Generate now": creates the schedule's upcoming invoice before its date (plus any missed
// periods) and answers with the newest document id. A `warning` (worded in the UI language) says
// what went wrong after an invoice was created.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Schedule not found')

  const { data: schedule, error: lookupErr } = await supabase.from('recurring_schedules').select('id, active').eq('id', id).maybeSingle()
  if (lookupErr) return databaseError(lookupErr)
  if (!schedule) return apiError(404, 'not_found', 'Schedule not found')
  if (!schedule.active) return apiError(409, 'inactive', 'Schedule is paused or ended')

  const { t, lang } = await getT()
  const { generated, errors } = await generateDueSchedules(supabase, today(), {
    scheduleId: id, force: true, issue: issueDocument, t, formatDate: date => formatDate(date, lang),
    describeError: err => {
      if (err instanceof IssueCheckError) return err.problems.map(p => issueProblemMessage(p, t)).join(' ')
      console.error('[recurring/generate] issue failed:', err)
      return lifecycleErrorMessage(asDbError(err), t)
    },
  })
  if (!generated.length) {
    // The template was cancelled (Storno) in the meantime; the generator has just paused the schedule.
    if (errors.some(e => e.code === 'template_cancelled')) return apiError(409, 'template_cancelled', 'Template invoice is cancelled')
    if (errors.length) {
      console.error('[recurring/generate]', errors)
      return apiError(500, 'generate_failed', errors.map(e => e.message).join('; '))
    }
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
