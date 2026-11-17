// Reading receipts from Gmail (PR 9b „Belege aus Gmail“): the searches, the messages they find
// and their PDF parts, within one search's budgets. Ported from Bookmatic's lib/gmail.ts
// (475072f); Bookmatic's own OAuth (one token row, drive.readonly) is not: the Gmail API comes
// from Mado's Google connection (lib/google/client.ts getAuthorizedGoogle, with gmail.readonly)
// and is passed in (gmailSearches). Gmail is only read. Server only.
import { createHash } from 'node:crypto'
import { google, type gmail_v1 } from 'googleapis'
// Gmail's attachment data is base64url; everything downstream (Anthropic, pdf-parse,
// bookamat) gets standard base64 from here on.
import { toStandardBase64 } from './base64'
import { sniffAttachmentType } from './attachment'
// Which parts are PDFs, a part by its id — the selector before P2-11 without one (pure)
import { pdfPartFor, pdfPartsOf, type GmailPart, type PdfPart } from './gmail-parts'

// One PDF part of an e-mail (lib/gmail-parts.ts pdfPartsOf), downloaded — or why not: over
// MAX_PDF_BYTES, bytes that are no PDF, a failed download, or beyond what one search
// downloads. base64: standard base64; sha256: of the bytes, hex.
export interface GmailPdf {
  partId: string | null
  filename: string
  base64: string | null
  size: number | null
  sha256: string | null
  skipped?: 'too_large' | 'not_pdf' | 'download_failed' | 'row_budget'
}

export interface GmailMessage {
  messageId: string
  subject: string
  from: string
  date: string
  bodyText: string         // plain-text email body for keyword matching
  // Every PDF part Analyse looks at (pdfPartsOf), in MIME order: which of them is the
  // receipt is lib/receipt-match.ts pickGmailReceipt's to say
  pdfs: GmailPdf[]
}

// A Gmail payload: the message's top part, with its headers
export type GmailPayload = GmailPart & { headers?: { name?: string | null; value?: string | null }[] | null }

// Extract readable text from a Gmail message payload (handles multipart)
function extractBodyText(payload: GmailPart | null | undefined): string {
  if (!payload) return ''
  // Decode a single part's data
  if (payload.body?.data) {
    const raw = Buffer.from(payload.body.data, 'base64url').toString('utf-8')
    if (payload.mimeType === 'text/plain') return raw
    if (payload.mimeType === 'text/html') return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  }
  if (!payload.parts) return ''
  // Prefer text/plain
  for (const part of payload.parts) {
    if (part.mimeType === 'text/plain' && part.body?.data)
      return Buffer.from(part.body.data, 'base64url').toString('utf-8')
  }
  // Fall back to text/html
  for (const part of payload.parts) {
    if (part.mimeType === 'text/html' && part.body?.data)
      return Buffer.from(part.body.data, 'base64url').toString('utf-8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  }
  // Recurse into nested multipart
  for (const part of payload.parts) {
    const text = extractBodyText(part)
    if (text) return text
  }
  return ''
}

// ─── The calls ────────────────────────────────────────────────────────────────

// Each Gmail call gives up after this (googleapis has no timeout of its own)
export const GMAIL_CALL_TIMEOUT_MS = 15_000

// Runs a call when the caller's budget of calls in flight allows it
export type GmailLimit = <T>(call: () => Promise<T>) => Promise<T>
// limit: the caller's limiter (default: one call at a time, as before P2-11); signal: aborts
// every call made for the caller
export type GmailCallOptions = { limit?: GmailLimit; signal?: AbortSignal }

// One call at a time, in the order asked: the pace of a caller that passes no limiter
function oneAtATime(): GmailLimit {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = last.then(call, call)
    last = run.then(() => undefined, () => undefined)
    return run
  }
}

// The Gmail calls made here (read-only), each through the limiter, with the signal and the
// timeout. Tests pass their own.
export type GmailCalls = {
  // The ids of the messages a query finds
  list(q: string, maxResults: number): Promise<string[]>
  // A message's payload (format full)
  message(id: string): Promise<GmailPayload | null>
  // An attachment's data (base64url)
  attachment(messageId: string, attachmentId: string): Promise<string | null>
}

export function gmailCalls(gmail: gmail_v1.Gmail, { limit = oneAtATime(), signal }: GmailCallOptions = {}): GmailCalls {
  const options = { signal, timeout: GMAIL_CALL_TIMEOUT_MS }
  return {
    list: async (q, maxResults) => {
      const res = await limit(() => gmail.users.messages.list({ userId: 'me', q, maxResults }, options))
      return (res.data.messages ?? []).map(m => m.id).filter((id): id is string => !!id)
    },
    message: async id => (await limit(() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }, options))).data.payload ?? null,
    attachment: async (messageId, id) =>
      (await limit(() => gmail.users.messages.attachments.get({ userId: 'me', messageId, id }, options))).data.data ?? null,
  }
}

