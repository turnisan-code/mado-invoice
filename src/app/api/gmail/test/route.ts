import { google } from 'googleapis'
import { NextResponse } from 'next/server'
import { requireUser, settingsUnavailable } from '@/lib/auth'
import { getAuthorizedGoogle, googleErrorResponse, googleNotConnected, recordGoogleError } from '@/lib/google/client'
import { GOOGLE_FOLDER_TRASHED_MESSAGE } from '@/lib/google/reauth'

// Settings → Google → Test connection: refreshes the token (an expired grant surfaces here as
// invalid_grant and clears the connection), reads the account and, when a Drive folder is set,
// opens it. Success clears the last error.
export async function POST() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const { data: settings, error } = await supabase
    .from('settings')
    .select('id, gmail_email, gmail_access_token, gmail_refresh_token, gmail_token_expiry, drive_folder_id')
    .single()
  if (error || !settings) return settingsUnavailable(error)
  if (!settings.gmail_refresh_token) return googleNotConnected(settings)

  const authClient = getAuthorizedGoogle(settings, supabase)
  try {
    const { data: me } = await google.oauth2({ version: 'v2', auth: authClient }).userinfo.get()
    let folder: string | null = null
    if (settings.drive_folder_id) {
      const { data: file } = await google.drive({ version: 'v3', auth: authClient })
        .files.get({ fileId: settings.drive_folder_id, fields: 'id,name,trashed', supportsAllDrives: true })
      if (file.trashed) throw new Error(GOOGLE_FOLDER_TRASHED_MESSAGE)
      folder = file.name ?? file.id ?? null
    }
    await recordGoogleError(supabase, settings.id, null)
    return NextResponse.json({ ok: true, email: me.email ?? settings.gmail_email, folder })
  } catch (err) {
    return googleErrorResponse(err, supabase, settings.id, 'gmail/test')
  }
}
