import { NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { logEvent } from '@/lib/events'
import { issueDocument } from '@/lib/pdf/issue'
import { applyCreditNote } from '@/lib/credits'

// A Storno renders, stores and archives its PDF before answering.
export const maxDuration = 60

type Created = { credit_note_id: string; number: string | null; invoice_status: string }

// Creates a draft credit note from an issued invoice; it takes its amount off the invoice's open
// balance when it is issued. With { cancel: true } it is a Storno: create_credit_note numbers it
// and cancels the invoice in one transaction, then it gets its frozen PDF and is applied here.
// An optional { reason } is kept in the history of both documents.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const cancel = body.cancel === true
  const reason = cancel && typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || undefined : undefined

  const { data, error } = await supabase.rpc('create_credit_note', { p_invoice_id: id, p_cancel: cancel })
  if (error) return databaseError(error, error.code === 'MI017' || error.code === 'MI018' || error.code === 'MI020' ? 409 : 500)
  const created = data as Created | null
  if (!created) return apiError(404, 'not_found', 'Invoice not found')
  const creditNoteId = created.credit_note_id

  const { data: invoice } = await supabase.from('documents').select('number').eq('id', id).single()
  await logEvent(supabase, creditNoteId, 'converted', { from_id: id, from_number: invoice?.number ?? null, from_type: 'invoice', storno: cancel, reason })
  if (!cancel) return NextResponse.json({ creditNoteId })

  await logEvent(supabase, creditNoteId, 'issued', { number: created.number })
  await logEvent(supabase, id, 'storno_created', { credit_note_id: creditNoteId, credit_note_number: created.number, from: created.invoice_status, reason })

  // The number is taken; the frozen PDF and the Drive copy follow (a failure is reported and the
  // page offers to create the archive copy), then the credit settles the invoice's open balance.
  let snapshotError: string | null = null
  let driveError: { error: string; code?: string } | null = null
  try {
    const outcome = await issueDocument(supabase, creditNoteId)
    snapshotError = outcome.snapshotError
    driveError = outcome.driveError
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : String(err)
  }
  try {
    await applyCreditNote(supabase, creditNoteId)
  } catch (err) {
    console.error(`[convert-to-credit-note] Storno ${created.number} not applied:`, err)
  }

  return NextResponse.json({ creditNoteId, number: created.number, snapshotError, driveError })
}