// The Gmail API of an authorised Google connection
export const gmailApiOf = (auth: gmail_v1.Options['auth']): gmail_v1.Gmail => google.gmail({ version: 'v1', auth })

// The ids the first query that finds anything finds, the queries tried in order
async function firstFound(calls: GmailCalls, queries: string[], maxResults: number): Promise<string[]> {
  for (const q of queries) {
    const ids = await calls.list(q, maxResults)
    if (ids.length) return ids
  }
  return []
}

// ─── The PDFs of the messages a search found ────────────────────────────────

// A part over this is not downloaded
export const MAX_PDF_BYTES = 10 * 1024 * 1024
// What one search downloads at most: parts, and bytes by the sizes Gmail states
export const MAX_PDFS_PER_SEARCH = 6
export const MAX_PDF_BYTES_PER_SEARCH = 15 * 1024 * 1024

const INVOICE_NAME = /rechnung|invoice|receipt|beleg|quittung|bill/i

// Which PDF parts of a search's messages are downloaded, in the order they are asked for:
// ranked by what Gmail says of them before any download — the bank text's invoice number in
// the file name or the subject, then an invoice-like file name, then Gmail's order —, a
// part over MAX_PDF_BYTES never, at most MAX_PDFS_PER_SEARCH parts and
// MAX_PDF_BYTES_PER_SEARCH bytes
function downloadOrder(
  messages: readonly { subject: string; parts: readonly PdfPart[] }[],
  invoiceNumber: string | null | undefined,
): { message: number; part: number; take: 'download' | 'too_large' | 'row_budget' }[] {
  const rank = (p: PdfPart, subject: string) =>
    invoiceNumber && (p.filename.includes(invoiceNumber) || subject.includes(invoiceNumber)) ? 0 : INVOICE_NAME.test(p.filename) ? 1 : 2
  const ranked = messages
    .flatMap((m, message) => m.parts.map((p, part) => ({ message, part, rank: rank(p, m.subject) })))
    .sort((a, b) => a.rank - b.rank)
  let parts = 0
  let bytes = 0
  return ranked.map(({ message, part }) => {
    const size = messages[message].parts[part].size ?? 0
    if (size > MAX_PDF_BYTES) return { message, part, take: 'too_large' as const }
    if (parts >= MAX_PDFS_PER_SEARCH || bytes + size > MAX_PDF_BYTES_PER_SEARCH) return { message, part, take: 'row_budget' as const }
    parts += 1
    bytes += size
    return { message, part, take: 'download' as const }
  })
}

