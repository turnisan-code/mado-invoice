import { createClient } from '@/lib/supabase/server'
import { issueDocument } from '@/lib/pdf/issue'
import { NextResponse } from 'next/server'
import { calcTotals, formatDate, today } from '@/lib/utils/document'
import { asDbError, canTransition, DOCUMENT_STATUSES, lifecycleErrorMessage } from '@/lib/status'
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { t, lang } = await getT()

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'ids and status required' }, { status: 400 })
  }
  const target = TARGETS.find(s => s === body.status)
  if (!target) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  const paidDate: unknown = body.paidDate ?? today()
  const method: unknown = body.method ?? 'bank'
  if (target === 'paid' && (!isPastIsoDate(paidDate) || (method !== 'bank' && method !== 'cash'))) {
    return NextResponse.json({ error: t('lifecycle.paymentDateInvalid') }, { status: 400 })
  }

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select(`id, number, status, date, tax_treatment, discount_type, discount_value, clients(name, company), ${ITEM_COLS}, payments(amount, kind)`)
    .in('id', body.ids)
    .eq('type', 'invoice')
    .in('status', sourcesFor(target))
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const invoices = docs ?? []

  // Drafts get a number assigned (sequentially) first, plus their archive copy; issuing also sets them to 'sent'.
  // The first incomplete draft stops the run: 422 says which one and why (problems, see issue-checks.ts).
  let issued = 0
  for (const d of invoices.filter(d => !d.number || d.status === 'draft')) {
    try {
      await issueDocument(supabase, d.id)
      issued++
      if (d.status === 'draft') d.status = 'sent'
    } catch (err) {
      if (err instanceof IssueCheckError) {
        // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
        const client = clientDisplayName(d.clients as unknown as NamedClient | null)
        const document = d.number ?? t('editor.bulk.draft', { client, date: formatDate(d.date, lang) })
        return NextResponse.json({ error: t('editor.bulk.incomplete', { document }), problems: err.problems, documentId: d.id, issued }, { status: 422 })
      }
      return NextResponse.json({ error: lifecycleErrorMessage(asDbError(err), t), issued }, { status: 500 })
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
      if (payErr) return NextResponse.json({ error: payErr.message }, { status: 500 })
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
    if (error) return NextResponse.json({ error: lifecycleErrorMessage(error, t) }, { status: 500 })
    const from = new Map(invoices.map(d => [d.id, d.status]))
    for (const { id } of updated ?? []) {
      await logEvent(supabase, id, 'status_changed', { from: from.get(id), to: 'paid' })
    }
  }

  return NextResponse.json({ updated: invoices.length, skipped: body.ids.length - invoices.length })
}

// Only drafts can be deleted; issued invoices must be kept and are skipped (documents_delete_guard
// rejects them in the database as well).
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.ids) || !body.ids.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  const { data: deleted, error } = await supabase
    .from('documents')
    .delete()
    .in('id', body.ids)
    .eq('type', 'invoice')
    .is('number', null)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const count = deleted?.length ?? 0
  return NextResponse.json({ deleted: count, skipped: body.ids.length - count })
}
