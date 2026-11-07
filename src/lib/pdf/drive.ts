import { PassThrough } from 'stream'
import { google, type drive_v3 } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthorizedGoogle, isGoogleAuthError, isGoogleNoAccess, isGoogleScopeError } from '@/lib/google/client'
import { logEvent } from '@/lib/events'
import { viennaDate } from '@/lib/utils/document'
import type { Document, DocumentType, Language, Settings } from '@/types'

export type DriveArchive = { fileId: string | null; webViewLink: string | null; existing: boolean }

type Drive = drive_v3.Drive
type ArchivedDocument = Pick<Document, 'id' | 'type' | 'date'> & { number: string; drive_file_id?: string | null }

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const

// The archive's layout inside the configured folder: <year of the document's date>/<type>. These
// names are the folders' identity in Drive, not UI text: a folder is found by either language's
// name, so switching the UI language never splits a year, and a missing one is created in the
// owner's UI language. Renaming one here leaves the folders made under the old name behind.
export const DRIVE_TYPE_FOLDERS: Record<DocumentType, Record<Language, string>> = {
  invoice: { en: 'Invoices', de: 'Rechnungen' },
  credit_note: { en: 'Credit notes', de: 'Gutschriften' },
  quote: { en: 'Quotes', de: 'Angebote' },
}
// Any other type that is ever archived.
const DRIVE_OTHER_FOLDER: Record<Language, string> = { en: 'Documents', de: 'Dokumente' }

export type DriveFolderStep = { names: string[]; create: string }

// The folders below the configured one, outermost first: each is looked up by any of `names` and
// created as `create` when none exists.
export function driveFolderPlan(doc: Pick<Document, 'type' | 'date'>, lang: Language): DriveFolderStep[] {
  const year = /^\d{4}-/.test(doc.date ?? '') ? doc.date.slice(0, 4) : viennaDate(new Date()).slice(0, 4)
  const pair = DRIVE_TYPE_FOLDERS[doc.type] ?? DRIVE_OTHER_FOLDER
  const create = pair[lang === 'en' ? 'en' : 'de']
  return [
    { names: [year], create: year },
    { names: [create, ...Object.values(pair).filter(n => n !== create)], create },
  ]
}

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

type Folder = { id: string; name: string }

function createdAt(file: drive_v3.Schema$File) {
  const at = Date.parse(file.createdTime ?? '')
  return Number.isNaN(at) ? Infinity : at
}

// Oldest first, then by id: every upload that sees the same folders picks the same one.
async function findFolders(drive: Drive, parentId: string, names: string[]): Promise<Folder[]> {
  const byName = names.map(n => `name='${escapeQuery(n)}'`).join(' or ')
  const { data } = await drive.files.list({
    q: `'${escapeQuery(parentId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false and (${byName})`,
    fields: 'files(id,name,createdTime)',
    pageSize: 100,
    ...ALL_DRIVES,
  })
  return (data.files ?? [])
    .filter(f => !!f.id)
    .sort((a, b) => createdAt(a) - createdAt(b) || (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0))
    .map(f => ({ id: f.id!, name: f.name ?? names[0] }))
}