// A PDF part's bytes, checked: no PDF by its first bytes → not kept
function pdfOf(part: PdfPart, data: string | null): GmailPdf {
  const meta = { partId: part.partId, filename: part.filename, size: part.size }
  if (!data) return { ...meta, base64: null, sha256: null, skipped: 'download_failed' }
  const bytes = Buffer.from(data, 'base64url')
  if (sniffAttachmentType(bytes) !== 'pdf') return { ...meta, base64: null, sha256: null, skipped: 'not_pdf' }
  return { ...meta, base64: toStandardBase64(data), sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * The messages of `ids` (in that order): headers, text and every PDF part Analyse looks at,
 * downloaded as downloadOrder says. A message that cannot be read fails the search, as
 * before; a download that fails is said on its part. Each attachment is downloaded once.
 */
export async function readMessages(calls: GmailCalls, ids: string[], invoiceNumber?: string | null): Promise<GmailMessage[]> {
  const payloads = await Promise.all(ids.map(id => calls.message(id)))
  const read = ids.map((id, k) => {
    const payload = payloads[k]
    const header = (name: string) => payload?.headers?.find(h => h.name === name)?.value || ''
    return { id, payload, subject: header('Subject'), from: header('From'), date: header('Date'), parts: pdfPartsOf(payload) }
  })

  const fetched = new Map<string, Promise<string | null>>()
  const attachment = (messageId: string, attachmentId: string): Promise<string | null> => {
    const key = `${messageId}/${attachmentId}`
    let data = fetched.get(key)
    if (!data) {
      data = calls.attachment(messageId, attachmentId).catch(() => null)
      fetched.set(key, data)
    }
    return data
  }

  const pdfs: GmailPdf[][] = read.map(() => [])
  await Promise.all(downloadOrder(read, invoiceNumber).map(async ({ message, part, take }) => {
    const m = read[message]
    const p = m.parts[part]
    pdfs[message][part] = take === 'download'
      ? pdfOf(p, p.data ?? (p.attachmentId ? await attachment(m.id, p.attachmentId) : null))
      : { partId: p.partId, filename: p.filename, size: p.size, base64: null, sha256: null, skipped: take }
  }))

  return read.map((m, k) => ({
    messageId: m.id,
    subject: m.subject,
    from: m.from,
    date: m.date,
    bodyText: extractBodyText(m.payload),
    pdfs: pdfs[k],
  }))
}

// ─── Searches ─────────────────────────────────────────────────────────────────

export type SenderSearch = {
  senderDomain: string
  dateFrom: Date
  dateTo: Date
  invoiceNumber?: string  // if provided, include in search for precise matching
}

// The sender search through the caller's Gmail calls (tests pass their own)
export async function senderSearch(calls: GmailCalls, params: SenderSearch): Promise<GmailMessage[]> {
  const afterDate = Math.floor(params.dateFrom.getTime() / 1000)
  const beforeDate = Math.floor(params.dateTo.getTime() / 1000)

  // If we have an invoice number, search for it specifically first
  // Fall back to date-range search, then to a search without attachment requirement
  // (some processors like Paddle now send HTML-only receipts without PDF attachments)
  const queries = params.invoiceNumber
    ? [
        `from:${params.senderDomain} ${params.invoiceNumber} has:attachment`,
        `from:${params.senderDomain} after:${afterDate} before:${beforeDate} has:attachment`,
        `from:${params.senderDomain} after:${afterDate} before:${beforeDate}`,
      ]
    : [
        `from:${params.senderDomain} after:${afterDate} before:${beforeDate} has:attachment`,
        `from:${params.senderDomain} after:${afterDate} before:${beforeDate}`,
      ]

  return readMessages(calls, await firstFound(calls, queries, 5), params.invoiceNumber)
}

// A message's PDF part by its part id — without one, the part the selector before P2-11
// takes (pdfPartFor) —, read by its attachmentId or from its inline data
export async function readPdfPart(
  calls: GmailCalls,
  messageId: string,
  partId: string | null,
): Promise<{ base64: string; filename: string } | null> {
  const part = pdfPartFor(await calls.message(messageId), partId)
  if (!part) return null
  const data = part.data ?? (part.attachmentId ? await calls.attachment(messageId, part.attachmentId) : null)
  return data ? { base64: toStandardBase64(data), filename: part.filename } : null
}

// The queries of a broad keyword search: the first two words of the name that are longer
// than three letters, quoted — with an attachment, then without; none without such a word
export function keywordQueries(params: { keyword: string; dateFrom: Date; dateTo: Date }): string[] {
  const after = Math.floor(params.dateFrom.getTime() / 1000)
  const before = Math.floor(params.dateTo.getTime() / 1000)

  // Strip payment processor prefixes so we search for the real vendor.
  // "KLARNA*THOMANN DE\\..." → "THOMANN DE\\..."
  // "PADDLE.NET* KLANGIO\\..." → "KLANGIO\\..."
  let searchText = params.keyword
  if (searchText.includes('*')) {
    searchText = searchText.split('*').slice(1).join('').trim()
  }

  // Sanitize: take first 2 meaningful words, skip BIC codes and short tokens
  const keyword = searchText
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^[A-Z]{2}\d/.test(w))
    .slice(0, 2)
    .join(' ')

  if (!keyword) return []
  // Fallback: some processors send HTML-only receipts without PDF attachments
  return [
    `"${keyword}" has:attachment after:${after} before:${before}`,
    `"${keyword}" after:${after} before:${before}`,
  ]
}

// Broad keyword search — used for unknown vendors where we don't know the email sender.
// Searches subject/body for the keyword within the date window. invoiceNumber: the bank
// text's, as written there — its PDF parts are downloaded first (downloadOrder), as a
// sender search's are.
export type KeywordSearch = { keyword: string; dateFrom: Date; dateTo: Date; invoiceNumber?: string }

// The keyword search through the caller's Gmail calls (tests pass their own)
export async function keywordSearch(calls: GmailCalls, params: KeywordSearch): Promise<GmailMessage[]> {
  const queries = keywordQueries(params)
  if (!queries.length) return []
  return readMessages(calls, await firstFound(calls, queries, 3), params.invoiceNumber)
}

// The searches and the PDF fetch on one Gmail API, each call through the caller's limiter and
// signal: the search of a line (lib/expenses/gmail-receipt.ts), its preview and „Anhängen“
// (the part a line names, by its id)
export function gmailSearches(gmail: gmail_v1.Gmail) {
  return {
    searchInvoices: (params: SenderSearch, opts: GmailCallOptions = {}) => senderSearch(gmailCalls(gmail, opts), params),
    searchInvoicesByKeyword: (params: KeywordSearch, opts: GmailCallOptions = {}) => keywordSearch(gmailCalls(gmail, opts), params),
    getPdfAttachment: (messageId: string, partId: string | null = null, opts: GmailCallOptions = {}) =>
      readPdfPart(gmailCalls(gmail, opts), messageId, partId),
  }
}
