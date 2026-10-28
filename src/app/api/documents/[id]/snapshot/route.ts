import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getIssuedPdf, NotIssuedError } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError } from '@/lib/pdf/render'

export const maxDuration = 60

// Manual "Create archive copy" for a document issued before archive copies existed: renders
// it server-side from the stored data. An existing copy is kept as it is.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { path, created } = await getIssuedPdf(supabase, id, 'manual')
    return NextResponse.json({ path, created })
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof NotIssuedError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[documents/snapshot]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Archive copy failed' }, { status: 500 })
  }
}
