import { NextRequest, NextResponse } from 'next/server'
import { apiError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { resetBookamatSync } from '@/lib/bookamat'

// Forgets a document's Bookamat bookings so it can be synced again. The UI asks first: the
// bookings must have been deleted in Bookamat, or the next sync books the money twice.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  if (!isUuid(body.documentId)) return apiError(400, 'invalid_request', 'documentId is required')

  const failure = await resetBookamatSync(auth.supabase, body.documentId)
  if (failure) {
    const { status, ...payload } = failure
    return NextResponse.json(payload, { status })
  }
  return NextResponse.json({ ok: true })
}
