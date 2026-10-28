import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { randomUUID } from 'crypto'
import { shareExpiry } from '@/lib/share'

type Supabase = Awaited<ReturnType<typeof createClient>>
type ShareRow = { share_token: string | null; share_expires_at: string | null; portal_viewed_at: string | null; number: string | null }

const SHARE_COLUMNS = 'share_token, share_expires_at, portal_viewed_at, number'

function shareState(row: ShareRow) {
  return { token: row.share_token, expiresAt: row.share_expires_at, viewedAt: row.portal_viewed_at }
}

async function authorize(): Promise<{ supabase: Supabase } | { response: NextResponse }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { supabase }
}

async function loadShare(supabase: Supabase, id: string) {
  const { data, error } = await supabase.from('documents').select(SHARE_COLUMNS).eq('id', id).maybeSingle()
  if (error) return { response: NextResponse.json({ error: error.message }, { status: 500 }) }
  if (!data) return { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { row: data as ShareRow }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize()
  if ('response' in auth) return auth.response
  const loaded = await loadShare(auth.supabase, id)
  if ('response' in loaded) return loaded.response
  return NextResponse.json(shareState(loaded.row))
}

// Returns the active link, creating one (valid SHARE_LINK_DAYS) when there is none.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize()
  if ('response' in auth) return auth.response
  const loaded = await loadShare(auth.supabase, id)
  if ('response' in loaded) return loaded.response
  const { row } = loaded
  if (!row.number) return NextResponse.json({ error: 'Only issued documents can be shared' }, { status: 400 })
  if (row.share_token) return NextResponse.json(shareState(row))

  // Conditional, so two concurrent requests cannot hand out two different links.
  const { data, error } = await auth.supabase
    .from('documents')
    .update({ share_token: randomUUID(), share_expires_at: shareExpiry() })
    .eq('id', id)
    .is('share_token', null)
    .select(SHARE_COLUMNS)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (data?.length) return NextResponse.json(shareState(data[0] as ShareRow))
  const current = await loadShare(auth.supabase, id)
  if ('response' in current) return current.response
  return NextResponse.json(shareState(current.row))
}

// { action: 'extend' } keeps the link working SHARE_LINK_DAYS from now; { action: 'rotate' }
// replaces it with a new one, so the old link stops working immediately. portal_viewed_at tracks
// the current link, so a new or revoked link starts unopened; document_events keeps every view.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => null) as { action?: unknown } | null
  const action = body?.action
  if (action !== 'extend' && action !== 'rotate') return NextResponse.json({ error: 'action must be extend or rotate' }, { status: 400 })

  const auth = await authorize()
  if ('response' in auth) return auth.response
  const update = action === 'rotate'
    ? { share_token: randomUUID(), share_expires_at: shareExpiry(), portal_viewed_at: null }
    : { share_expires_at: shareExpiry() }
  const { data, error } = await auth.supabase
    .from('documents')
    .update(update)
    .eq('id', id)
    .not('share_token', 'is', null)
    .not('number', 'is', null)
    .select(SHARE_COLUMNS)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'No share link to change' }, { status: 404 })
  return NextResponse.json(shareState(data[0] as ShareRow))
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize()
  if ('response' in auth) return auth.response

  const { data: updated, error } = await auth.supabase
    .from('documents')
    .update({ share_token: null, share_expires_at: null, portal_viewed_at: null })
    .eq('id', id)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
