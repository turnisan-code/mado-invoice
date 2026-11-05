// Browser helpers for the frozen PDF of a numbered document: every outgoing copy (download,
// email, Drive, Bookamat) is the stored one, never a fresh render of the editor.
import type { TFn } from '@/lib/i18n'
import type { ArchiveErrorCode } from '@/lib/pdf/snapshot'

const ARCHIVE_ERROR_CODES: readonly ArchiveErrorCode[] = ['not_issued', 'stored_unreadable']

// The archive routes answer known failures with a code, worded here in the UI language.
export function archiveErrorMessage(t: TFn, payload: unknown, fallback: string): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; code?: unknown }
  const code = ARCHIVE_ERROR_CODES.find(c => c === p.code)
  if (code) return t(`archive.errors.${code}`)
  return typeof p.error === 'string' && p.error ? p.error : fallback
}

export async function fetchIssuedPdf(documentId: string, t: TFn): Promise<Blob> {
  const res = await fetch(`/api/documents/${documentId}/pdf`)
  if (!res.ok) throw new Error(archiveErrorMessage(t, await res.json().catch(() => ({})), res.statusText))
  return res.blob()
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(new Error('Failed to read PDF'))
    reader.readAsDataURL(blob)
  })
}

export const FLUSH_EDITS_EVENT = 'document-builder:flush'
export type FlushEditsDetail = { documentId: string; waitUntil: (pending: Promise<unknown>) => void }

// The server renders the frozen PDF from the database, so an edit still waiting for the
// builder's autosave on the same page has to be written before anything issues the document.
export async function flushPendingEdits(documentId: string): Promise<void> {
  const pending: Promise<unknown>[] = []
  const detail: FlushEditsDetail = { documentId, waitUntil: p => { pending.push(p) } }
  window.dispatchEvent(new CustomEvent<FlushEditsDetail>(FLUSH_EDITS_EVENT, { detail }))
  await Promise.allSettled(pending)
}
