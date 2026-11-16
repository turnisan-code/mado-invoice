import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, type BookamatSettings } from '@/lib/bookamat'
import type { AdoptBooking } from '@/lib/bookamat-client'
import type { BookingRef } from '@/lib/bookamat-search'
import { syncBookamat } from '@/lib/services/bookamat-sync'

export const maxDuration = 60

// Bookings in Bookamat the owner said are other money („trotzdem buchen“).
function parseAcknowledge(value: unknown): BookingRef[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) return null
  const out: BookingRef[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const { year, bookingId } = v as Record<string, unknown>
    if (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2999) return null
    if ((typeof bookingId !== 'string' && typeof bookingId !== 'number') || !/^\d{1,18}$/.test(String(bookingId))) return null
    out.push({ year: year as number, bookingId: String(bookingId) })
  }
  return out
}

function parseAdopt(value: unknown): AdoptBooking[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10) return null
  const out: AdoptBooking[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const { year, kind, bookingId } = v as Record<string, unknown>
    if (!Number.isInteger(year) || (kind !== 'income' && kind !== 'refund')) return null
    if (typeof bookingId !== 'string' && typeof bookingId !== 'number') return null
    if (!/^\d{1,18}$/.test(String(bookingId))) return null
    out.push({ year: year as number, kind, bookingId: String(bookingId) })
  }
  return out
}

// Books an issued invoice's money (or a credit note's refunds) in Bookamat, one booking per
// payment, and attaches the frozen PDF. `adopt` records bookings an earlier attempt created
// but could not store (its `pending`), instead of booking them again.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuid(body.documentId)) return apiError(400, 'invalid_request', 'documentId is required')
  const adopt = parseAdopt(body.adopt)
  if (!adopt) return apiError(400, 'invalid_request', 'Invalid adopt list')
  const acknowledge = parseAcknowledge(body.acknowledge)
  if (!acknowledge) return apiError(400, 'invalid_request', 'Invalid acknowledge list')

  const { data: settings, error: settingsErr } = await supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)

  const result = await syncBookamat(supabase, settings as unknown as BookamatSettings, body.documentId, { adopt, acknowledge })
  if (!result.ok) {
    const { status, ...payload } = result
    return NextResponse.json(payload, { status })
  }
  return NextResponse.json(result)
}
