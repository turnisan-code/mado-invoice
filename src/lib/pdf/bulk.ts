import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays } from '@/lib/utils/document'
import { unlinkedEntries } from '@/lib/utils/issue-checks'
import { beforeLatest, movesToToday, type IssuedNote, type LatestIssued } from '@/lib/utils/bulk-issue'
import { termDays } from '@/components/forms/builder/model'
import type { DocumentType } from '@/types'
import { issueDocument, type IssueOutcome } from './issue'

export type BulkDraft = { id: string; date: string; due_date: string | null; clients: { payment_days: number | null } | null }

type DbError = { message: string; code?: string; details?: string | null }

export interface BulkIssue {
  type: DocumentType
  today: string
  // Drafts dated before today are issued with today's date.
  redate: boolean
  // Grows with the batch: each issued draft may become the newest.
  latest: LatestIssued | null
  terms: { default_payment_days: number; default_quote_validity_days: number }
}

// What every draft of one batch is compared with: the newest issued document of its type, and the
// payment and validity defaults a draft moved to today takes its new due date from.
export async function startBulkIssue(supabase: SupabaseClient, type: DocumentType, redate: boolean, today: string): Promise<{ batch: BulkIssue } | { error: DbError }> {
  const [latest, settings] = await Promise.all([
    supabase.from('documents').select('number, date').eq('type', type).not('number', 'is', null)
      .order('date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('settings').select('default_payment_days, default_quote_validity_days').maybeSingle(),
  ])
  if (latest.error) return { error: latest.error }
  if (settings.error) return { error: settings.error }
  return {
    batch: {
      type,
      today,
      redate,
      latest: latest.data?.number ? { number: latest.data.number, date: latest.data.date } : null,
      terms: {
        default_payment_days: settings.data?.default_payment_days ?? 14,
        default_quote_validity_days: settings.data?.default_quote_validity_days ?? 14,
      },
    },
  }
}

// Time entries and expenses billed on the invoice that no longer sit on one of its lines (as the
// issue dialog's ProjectLinkWarning checks). A failed check reports nothing.
async function lostEntries(supabase: SupabaseClient, documentId: string): Promise<IssuedNote['unlinked']> {
  const billed = (table: 'time_entries' | 'project_expenses') => supabase.from(table).select('document_item_id').eq('invoiced_document_id', documentId)
  const [time, expenses, items] = await Promise.all([
    billed('time_entries'),
    billed('project_expenses'),
    supabase.from('document_items').select('id').eq('document_id', documentId),
  ])
  const failed = time.error ?? expenses.error ?? items.error
  if (failed) {
    console.error(`[bulk] project links of ${documentId} not checked:`, failed.message)
    return null
  }
  const lineIds = (items.data ?? []).map(i => i.id as string)
  const lost = { time: unlinkedEntries(time.data ?? [], lineIds).length, expenses: unlinkedEntries(expenses.data ?? [], lineIds).length }
  return lost.time + lost.expenses > 0 ? lost : null
}

// One draft of the batch: moved to today first when the batch says so (the due date follows the
// client's terms from today, a credit note keeps its own), then issued (number, archive copy,
// Drive). A failed issue puts the draft's own dates back and throws as issueDocument does; archive
// and Drive problems, an order the numbers no longer follow and lost project links come back as notes.
export async function issueBulkDraft(supabase: SupabaseClient, batch: BulkIssue, d: BulkDraft): Promise<IssuedNote> {
  let date = d.date
  let movedFrom: string | null = null
  let dateKept = false
  if (batch.redate && movesToToday(d.date, batch.today)) {
    const dueDate = batch.type === 'credit_note' ? {} : { due_date: addDays(batch.today, termDays(batch.type, batch.terms, d.clients)) }
    const { error } = await supabase.from('documents').update({ date: batch.today, ...dueDate }).eq('id', d.id).is('number', null)
    // documents_recurring_period_key: a schedule has one invoice per date.
    if (error?.code === '23505') dateKept = true
    else if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details })
    else {
      movedFrom = d.date
      date = batch.today
    }
  }

  let outcome: IssueOutcome
  try {
    outcome = await issueDocument(supabase, d.id)
  } catch (err) {
    if (movedFrom) {
      const { error } = await supabase.from('documents').update({ date: movedFrom, due_date: d.due_date }).eq('id', d.id).is('number', null)
      if (error) console.error(`[bulk] dates of ${d.id} not restored:`, error.message)
    }
    throw err
  }

  const earlier = beforeLatest(date, batch.latest) ? batch.latest : null
  if (!batch.latest || date >= batch.latest.date) batch.latest = { number: outcome.number, date }
  return {
    id: d.id,
    number: outcome.number,
    movedFrom,
    dateKept,
    beforeLatest: earlier,
    snapshotFailed: !!outcome.snapshotError,
    driveError: outcome.driveError,
    unlinked: batch.type === 'invoice' ? await lostEntries(supabase, d.id) : null,
  }
}
