import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Only drafts can be issued in bulk; accepted/rejected/cancelled quotes are per-document decisions.
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length || body.status !== 'sent') {
    return NextResponse.json({ error: 'ids and status "sent" required' }, { status: 400 })
  }

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select('id')
    .in('id', body.ids)
    .eq('type', 'quote')
    .eq('status', 'draft')
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const quotes = docs ?? []

  // issue_document assigns the next quote number and sets 'sent' in one transaction per quote.
  for (const d of quotes) {
    const { error: issueErr } = await supabase.rpc('issue_document', { p_document_id: d.id })
    if (issueErr) return NextResponse.json({ error: issueErr.message }, { status: 500 })
  }

  return NextResponse.json({ updated: quotes.length, skipped: body.ids.length - quotes.length })
}
