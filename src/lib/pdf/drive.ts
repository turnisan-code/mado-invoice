import { PassThrough } from 'stream'
import { google } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthorizedGoogle, isGoogleAuthError, isGoogleScopeError } from '@/lib/google/client'
import { logEvent } from '@/lib/events'
import type { Settings } from '@/types'

export type DriveArchive = { fileId: string | null; webViewLink: string | null; existing: boolean }

function escapeQuery(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// The file id is only a shortcut: Drive finds the document's file by its documentId tag too.
async function linkDriveFile(supabase: SupabaseClient, documentId: string, fileId: string) {
  const { error } = await supabase.from('documents').update({ drive_file_id: fileId }).eq('id', documentId)
  if (error) console.error('[drive] drive_file_id not recorded:', error.message)
}

function rethrowGoogleAccess(err: unknown) {
  if (isGoogleAuthError(err) || isGoogleScopeError(err)) throw err
}

// Archives the issued PDF to the configured Drive folder as a new file named after the number.
// An archived file is never overwritten or renamed: the document's own file (by stored id or
// by the documentId tag set on upload) is returned as it is. A file with the same name in the
// folder is adopted only when nothing marks it as another document's (no documentId tag, e.g.
// one uploaded before files were tagged); it is tagged then, so it is found by the tag from now
// on. Otherwise a new file is uploaded next to it.
export async function archiveToDrive(
  supabase: SupabaseClient,
  settings: Settings,
  doc: { id: string; number: string; drive_file_id?: string | null },
  pdf: { buffer: Buffer; filename: string },
): Promise<DriveArchive> {
  const folderId = settings.drive_folder_id
  if (!folderId) throw new Error('No Drive folder configured')
  const drive = google.drive({ version: 'v3', auth: getAuthorizedGoogle(settings, supabase) })

  if (doc.drive_file_id) {
    try {
      const { data } = await drive.files.get({ fileId: doc.drive_file_id, fields: 'id,trashed,webViewLink', supportsAllDrives: true })
      if (!data.trashed) return { fileId: data.id ?? doc.drive_file_id, webViewLink: data.webViewLink ?? null, existing: true }
    } catch (err) {
      rethrowGoogleAccess(err)
    }
  }

  const { data: tagged } = await drive.files.list({
    q: `appProperties has { key='documentId' and value='${escapeQuery(doc.id)}' } and trashed=false`,
    fields: 'files(id,webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const own = tagged.files?.[0]
  if (own?.id) {
    if (own.id !== doc.drive_file_id) await linkDriveFile(supabase, doc.id, own.id)
    return { fileId: own.id, webViewLink: own.webViewLink ?? null, existing: true }
  }

  const { data: named } = await drive.files.list({
    q: `name='${escapeQuery(pdf.filename)}' and '${escapeQuery(folderId)}' in parents and trashed=false`,
    fields: 'files(id,webViewLink,appProperties)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const sameName = named.files?.find(f => !!f.id && (f.appProperties?.documentId ?? doc.id) === doc.id)
  if (sameName?.id) {
    let tagged = !!sameName.appProperties?.documentId
    if (!tagged) {
      try {
        await drive.files.update({
          fileId: sameName.id,
          requestBody: { appProperties: { documentId: doc.id } },
          fields: 'id',
          supportsAllDrives: true,
        })
        tagged = true
      } catch (err) {
        // A file this account may not change (shared read-only) is not adopted.
        rethrowGoogleAccess(err)
        console.warn('[drive] same-named file not adopted, it could not be tagged:', err)
      }
    }
    if (tagged) {
      if (sameName.id !== doc.drive_file_id) await linkDriveFile(supabase, doc.id, sameName.id)
      if (!sameName.appProperties?.documentId) {
        await logEvent(supabase, doc.id, 'drive_archived', { file_id: sameName.id, link: sameName.webViewLink ?? null, name: pdf.filename, adopted: true })
      }
      return { fileId: sameName.id, webViewLink: sameName.webViewLink ?? null, existing: true }
    }
  }

  const body = new PassThrough()
  body.end(pdf.buffer)
  const { data: file } = await drive.files.create({
    requestBody: { name: pdf.filename, parents: [folderId], appProperties: { documentId: doc.id } },
    media: { mimeType: 'application/pdf', body },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })
  const fileId = file.id ?? null
  if (fileId) {
    await linkDriveFile(supabase, doc.id, fileId)
    await logEvent(supabase, doc.id, 'drive_archived', { file_id: fileId, link: file.webViewLink ?? null, name: pdf.filename })
  }
  return { fileId, webViewLink: file.webViewLink ?? null, existing: false }
}
