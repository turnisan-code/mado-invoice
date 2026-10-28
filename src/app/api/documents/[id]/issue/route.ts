import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { numberingErrorMessage } from '@/lib/utils/numbering'
import { getT } from '@/lib/i18n/server'

export const maxDuration = 60

// Assigns the number, freezes the PDF and archives it to Drive. 200 whenever the number was
// assigned; archive problems come back as snapshotError / driveError for the caller to report.
// 422 = the document is incomplete: `problems` lists why (see issue-checks.ts), `error` says it
// in the UI language. Numbering failures carry the SQL error code (MI001–MI003).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    return NextResponse.json(await issueDocument(supabase, id))
  } catch (err) {
    if (err instanceof IssueCheckError) {
      return NextResponse.json({ error: err.message, problems: err.problems }, { status: 422 })
    }
    const e = err as { message?: string; code?: string; details?: string }
    const { t } = await getT()
    return NextResponse.json(
      { error: numberingErrorMessage({ code: e.code, message: e.message || 'Issuing failed', details: e.details }, t), code: e.code ?? null, details: e.details ?? null },
      { status: 400 },
    )
  }
}
