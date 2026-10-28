import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/events'
import { viennaDate } from '@/lib/utils/document'
import { loadPdfDocument, loadSettings, pdfFilename, renderLoadedPdf, type PdfDocument } from './render'
import type { Settings } from '@/types'

const BUCKET = 'documents'

// Failures the UI words itself (archive.errors.*); any other failure carries the raw message.
export type ArchiveErrorCode = 'not_issued' | 'stored_unreadable'

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) {
    super(message)
  }
}

// Supabase Storage rejects keys outside this character set; a slash would also nest a folder.
export function storageKey(date: string, number: string) {
  return `${date.slice(0, 4)}/${number.replace(/[^\w!.*'() &$@=;:+,?-]/g, '_')}.pdf`
}

export async function readStoredPdf(supabase: SupabaseClient, path: string): Promise<Buffer | null> {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(path)
    return data ? Buffer.from(await data.arrayBuffer()) : null
  } catch (err) {
    console.error(`[snapshot] could not read ${path}:`, err)
    return null
  }
}

// Only a definite "no such object" counts; storage being unreachable is not a missing copy.
async function isStoredPdfMissing(supabase: SupabaseClient, path: string): Promise<boolean> {
  try {
    const { data } = await supabase.storage.from(BUCKET).exists(path)
    return data === false
  } catch {
    return false
  }
}

// The copy shows the document as issued: payments dated after the issue day are left out, so a
// copy made later for an older document does not read as already paid.
function asIssued(doc: PdfDocument): PdfDocument {
  const issuedOn = doc.issued_at ? viennaDate(new Date(doc.issued_at)) : doc.date
  return { ...doc, payments: (doc.payments ?? []).filter(p => p.date <= issuedOn) }
}

export type IssuedPdf = {
  buffer: Buffer
  filename: string
  path: string
  created: boolean
  doc: PdfDocument
  settings: Settings
}

// The frozen copy of a numbered document: the stored PDF when there is one, otherwise rendered
// now and stored. An existing object is never overwritten; if one is already at the key (a
// previous attempt stored it but could not link it), that object is adopted as the copy. When the
// linked object itself is gone (deleted in the Storage dashboard), a copy is stored again at the
// same key so outgoing actions keep working.
export async function getIssuedPdf(
  supabase: SupabaseClient,
  documentId: string,
  source: 'issue' | 'on_demand' | 'manual',
): Promise<IssuedPdf> {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, documentId), loadSettings(supabase)])
  if (!doc.number) throw new ArchiveError('not_issued', 'Only issued documents have an archive copy')
  const filename = pdfFilename(doc.number)

  if (doc.pdf_path) {
    const stored = await readStoredPdf(supabase, doc.pdf_path)
    if (stored) return { buffer: stored, filename, path: doc.pdf_path, created: false, doc, settings }
    if (!(await isStoredPdfMissing(supabase, doc.pdf_path))) {
      throw new ArchiveError('stored_unreadable', 'The stored PDF could not be read')
    }
  }

  const path = doc.pdf_path ?? storageKey(doc.date, doc.number)
  let buffer = await renderLoadedPdf(supabase, asIssued(doc), settings, { includeQr: true })
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { upsert: false, contentType: 'application/pdf' })
  if (uploadErr) {
    const existing = await readStoredPdf(supabase, path)
    if (!existing) throw new Error(uploadErr.message)
    buffer = existing
  }

  if (doc.pdf_path) {
    if (!uploadErr) await logEvent(supabase, doc.id, 'archived', { path, source, restored: true })
    return { buffer, filename, path, created: !uploadErr, doc, settings }
  }

  // Conditional, so two concurrent requests link (and log) the copy only once.
  const { data: linked, error: linkErr } = await supabase
    .from('documents')
    .update({ pdf_path: path })
    .eq('id', doc.id)
    .is('pdf_path', null)
    .select('id')
  if (linkErr) throw new Error(linkErr.message)
  const created = !!linked?.length
  if (created) await logEvent(supabase, doc.id, 'archived', { path, source })

  return { buffer, filename, path, created, doc: { ...doc, pdf_path: path }, settings }
}

// A reminder asks for what is still open. The frozen copy says so only while nothing has been
// paid; after a (part) payment the PDF is rendered from the current data, with the paid and open
// rows and a QR for the balance due. Never stored: the archive copy stays the issued one.
export async function getReminderPdf(supabase: SupabaseClient, doc: PdfDocument, settings: Settings): Promise<Buffer> {
  if (doc.pdf_path && !doc.payments?.length) {
    const stored = await readStoredPdf(supabase, doc.pdf_path)
    if (stored) return stored
  }
  return renderLoadedPdf(supabase, doc, settings)
}
