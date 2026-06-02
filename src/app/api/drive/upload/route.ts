import { google } from 'googleapis'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOAuthClient } from '@/lib/google/client'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: settings } = await supabase.from('settings').select('*').single()
  if (!settings?.gmail_refresh_token) {
    return NextResponse.json({ error: 'Google not connected' }, { status: 400 })
  }
  if (!settings.drive_folder_id) {
    return NextResponse.json({ error: 'No Drive folder configured' }, { status: 400 })
  }

  const { pdfBase64, filename, documentId } = await req.json()

  // Look up existing Drive file ID for this document (if any)
  let existingFileId: string | null = null
  if (documentId) {
    const { data: doc } = await supabase
      .from('documents')
      .select('drive_file_id')
      .eq('id', documentId)
      .single()
    existingFileId = doc?.drive_file_id ?? null
  }

  const oauth2 = getOAuthClient()
  oauth2.setCredentials({
    access_token: settings.gmail_access_token,
    refresh_token: settings.gmail_refresh_token,
    expiry_date: settings.gmail_token_expiry,
  })
  oauth2.on('tokens', async (tokens) => {
    await supabase.from('settings').update({
      gmail_access_token: tokens.access_token,
      ...(tokens.refresh_token ? { gmail_refresh_token: tokens.refresh_token } : {}),
      gmail_token_expiry: tokens.expiry_date,
    }).eq('id', settings.id)
  })

  const drive = google.drive({ version: 'v3', auth: oauth2 })
  const { PassThrough } = await import('stream')

  try {
    // 1. Verify stored file ID is still active (not trashed/deleted)
    if (existingFileId) {
      try {
        const { data: check } = await drive.files.get({ fileId: existingFileId, fields: 'id,trashed' })
        if (check.trashed) existingFileId = null
      } catch {
        existingFileId = null
      }
    }

    // 2. If no stored ID, search the folder for a file with the same name
    //    (handles pre-existing files and stale DB state)
    if (!existingFileId) {
      const safe = filename.replace(/'/g, "\\'")
      const { data: found } = await drive.files.list({
        q: `name='${safe}' and '${settings.drive_folder_id}' in parents and trashed=false`,
        fields: 'files(id,webViewLink)',
        pageSize: 1,
      })
      if (found.files && found.files.length > 0) {
        existingFileId = found.files[0].id ?? null
        // Adopt this file — persist so future uploads reuse it
        if (documentId && existingFileId) {
          await supabase.from('documents').update({ drive_file_id: existingFileId }).eq('id', documentId)
        }
      }
    }

    const pdfBuffer = Buffer.from(pdfBase64, 'base64')
    let fileId: string | null | undefined
    let webViewLink: string | null | undefined

    if (existingFileId) {
      // Update existing file in-place — same ID means Drive Desktop syncs cleanly
      const stream = new PassThrough()
      stream.end(pdfBuffer)
      const { data: file } = await drive.files.update({
        fileId: existingFileId,
        media: { mimeType: 'application/pdf', body: stream },
        fields: 'id,webViewLink',
      })
      fileId = file.id
      webViewLink = file.webViewLink
    } else {
      // No existing file — create new and persist the ID
      const stream = new PassThrough()
      stream.end(pdfBuffer)
      const { data: file } = await drive.files.create({
        requestBody: { name: filename, parents: [settings.drive_folder_id] },
        media: { mimeType: 'application/pdf', body: stream },
        fields: 'id,webViewLink',
      })
      fileId = file.id
      webViewLink = file.webViewLink
      if (documentId && fileId) {
        await supabase.from('documents').update({ drive_file_id: fileId }).eq('id', documentId)
      }
    }

    return NextResponse.json({ fileId, webViewLink })
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? 'Unknown error'
    console.error('[drive/upload]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
