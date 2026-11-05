import { NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { createCreditNote } from '@/lib/services/credit-notes'

// A Storno renders, stores and archives its PDF before answering.
export const maxDuration = 60

// Creates a draft credit note from an issued invoice, or with { cancel: true } its Storno, which
// cancels the invoice (src/lib/services/credit-notes.ts). An optional { reason } is kept in the
// history of both documents.
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

  const { data, error } = await createCreditNote(supabase, id, { cancel, reason })
  if (error) return databaseError(error, error.code === 'MI017' || error.code === 'MI018' || error.code === 'MI020' ? 409 : 500)
  if (!data) return apiError(404, 'not_found', 'Invoice not found')
  if (!cancel) return NextResponse.json({ creditNoteId: data.creditNoteId })
  return NextResponse.json({ creditNoteId: data.creditNoteId, number: data.number, snapshotError: data.snapshotError, driveError: data.driveError, creditNotApplied: data.creditNotApplied })
}
