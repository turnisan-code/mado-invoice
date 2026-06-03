import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { action } = await req.json()

  if (action !== 'accepted' && action !== 'rejected') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: doc } = await supabase
    .from('documents')
    .select('id, type, status')
    .eq('share_token', token)
    .single()

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (doc.type !== 'quote') return NextResponse.json({ error: 'Not a quote' }, { status: 400 })
  if (doc.status !== 'sent') return NextResponse.json({ error: 'Quote is not in sent status' }, { status: 400 })

  const { error } = await supabase
    .from('documents')
    .update({ status: action })
    .eq('id', doc.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, status: action })
}
