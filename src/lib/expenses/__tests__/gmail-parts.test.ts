import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isGmailAuthError, isPdfPart, legacyPdfPart, pdfPartFor, pdfPartsOf, MAX_PDF_PARTS_PER_MESSAGE, type GmailPart,
} from '../gmail-parts'

// The Gmail layer of P2-11 (PR „Job 1 fixes“ § 2.1 B): which parts of an e-mail are PDFs,
// the selector before P2-11 for rows that name no part, and which errors mean the Gmail
// connection is gone. Synthetic messages: made-up names, message ids msg-…, invoice
// numbers 2025019xx / 910000000xxx.

const part = (partId: string, mimeType: string, filename: string, body: GmailPart['body'] = {}, parts?: GmailPart[]): GmailPart =>
  ({ partId, mimeType, filename, body, ...(parts ? { parts } : {}) })
const pdf = (partId: string, filename: string, over: { mimeType?: string; attachmentId?: string | null; data?: string; size?: number } = {}): GmailPart =>
  part(partId, over.mimeType ?? 'application/pdf', filename, {
    attachmentId: over.attachmentId === undefined ? `att-${partId}` : over.attachmentId,
    ...(over.data ? { data: over.data } : {}),
    size: over.size ?? 2048,
  })
const html = (partId: string) => part(partId, 'text/html', '', { data: Buffer.from('<p>Ihre Rechnung</p>').toString('base64url'), size: 20 })
const text = (partId: string) => part(partId, 'text/plain', '', { data: Buffer.from('Ihre Rechnung').toString('base64url'), size: 13 })
const message = (...parts: GmailPart[]): GmailPart => part('', 'multipart/mixed', '', { size: 0 }, parts)
// Inline data of a small PDF (base64url)
const INLINE = Buffer.from('%PDF-1.4\n%%EOF').toString('base64url')

// The usual invoice e-mail: its text, the invoice, the terms
const INVOICE_AND_TERMS = message(html('0'), pdf('1', 'Rechnung_2026-07.pdf'), pdf('2', 'AGB.pdf'))
// The critic's case: the invoice typed as a PDF, the terms as a generic file named „.PDF“
const CRITIC = message(text('0'), pdf('1', 'Rechnung.pdf'), pdf('2', 'AGB.PDF', { mimeType: 'application/octet-stream' }))

