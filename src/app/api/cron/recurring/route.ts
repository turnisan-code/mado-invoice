import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { authorizeCron } from '@/lib/utils/cron'
import { generateDueSchedules } from '@/lib/utils/recurring'
import { today } from '@/lib/utils/document'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req)
  if (denied) return denied

  const result = await generateDueSchedules(createServiceClient(), today())

  if (result.errors.length) console.error(`[cron/recurring] generated=${result.generated.length} errors=${result.errors.length}`, result.errors)
  else console.log(`[cron/recurring] generated=${result.generated.length}`)
  return NextResponse.json(result)
}
