// Status changes and deletes, shared by the pages, the API routes and the Claude connector. Each
// takes the caller's Supabase client (browser, cookie session or a Claude grant's session), so RLS
// and the database guards decide exactly as before; nothing here reads cookies or a UI language.
// Failures come back as PostgrestError (a refusal decided here carries the database's own code).
import { PostgrestError, type SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/events'
import { canTransition } from '@/lib/status'
import type { DocumentStatus, DocumentType } from '@/types'

const refusal = (code: string, message: string, details = '') => new PostgrestError({ code, message, details, hint: '' })

// A status step other than issuing, a Storno or a payment, with its 'status_changed' event.
// documents_status_guard has the last word (MI010–MI014); a step canTransition already rules out
// is refused here with the guard's MI010. `current` is the state the caller shows (the status
// menu); without it the document is read first.
export async function setDocumentStatus(
  supabase: SupabaseClient,
  id: string,
  to: DocumentStatus,
  current?: { type: DocumentType; status: DocumentStatus },
): Promise<{ error: PostgrestError | null; from: DocumentStatus | null; changed: boolean }> {
  let doc = current
  if (!doc) {
    const { data, error } = await supabase.from('documents').select('type, status').eq('id', id).maybeSingle()
    if (error) return { error, from: null, changed: false }
    if (!data) return { error: refusal('not_found', 'Document not found'), from: null, changed: false }
    doc = data as { type: DocumentType; status: DocumentStatus }
  }
  const from = doc.status
  if (to === from) return { error: null, from, changed: false }
  if (!canTransition(doc.type, from, to)) {
    return { error: refusal('MI010', `A ${doc.type.replace('_', ' ')} cannot change from ${from} to ${to}.`, `${from}>${to}`), from, changed: false }
  }
  const { error } = await supabase.from('documents').update({ status: to }).eq('id', id)
  if (error) return { error, from, changed: false }
  await logEvent(supabase, id, 'status_changed', { from, to })
  return { error: null, from, changed: true }
}

// Only unnumbered documents match, and documents_delete_guard (MI015) refuses a numbered one
// anyway, so a stale page cannot delete what another tab issued. The database takes the lines,
// payments, history, reminders and a recurring schedule it is the template of with it, and frees
// its project entries and deducted invoices. `deleted` is false when nothing matched.
export async function deleteDraft(supabase: SupabaseClient, id: string): Promise<{ deleted: boolean; error: PostgrestError | null }> {
  const { data, error } = await supabase.from('documents').delete().eq('id', id).is('number', null).select('id')
  return { deleted: !error && !!data?.length, error }
}

// The bulk form: the ids that were drafts (of `type`, when given) and are gone now.
export async function deleteDrafts(
  supabase: SupabaseClient,
  ids: string[],
  type?: DocumentType,
): Promise<{ deleted: string[]; error: PostgrestError | null }> {
  let query = supabase.from('documents').delete().in('id', ids)
  if (type) query = query.eq('type', type)
  const { data, error } = await query.is('number', null).select('id')
  return { deleted: error ? [] : (data ?? []).map(row => row.id as string), error }
}

// Postgres foreign_key_violation: documents.client_id and projects.client_id are "on delete restrict".
const FK_VIOLATION = '23503'

// A client with documents or projects stays (set it to inactive instead); `inUse` says which
// table still refers to it, as the violated constraint names it.
export async function deleteClient(
  supabase: SupabaseClient,
  id: string,
): Promise<{ error: PostgrestError | null; inUse: 'documents' | 'projects' | null }> {
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error?.code !== FK_VIOLATION) return { error, inUse: null }
  return { error, inUse: /"projects"/.test(`${error.message} ${error.details ?? ''}`) ? 'projects' : 'documents' }
}

// projects_delete_guard keeps a project with billed entries (MI033, `billed`): it is archived
// instead. Its unbilled time entries and expenses go with it.
export async function deleteProject(supabase: SupabaseClient, id: string): Promise<{ error: PostgrestError | null; billed: boolean }> {
  const { error } = await supabase.from('projects').delete().eq('id', id)
  return { error, billed: error?.code === 'MI033' }
}
