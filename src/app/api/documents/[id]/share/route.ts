import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser, type AuthResult } from '@/lib/auth'
import { shareExpiry } from '@/lib/share'

type ShareRow = { share_token: string | null; share_expires_at: string | null; portal_viewed_at: string | null; number: string | null }

const SHARE_COLUMNS = 'share_token, share_expires_at, portal_viewed_at, number'

function shareState(row: ShareRow) {
  return { token: row.share_token, expiresAt: row.share_expires_at, viewedAt: row.portal_viewed_at }
}

const notFound = () => apiError(404, 'not_found', 'Not found')

async function authorize(id: string): Promise<AuthResult> {
  const auth = await requireUser()
  if (auth.ok && !isUuid(id)) return { ok: false, response: notFound() }
  return auth
}

async function loadShare(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from('documents').select(SHARE_COLUMNS).eq('id', id).maybeSingle()
  if (error) return { response: databaseError(error) }
  if (!data) return { response: notFound() }
  return { row: data as ShareRow }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(id)
  if (!auth.ok) return auth.response
  const loaded = await loadShare(auth.supabase, id)
  if ('response' in loaded) return loaded.response
  return NextResponse.json(shareState(loaded.row))
}

// Returns the active link, creating one (valid SHARE_LINK_DAYS) when there is none.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(id)
  if (!auth.ok) return auth.response
  const loaded = await loadShare(auth.supabase, id)
  if ('response' in loaded) return loaded.response
  const { row } = loaded
  if (!row.number) return apiError(400, 'not_issued', 'Only issued documents can be shared')
  if (row.share_token) return NextResponse.json(shareState(row))

  // Conditional, so two concurrent requests cannot hand out two different links.
  const { data, error } = await auth.supabase
    .from('documents')
    .update({ share_token: randomUUID(), share_expires_at: shareExpiry() })
    .eq('id', id)
    .is('share_token', null)
    .select(SHARE_COLUMNS)
  if (error) return databaseError(error)
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
  const auth = await authorize(id)
  if (!auth.ok) return auth.response
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const action = body.action
  if (action !== 'extend' && action !== 'rotate') return apiError(400, 'invalid_request', 'action must be extend or rotate')

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
  if (error) return databaseError(error)
  if (!data?.length) return apiError(404, 'no_share_link', 'No share link to change')
  return NextResponse.json(shareState(data[0] as ShareRow))
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(id)
  if (!auth.ok) return auth.response

  const { data: updated, error } = await auth.supabase
    .from('documents')
    .update({ share_token: null, share_expires_at: null, portal_viewed_at: null })
    .eq('id', id)
    .select('id')

  if (error) return databaseError(error)
  if (!updated?.length) return notFound()
  return NextResponse.json({ ok: true })
}
