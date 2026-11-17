import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { parseReview, receiptPathOk } from '@/lib/expenses/input'
import { releaseGmailReceipt } from '@/lib/expenses/receipts'
import type { BankLine, BankLineStatus } from '@/types'

// What the owner sets on a line, saved as it changes: its review (the rule picked, the fields,
// the split lines, the bookings said not to be it), „Überspringen“ (skipped) and back (open), its
// Beleg (uploaded to the 'receipts' bucket by the page, here only its path and name; one in its
// place, or none, releases a receipt from Gmail). A booked line stays as it was booked
// (bank_lines_booking_guard; „Buchung vergessen“ first).
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
  if (body.receipt !== undefined) {
    if (body.receipt === null) Object.assign(update, { receipt_path: null, receipt_name: null })
    else {
      const r = body.receipt as Record<string, unknown>
      if (!r || typeof r !== 'object' || !receiptPathOk(id, r.path) || typeof r.name !== 'string' || r.name.length > 200) {
        return apiError(400, 'invalid_request', 'Invalid receipt')
      }
      Object.assign(update, { receipt_path: r.path, receipt_name: r.name })
    }
  }
  if (!Object.keys(update).length) return apiError(400, 'invalid_request', 'Nothing to save')
  if (body.receipt !== undefined) {
    // A Beleg by hand, or none: a receipt from Gmail is forgotten and its claims go (PR 9b); the
    // line's list of what Gmail found stays
    const { data: current, error: readErr } = await supabase.from('bank_lines').select('id, status, receipt_search').eq('id', id).maybeSingle()
    if (readErr) return databaseError(readErr)
    if (!current) return apiError(404, 'not_found', 'Statement line not found')
    if ((current as { status: string }).status === 'booked') return apiError(409, 'invalid_status', 'This line is booked: forget its booking first')
    try {
      Object.assign(update, await releaseGmailReceipt(supabase, current as Pick<BankLine, 'id' | 'receipt_search'>))
    } catch (err) {
      return databaseError({ message: err instanceof Error ? err.message : String(err) })
    }
  }

  const { data, error } = await supabase.from('bank_lines').update(update).eq('id', id).neq('status', 'booked')
    .select('id, status, review, receipt_path, receipt_name, receipt_search, receipt_gmail, updated_at')
  // A booked line, or one with a booking attempt open, stays as it is (MI050/MI051): a conflict
  if (error) return databaseError(error, /^MI05[01]$/.test(error.code ?? '') ? 409 : 500)
  if (!data?.length) {
    const { data: line } = await supabase.from('bank_lines').select('status').eq('id', id).maybeSingle()
    return line ? apiError(409, 'invalid_status', 'This line is booked: forget its booking first') : apiError(404, 'not_found', 'Statement line not found')
  }
  return NextResponse.json(data[0])
}
