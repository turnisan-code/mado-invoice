// Writing drafts: the editor's save path (autosave, Save draft, issuing, the flush on leaving),
// copying a document and changing what a final invoice deducts. Shared by the editor, the
// duplicate button and the Claude connector. Browser-safe (supabase-js and the editor's pure model).
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { docFields, itemsPayload, termDays, clientTerms, type FormState } from '@/components/forms/builder/model'
import { linkDeposit, unlinkDeposit, writeDeductions } from '@/lib/deposits'
import { addDays, today } from '@/lib/utils/document'
import type { Client, DocumentType, Settings } from '@/types'

export type DraftSaveMode = 'auto' | 'save' | 'issue'

export type DraftFields = ReturnType<typeof docFields>
export type DraftItems = ReturnType<typeof itemsPayload>

// What a save of `f` writes. An empty date falls back to today; issuing fills an empty due date
// from the client's terms. An autosave never writes an empty date over the stored one
// (`keepStoredDate`): the field is empty from clearing it until a new date is complete.
export function draftPayload(
  type: DocumentType,
  f: FormState,
  { mode, settings, client }: { mode: DraftSaveMode; settings: Pick<Settings, 'default_quote_validity_days' | 'default_payment_days'>; client?: Pick<Client, 'payment_days'> | null },
): { effective: FormState; fields: DraftFields; items: DraftItems; keepStoredDate: boolean } {
  const effectiveDate = f.date || today()
  const effective: FormState = {
    ...f,
    date: effectiveDate,
    dueDate: f.dueDate || (mode === 'issue' && client ? addDays(effectiveDate, termDays(type, settings, client)) : ''),
  }
  return { effective, fields: docFields(type, effective), items: itemsPayload(effective.lines), keepStoredDate: mode === 'auto' && !f.date }
}

export interface DraftWrite {
  // null: a new draft is inserted.
  id: string | null
  type: DocumentType
  fields: DraftFields
  items: DraftItems
  keepStoredDate?: boolean
}

export type SaveDraftError =
  // One invoice per period date of a recurring schedule: another one has this date. `stored` is
  // the date and due date the document keeps.
  | { kind: 'recurring_period'; error: PostgrestError; stored: { date: string | null; due_date: string | null } | null }
  | { kind: 'database'; error: PostgrestError }
  // draftOnly: the document has a number or is no draft (or is gone); nothing was written.
  | { kind: 'draft_only' }

export interface SavedDraft {
  // Set once the header is written (an inserted draft's new id), even when the items failed.
  id: string | null
  inserted: boolean
  error: SaveDraftError | null
}

// Header, then items: a new document is inserted as an unnumbered EUR draft once, an existing one
// updated; replace_document_items keeps every line under the id it carries, so what is billed on a
// line stays linked to it. `onHeaderSaved` runs as soon as the header is written, before the items.
// `draftOnly` refuses a document that has a number or is not a draft any more (neither the update
// nor replace_document_items checks that on their own).
export async function saveDraft(
  supabase: SupabaseClient,
  { id, type, fields, items, keepStoredDate = false }: DraftWrite,
  opts: { draftOnly?: boolean; onHeaderSaved?: (id: string, inserted: boolean) => void } = {},
): Promise<SavedDraft> {
  const inserted = !id
  if (id) {
    const update: Partial<DraftFields> = { ...fields }
    if (keepStoredDate) delete update.date
    const query = supabase.from('documents').update(update).eq('id', id)
    const { data, error } = opts.draftOnly ? await query.is('number', null).eq('status', 'draft').select('id') : await query
    if (error) {
      if (error.code === '23505' && /recurring_period/.test(`${error.message} ${error.details ?? ''}`)) {
        const { data: stored } = await supabase.from('documents').select('date, due_date').eq('id', id).maybeSingle()
        return { id, inserted: false, error: { kind: 'recurring_period', error, stored: stored ?? null } }
      }
      return { id, inserted: false, error: { kind: 'database', error } }
    }
    if (opts.draftOnly && !(data as unknown[] | null)?.length) return { id, inserted: false, error: { kind: 'draft_only' } }
    opts.onHeaderSaved?.(id, false)
  } else {
    const { data, error } = await supabase.from('documents')
      .insert({ type, number: null, status: 'draft', exchange_rate: 1, ...fields })
      .select('id').single()
    if (error) return { id: null, inserted: false, error: { kind: 'database', error } }
    id = data.id as string
    opts.onHeaderSaved?.(id, true)
  }
  const { error: itemsErr } = await supabase.rpc('replace_document_items', { p_document_id: id, p_items: items })
  return { id, inserted, error: itemsErr ? { kind: 'database', error: itemsErr } : null }
}

