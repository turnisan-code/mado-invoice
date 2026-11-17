import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { parseReview, receiptPathOk } from '@/lib/expenses/input'
import { setHandReceipt } from '@/lib/expenses/receipts'
import type { BankLine, BankLineStatus } from '@/types'

// What the owner sets on a line, saved as it changes: its review (the rule picked, the fields,
// the split lines, the bookings said not to be it), „Überspringen“ (skipped) and back (open), its
// Beleg (uploaded to the 'receipts' bucket by the page, here only its path and name; one in its
// place, or none, releases a receipt from Gmail, lib/expenses/receipts.ts setHandReceipt). A
// booked line stays as it was booked (bank_lines_booking_guard; „Buchung vergessen“ first).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Statement line not found')
  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (Object.keys(body).some(k => !['review', 'status', 'receipt'].includes(k))) return apiError(400, 'invalid_request', 'Only review, status and receipt can be set')

  const update: Record<string, unknown> = {}
  if (body.review !== undefined) {
    const review = parseReview(body.review)
    if (!review) return apiError(400, 'invalid_request', 'Invalid review')
    update.review = review
  }
  if (body.status !== undefined) {
    if (body.status !== 'open' && body.status !== 'skipped') return apiError(400, 'invalid_request', 'status must be open or skipped')
    update.status = body.status as BankLineStatus
  }
  let receipt: { path: string; name: string } | null | undefined
  if (body.receipt !== undefined) {
    if (body.receipt !== null) {
      const r = body.receipt as Record<string, unknown>
      if (!r || typeof r !== 'object' || !receiptPathOk(id, r.path) || typeof r.name !== 'string' || r.name.length > 200) {
        return apiError(400, 'invalid_request', 'Invalid receipt')
      }
      receipt = { path: r.path, name: r.name }
    } else receipt = null
  }
  if (!Object.keys(update).length && receipt === undefined) return apiError(400, 'invalid_request', 'Nothing to save')

  // A Beleg by hand, or none (PR 9b): in one step with the line's claims, against the line as it
  // is now — a receipt from Gmail is forgotten and its claims go, the list of what Gmail found
  // stays; refused while the line is booked or a booking attempt is open or running
  if (receipt !== undefined) {
    const { data: current, error: readErr } = await supabase.from('bank_lines').select('id, status, receipt_path, receipt_search, receipt_gmail').eq('id', id).maybeSingle()
    if (readErr) return databaseError(readErr)
    if (!current) return apiError(404, 'not_found', 'Statement line not found')
    try {
      const step = await setHandReceipt(supabase, current as Pick<BankLine, 'id' | 'receipt_path' | 'receipt_search' | 'receipt_gmail'>, receipt)
      if (step.status === 'not_found') return apiError(404, 'not_found', 'Statement line not found')
      if (step.status !== 'ok') return apiError(409, 'invalid_status', 'This line is booked, a booking attempt is open, or its receipt changed meanwhile: reload')
    } catch (err) {
      return databaseError({ message: err instanceof Error ? err.message : String(err) })
    }
  }

  const query = Object.keys(update).length
    ? supabase.from('bank_lines').update(update).eq('id', id).neq('status', 'booked')
    : supabase.from('bank_lines').select('id').eq('id', id)
  const { data, error } = await query.select('id, status, review, receipt_path, receipt_name, updated_at')
  // A booked line, or one with a booking attempt open, stays as it is (MI050/MI051): a conflict
  if (error) return databaseError(error, /^MI05[01]$/.test(error.code ?? '') ? 409 : 500)
  if (!data?.length) {
    const { data: line } = await supabase.from('bank_lines').select('status').eq('id', id).maybeSingle()
    return line ? apiError(409, 'invalid_status', 'This line is booked: forget its booking first') : apiError(404, 'not_found', 'Statement line not found')
  }
  return NextResponse.json(data[0])
}
