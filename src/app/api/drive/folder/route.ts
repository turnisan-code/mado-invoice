import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected, isGoogleNotFound } from '@/lib/google/client'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let payload: { folderId?: unknown } | null
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const raw = payload?.folderId
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return NextResponse.json({ error: 'Invalid folderId' }, { status: 400 })
  }

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  const input = (raw ?? '').trim()
  if (!input) {
    const { error } = await supabase.from('settings')
      .update({ drive_folder_id: null, drive_folder_name: null })
      .eq('id', settings.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ id: null, name: null })
  }

  if (!settings.gmail_refresh_token) return googleNotConnected()

  const folderId = input.match(/[-\w]{25,}/)?.[0] ?? input
  const drive = google.drive({ version: 'v3', auth: getAuthorizedGoogle(settings, supabase) })

  let file: { id?: string | null; name?: string | null; mimeType?: string | null }
  try {
    file = (await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType', supportsAllDrives: true })).data
  } catch (err) {
    if (isGoogleNotFound(err)) {
      return NextResponse.json({ error: 'Folder not found — check the ID and that it belongs to the connected Google account' }, { status: 400 })
    }
    return googleErrorResponse(err, supabase, settings.id, 'drive/folder')
  }
  if (!file.id) return NextResponse.json({ error: 'Folder not found' }, { status: 400 })
  if (file.mimeType !== FOLDER_MIME) {
    return NextResponse.json({ error: `"${file.name ?? folderId}" is a file, not a folder` }, { status: 400 })
  }

  const { error } = await supabase.from('settings')
    .update({ drive_folder_id: file.id, drive_folder_name: file.name ?? null })
    .eq('id', settings.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ id: file.id, name: file.name ?? null })
}
