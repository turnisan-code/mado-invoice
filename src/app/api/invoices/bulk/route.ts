import { NextResponse } from 'next/server'
import { issueBulkDraft, startBulkIssue, type BulkDraft } from '@/lib/pdf/bulk'
import { issueOrder, type IssuedNote } from '@/lib/utils/bulk-issue'
import { apiError, databaseError, invalidJson, isUuidList, issueFailure, readJsonObject, requireUser } from '@/lib/auth'
import { calcTotals, formatDate, today } from '@/lib/utils/document'
import { canTransition, DOCUMENT_STATUSES } from '@/lib/status'
import { IssueCheckError } from '@/lib/utils/issue-checks'
import { clientDisplayName, type NamedClient } from '@/lib/utils/clients'
import { logEvent } from '@/lib/events'
import { getT } from '@/lib/i18n/server'
import type { DocumentStatus } from '@/types'

// Issuing renders, stores and archives each draft's PDF in turn.
export const maxDuration = 60

// "Mark sent" issues drafts and nothing else (overdue → sent is the cron's correction, paid → sent
// only follows a removed payment). "Mark paid" issues drafts first, then takes every status the
// transition table lets move to paid. Cancelling an issued invoice needs a Storno (per-document
// flow), so it is not offered here.
const TARGETS: readonly DocumentStatus[] = ['sent', 'paid']
const sourcesFor = (target: DocumentStatus) => target === 'sent'
  ? ['draft']
  : ['draft', ...DOCUMENT_STATUSES.invoice.filter(s => s !== 'draft' && canTransition('invoice', s, target))]
const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

function isPastIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && value <= today()
}

export async function PATCH(req: Request) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuidList(body.ids) || typeof body.status !== 'string') {
    return apiError(400, 'invalid_request', 'ids and status required')
  }
  const ids = body.ids
  const target = TARGETS.find(s => s === body.status)
  if (!target) return apiError(400, 'invalid_status', 'Invalid status')
  // The lists move drafts dated before today to today (their confirm says so); the status menu
  // has asked about the date itself before it sends one draft here.
  const redate = body.redate === true
  const paidDate: unknown = body.paidDate ?? today()
  const method: unknown = body.method ?? 'bank'
  if (target === 'paid' && (!isPastIsoDate(paidDate) || (method !== 'bank' && method !== 'cash'))) {
    return apiError(400, 'payment_date_invalid', 'Invalid payment date or method')
  }

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select(`id, number, status, date, due_date, created_at, tax_treatment, discount_type, discount_value, clients(name, company, payment_days), ${ITEM_COLS}, payments(amount, kind)`)
    .in('id', ids)
    .eq('type', 'invoice')
    .in('status', sourcesFor(target))
  if (lookupErr) return databaseError(lookupErr)
  const invoices = docs ?? []

  // Drafts get the next number in date order, plus their archive copy; issuing also sets them to
  // 'sent'. Each one's archive, Drive and project-link problems come back in `documents`. The first
  // incomplete draft stops the run: 422 says which one and why (problems, see issue-checks.ts).
  const notes: IssuedNote[] = []
  const drafts = issueOrder(invoices.filter(d => !d.number || d.status === 'draft'))
  const started = drafts.length ? await startBulkIssue(supabase, 'invoice', redate, today()) : null
  if (started && 'error' in started) return databaseError(started.error)
  for (const d of drafts) {
    try {
      // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
      notes.push(await issueBulkDraft(supabase, started!.batch, d as unknown as BulkDraft))
      if (d.status === 'draft') d.status = 'sent'
    } catch (err) {
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
  }

  if (target === 'paid') {
    // "Paid" means money arrived: record the open balance as a payment on the date and by the
    // method the user confirmed (Ist-Besteuerung and the Bookamat account depend on both).
    // Exactly the open balance is recorded, so this can never overpay an invoice.
    const rows = invoices
      .map(d => ({
        document_id: d.id,
        date: paidDate as string,
        amount: calcTotals(
          d.document_items ?? [],
          d.payments ?? [],
          d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
          d.tax_treatment,
        ).balance_due,
        kind: 'payment' as const,
        method: method as 'bank' | 'cash',
        note: null,
      }))
      .filter(r => r.amount > 0)
    if (rows.length) {
      const { error: payErr } = await supabase.from('payments').insert(rows)
      if (payErr) return databaseError(payErr)
      for (const r of rows) {
        await logEvent(supabase, r.document_id, 'payment_added', { amount: r.amount, date: r.date, kind: r.kind, method: r.method })
      }
    }
    const { data: updated, error } = await supabase
      .from('documents')
      .update({ status: 'paid' })
      .in('id', invoices.map(d => d.id))
      .in('status', DOCUMENT_STATUSES.invoice.filter(s => canTransition('invoice', s, 'paid')))
      .select('id')
    if (error) return databaseError(error)
    const from = new Map(invoices.map(d => [d.id, d.status]))
    for (const { id } of updated ?? []) {
      await logEvent(supabase, id, 'status_changed', { from: from.get(id), to: 'paid' })
    }
  }

  return NextResponse.json({ updated: invoices.length, skipped: ids.length - invoices.length, documents: notes })
}

// Only drafts can be deleted; issued invoices must be kept and are skipped (documents_delete_guard
// rejects them in the database as well).
export async function DELETE(req: Request) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuidList(body.ids)) return apiError(400, 'invalid_request', 'ids required')
  const ids = body.ids

  const { data: deleted, error } = await auth.supabase
    .from('documents')
    .delete()
    .in('id', ids)
    .eq('type', 'invoice')
    .is('number', null)
    .select('id')
  if (error) return databaseError(error)

  const count = deleted?.length ?? 0
  return NextResponse.json({ deleted: count, skipped: ids.length - count })
}
