import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let body: { action?: unknown } | null
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const action = body?.action
  if (action !== 'accepted' && action !== 'rejected') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from('documents')
    .select('id, type')
    .eq('share_token', token)
    .single()

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (doc.type !== 'quote') return NextResponse.json({ error: 'Not a quote' }, { status: 400 })

  const { data: updated, error } = await supabase
    .from('documents')
    .update({ status: action })
    .eq('id', doc.id)
    .eq('status', 'sent')
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'Quote is not in sent status' }, { status: 409 })

  return NextResponse.json({ ok: true, status: action })
}
