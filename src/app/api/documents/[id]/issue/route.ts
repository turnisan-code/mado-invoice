import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'

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
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Issuing failed' }, { status: 400 })
  }
}
