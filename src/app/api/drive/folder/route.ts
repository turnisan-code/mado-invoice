import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, readJsonObject, requireUser, settingsUnavailable } from '@/lib/auth'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected, isGoogleNotFound } from '@/lib/google/client'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export async function POST(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const payload = await readJsonObject(req)
  if (!payload) return invalidJson()
  const raw = payload.folderId
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return apiError(400, 'invalid_request', 'Invalid folderId')
  }

  const { data: settings, error: settingsErr } = await supabase.from('settings').select('*').single()
  if (settingsErr || !settings) return settingsUnavailable(settingsErr)

  const input = (typeof raw === 'string' ? raw : '').trim()
  if (!input) {
    const { error } = await supabase.from('settings')
      .update({ drive_folder_id: null, drive_folder_name: null })
      .eq('id', settings.id)
    if (error) return databaseError(error)
    return NextResponse.json({ id: null, name: null })
  }

  if (!settings.gmail_refresh_token) return googleNotConnected(settings)

  const folderId = input.match(/[-\w]{25,}/)?.[0] ?? input
  const drive = google.drive({ version: 'v3', auth: getAuthorizedGoogle(settings, supabase) })

  let file: { id?: string | null; name?: string | null; mimeType?: string | null }
  try {
    file = (await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType', supportsAllDrives: true })).data
  } catch (err) {
    if (isGoogleNotFound(err)) {
      return apiError(400, 'folder_not_found', 'Folder not found — check the ID and that it belongs to the connected Google account')
    }
    return googleErrorResponse(err, supabase, settings.id, 'drive/folder')
  }
  if (!file.id) return apiError(400, 'folder_not_found', 'Folder not found')
  if (file.mimeType !== FOLDER_MIME) {
    return apiError(400, 'not_a_folder', `"${file.name ?? folderId}" is a file, not a folder`)
  }

  const { error } = await supabase.from('settings')
    .update({ drive_folder_id: file.id, drive_folder_name: file.name ?? null })
    .eq('id', settings.id)
  if (error) return databaseError(error)

  return NextResponse.json({ id: file.id, name: file.name ?? null })
}
