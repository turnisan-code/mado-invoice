import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { adoptExternalBooking, BOOKAMAT_SETTINGS_COLUMNS, type BookamatSettings } from '@/lib/bookamat'

export const maxDuration = 30

// „Das ist diese Zahlung — übernehmen“: records a booking Bookamat already has (one Mado did not
// make) as the booking of one of the document's payments, after reading it again from Bookamat. Books
// nothing. Production only.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuid(body.documentId)) return apiError(400, 'invalid_request', 'documentId is required')
  const { year, bookingId } = body
  if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2999) return apiError(400, 'invalid_request', 'year is required')
  if ((typeof bookingId !== 'string' && typeof bookingId !== 'number') || !/^\d{1,18}$/.test(String(bookingId))) {
    return apiError(400, 'invalid_request', 'bookingId is required')
  }
  const paymentId = body.paymentId === undefined || body.paymentId === null ? null : body.paymentId
  if (paymentId !== null && !isUuid(paymentId)) return apiError(400, 'invalid_request', 'Invalid paymentId')

  const { data: settings, error: settingsErr } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)

  const result = await adoptExternalBooking(supabase, settings as unknown as BookamatSettings, body.documentId, { year: year as number, bookingId: String(bookingId), paymentId })
  if (!result.ok) {
    const { status, ...payload } = result
    return NextResponse.json(payload, { status })
  }
  return NextResponse.json(result)
}
