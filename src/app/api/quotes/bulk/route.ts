import { NextResponse } from 'next/server'
import type { BulkDraft } from '@/lib/pdf/bulk'
import { issueMany, startIssueBatches } from '@/lib/services/issue'
import { apiError, databaseError, invalidJson, isUuidList, issueFailure, readJsonObject, requireUser } from '@/lib/auth'
import { getT } from '@/lib/i18n/server'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { clientDisplayName, type NamedClient } from '@/lib/utils/clients'
import { formatDate, today } from '@/lib/utils/document'

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
  // The list moves drafts dated before today to today; its confirm says so.
  const redate = body.redate === true

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select('id, number, date, due_date, created_at, clients(name, company, payment_days)')
    .in('id', ids)
    .eq('type', 'quote')
    .eq('status', 'draft')
  if (lookupErr) return databaseError(lookupErr)
  const quotes = docs ?? []

  // Each quote gets the next number (in date order) and 'sent' in one transaction, then its archive
  // copy; archive and Drive problems come back in `documents`. The first incomplete draft stops the
  // run: 422 says which one and why (problems, see issue-checks.ts).
  const drafts = quotes.map(d => ({ ...d, type: 'quote' as const }))
  const started = drafts.length ? await startIssueBatches(supabase, ['quote'], redate, today()) : null
  if (started && 'error' in started) return databaseError(started.error)
  // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
  const { notes, failed } = started ? await issueMany(supabase, started.batches, drafts as unknown as (BulkDraft & typeof drafts[number])[]) : { notes: [], failed: null }
  if (failed) {
    const { draft: d, error: err } = failed
    const issued = notes.length
    if (err instanceof IssueCheckError) {
      // The toast's title names the draft, so it is worded here in the UI language.
      const { t, lang } = await getT()
      const client = clientDisplayName(d.clients as unknown as NamedClient | null)
      const document = d.number ?? t('editor.bulk.draft', { client, date: formatDate(d.date, lang) })
      return apiError(422, 'incomplete', t('editor.bulk.incomplete', { document }), { problems: err.problems, documentId: d.id, issued, documents: notes })
    }
    return issueFailure(err, 'issue_failed', { issued, documents: notes })
  }

  return NextResponse.json({ updated: quotes.length, skipped: ids.length - quotes.length, documents: notes })
}
