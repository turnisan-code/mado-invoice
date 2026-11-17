// Which parts of a Gmail message are PDFs, and which Gmail errors mean the connection is
// gone (P2-11). Pure, without a single import: lib/gmail.ts reads messages with it, and the
// tests run it without googleapis.

// A part of a Gmail message as the API answers it (googleapis' gmail_v1.Schema$MessagePart),
// as far as it is read here
export type GmailPart = {
  partId?: string | null
  mimeType?: string | null
  filename?: string | null
  body?: { attachmentId?: string | null; data?: string | null; size?: number | null } | null
  parts?: GmailPart[] | null
}

// A PDF part: its part id — what a row stores to find it again; an attachmentId is not
// stable between calls —, the name to give the file, and its data: an attachment to fetch,
// or inline (base64url). size: as Gmail states it, in bytes.
export type PdfPart = {
  partId: string | null
  filename: string
  attachmentId: string | null
  data: string | null
  size: number | null
}

// How many PDF parts of one e-mail Analyse looks at
export const MAX_PDF_PARTS_PER_MESSAGE = 3

const PDF_TYPES = ['application/pdf', 'application/x-pdf']
// Types a mailer gives a file whose type it does not know: then its name says PDF
const GENERIC_TYPES = ['', 'application/octet-stream', 'binary/octet-stream']

// A PDF by its type, or by its name („.pdf“ in any case) under a generic type
export function isPdfPart(part: GmailPart): boolean {
  const type = (part.mimeType ?? '').trim().toLowerCase()
  return PDF_TYPES.includes(type) || (GENERIC_TYPES.includes(type) && /\.pdf$/i.test((part.filename ?? '').trim()))
}

// Every PDF part, depth-first in MIME order, the payload itself included. A part with
// neither an attachment nor inline data has nothing to read and is left out.
function allPdfParts(payload: GmailPart | null | undefined): PdfPart[] {
  const out: PdfPart[] = []
  const walk = (part: GmailPart): void => {
    const attachmentId = part.body?.attachmentId || null
    const data = part.body?.data || null
    if (isPdfPart(part) && (attachmentId || data)) {
      out.push({ partId: part.partId ?? null, filename: part.filename || 'invoice.pdf', attachmentId, data, size: part.body?.size ?? null })
    }
    for (const child of part.parts ?? []) walk(child)
  }
  if (payload) walk(payload)
  return out
}

// The PDF parts of an e-mail that Analyse looks at: the first MAX_PDF_PARTS_PER_MESSAGE,
// in MIME order
export function pdfPartsOf(payload: GmailPart | null | undefined): PdfPart[] {
  return allPdfParts(payload).slice(0, MAX_PDF_PARTS_PER_MESSAGE)
}

/**
 * The PDF the selector before P2-11 takes (lib/gmail.ts getPdfAttachment, verbatim): it walks
 * the payload's parts only (not the payload itself), takes a part of type application/pdf or
 * whose name ends in „.pdf“ (lower case, any type), and keeps the name of the last such part
 * that has one (else „invoice.pdf“) and the last such part that has an attachmentId — which
 * can be another part than the name's. Inline data is never taken. The part id is that
 * attachment's part's. null without an attachmentId.
 *
 * A row analysed before P2-11 has no part id: its Beleg is fetched again by this selector, so
 * it gets the part its Analyse attached.
 */
export function legacyPdfPart(payload: GmailPart | null | undefined): { partId: string | null; filename: string; attachmentId: string } | null {
  let attachmentId = null as string | null
  let partId = null as string | null
  let filename = 'invoice.pdf'
  const findPdf = (parts: GmailPart[] | null | undefined): void => {
    if (!parts) return
    for (const part of parts) {
      if (part.mimeType === 'application/pdf' || part.filename?.endsWith('.pdf')) {
        filename = part.filename || filename
        if (part.body?.attachmentId) {
          attachmentId = part.body.attachmentId
          partId = part.partId ?? null
        }
      }
      if (part.parts) findPdf(part.parts)
    }
  }
  findPdf(payload?.parts || [])

  if (!attachmentId) return null
  return { partId, filename, attachmentId }
}

// The PDF part a row names by its part id, among all of the message's PDF parts (not only
// the ones Analyse looks at); null when the message has no PDF part of that id. Without a
// part id (a row analysed before P2-11): the part the selector before takes.
export function pdfPartFor(payload: GmailPart | null | undefined, partId: string | null | undefined): PdfPart | null {
  if (partId == null) {
    const legacy = legacyPdfPart(payload)
    return legacy && { ...legacy, data: null, size: null }
  }
  return allPdfParts(payload).find(p => p.partId === partId) ?? null
}

type ErrorShape = {
  message?: unknown
  status?: unknown
  code?: unknown
  errors?: unknown
  response?: { status?: unknown; data?: unknown } | null
}

// An HTTP status as googleapis' errors carry it (a number, or digits)
const statusOf = (v: unknown): number | null =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d{3}$/.test(v) ? Number(v) : null

// The reasons a Google API error gives: errors[].reason (google-auth-library copies them onto
// the error) and the newer error model's details[].reason
function reasonsOf(err: ErrorShape): string[] {
  const data = err.response?.data
  const body = data && typeof data === 'object' ? (data as { error?: unknown }).error : null
  const lists = [err.errors]
  if (body && typeof body === 'object') lists.push((body as { errors?: unknown }).errors, (body as { details?: unknown }).details)
  return lists.flatMap(list => Array.isArray(list) ? list.map(x => (x && typeof x === 'object' ? (x as { reason?: unknown }).reason : null)) : [])
    .filter((r): r is string => typeof r === 'string')
}

/**
 * Whether a Gmail error means the connection itself is gone, so that no later call of the run
 * can succeed: Gmail not connected, a refresh token Google refused (invalid_grant), HTTP 401,
 * or HTTP 403 for missing permissions. A 403 for a rate or daily limit, 429, 5xx and network
 * errors are not: the next call may well succeed.
 */
export function isGmailAuthError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as ErrorShape
  const message = typeof err.message === 'string' ? err.message : ''
  if (message.includes('Gmail not connected')) return true
  const data = err.response?.data
  if (/\binvalid_grant\b/.test(message) || (!!data && typeof data === 'object' && (data as { error?: unknown }).error === 'invalid_grant')) return true
  const statuses = [err.response?.status, err.status, err.code].map(statusOf)
  if (statuses.includes(401)) return true
  return statuses.includes(403) && reasonsOf(err).some(r => r === 'insufficientPermissions' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
}
