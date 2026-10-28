import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getIssuedPdf, NotIssuedError } from '@/lib/pdf/snapshot'
import { DocumentNotFoundError } from '@/lib/pdf/render'

export const maxDuration = 60

// Every outgoing copy of a numbered document (download, email, Drive, Bookamat, reminders) is
// this stored PDF. A document issued before archive copies existed gets one on first request.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { buffer, filename } = await getIssuedPdf(supabase, id, 'on_demand')
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DocumentNotFoundError || err instanceof NotIssuedError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    console.error('[documents/pdf]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF unavailable' }, { status: 500 })
  }
}
