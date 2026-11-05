import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { NextResponse } from 'next/server'
import { asDbError, lifecycleErrorMessage } from '@/lib/status'
import { getT } from '@/lib/i18n/server'

// Issuing renders, stores and archives each draft's PDF in turn.
export const maxDuration = 60

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

  // Each quote gets the next number and 'sent' in one transaction, then its archive copy.
  for (const d of quotes) {
    try { await issueDocument(supabase, d.id) } catch (err) {
      const { t } = await getT()
      return NextResponse.json({ error: lifecycleErrorMessage(asDbError(err), t) }, { status: 500 })
    }
  }

  return NextResponse.json({ updated: quotes.length, skipped: body.ids.length - quotes.length })
}
