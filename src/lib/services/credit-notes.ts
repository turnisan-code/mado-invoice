// Credit notes from an issued invoice: a draft to edit and issue later, or a Storno that cancels
// the invoice at once. Server only (issuing renders the PDF).
import 'server-only'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/events'
import { issueDocument } from '@/lib/pdf/issue'
import { applyCreditNote } from '@/lib/credits'

export type CreatedCreditNote = {
  creditNoteId: string
  // Set for a Storno only: it is numbered as it is created.
  number: string | null
  snapshotError: string | null
  driveError: { error: string; code?: string } | null
  // A Storno whose credit could not be taken off the invoice's open balance (its page offers to
  // apply it).
  creditNotApplied: boolean
}

type Created = { credit_note_id: string; number: string | null; invoice_status: string }

// create_credit_note copies the invoice; it takes its amount off the invoice's open balance when
// it is issued. With `cancel` it is a Storno: numbered and the invoice cancelled in one
// transaction, then it gets its frozen PDF and is applied here. A `reason` is kept in the history
// of both documents. `error` carries MI017 (already cancelled), MI018 (a draft) or MI020 (deducted
// on an issued final invoice); null data = no such invoice.
// A Storno's archive copy is made with the client as it was before its number was taken
// (issueDocument's `clientWrittenAt`): the mark of the invoice's client (clients.mcp_written_at) is
// read just before create_credit_note, unless the caller passes the one it read (a Storno Claude
// prepared: null, as such a client is refused). A client Claude changes in between (a parallel
// call during the owner's Storno, or during one confirmed in the chat) leaves the credit note
// without an archive copy until the owner saves the client (snapshotError).
export async function createCreditNote(
  supabase: SupabaseClient,
  invoiceId: string,
  { cancel, reason, clientWrittenAt }: { cancel: boolean; reason?: string; clientWrittenAt?: string | null },
): Promise<{ data: CreatedCreditNote | null; error: PostgrestError | null }> {
  let writtenAt = clientWrittenAt ?? null
  if (cancel && clientWrittenAt === undefined) {
    // The whole client row: a database without clients.mcp_written_at has nothing from Claude.
    const { data: before, error: readErr } = await supabase.from('documents').select('clients(*)').eq('id', invoiceId).maybeSingle()
    if (readErr) return { data: null, error: readErr }
    writtenAt = (before as unknown as { clients?: { mcp_written_at?: string | null } | null } | null)?.clients?.mcp_written_at ?? null
  }
  const { data, error } = await supabase.rpc('create_credit_note', { p_invoice_id: invoiceId, p_cancel: cancel })
  if (error) return { data: null, error }
  const created = data as Created | null
  if (!created) return { data: null, error: null }
  const creditNoteId = created.credit_note_id

  const { data: invoice } = await supabase.from('documents').select('number').eq('id', invoiceId).single()
  await logEvent(supabase, creditNoteId, 'converted', { from_id: invoiceId, from_number: invoice?.number ?? null, from_type: 'invoice', storno: cancel, reason })
  const result: CreatedCreditNote = { creditNoteId, number: null, snapshotError: null, driveError: null, creditNotApplied: false }
  if (!cancel) return { data: result, error: null }

  result.number = created.number
  await logEvent(supabase, creditNoteId, 'issued', { number: created.number })
  await logEvent(supabase, invoiceId, 'storno_created', { credit_note_id: creditNoteId, credit_note_number: created.number, from: created.invoice_status, reason })

  // The number is taken; the frozen PDF and the Drive copy follow (a failure is reported and the
  // page offers to create the archive copy), then the credit settles the invoice's open balance.
  try {
    const outcome = await issueDocument(supabase, creditNoteId, { clientWrittenAt: writtenAt })
    result.snapshotError = outcome.snapshotError
    result.driveError = outcome.driveError
  } catch (err) {
    result.snapshotError = err instanceof Error ? err.message : String(err)
  }
  try {
    await applyCreditNote(supabase, creditNoteId)
  } catch (err) {
    console.error(`[convert-to-credit-note] Storno ${created.number} not applied:`, err)
    result.creditNotApplied = true
  }
  return { data: result, error: null }
}
