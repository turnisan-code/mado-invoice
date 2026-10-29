import { NextRequest, NextResponse } from 'next/server'
import { isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { attachPdf, BOOKAMAT_SETTINGS_COLUMNS, recordBookamatError, settingsT, type BookamatSettings } from '@/lib/bookamat'
import { isBookamatConfigured } from '@/lib/public-settings'
import { getIssuedPdf } from '@/lib/pdf/snapshot'

export const maxDuration = 60

// Attaches the frozen PDF to the document's existing Bookamat booking(s) again, without booking
// anything: to the bookings that have no attachment yet, or to all of them when every one has.
// Country, year and booking ids come from the database, never from the request.
export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await readJsonObject(req)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  if (!isUuid(body.documentId)) return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  const documentId = body.documentId

  const [{ data: settingsRow, error: settingsErr }, { data: bookings, error: bookingsErr }] = await Promise.all([
    supabase.from('settings').select(BOOKAMAT_SETTINGS_COLUMNS).single(),
    supabase.from('bookamat_bookings').select('year, booking_id, pdf_attached_at').eq('document_id', documentId).order('year'),
  ])
  if (settingsErr || !settingsRow) return NextResponse.json({ error: settingsErr?.message ?? 'Settings not found' }, { status: 500 })
  if (bookingsErr) return NextResponse.json({ error: bookingsErr.message }, { status: 500 })
  const settings = settingsRow as unknown as BookamatSettings
  if (!isBookamatConfigured(settings)) return NextResponse.json({ error: 'Bookamat is not fully configured', code: 'not_configured' }, { status: 400 })
  if (!bookings?.length) return NextResponse.json({ error: 'This document has no Bookamat booking yet — sync it first', code: 'not_synced' }, { status: 400 })

  const missing = bookings.filter(b => !b.pdf_attached_at)
  const targets = missing.length ? missing : bookings
  const result = await attachPdf(supabase, settings, documentId, targets, async id => getIssuedPdf(supabase, id, 'on_demand'))
  if (!result.attached) {
    const error = result.error ?? settingsT(settings)('books.sync.attachNone')
    await recordBookamatError(supabase, settings.id, null, error)
    return NextResponse.json({ error }, { status: 502 })
  }
  return NextResponse.json({ ok: true, attached: result.attached, failed: targets.length - result.attached, error: result.error })
}
