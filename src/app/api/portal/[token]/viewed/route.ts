import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { apiError, databaseError } from '@/lib/auth'
import { logEvent } from '@/lib/events'
import { isShareExpired } from '@/lib/share'

const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000

// Called by the portal page once it has rendered in a browser (link previews and mail scanners
// that do not run scripts never count). The first view sets portal_viewed_at; later views are
// logged at most once a day. The owner opening their own link is not a client view.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (user) return NextResponse.json({ ok: true, counted: false })

  const supabase = createServiceClient()
  const { data: doc } = await supabase
    .from('documents')
    .select('id, number, share_expires_at')
    .eq('share_token', token)
    .maybeSingle()
  if (!doc?.number || isShareExpired(doc.share_expires_at)) return apiError(404, 'not_found', 'Not found')

  const { data: first, error } = await supabase
    .from('documents')
    .update({ portal_viewed_at: new Date().toISOString() })
    .eq('id', doc.id)
    .is('portal_viewed_at', null)
    .select('id')
  if (error) return databaseError(error)
  if (first?.length) {
    await logEvent(supabase, doc.id, 'portal_viewed', { first: true })
    return NextResponse.json({ ok: true, counted: true })
  }

  const { data: last } = await supabase
    .from('document_events')
    .select('created_at')
    .eq('document_id', doc.id)
    .eq('type', 'portal_viewed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (last && Date.now() - new Date(last.created_at).getTime() < REPEAT_AFTER_MS) return NextResponse.json({ ok: true, counted: false })
  await logEvent(supabase, doc.id, 'portal_viewed')
  return NextResponse.json({ ok: true, counted: true })
}
