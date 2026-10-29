import { issueDocument } from '@/lib/pdf/issue'
import { NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuidList, issueFailure, readJsonObject, requireUser } from '@/lib/auth'
import { getT } from '@/lib/i18n/server'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { clientDisplayName, type NamedClient } from '@/lib/utils/clients'
import { formatDate } from '@/lib/utils/document'

// Issuing renders, stores and archives each draft's PDF in turn.
export const maxDuration = 60

// Only drafts can be issued in bulk; accepted/rejected/cancelled quotes are per-document decisions.
export async function PATCH(req: Request) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuidList(body.ids)) return apiError(400, 'invalid_request', 'ids required')
  if (body.status !== 'sent') return apiError(400, 'invalid_status', 'status "sent" required')
  const ids = body.ids

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select('id, number, date, clients(name, company)')
    .in('id', ids)
    .eq('type', 'quote')
    .eq('status', 'draft')
  if (lookupErr) return databaseError(lookupErr)
  const quotes = docs ?? []

  // Each quote gets the next number and 'sent' in one transaction, then its archive copy. The first
  // incomplete draft stops the run: 422 says which one and why (problems, see issue-checks.ts).
  let issued = 0
  for (const d of quotes) {
    try {
      await issueDocument(supabase, d.id)
      issued++
    } catch (err) {
      if (err instanceof IssueCheckError) {
        // The toast's title names the draft, so it is worded here in the UI language.
        const { t, lang } = await getT()
        // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
        const client = clientDisplayName(d.clients as unknown as NamedClient | null)
        const document = d.number ?? t('editor.bulk.draft', { client, date: formatDate(d.date, lang) })
        return apiError(422, 'incomplete', t('editor.bulk.incomplete', { document }), { problems: err.problems, documentId: d.id, issued })
      }
      return issueFailure(err, 'issue_failed', { issued })
    }
  }

  return NextResponse.json({ updated: quotes.length, skipped: ids.length - quotes.length })
}