describe('pdfPartsOf — every PDF part of an e-mail, with its part id (P2-11)', () => {
  test('multipart/mixed [text/html, the invoice, the terms]: both PDFs, in MIME order, each with its part id, name, attachment and size', () => {
    assert.deepEqual(pdfPartsOf(INVOICE_AND_TERMS), [
      { partId: '1', filename: 'Rechnung_2026-07.pdf', attachmentId: 'att-1', data: null, size: 2048 },
      { partId: '2', filename: 'AGB.pdf', attachmentId: 'att-2', data: null, size: 2048 },
    ])
  })
  test('nested parts: depth-first, by their own part id', () => {
    const nested = message(
      part('0', 'multipart/alternative', '', { size: 0 }, [text('0.0'), html('0.1')]),
      part('1', 'multipart/related', '', { size: 0 }, [html('1.0'), pdf('1.1', 'Rechnung.pdf')]),
      pdf('2', 'Lieferschein.pdf'),
    )
    assert.deepEqual(pdfPartsOf(nested).map(p => p.partId), ['1.1', '2'])
  })
  test('by type (application/pdf, application/x-pdf, any case), or by a name ending in „.pdf“ in any case under a generic type', () => {
    const parts = [
      pdf('1', 'BELEG.PDF', { mimeType: 'application/octet-stream' }),
      pdf('2', 'beleg.Pdf', { mimeType: 'binary/octet-stream' }),
      pdf('3', 'rechnung.pdf', { mimeType: '' }),
      pdf('4', 'scan', { mimeType: 'application/x-pdf' }),
      pdf('5', 'rechnung', { mimeType: 'Application/PDF' }),
    ]
    for (const p of parts) assert.equal(isPdfPart(p), true, `${p.mimeType} ${p.filename}`)
    assert.deepEqual(pdfPartsOf(message(...parts.slice(0, 3))).map(p => p.filename), ['BELEG.PDF', 'beleg.Pdf', 'rechnung.pdf'])
  })
  test('no PDF: an image, an image or another type named „.pdf“, a generic file named otherwise', () => {
    for (const p of [
      pdf('1', 'scan.png', { mimeType: 'image/png' }),
      pdf('2', 'scan.pdf', { mimeType: 'image/png' }),
      pdf('3', 'Rechnung.pdf', { mimeType: 'application/force-download' }),
      pdf('4', 'Rechnung.zip', { mimeType: 'application/octet-stream' }),
      pdf('5', 'Rechnung.pdf.html', { mimeType: '' }),
    ]) assert.equal(isPdfPart(p), false, `${p.mimeType} ${p.filename}`)
    assert.deepEqual(pdfPartsOf(message(html('0'), pdf('1', 'scan.png', { mimeType: 'image/png' }))), [])
  })
  test('inline data counts (no attachment to fetch); a PDF part with neither has nothing to read; no name: „invoice.pdf“', () => {
    const inline = pdf('1', '', { attachmentId: null, data: INLINE, size: 14 })
    const empty = pdf('2', 'leer.pdf', { attachmentId: null })
    assert.deepEqual(pdfPartsOf(message(inline, empty)), [{ partId: '1', filename: 'invoice.pdf', attachmentId: null, data: INLINE, size: 14 }])
  })
  test('the payload itself: an e-mail that is one PDF', () => {
    const single: GmailPart = { partId: '', mimeType: 'application/pdf', filename: 'Rechnung.pdf', body: { attachmentId: 'att-root', size: 100 } }
    assert.deepEqual(pdfPartsOf(single), [{ partId: '', filename: 'Rechnung.pdf', attachmentId: 'att-root', data: null, size: 100 }])
  })
  test('four PDFs: the first three', () => {
    assert.equal(MAX_PDF_PARTS_PER_MESSAGE, 3)
    const four = message(pdf('1', 'a.pdf'), pdf('2', 'b.pdf'), pdf('3', 'c.pdf'), pdf('4', 'd.pdf'))
    assert.deepEqual(pdfPartsOf(four).map(p => p.filename), ['a.pdf', 'b.pdf', 'c.pdf'])
    assert.deepEqual(pdfPartsOf(null), [])
  })
})

// The selectors before P2-11, copied from lib/gmail.ts as it was (getPdfAttachment's, and
// searchInvoices' — which named an unnamed last PDF „invoice.pdf“): legacyPdfPart must take
// what they took
function getPdfAttachmentBefore(payload: GmailPart): { attachmentId: string; filename: string } | null {
  let attachmentId = null as string | null
  let filename = 'invoice.pdf'
  const findPdf = (parts: GmailPart['parts']): void => {
    if (!parts) return
    for (const part of parts) {
      if (part.mimeType === 'application/pdf' || part.filename?.endsWith('.pdf')) {
        filename = part.filename || filename
        if (part.body?.attachmentId) attachmentId = part.body.attachmentId
      }
      if (part.parts) findPdf(part.parts)
    }
  }
  findPdf(payload?.parts || [])
  return attachmentId ? { attachmentId, filename } : null
}
function searchInvoicesBefore(payload: GmailPart): { attachmentId: string | null; filename: string | null } {
  let pdfBase64 = null as string | null
  let pdfFilename = null as string | null
  const findPdf = (parts: GmailPart['parts']): void => {
    if (!parts) return
    for (const part of parts) {
      if (part.mimeType === 'application/pdf' || part.filename?.endsWith('.pdf')) {
        pdfFilename = part.filename || 'invoice.pdf'
        const attachmentId = part.body?.attachmentId
        if (attachmentId) {
          pdfBase64 = attachmentId
        }
      }
      if (part.parts) findPdf(part.parts)
    }
  }
  findPdf(payload?.parts || [])
  return { attachmentId: pdfBase64, filename: pdfFilename }
}

