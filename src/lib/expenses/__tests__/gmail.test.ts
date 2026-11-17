import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { gmail_v1 } from 'googleapis'
import {
  gmailCalls, keywordQueries, keywordSearch, readMessages, readPdfPart, GMAIL_CALL_TIMEOUT_MS, MAX_PDF_BYTES, MAX_PDF_BYTES_PER_SEARCH, MAX_PDFS_PER_SEARCH,
  type GmailCalls, type GmailLimit, type GmailPayload,
} from '../gmail'
import type { GmailPart } from '../gmail-parts'
import { ruleEmailPool } from '../rule-match'
import type { Vendor } from '@/lib/expenses/types'

// The Gmail layer of P2-11 (PR „Job 1 fixes“ § 2.1 B, lib/gmail.ts): every PDF part of an
// e-mail with its part id, downloaded within a search's budget and checked; which of them
// is the receipt is lib/receipt-match.ts pickGmailReceipt's to say (commit 13: the pick
// before P2-11 is gone). Run on synthetic messages through a stand-in for the Gmail API: no
// network. Made-up senders, message ids msg-…, invoice
// numbers 2025019xx / 910000000xxx.

const MB = 1024 * 1024
const pdfBytes = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// A stand-in for the Gmail API: payloads by message id, attachment bytes by attachment id
// (an Error: that download fails); every call logged in the order it is made
function fakeGmail(messages: Record<string, GmailPayload>, attachments: Record<string, Buffer | Error> = {}, lists: Record<string, string[]> = {}) {
  const log: string[] = []
  const calls: GmailCalls = {
    list: async (q, maxResults) => {
      log.push(`list ${q} ${maxResults}`)
      return lists[q] ?? []
    },
    message: async id => {
      log.push(`get ${id}`)
      const m = messages[id]
      if (!m) throw Object.assign(new Error('Requested entity was not found.'), { status: 404 })
      return m
    },
    attachment: async (messageId, attachmentId) => {
      log.push(`attachment ${messageId} ${attachmentId}`)
      const bytes = attachments[attachmentId]
      if (bytes instanceof Error) throw bytes
      return bytes ? bytes.toString('base64url') : null
    },
  }
  return { calls, log, downloads: () => log.filter(l => l.startsWith('attachment ')) }
}

const mail = (subject: string, ...parts: GmailPart[]): GmailPayload => ({
  partId: '', mimeType: 'multipart/mixed', filename: '', body: { size: 0 }, parts,
  headers: [
    { name: 'Subject', value: subject },
    { name: 'From', value: 'Muster GmbH <rechnung@muster.example>' },
    { name: 'Date', value: 'Wed, 15 Jul 2026 08:00:00 +0200' },
  ],
})
const textPart = (body: string): GmailPart =>
  ({ partId: '0', mimeType: 'text/plain', filename: '', body: { data: Buffer.from(body).toString('base64url'), size: body.length } })
const pdfPart = (partId: string, filename: string, attachmentId: string, size = 2048, mimeType = 'application/pdf'): GmailPart =>
  ({ partId, mimeType, filename, body: { attachmentId, size } })
// What a downloaded PDF part is
const read = (partId: string, filename: string, bytes: Buffer, size = 2048) =>
  ({ partId, filename, size, base64: bytes.toString('base64'), sha256: sha(bytes) })
const state = (m: { pdfs: { skipped?: string }[] }) => m.pdfs.map(p => p.skipped ?? 'read')

