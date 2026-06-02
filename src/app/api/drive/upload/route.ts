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
  const { Readable } = await import('stream')

  try {
    // Delete the old file if it exists — we'll create a fresh one
    if (existingFileId) {
      try { await drive.files.delete({ fileId: existingFileId }) } catch { /* already gone */ }
    }

    const { data: file } = await drive.files.create({
      requestBody: { name: filename, parents: [settings.drive_folder_id] },
      media: { mimeType: 'application/pdf', body: Readable.from(Buffer.from(pdfBase64, 'base64')) },
      fields: 'id,webViewLink',
    })

    // Persist the new file ID
    if (documentId && file.id) {
      await supabase.from('documents').update({ drive_file_id: file.id }).eq('id', documentId)
    }

    return NextResponse.json({ fileId: file.id, webViewLink: file.webViewLink })
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? 'Unknown error'
    console.error('[drive/upload]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