describe('legacyPdfPart — the selector before P2-11, verbatim: the part a row without a part id gets again', () => {
  const SPLIT = message(pdf('1', 'a.pdf'), pdf('2', 'b.pdf', { attachmentId: null, data: INLINE }))
  const UNNAMED_LAST = message(pdf('1', 'a.pdf'), pdf('2', ''))
  const FIXTURES: [string, GmailPart][] = [
    ['the invoice and the terms', INVOICE_AND_TERMS],
    ['the critic’s case', CRITIC],
    ['the name and the data from two parts', SPLIT],
    ['an unnamed last PDF', UNNAMED_LAST],
    ['nested', message(part('0', 'multipart/related', '', {}, [html('0.0'), pdf('0.1', 'Rechnung.pdf')]), pdf('1', 'Info.pdf', { mimeType: 'text/plain' }))],
    ['a „.pdf“ of another type', message(pdf('1', 'Rechnung.pdf', { mimeType: 'application/force-download' }))],
    ['a „.PDF“ under a generic type only', message(pdf('1', 'BELEG.PDF', { mimeType: 'application/octet-stream' }))],
    ['four PDFs', message(pdf('1', 'a.pdf'), pdf('2', 'b.pdf'), pdf('3', 'c.pdf'), pdf('4', 'd.pdf'))],
    ['inline data only', message(pdf('1', 'inline.pdf', { attachmentId: null, data: INLINE }))],
    ['the payload itself a PDF', { partId: '', mimeType: 'application/pdf', filename: 'Rechnung.pdf', body: { attachmentId: 'att-root' } }],
    ['no PDF', message(html('0'))],
  ]

  test('the critic’s case [„Rechnung.pdf“ application/pdf, „AGB.PDF“ octet-stream]: Rechnung.pdf — where every-part reading sees both', () => {
    assert.deepEqual(legacyPdfPart(CRITIC), { partId: '1', filename: 'Rechnung.pdf', attachmentId: 'att-1' })
    assert.deepEqual(pdfPartsOf(CRITIC).map(p => p.filename), ['Rechnung.pdf', 'AGB.PDF'])
  })
  test('two PDFs with attachments: the last', () => {
    assert.deepEqual(legacyPdfPart(message(pdf('1', 'a.pdf'), pdf('2', 'b.pdf'))), { partId: '2', filename: 'b.pdf', attachmentId: 'att-2' })
    assert.deepEqual(legacyPdfPart(INVOICE_AND_TERMS), { partId: '2', filename: 'AGB.pdf', attachmentId: 'att-2' })
  })
  test('the last PDF without an attachment: its name, the earlier attachment and its part id (the split as before)', () => {
    assert.deepEqual(legacyPdfPart(SPLIT), { partId: '1', filename: 'b.pdf', attachmentId: 'att-1' })
  })
  test('the last PDF unnamed: the last name there is; no attachment, inline data only, the payload itself or no PDF: none', () => {
    assert.deepEqual(legacyPdfPart(UNNAMED_LAST), { partId: '2', filename: 'a.pdf', attachmentId: 'att-2' })
    assert.equal(legacyPdfPart(message(pdf('1', 'inline.pdf', { attachmentId: null, data: INLINE }))), null)
    assert.equal(legacyPdfPart({ partId: '', mimeType: 'application/pdf', filename: 'Rechnung.pdf', body: { attachmentId: 'att-root' } }), null)
    assert.equal(legacyPdfPart(message(html('0'))), null)
    assert.equal(legacyPdfPart(null), null)
  })
  test('a lower-case „.pdf“ of any type is taken; a „.PDF“ under a generic type is not', () => {
    assert.equal(legacyPdfPart(message(pdf('1', 'Rechnung.pdf', { mimeType: 'application/force-download' })))?.partId, '1')
    assert.equal(legacyPdfPart(message(pdf('1', 'BELEG.PDF', { mimeType: 'application/octet-stream' }))), null)
  })
  test('on every fixture: the attachment and the name the code it replaced took (getPdfAttachment before P2-11)', () => {
    for (const [name, payload] of FIXTURES) {
      const now = legacyPdfPart(payload)
      assert.deepEqual(now && { attachmentId: now.attachmentId, filename: now.filename }, getPdfAttachmentBefore(payload), name)
    }
  })
  test('on every fixture: the attachment Analyse attached before P2-11 (searchInvoices) — its name too, unless the last PDF has none', () => {
    for (const [name, payload] of FIXTURES) {
      const before = searchInvoicesBefore(payload)
      assert.equal(legacyPdfPart(payload)?.attachmentId ?? null, before.attachmentId, name)
      if (before.attachmentId && payload !== UNNAMED_LAST) assert.equal(legacyPdfPart(payload)?.filename, before.filename, name)
    }
    // Analyse named an unnamed last PDF „invoice.pdf“; the booking's refetch named it as now
    assert.equal(searchInvoicesBefore(UNNAMED_LAST).filename, 'invoice.pdf')
  })
})