// A duplicate this upload just made is moved to the trash while it is still empty; one that
// cannot be checked or moved stays, and later uploads use the oldest anyway.
async function discardFolder(drive: Drive, folderId: string) {
  try {
    const { data } = await drive.files.list({
      q: `'${escapeQuery(folderId)}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: 1,
      ...ALL_DRIVES,
    })
    if (data.files?.length) return
    await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, fields: 'id', supportsAllDrives: true })
  } catch (err) {
    console.warn('[drive] duplicate folder left in place:', err)
  }
}

// Looked up by name within its parent and created only when none exists. Drive has no unique
// names, so two uploads at the same moment can both create one: each looks again after creating
// and keeps the oldest, and the one that made a newer folder puts it in the trash.
async function findOrCreateFolder(drive: Drive, parentId: string, step: DriveFolderStep): Promise<Folder> {
  const [found] = await findFolders(drive, parentId, step.names)
  if (found) return found
  const { data: made } = await drive.files.create({
    requestBody: { name: step.create, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!made.id) throw new Error(`Drive folder "${step.create}" was not created`)
  const [oldest] = await findFolders(drive, parentId, step.names)
  if (!oldest || oldest.id === made.id) return { id: made.id, name: step.create }
  await discardFolder(drive, made.id)
  return oldest
}

// Uploads running in this server instance at once share one lookup per folder, so they never
// race each other; uploads in other instances are settled by findOrCreateFolder.
const pendingFolders = new Map<string, Promise<Folder>>()

function ensureFolder(drive: Drive, parentId: string, step: DriveFolderStep): Promise<Folder> {
  const key = `${parentId}\n${[...step.names].sort().join('\n')}`
  const pending = pendingFolders.get(key)
  if (pending) return pending
  const lookup = findOrCreateFolder(drive, parentId, step).finally(() => pendingFolders.delete(key))
  pendingFolders.set(key, lookup)
  return lookup
}

// The folder the document's PDF is uploaded to, and its path below the configured folder. When the
// connection may not look into or add to the configured folder (a folder shared read-only, or one
// the grant cannot see into), the PDF goes into the configured folder itself, as before the year and
// type folders; that upload then reports any lasting problem.
async function archiveFolder(drive: Drive, rootId: string, doc: ArchivedDocument, lang: Language): Promise<{ id: string; path: string | null }> {
  const names: string[] = []
  let parent = rootId
  try {
    for (const step of driveFolderPlan(doc, lang)) {
      const folder = await ensureFolder(drive, parent, step)
      parent = folder.id
      names.push(folder.name)
    }
    return { id: parent, path: names.join('/') }
  } catch (err) {
    if (!isGoogleNoAccess(err)) throw err
    console.warn('[drive] year and type folders unavailable, uploading to the configured folder:', err)
    return { id: rootId, path: null }
  }
}

// A file with the document's file name in one of `parents` that nothing marks as another
// document's (no documentId tag, e.g. one uploaded before files were tagged) is adopted: it is
// tagged then, so it is found by the tag from now on.
async function adoptSameName(
  drive: Drive,
  supabase: SupabaseClient,
  doc: ArchivedDocument,
  filename: string,
  parents: { id: string; path: string | null }[],
): Promise<DriveArchive | null> {
  const inParents = parents.map(p => `'${escapeQuery(p.id)}' in parents`).join(' or ')
  const { data: named } = await drive.files.list({
    q: `name='${escapeQuery(filename)}' and (${inParents}) and trashed=false`,
    fields: 'files(id,webViewLink,appProperties,parents)',
    pageSize: 10,
    ...ALL_DRIVES,
  })
  const sameName = named.files?.find(f => !!f.id && (f.appProperties?.documentId ?? doc.id) === doc.id)
  if (!sameName?.id) return null
  if (!sameName.appProperties?.documentId) {
    try {
      await drive.files.update({
        fileId: sameName.id,
        requestBody: { appProperties: { documentId: doc.id } },
        fields: 'id',
        supportsAllDrives: true,
      })
    } catch (err) {
      // A file this account may not change (shared read-only) is not adopted.
      rethrowGoogleAccess(err)
      console.warn('[drive] same-named file not adopted, it could not be tagged:', err)
      return null
    }
  }
  if (sameName.id !== doc.drive_file_id) await linkDriveFile(supabase, doc.id, sameName.id)
  if (!sameName.appProperties?.documentId) {
    const folder = parents.find(p => sameName.parents?.includes(p.id))?.path ?? null
    await logEvent(supabase, doc.id, 'drive_archived', { file_id: sameName.id, link: sameName.webViewLink ?? null, name: filename, folder, adopted: true })
  }
  return { fileId: sameName.id, webViewLink: sameName.webViewLink ?? null, existing: true }
}

// Archives the issued PDF as a new file named after the number, in <configured folder>/<year of
// the document's date>/<type folder> (Invoices, Credit notes, Quotes; Rechnungen, Gutschriften,
// Angebote), creating those folders as needed. An archived file is never overwritten, renamed or
// moved: the document's own file (by stored id or by the documentId tag set on upload, wherever it
// is, also in the configured folder itself, where PDFs went before the year and type folders) is
// returned as it is. An untagged file with the same name, in the configured folder or the year and
// type folder, is adopted (adoptSameName). Otherwise a new file is uploaded next to it.
export async function archiveToDrive(
  supabase: SupabaseClient,
  settings: Settings,
  doc: ArchivedDocument,
  pdf: { buffer: Buffer; filename: string },
): Promise<DriveArchive> {
  const rootId = settings.drive_folder_id
  if (!rootId) throw new Error('No Drive folder configured')
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
    ...ALL_DRIVES,
  })
  const own = tagged.files?.[0]
  if (own?.id) {
    if (own.id !== doc.drive_file_id) await linkDriveFile(supabase, doc.id, own.id)
    return { fileId: own.id, webViewLink: own.webViewLink ?? null, existing: true }
  }

  // The configured folder first: a copy already there needs no year or type folder.
  const root = { id: rootId, path: null }
  const inRoot = await adoptSameName(drive, supabase, doc, pdf.filename, [root])
  if (inRoot) return inRoot

  const folder = await archiveFolder(drive, rootId, doc, settings.ui_language)
  if (folder.id !== rootId) {
    const inFolder = await adoptSameName(drive, supabase, doc, pdf.filename, [folder])
    if (inFolder) return inFolder
  }

  const body = new PassThrough()
  body.end(pdf.buffer)
  const { data: file } = await drive.files.create({
    requestBody: { name: pdf.filename, parents: [folder.id], appProperties: { documentId: doc.id } },
    media: { mimeType: 'application/pdf', body },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })
  const fileId = file.id ?? null
  if (fileId) {
    await linkDriveFile(supabase, doc.id, fileId)
    await logEvent(supabase, doc.id, 'drive_archived', { file_id: fileId, link: file.webViewLink ?? null, name: pdf.filename, folder: folder.path })
  }
  return { fileId, webViewLink: file.webViewLink ?? null, existing: false }
}
