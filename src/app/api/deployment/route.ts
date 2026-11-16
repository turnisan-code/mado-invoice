import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { bookamatWritesAllowed, deploymentCommit, deploymentEnv } from '@/lib/deployment'

// Which build answers and whether it books in Bookamat: checked first on every preview check.
export async function GET() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  return NextResponse.json({ env: deploymentEnv(), bookamat_writes_allowed: bookamatWritesAllowed(), commit: deploymentCommit() })
}
