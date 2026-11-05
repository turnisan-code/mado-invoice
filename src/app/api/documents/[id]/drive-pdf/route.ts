import { NextRequest, NextResponse } from 'next/server'
import { isUuid, requireUser } from '@/lib/auth'
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
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: doc, error: docErr }, { data: settings, error: settingsErr }] = await Promise.all([
    supabase.from('documents').select('id, number').eq('id', id).maybeSingle(),
    supabase.from('settings').select('drive_folder_id, gmail_email, gmail_refresh_token').single(),
  ])
  if (docErr || settingsErr) return NextResponse.json({ error: (docErr ?? settingsErr)!.message }, { status: 500 })
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!doc.number) return NextResponse.json({ error: 'Issue the document before saving it to Drive', code: 'not_issued' }, { status: 400 })
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })
  if (!settings.gmail_refresh_token) return googleNotConnected(settings)
  if (!settings.drive_folder_id) return NextResponse.json({ error: 'No Drive folder configured' }, { status: 400 })

  let issued
  try {
    issued = await getIssuedPdf(supabase, id, 'on_demand')
  } catch (err) {
    console.error('[drive-pdf] archive copy unavailable:', err)
    const code = err instanceof ArchiveError ? err.code : undefined
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF unavailable', code }, { status: 500 })
  }

  try {
    const result = await archiveToDrive(supabase, issued.settings, { ...issued.doc, number: doc.number }, issued)
    return NextResponse.json(result)
  } catch (err) {
    return googleErrorResponse(err, supabase, issued.settings.id, 'drive-pdf')
  }
}
