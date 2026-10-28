import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { asDbError, lifecycleErrorMessage } from '@/lib/status'
import { getT } from '@/lib/i18n/server'

export const maxDuration = 60

// Assigns the number, freezes the PDF and archives it to Drive. 200 whenever the number was
// assigned; archive problems come back as snapshotError / driveError for the caller to report.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    return NextResponse.json(await issueDocument(supabase, id))
  } catch (err) {
    const { t } = await getT()
    const dbError = asDbError(err)
    return NextResponse.json({ error: lifecycleErrorMessage(dbError, t), code: dbError.code }, { status: 400 })
  }
}
