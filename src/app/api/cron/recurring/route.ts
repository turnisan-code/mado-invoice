import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { authorizeCron } from '@/lib/utils/cron'
import { generateDueSchedules } from '@/lib/utils/recurring'
import { today } from '@/lib/utils/document'
import { issueDocument } from '@/lib/pdf/issue'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req)
  if (denied) return denied

  const result = await generateDueSchedules(createServiceClient(), today(), { issue: issueDocument })

  const counts = `generated=${result.generated.length} skipped=${result.skipped.length}`
  if (result.errors.length) console.error(`[cron/recurring] ${counts} errors=${result.errors.length}`, result.errors)
  else console.log(`[cron/recurring] ${counts}`)
  // Periods not generated because invoices of their schedule already cover part of them (an edited
  // schedule, or a generated invoice whose service period was moved into the next period); the
  // days left uncovered are recorded on the schedule, and the schedule list and list_recurring
  // show them until an invoice covers them or the owner dismisses them.
  const overlaps = result.skipped.filter(s => s.skipped === 'overlaps')
  if (overlaps.length) console.warn(`[cron/recurring] overlapping periods skipped=${overlaps.length}`, overlaps)
  return NextResponse.json(result)
}