describe('pdfPartFor — the part a row names', () => {
  test('by its part id among the PDF parts: „2“ is the terms; without one (a row analysed before P2-11): the old selector’s', () => {
    assert.deepEqual(pdfPartFor(CRITIC, '2'), { partId: '2', filename: 'AGB.PDF', attachmentId: 'att-2', data: null, size: 2048 })
    assert.deepEqual(pdfPartFor(CRITIC, null), { partId: '1', filename: 'Rechnung.pdf', attachmentId: 'att-1', data: null, size: null })
    assert.deepEqual(pdfPartFor(CRITIC, undefined), pdfPartFor(CRITIC, null))
  })
  test('any of the e-mail’s PDF parts, also past the three Analyse looks at; inline data as it is', () => {
    const five = message(pdf('1', 'a.pdf'), pdf('2', 'b.pdf'), pdf('3', 'c.pdf'), pdf('4', 'd.pdf'), pdf('5', 'e.pdf', { attachmentId: null, data: INLINE }))
    assert.equal(pdfPartFor(five, '4')?.filename, 'd.pdf')
    assert.deepEqual(pdfPartFor(five, '5'), { partId: '5', filename: 'e.pdf', attachmentId: null, data: INLINE, size: 2048 })
  })
  test('no PDF part of that id (gone, or not a PDF): none — never another part', () => {
    assert.equal(pdfPartFor(CRITIC, '9'), null)
    assert.equal(pdfPartFor(CRITIC, '0'), null)
    assert.equal(pdfPartFor(message(pdf('1', 'Rechnung.pdf', { mimeType: 'application/force-download' })), '1'), null)
    assert.equal(pdfPartFor(null, '1'), null)
  })
})

describe('isGmailAuthError — a dead connection, not a passing failure (the free part of P2-9)', () => {
  // As googleapis throws them: gaxios' status, google-auth-library's code and errors
  const apiError = (status: number, reasons: string[], over: Record<string, unknown> = {}) =>
    Object.assign(new Error(`HTTP ${status}`), {
      status, code: status, errors: reasons.map(reason => ({ reason, domain: 'global', message: reason })),
      response: { status, data: { error: { code: status, message: `HTTP ${status}`, errors: reasons.map(reason => ({ reason })) } } },
      ...over,
    })

  test('dead: „Gmail not connected …“, invalid_grant (as the message or the token endpoint’s answer), 401, 403 for missing permissions', () => {
    assert.equal(isGmailAuthError(new Error('Gmail not connected. Please authorize in Settings.')), true)
    assert.equal(isGmailAuthError(Object.assign(new Error('invalid_grant'), {
      status: 400, response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
    })), true)
    assert.equal(isGmailAuthError(Object.assign(new Error('Bad Request'), { response: { status: 400, data: { error: 'invalid_grant' } } })), true)
    assert.equal(isGmailAuthError(apiError(401, ['authError'])), true)
    assert.equal(isGmailAuthError({ response: { status: 401 } }), true)
    assert.equal(isGmailAuthError(apiError(403, ['insufficientPermissions'])), true)
    // the newer error model's reason for the same refusal
    assert.equal(isGmailAuthError({ response: { status: 403, data: { error: { code: 403, details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } } }), true)
  })
  test('passing: a 403 for a rate or daily limit, 429, 5xx, a network error, a timeout, an abort', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']) {
      assert.equal(isGmailAuthError(apiError(403, [reason])), false, reason)
    }
    assert.equal(isGmailAuthError(apiError(429, ['rateLimitExceeded'])), false)
    assert.equal(isGmailAuthError(apiError(500, ['backendError'])), false)
    assert.equal(isGmailAuthError(apiError(503, [])), false)
    assert.equal(isGmailAuthError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false)
    assert.equal(isGmailAuthError(Object.assign(new Error('network timeout at: https://gmail.googleapis.com/'), { type: 'request-timeout' })), false)
    assert.equal(isGmailAuthError(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })), false)
    assert.equal(isGmailAuthError(null), false)
    assert.equal(isGmailAuthError('invalid_grant'), false)
  })
})

