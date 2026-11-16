import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, credentialsOf, resetBookamatSync, type BookamatSettings, type ForgetTarget } from '@/lib/bookamat'
import { isBookamatConfigured } from '@/lib/public-settings'

// „Buchung vergessen“: forgets one Bookamat booking of a document (`year` and `bookingId`), or with
// `unsettled` the attempts a sync could not settle, so the money can be booked again. The UI asks
// first: the booking must have been deleted in Bookamat, or the next sync books the money twice;
// with Bookamat set up, Bookamat is asked (GET) and a booking it still has is not forgotten.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuid(body.documentId)) return apiError(400, 'invalid_request', 'documentId is required')
  let target: ForgetTarget
  if (body.unsettled === true) target = { unsettled: true }
  else {
    const { year, bookingId } = body
    if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2999) return apiError(400, 'invalid_request', 'year is required')
    if (typeof bookingId !== 'string' || !/^\d{1,18}$/.test(bookingId)) return apiError(400, 'invalid_request', 'bookingId is required')
    target = { booking: { year: year as number, bookingId } }
  }

  const { data: settings, error: settingsErr } = await auth.supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)
  const bookamat = settings as unknown as BookamatSettings
  const creds = isBookamatConfigured(bookamat) ? credentialsOf(bookamat) : null

  const failure = await resetBookamatSync(auth.supabase, body.documentId, target, creds)
  if (failure) {
    const { status, ...payload } = failure
    return NextResponse.json(payload, { status })
  }
  return NextResponse.json({ ok: true })
}