describe('readMessages — every PDF part of each e-mail, downloaded within the search’s budget', () => {
  const RECHNUNG = pdfBytes('Rechnung 2025019001')
  const AGB = pdfBytes('AGB')

  test('the invoice and the terms: both read, with part id, size and hash — each downloaded once', async () => {
    const { calls, log } = fakeGmail(
      { 'msg-a1': mail('Ihre Rechnung 2025019001', textPart('Ihre Rechnung'), pdfPart('1', 'Rechnung_2026-07.pdf', 'att-a1-1'), pdfPart('2', 'AGB.pdf', 'att-a1-2')) },
      { 'att-a1-1': RECHNUNG, 'att-a1-2': AGB },
    )
    assert.deepEqual(await readMessages(calls, ['msg-a1']), [{
      messageId: 'msg-a1', subject: 'Ihre Rechnung 2025019001', from: 'Muster GmbH <rechnung@muster.example>',
      date: 'Wed, 15 Jul 2026 08:00:00 +0200', bodyText: 'Ihre Rechnung',
      pdfs: [read('1', 'Rechnung_2026-07.pdf', RECHNUNG), read('2', 'AGB.pdf', AGB)],
    }])
    assert.deepEqual(log, ['get msg-a1', 'attachment msg-a1 att-a1-1', 'attachment msg-a1 att-a1-2'])
  })

  test('the critic’s case [„Rechnung.pdf“ application/pdf, „AGB.PDF“ octet-stream]: both read', async () => {
    const { calls } = fakeGmail(
      { 'msg-a1': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-1'), pdfPart('2', 'AGB.PDF', 'att-2', 2048, 'application/octet-stream')) },
      { 'att-1': RECHNUNG, 'att-2': AGB },
    )
    const [m] = await readMessages(calls, ['msg-a1'])
    assert.deepEqual(m.pdfs, [read('1', 'Rechnung.pdf', RECHNUNG), read('2', 'AGB.PDF', AGB)])
    assert.deepEqual(Object.keys(m).sort(), ['bodyText', 'date', 'from', 'messageId', 'pdfs', 'subject'])
  })

  test('a „BELEG.PDF“ the old selector did not see: read now', async () => {
    const BELEG = pdfBytes('Beleg')
    const { calls } = fakeGmail({ 'msg-a1': mail('Beleg', pdfPart('1', 'BELEG.PDF', 'att-1', 2048, 'application/octet-stream')) }, { 'att-1': BELEG })
    const [m] = await readMessages(calls, ['msg-a1'])
    assert.deepEqual(m.pdfs, [read('1', 'BELEG.PDF', BELEG)])
  })

  test('a „.pdf“ of another type: no PDF part, not downloaded — a row an Analyse before P2-11 attached it to (no part id) still gets it by the old selector', async () => {
    const { calls, downloads } = fakeGmail({ 'msg-a1': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-1', 2048, 'application/force-download')) }, { 'att-1': RECHNUNG })
    const [m] = await readMessages(calls, ['msg-a1'])
    assert.deepEqual(m.pdfs, [])
    assert.deepEqual(downloads(), [])
    assert.deepEqual(await readPdfPart(calls, 'msg-a1', null), { base64: RECHNUNG.toString('base64'), filename: 'Rechnung.pdf' })
  })

  test('over 10 MB, bytes that are no PDF, a failed download: said on the part; one over 10 MB is never downloaded', async () => {
    const BIG = pdfBytes('groß')
    const HTML = Buffer.from('<html>Ihre Rechnung</html>')
    const { calls, downloads } = fakeGmail({
      'msg-a2': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-big', MAX_PDF_BYTES + 1)),
      'msg-a3': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-html')),
      'msg-a4': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-lost')),
      'msg-a5': mail('Rechnung', pdfPart('1', 'Rechnung.pdf', 'att-edge', MAX_PDF_BYTES)),
    }, { 'att-big': BIG, 'att-html': HTML, 'att-lost': new Error('socket hang up'), 'att-edge': RECHNUNG })
    const [big, html, lost, edge] = await readMessages(calls, ['msg-a2', 'msg-a3', 'msg-a4', 'msg-a5'])
    const skipped = (skipped: string, size = 2048) => [{ partId: '1', filename: 'Rechnung.pdf', size, base64: null, sha256: null, skipped }]
    assert.equal(MAX_PDF_BYTES, 10 * MB)
    assert.deepEqual(big.pdfs, skipped('too_large', MAX_PDF_BYTES + 1))
    assert.deepEqual(html.pdfs, skipped('not_pdf'))
    assert.deepEqual(lost.pdfs, skipped('download_failed'))
    // exactly 10 MB is read
    assert.deepEqual(edge.pdfs, [read('1', 'Rechnung.pdf', RECHNUNG, MAX_PDF_BYTES)])
    // each attachment asked for once, the failed one too; the one over 10 MB never
    assert.deepEqual(downloads().sort(), ['attachment msg-a3 att-html', 'attachment msg-a4 att-lost', 'attachment msg-a5 att-edge'])
  })

  test('a search reads at most 6 parts: the bank text’s number (file name or subject) first, then invoice-like names, then Gmail’s order', async () => {
    const three = (m: string, names: string[]) => names.map((n, j) => pdfPart(String(j + 1), n, `att-${m}-${j + 1}`))
    const messages = {
      'msg-b1': mail('Ihre Unterlagen', ...three('b1', ['AGB.pdf', 'Datenschutz.pdf', 'Rechnung.pdf'])),
      'msg-b2': mail('Rechnung 910000000123', ...three('b2', ['Anhang1.pdf', 'Anhang2.pdf', 'Anhang3.pdf'])),
      'msg-b3': mail('Info', ...three('b3', ['Info.pdf', 'Beleg.pdf', 'Flyer.pdf'])),
    }
    const bytes = Object.fromEntries(Object.values(messages).flatMap(m => m.parts!.map(p => [p.body!.attachmentId!, pdfBytes(p.filename!)])))
    const { calls, downloads } = fakeGmail(messages, bytes)
    const out = await readMessages(calls, ['msg-b1', 'msg-b2', 'msg-b3'], '910000000123')
    assert.equal(MAX_PDFS_PER_SEARCH, 6)
    // six parts, nothing beyond them
    assert.deepEqual(downloads(), [
      'attachment msg-b2 att-b2-1', 'attachment msg-b2 att-b2-2', 'attachment msg-b2 att-b2-3',
      'attachment msg-b1 att-b1-3', 'attachment msg-b3 att-b3-2', 'attachment msg-b1 att-b1-1',
    ])
    assert.deepEqual(out.map(state), [['read', 'row_budget', 'read'], ['read', 'read', 'read'], ['row_budget', 'read', 'row_budget']])
    // the number in a file name ranks it first too
    const named = fakeGmail({ 'msg-b4': mail('Ihre Unterlagen', ...three('b4', ['AGB.pdf', 'Rechnung.pdf', 'RE-910000000123.pdf'])) }, bytes)
    await readMessages(named.calls, ['msg-b4'], '910000000123')
    assert.deepEqual(named.downloads().slice(0, 3), ['attachment msg-b4 att-b4-3', 'attachment msg-b4 att-b4-2', 'attachment msg-b4 att-b4-1'])
  })

  test('… and at most 15 MB by the sizes Gmail states: a part that does not fit is left, a smaller later one still read', async () => {
    const messages = {
      'msg-c1': mail('Unterlagen', pdfPart('1', 'a.pdf', 'att-c1-1', 6 * MB), pdfPart('2', 'b.pdf', 'att-c1-2', 6 * MB), pdfPart('3', 'c.pdf', 'att-c1-3', 6 * MB)),
      'msg-c2': mail('Unterlagen', pdfPart('1', 'd.pdf', 'att-c2-1', 1 * MB)),
    }
    const bytes = { 'att-c1-1': pdfBytes('a'), 'att-c1-2': pdfBytes('b'), 'att-c1-3': pdfBytes('c'), 'att-c2-1': pdfBytes('d') }
    const { calls } = fakeGmail(messages, bytes)
    const out = await readMessages(calls, ['msg-c1', 'msg-c2'])
    assert.equal(MAX_PDF_BYTES_PER_SEARCH, 15 * MB)
    assert.deepEqual(out.map(state), [['read', 'read', 'row_budget'], ['read']])
  })

  test('inline data: read from the message, no download; the old selector took attachments only', async () => {
    const INLINE = pdfBytes('inline')
    const { calls, downloads } = fakeGmail({
      'msg-d1': mail('Beleg', { partId: '1', mimeType: 'application/pdf', filename: 'beleg.pdf', body: { data: INLINE.toString('base64url'), size: INLINE.length } }),
    })
    const [m] = await readMessages(calls, ['msg-d1'])
    assert.deepEqual(m.pdfs, [read('1', 'beleg.pdf', INLINE, INLINE.length)])
    assert.deepEqual(downloads(), [])
  })

  test('an e-mail without PDF; no e-mails; one that cannot be read fails the search, as before', async () => {
    const { calls, log } = fakeGmail({ 'msg-e1': mail('Zahlung erhalten', textPart('Danke für Ihre Zahlung')) })
    const [m] = await readMessages(calls, ['msg-e1'])
    assert.deepEqual([m.pdfs, m.bodyText], [[], 'Danke für Ihre Zahlung'])
    log.length = 0
    assert.deepEqual(await readMessages(calls, []), [])
    assert.deepEqual(log, [])
    await assert.rejects(readMessages(calls, ['msg-e1', 'msg-gone']), /Requested entity was not found/)
  })

  test('e-mails read so, pooled for a rule’s row (lib/rule-match.ts ruleEmailPool): each with every PDF part and its part id, and the rules that found it', async () => {
    const RULE = { id: 'mu', name: 'Muster Telekom', email_sender: '@muster.example', email_body_keywords: [] } as unknown as Vendor
    const { calls } = fakeGmail({
      'msg-f1': mail('Ihre Rechnung', pdfPart('1', 'Rechnung_06.pdf', 'att-f1-1')),
      'msg-f2': mail('Rechnung 910000000124', pdfPart('1', 'Rechnung.pdf', 'att-f2-1'), pdfPart('2', 'Einzelverbindungen.pdf', 'att-f2-2')),
    }, { 'att-f1-1': pdfBytes('f1'), 'att-f2-1': pdfBytes('f2 Rechnung'), 'att-f2-2': pdfBytes('f2 EVN') })
    const emails = await readMessages(calls, ['msg-f1', 'msg-f2'], '910000000124')
    const pool = ruleEmailPool([{ sender: '@muster.example', rules: [RULE], emails }])
    assert.deepEqual(pool.map(p => [p.email.messageId, p.email.pdfs.map(x => [x.partId, x.filename]), p.sender, p.ruleIds]), [
      ['msg-f1', [['1', 'Rechnung_06.pdf']], '@muster.example', ['mu']],
      ['msg-f2', [['1', 'Rechnung.pdf'], ['2', 'Einzelverbindungen.pdf']], '@muster.example', ['mu']],
    ])
  })
})

describe('gmailCalls — each call through the caller’s limiter, with its signal and a 15 s timeout', () => {
  test('list, get and attachments.get: their parameters, the signal and the timeout; each through the limiter', async () => {
    const signal = new AbortController().signal
    const seen: [string, unknown, unknown][] = []
    const api = {
      users: {
        messages: {
          list: async (params: unknown, options: unknown) => {
            seen.push(['list', params, options])
            return { data: { messages: [{ id: 'msg-a1' }, { id: null }, { id: 'msg-a2' }] } }
          },
          get: async (params: unknown, options: unknown) => {
            seen.push(['get', params, options])
            return { data: { payload: { partId: '', mimeType: 'text/plain' } } }
          },
          attachments: {
            get: async (params: unknown, options: unknown) => {
              seen.push(['attachments.get', params, options])
              return { data: { data: 'JVBERi0' } }
            },
          },
        },
      },
    }
    let limited = 0
    const limit: GmailLimit = call => { limited += 1; return call() }
    const calls = gmailCalls(api as unknown as gmail_v1.Gmail, { limit, signal })
    assert.deepEqual(await calls.list('from:@muster.example has:attachment', 5), ['msg-a1', 'msg-a2'])
    assert.deepEqual(await calls.message('msg-a1'), { partId: '', mimeType: 'text/plain' })
    assert.equal(await calls.attachment('msg-a1', 'att-1'), 'JVBERi0')
    assert.equal(limited, 3)
    assert.equal(GMAIL_CALL_TIMEOUT_MS, 15_000)
    const options = { signal, timeout: 15_000 }
    assert.deepEqual(seen, [
      ['list', { userId: 'me', q: 'from:@muster.example has:attachment', maxResults: 5 }, options],
      ['get', { userId: 'me', id: 'msg-a1', format: 'full' }, options],
      ['attachments.get', { userId: 'me', messageId: 'msg-a1', id: 'att-1' }, options],
    ])
  })

  test('without a limiter: one call at a time, in the order asked (the pace before P2-11); a failed call does not stop the next', async () => {
    let inFlight = 0
    let most = 0
    const started: string[] = []
    const seenOptions: unknown[] = []
    const api = {
      users: {
        messages: {
          get: async ({ id }: { id: string }, options: unknown) => {
            started.push(id)
            seenOptions.push(options)
            inFlight += 1
            most = Math.max(most, inFlight)
            await new Promise(resolve => setTimeout(resolve, 5))
            inFlight -= 1
            if (id === 'msg-a1') throw new Error('Backend Error')
            return { data: { payload: { partId: id } } }
          },
        },
      },
    }
    const calls = gmailCalls(api as unknown as gmail_v1.Gmail)
    const out = await Promise.allSettled(['msg-a1', 'msg-a2', 'msg-a3'].map(id => calls.message(id)))
    assert.equal(most, 1)
    assert.deepEqual(started, ['msg-a1', 'msg-a2', 'msg-a3'])
    assert.deepEqual(out.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled'])
    assert.deepEqual(seenOptions[0], { signal: undefined, timeout: 15_000 })
  })
})

describe('readPdfPart — the PDF the booking and the preview fetch again (getPdfAttachment)', () => {
  const RECHNUNG = pdfBytes('Rechnung')
  const AGB = pdfBytes('AGB')
  const CRITIC = mail('Rechnung', textPart(''), pdfPart('1', 'Rechnung.pdf', 'att-1'), pdfPart('2', 'AGB.PDF', 'att-2', 2048, 'application/octet-stream'))

  test('the row’s part by its id; a row analysed before P2-11 (no part id): the part its Analyse attached', async () => {
    const { calls } = fakeGmail({ 'msg-a1': CRITIC }, { 'att-1': RECHNUNG, 'att-2': AGB })
    assert.deepEqual(await readPdfPart(calls, 'msg-a1', '2'), { base64: AGB.toString('base64'), filename: 'AGB.PDF' })
    assert.deepEqual(await readPdfPart(calls, 'msg-a1', '1'), { base64: RECHNUNG.toString('base64'), filename: 'Rechnung.pdf' })
    assert.deepEqual(await readPdfPart(calls, 'msg-a1', null), { base64: RECHNUNG.toString('base64'), filename: 'Rechnung.pdf' })
  })
  test('a part the message no longer has, or an empty attachment: none — never another part', async () => {
    const { calls, log } = fakeGmail({ 'msg-a1': CRITIC }, { 'att-1': RECHNUNG })
    assert.equal(await readPdfPart(calls, 'msg-a1', '9'), null)
    assert.deepEqual(log, ['get msg-a1'])
    assert.equal(await readPdfPart(calls, 'msg-a1', '2'), null)
  })
  test('inline data: from the message itself', async () => {
    const INLINE = pdfBytes('inline')
    const { calls, downloads } = fakeGmail({
      'msg-d1': mail('Beleg', { partId: '1', mimeType: 'application/pdf', filename: 'beleg.pdf', body: { data: INLINE.toString('base64url'), size: INLINE.length } }),
    })
    assert.deepEqual(await readPdfPart(calls, 'msg-d1', '1'), { base64: INLINE.toString('base64'), filename: 'beleg.pdf' })
    assert.deepEqual(downloads(), [])
  })
})

describe('keywordQueries — the keyword search’s queries, as before', () => {
  const dateFrom = new Date('2026-07-05T00:00:00Z')
  const dateTo = new Date('2026-07-18T00:00:00Z')
  const after = Math.floor(dateFrom.getTime() / 1000)
  const before = Math.floor(dateTo.getTime() / 1000)

  test('the first two words of more than three letters after a processor’s „*“, quoted: with an attachment, then without', () => {
    assert.deepEqual(keywordQueries({ keyword: 'KLARNA*MUSTER SHOP DE\\WIEN', dateFrom, dateTo }), [
      `"MUSTER SHOP" has:attachment after:${after} before:${before}`,
      `"MUSTER SHOP" after:${after} before:${before}`,
    ])
    assert.deepEqual(keywordQueries({ keyword: 'ACME CLOUD AT12BKAUATWW', dateFrom, dateTo })[0], `"ACME CLOUD" has:attachment after:${after} before:${before}`)
  })
  test('no such word: no search', () => {
    assert.deepEqual(keywordQueries({ keyword: 'AB CD AT12XYZ', dateFrom, dateTo }), [])
  })
  test('keywordSearch: its downloads ranked by the bank text’s number as a sender search’s are — the part named by it read, not left beyond the budget (review GMAIL-B2)', async () => {
    const q = keywordQueries({ keyword: 'MUSTER TELEKOM', dateFrom, dateTo })[0]
    const three = (m: string, names: string[]) => names.map((n, j) => pdfPart(String(j + 1), n, `att-${m}-${j + 1}`))
    const messages = {
      'msg-k1': mail('Ihre Unterlagen', ...three('k1', ['Anhang1.pdf', 'Anhang2.pdf', 'Anhang3.pdf'])),
      'msg-k2': mail('Ihre Unterlagen', ...three('k2', ['Anhang4.pdf', 'Anhang5.pdf', 'Anhang6.pdf'])),
      'msg-k3': mail('Ihre Unterlagen', ...three('k3', ['Anhang7.pdf', 'Anhang8.pdf', '910000000123.pdf'])),
    }
    const bytes = Object.fromEntries(Object.values(messages).flatMap(m => m.parts!.map(p => [p.body!.attachmentId!, pdfBytes(p.filename!)])))
    const lists = { [q]: ['msg-k1', 'msg-k2', 'msg-k3'] }
    const params = { keyword: 'MUSTER TELEKOM', dateFrom, dateTo }
    const numbered = fakeGmail(messages, bytes, lists)
    const out = await keywordSearch(numbered.calls, { ...params, invoiceNumber: '910000000123' })
    assert.equal(numbered.downloads()[0], 'attachment msg-k3 att-k3-3')
    assert.deepEqual(out[2].pdfs.map(p => [p.filename, p.skipped ?? 'read'])[2], ['910000000123.pdf', 'read'])
    // without the number: Gmail's order — the ninth part left beyond the search's six
    const plain = fakeGmail(messages, bytes, lists)
    const before = await keywordSearch(plain.calls, params)
    assert.equal(before[2].pdfs[2].skipped, 'row_budget')
    // no query: nothing asked of Gmail
    const none = fakeGmail(messages, bytes, lists)
    assert.deepEqual(await keywordSearch(none.calls, { ...params, keyword: 'AB CD' }), [])
    assert.deepEqual(none.log, [])
  })
})