// ─── Wiring, read from the source (lib/expenses/gmail.ts loads googleapis) ───────────────
// Bookmatic's checks of its matcher, booking route, refetch route and page are not ported: Mado's
// routes are tested in their own files (PR 9b).

const DIR = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(DIR, rel), 'utf8')
// The code without its comments (those on lines of their own)
const code = (src: string) => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '')
const count = (s: string, piece: string) => s.split(piece).length - 1

describe('wiring: Gmail is only read, each call within the search’s budget', () => {
  test('gmail-parts.ts is pure: no import, no env variable', () => {
    const src = read('gmail-parts.ts')
    assert.doesNotMatch(src, /^\s*import\b/m)
    assert.doesNotMatch(src, /\bfrom\s+['"]|\brequire\(|\bimport\(|process\.env/)
  })
  test('gmail.ts: every Gmail call is made in gmailCalls, through the limiter, with the signal and the timeout; Gmail is only read', () => {
    const src = code(read('gmail.ts'))
    const start = src.indexOf('export function gmailCalls(')
    const calls = src.slice(start, src.indexOf('\n}\n', start))
    assert.equal(count(src, 'gmail.users.'), 3)
    assert.equal(count(calls, 'gmail.users.'), 3)
    assert.match(calls, /const options = \{ signal, timeout: GMAIL_CALL_TIMEOUT_MS \}/)
    for (const call of ['gmail.users.messages.list({ userId: \'me\', q, maxResults }, options)', 'gmail.users.messages.get({ userId: \'me\', id, format: \'full\' }, options)',
      'gmail.users.messages.attachments.get({ userId: \'me\', messageId, id }, options)']) {
      assert.ok(calls.includes(`limit(() => ${call})`), call)
    }
    assert.match(src, /export const GMAIL_CALL_TIMEOUT_MS = 15_000/)
    assert.doesNotMatch(src, /\.(?:send|modify|trash|untrash|insert|import|delete|batchModify|batchDelete)\(/)
  })
  test('the searches keep their queries and how many e-mails they read; each goes through the caller’s Gmail API', () => {
    const src = code(read('gmail.ts'))
    for (const q of [
      '`from:${params.senderDomain} ${params.invoiceNumber} has:attachment`',
      '`from:${params.senderDomain} after:${afterDate} before:${beforeDate} has:attachment`',
      '`from:${params.senderDomain} after:${afterDate} before:${beforeDate}`',
    ]) assert.ok(src.includes(q), q)
    assert.match(src, /return readMessages\(calls, await firstFound\(calls, queries, 5\), params\.invoiceNumber\)/)
    // the keyword search's downloads ranked by the bank text's number too (review GMAIL-B2)
    assert.match(src, /return readMessages\(calls, await firstFound\(calls, queries, 3\), params\.invoiceNumber\)/)
    assert.match(src, /searchInvoices: \(params: SenderSearch, opts: GmailCallOptions = \{\}\) => senderSearch\(gmailCalls\(gmail, opts\), params\)/)
    assert.match(src, /searchInvoicesByKeyword: \(params: KeywordSearch, opts: GmailCallOptions = \{\}\) => keywordSearch\(gmailCalls\(gmail, opts\), params\)/)
    assert.doesNotMatch(src, /process\.env|supabase/)
  })
  test('Mado’s Google connection asks for gmail.readonly beside its send and Drive scopes (decision D4)', () => {
    const src = readFileSync(join(DIR, '..', '..', 'app', 'api', 'gmail', 'auth', 'route.ts'), 'utf8')
    for (const scope of ['gmail.readonly', 'gmail.send', 'userinfo.email', 'drive']) {
      assert.ok(src.includes(`'https://www.googleapis.com/auth/${scope}'`), scope)
    }
  })
})
