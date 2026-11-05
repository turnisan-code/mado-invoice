import { NextRequest, NextResponse } from 'next/server'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { apiError, isUuid, requireUser } from '@/lib/auth'
import { asDbError } from '@/lib/status'
import { issueDocument } from '@/lib/pdf/issue'
import type { LifecycleErrorCode } from '@/types'

export const maxDuration = 60

// Assigns the number, freezes the PDF and archives it to Drive. 200 whenever the number was
// assigned; archive problems come back as snapshotError / driveError for the caller to report.
// 422 = the document is incomplete: `problems` lists why (see issue-checks.ts). 400 = issue_document
// refused: `code` (MI001–MI004) and `details` say why.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  try {
    const outcome = await issueDocument(auth.supabase, id).catch((err: unknown) => {
      if (err instanceof IssueCheckError) return err
      throw err
    })
    if (outcome instanceof IssueCheckError) return apiError(422, 'incomplete', outcome.message, { problems: outcome.problems })
    return NextResponse.json(outcome)
  } catch (err) {
    const { code, message, details } = asDbError(err)
    console.error('[documents/issue]', code, message)
    return apiError(400, code && /^MI0\d\d$/.test(code) ? code as LifecycleErrorCode : 'issue_failed', message, { details })
  }
}
