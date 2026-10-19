import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { randomUUID } from 'crypto'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: existing } = await supabase
    .from('documents')
    .select('share_token, number')
    .eq('id', id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!existing.number) return NextResponse.json({ error: 'Only issued documents can be shared' }, { status: 400 })

  const token = existing.share_token ?? randomUUID()

  if (!existing.share_token) {
    const { error } = await supabase
      .from('documents')
      .update({ share_token: token })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ token })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: updated, error } = await supabase
    .from('documents')
    .update({ share_token: null })
    .eq('id', id)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
