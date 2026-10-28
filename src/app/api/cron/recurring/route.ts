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
  return NextResponse.json(result)
}
