import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/events'
import { loadPdfDocument, loadSettings, pdfFilename, renderLoadedPdf, type PdfDocument } from './render'
import type { Settings } from '@/types'

const BUCKET = 'documents'

export class NotIssuedError extends Error {}

// Supabase Storage rejects keys outside this character set; a slash would also nest a folder.
export function storageKey(date: string, number: string) {
  return `${date.slice(0, 4)}/${number.replace(/[^\w!.*'() &$@=;:+,?-]/g, '_')}.pdf`
}

async function download(supabase: SupabaseClient, path: string): Promise<Buffer | null> {
  const { data } = await supabase.storage.from(BUCKET).download(path)
  return data ? Buffer.from(await data.arrayBuffer()) : null
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
// previous attempt stored it but could not link it), that object is adopted as the copy.
export async function getIssuedPdf(
  supabase: SupabaseClient,
  documentId: string,
  source: 'issue' | 'on_demand' | 'manual',
): Promise<IssuedPdf> {
  const [doc, settings] = await Promise.all([loadPdfDocument(supabase, documentId), loadSettings(supabase)])
  if (!doc.number) throw new NotIssuedError('Only issued documents have an archive copy')
  const filename = pdfFilename(doc.number)

  if (doc.pdf_path) {
    const stored = await download(supabase, doc.pdf_path)
    if (!stored) throw new Error('The stored PDF could not be read')
    return { buffer: stored, filename, path: doc.pdf_path, created: false, doc, settings }
  }

  const path = storageKey(doc.date, doc.number)
  let buffer = await renderLoadedPdf(supabase, doc, settings, { includeQr: true })
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { upsert: false, contentType: 'application/pdf' })
  if (uploadErr) {
    const existing = await download(supabase, path)
    if (!existing) throw new Error(uploadErr.message)
    buffer = existing
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