export type DuplicateResult =
  | { id: string; type: DocumentType; error: null }
  | { id: null; type: null; error: { stage: 'load' | 'copy'; cause: PostgrestError | null } }

// A copy is a new document: dated today, due and with Skonto as the client's terms say, EUR, its
// lines with new ids but without a final invoice's deduction lines. A copy that could not get its
// lines is removed again.
export async function duplicateDocument(supabase: SupabaseClient, id: string): Promise<DuplicateResult> {
  const [{ data: doc, error }, { data: settings, error: settingsErr }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), clients(payment_days, skonto_percent, skonto_days)').eq('id', id).single(),
    supabase.from('settings').select('default_payment_days, default_quote_validity_days, default_skonto_percent, default_skonto_days').maybeSingle(),
  ])
  if (error || !doc || settingsErr || !settings) return { id: null, type: null, error: { stage: 'load', cause: error ?? settingsErr ?? null } }

  const date = today()
  const type = doc.type as DocumentType
  const terms = clientTerms(type, settings, doc.clients ?? { payment_days: null }, date)

  const { data: newDoc, error: insertErr } = await supabase
    .from('documents')
    .insert({
      type: doc.type,
      client_id: doc.client_id,
      date,
      due_date: type === 'credit_note' ? null : terms.dueDate,
      service_date: null,
      language: doc.language,
      // EUR only: a copy of an old USD/GBP document starts as a EUR draft.
      currency: 'EUR',
      exchange_rate: 1,
      tax_treatment: doc.tax_treatment,
      notes: doc.notes,
      notes_internal: null,
      discount_type: doc.discount_type,
      discount_value: doc.discount_value,
      skonto_percent: terms.skontoPercent === '' ? null : terms.skontoPercent,
      skonto_days: terms.skontoDays === '' ? null : terms.skontoDays,
      status: 'draft',
      number: null,
      // A copy bills the service anew: a copied final invoice deducts nothing (and an advance or
      // partial invoice is no longer one), so it starts as a standard invoice.
      ...(type === 'invoice' ? { invoice_kind: 'standard' } : {}),
    })
    .select()
    .single()
  if (insertErr || !newDoc) return { id: null, type: null, error: { stage: 'copy', cause: insertErr } }

  // Deduction lines belong to the invoices the original deducts; the copy gets new line ids.
  const items = (doc.document_items ?? [])
    .filter((item: Record<string, unknown>) => item.line_type !== 'deduction')
    .map((item: Record<string, unknown>) => {
      const rest = { ...item }
      delete rest.id
      delete rest.created_at
      return { ...rest, document_id: newDoc.id }
    })

  if (items.length > 0) {
    const { error: itemsErr } = await supabase.from('document_items').insert(items)
    if (itemsErr) {
      // A copy without its lines is no copy; the empty draft goes again.
      const { error: cleanupErr } = await supabase.from('documents').delete().eq('id', newDoc.id).is('number', null)
      if (cleanupErr) console.error('[duplicate] empty draft not removed:', cleanupErr.message)
      return { id: null, type: null, error: { stage: 'copy', cause: itemsErr } }
    }
  }
  return { id: newDoc.id as string, type, error: null }
}

// Deducts an issued advance or partial invoice on a draft (which becomes a final invoice), or stops
// deducting it. 'taken' when another final invoice deducts it already. `syncLines` rewrites the
// draft's deduction lines at once; the editor keeps them in step in its form instead. Database
// failures (the deposit guards' MI020/MI021 included) are thrown.
export async function setDepositLink(
  supabase: SupabaseClient,
  finalId: string,
  invoiceId: string,
  linked: boolean,
  { syncLines = true }: { syncLines?: boolean } = {},
): Promise<'ok' | 'taken'> {
  if (linked) {
    const result = await linkDeposit(supabase, finalId, invoiceId)
    if (result === 'taken') return result
  } else {
    await unlinkDeposit(supabase, finalId, invoiceId)
  }
  if (syncLines) await writeDeductions(supabase, finalId)
  return 'ok'
}
