import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, isUuid, requireUser, settingsUnavailable } from '@/lib/auth'
import { googleErrorResponse, googleNotConnected } from '@/lib/google/client'
import { ArchiveError, getIssuedPdf } from '@/lib/pdf/snapshot'
import { archiveToDrive } from '@/lib/pdf/drive'

export const maxDuration = 60

// Saves the issued copy of a numbered document to the Drive folder. Never overwrites: when the
// document is already archived there, the existing file's link is returned.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  if (!isUuid(id)) return apiError(404, 'not_found', 'Not found')

  const [{ data: doc, error: docErr }, { data: settings, error: settingsErr }] = await Promise.all([
    supabase.from('documents').select('id, number').eq('id', id).maybeSingle(),
    supabase.from('settings').select('drive_folder_id, gmail_email, gmail_refresh_token').single(),
  ])
  if (docErr) return databaseError(docErr)
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)
  if (!doc) return apiError(404, 'not_found', 'Not found')
  if (!doc.number) return apiError(400, 'not_issued', 'Issue the document before saving it to Drive')
  if (!settings.gmail_refresh_token) return googleNotConnected(settings)
  if (!settings.drive_folder_id) return apiError(400, 'drive_not_configured', 'No Drive folder configured')

  let issued
  try {
    issued = await getIssuedPdf(supabase, id, 'on_demand')
  } catch (err) {
    console.error('[drive-pdf] archive copy unavailable:', err)
    if (err instanceof ArchiveError) return NextResponse.json({ error: err.message, code: err.code }, { status: 500 })
    return apiError(500, 'archive_failed', err instanceof Error ? err.message : 'PDF unavailable')
  }

  try {
    const result = await archiveToDrive(supabase, issued.settings, { ...issued.doc, number: doc.number }, issued)
    return NextResponse.json(result)
  } catch (err) {
    return googleErrorResponse(err, supabase, issued.settings.id, 'drive-pdf')
  }
}
