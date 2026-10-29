import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { NextResponse } from 'next/server'
import { asDbError, lifecycleErrorMessage } from '@/lib/status'
import { getT } from '@/lib/i18n/server'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { clientDisplayName, type NamedClient } from '@/lib/utils/clients'
import { formatDate } from '@/lib/utils/document'

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
    .select('id, number, date, clients(name, company)')
    .in('id', body.ids)
    .eq('type', 'quote')
    .eq('status', 'draft')
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const quotes = docs ?? []

  // Each quote gets the next number and 'sent' in one transaction, then its archive copy. The first
  // incomplete draft stops the run: 422 says which one and why (problems, see issue-checks.ts).
  let issued = 0
  for (const d of quotes) {
    try {
      await issueDocument(supabase, d.id)
      issued++
    } catch (err) {
      const { t, lang } = await getT()
      if (err instanceof IssueCheckError) {
        // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
        const client = clientDisplayName(d.clients as unknown as NamedClient | null)
        const document = d.number ?? t('editor.bulk.draft', { client, date: formatDate(d.date, lang) })
        return NextResponse.json({ error: t('editor.bulk.incomplete', { document }), problems: err.problems, documentId: d.id, issued }, { status: 422 })
      }
      return NextResponse.json({ error: lifecycleErrorMessage(asDbError(err), t), issued }, { status: 500 })
    }
  }

  return NextResponse.json({ updated: quotes.length, skipped: body.ids.length - quotes.length })
}
