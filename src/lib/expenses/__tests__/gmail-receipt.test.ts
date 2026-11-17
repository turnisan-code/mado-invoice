import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findGmailReceipt, searchWindow, MAX_READS_PER_ROW, type GmailReceiptDeps, type GmailPath } from '../gmail-receipt'
import { newAnalyseRun, type PdfText } from '../analyse-run'
import { readMessages, type GmailCalls, type GmailMessage, type GmailPdf } from '../gmail'
import type { PdfInvoiceData } from '../pdf-reader'
import { gmailCandidateLabel, gmailFailedNote, rowLabel, GMAIL_TIME_NOTE, GMAIL_TIME_PARTIAL_NOTE } from '../receipt-match'
import type { EasybankTransaction, Vendor } from '@/lib/expenses/types'

// A debit's Gmail receipt within one Analyse (PR „Job 1 fixes“ § 2.1 E, lib/gmail-receipt.ts),
// run through stand-ins for Gmail's searches, pdf-parse and the PDF reader: no network.
// Made-up senders (muster.example, acme.example, paddle.com as a processor), message ids
// msg-…, invoice numbers 910000000xxx.

// A PDF part as lib/gmail.ts gives it: its bytes name it, so the stand-ins know which it is
const bytesOf = (label: string) => Buffer.from(`%PDF-1.4 ${label}`).toString('base64')
const labelOf = (base64: string) => Buffer.from(base64, 'base64').toString().replace('%PDF-1.4 ', '')
const pdf = (partId: string, filename: string, label: string, over: Partial<GmailPdf> = {}): GmailPdf =>
  ({ partId, filename, base64: bytesOf(label), size: 2048, sha256: `sha-${label}`, ...over })
const DAY = (d: number) => `Wed, ${d} Jul 2026 08:00:00 +0200`
const msg = (messageId: string, subject: string, pdfs: GmailPdf[], over: Partial<GmailMessage> = {}): GmailMessage =>
  ({ messageId, subject, from: 'Muster GmbH <rechnung@muster.example>', date: DAY(15), bodyText: '', pdfs, ...over })
const NOTHING: PdfInvoiceData = { date: null, invoice_number: null, amount: null, currency: null, vatin: null, amount_due: null, foreign_total: null, document_type: null }

type World = {
  senders?: Record<string, GmailMessage[] | Error>
  keyword?: GmailMessage[] | Error
  texts?: Record<string, PdfText>
  reads?: Record<string, Partial<PdfInvoiceData> | Error>
}
// The stand-ins, and what was asked of them
function standIn(world: World) {
  const log = { searches: [] as string[], params: [] as Record<string, unknown>[], gmailOptions: [] as unknown[], reads: [] as string[], readOptions: [] as unknown[] }
  const deps: GmailReceiptDeps = {
    searchInvoices: async (params, opts) => {
      log.searches.push(`from:${params.senderDomain}`)
      log.params.push(params)
      log.gmailOptions.push(opts)
      const found = world.senders?.[params.senderDomain]
      if (found instanceof Error) throw found
      return found ?? []
    },
    searchInvoicesByKeyword: async (params, opts) => {
      log.searches.push(`name:${params.keyword}`)
      log.params.push(params)
      log.gmailOptions.push(opts)
      if (world.keyword instanceof Error) throw world.keyword
      return world.keyword ?? []
    },
    pdfText: async base64 => world.texts?.[labelOf(base64)] ?? { text: '', pages: 1 },
    readPdf: async (base64, opts) => {
      const label = labelOf(base64)
      log.reads.push(label)
      log.readOptions.push(opts)
      const r = world.reads?.[label]
      if (r instanceof Error) throw r
      return { ...NOTHING, document_type: 'invoice', ...r }
    },
  }
  return { deps, log }
}

const rule = (id: string, name: string, extra: Partial<Vendor> = {}): Vendor => ({
  id, name, match_strings: ['MUSTER'], email_sender: '@muster.example', cost_account_id: 39209, purchasetax_account_id: 7002,
  bank_account_id: 5002, tax_percent: 20, deductibility_tax_percent: 100, deductibility_amount_percent: 100,
  country: '', vatin: '', title_template: '{vendor} {month_short}', category: '', active: true,
  amount_min: null, amount_max: null, invoice_address_match: '', email_body_keywords: [], notes_template: '', skip_invoice_search: false, ...extra,
})
const MU = rule('mu', 'Muster Telekom')
const SENDER: GmailPath[] = [{ kind: 'sender', rules: [MU] }]
const debit = (reference: string, over: Partial<EasybankTransaction> = {}): EasybankTransaction =>
  ({ date: '2026-07-16', counterparty: 'MUSTER TELEKOM', reference, amount: 23.45, type: 'expense', currency: 'EUR', raw: {}, ...over })
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('findGmailReceipt — a Buchungsregel’s sender', () => {
  test('its PDF read and attached by its amount, claimed for the row by all its keys; Gmail with the run’s limiter and signal; the reader with the run’s time', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    // A fixed clock: the read's options at the run's start (both tries fit: 22,5 s each)
    const run = newAnalyseRun([tx], { maxDurationS: 60, startedAt: 0, now: () => 0 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-a1', 'Ihre Rechnung', [pdf('1', 'Rechnung_910000000123.pdf', 'a1')])] },
      texts: { a1: { text: 'Rechnung 910000000123\nGesamt 23,45 €', pages: 1 } },
      reads: { a1: { amount: 23.45, invoice_number: '910000000123', vatin: 'ATU12345678' } },
    })
    const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.messageId, found.pick.chosen?.partId], ['amount', 'msg-a1', '1'])
    assert.equal(found.pick.note, 'Gmail: @muster.example · Betrag 23,45 € stimmt · Rechnungsnr. 910000000123')
    assert.deepEqual([found.chosenBase64, found.chosenText, found.read?.vatin, found.failed], [bytesOf('a1'), 'Rechnung 910000000123\nGesamt 23,45 €', 'ATU12345678', []])
    assert.deepEqual(found.pick.chosen?.via, { kind: 'sender', sender: '@muster.example', ruleIds: ['mu'] })
    const own = { row: 0, label: rowLabel(tx) }
    for (const key of ['gmail:msg-a1:1', 'sha:sha-a1', 'inv:muster.example:910000000123']) assert.deepEqual(run.claims.ownerOf(key), own, key)
    // the query asks for the bank text's number as it is written there
    assert.equal(log.params[0].invoiceNumber, '910000000123')
    assert.deepEqual(log.gmailOptions, [{ limit: run.gmailLimit, signal: run.signal }])
    assert.deepEqual(log.readOptions, [{ timeoutMs: 22_500, maxRetries: 1, signal: run.signal }])
    assert.equal(run.reads.left, 149)
  })
  test('the window: from the day of payment less 10 days — a card payment of 29.12. posted on 04.01. too —, to the bank date plus 3', () => {
    const plain = searchWindow(debit('Muster Telekom'))
    assert.deepEqual([ymd(plain.dateFrom), ymd(plain.dateTo)], ['2026-07-06', '2026-07-19'])
    const card = searchWindow({ date: '2027-01-04', reference: '', raw: { col1: 'Bezahlung Karte                              MC/000000901|POS          45,00 0001 K002 29.12. 18:05|MUSTER SHOP' } })
    assert.deepEqual([ymd(card.dateFrom), ymd(card.dateTo)], ['2026-12-19', '2027-01-07'])
  })
  test('a rule that searches none, or has no sender: nothing searched, nothing said', async () => {
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const { deps, log } = standIn({})
    for (const r of [rule('sk', 'Ohne Suche', { skip_invoice_search: true }), rule('no', 'Ohne Absender', { email_sender: ' ' })]) {
      const found = await findGmailReceipt(debit('x'), { paths: [{ kind: 'sender', rules: [r] }], run, row: 0 }, deps)
      assert.deepEqual([found.pick.chosen, found.pick.note, found.failed], [null, null, []])
    }
    assert.deepEqual(log.searches, [])
  })
})

describe('findGmailReceipt — two debits of one sender (the Magenta pair)', () => {
  test('by their numbers: each row its own PDF — the other’s number keeps each off it', async () => {
    const one = debit('Netzcom|Rechnung 910000000301 vom 10.07.2026', { amount: 40.52 })
    const two = debit('Netzcom|Rechnung 910000000302 vom 10.07.2026', { amount: 40.52 })
    const run = newAnalyseRun([one, two], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-b1', 'Ihre Rechnung', [pdf('1', 'Rechnung_910000000301.pdf', 'b1')]), msg('msg-b2', 'Ihre Rechnung', [pdf('1', 'Rechnung_910000000302.pdf', 'b2')])] },
      texts: { b1: { text: 'Rechnung 910000000301 Summe 40,52 €', pages: 1 }, b2: { text: 'Rechnung 910000000302 Summe 40,52 €', pages: 1 } },
      reads: { b1: { amount: 40.52, invoice_number: '910000000301' }, b2: { amount: 40.52, invoice_number: '910000000302' } },
    })
    const [a, b] = await Promise.all([
      findGmailReceipt(one, { paths: SENDER, run, row: 0 }, deps),
      findGmailReceipt(two, { paths: SENDER, run, row: 1 }, deps),
    ])
    assert.deepEqual([a.pick.check, a.pick.chosen?.messageId, b.pick.check, b.pick.chosen?.messageId], ['amount', 'msg-b1', 'amount', 'msg-b2'])
    // each PDF read once for both rows
    assert.deepEqual(log.reads.sort(), ['b1', 'b2'])
  })
  test('without numbers: each row sees both PDFs of the amount — „ambiguous“ for both, attached one to one by the claims', async () => {
    const one = debit('Netzcom|Lastschrift', { amount: 40.52 })
    const two = debit('Netzcom|Lastschrift', { amount: 40.52 })
    const run = newAnalyseRun([one, two], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-c1', 'Rechnung', [pdf('1', 'Rechnung.pdf', 'c1')]), msg('msg-c2', 'Rechnung', [pdf('1', 'Rechnung.pdf', 'c2')], { date: DAY(14) })] },
      texts: { c1: { text: 'Summe 40,52 €', pages: 2 }, c2: { text: 'Summe 40,52 €', pages: 2 } },
      reads: { c1: { amount: 40.52 }, c2: { amount: 40.52 } },
    })
    const a = await findGmailReceipt(one, { paths: SENDER, run, row: 0 }, deps)
    const b = await findGmailReceipt(two, { paths: SENDER, run, row: 1 }, deps)
    assert.deepEqual([a.pick.check, a.pick.chosen?.messageId, b.pick.check, b.pick.chosen?.messageId], ['ambiguous', 'msg-c1', 'ambiguous', 'msg-c2'])
    assert.deepEqual(b.pick.candidates.map(c => [c.message_id, c.why, c.claimed_by]), [['msg-c1', 'claimed', rowLabel(one)]])
    // what the first row read is the second's: two reads in all
    assert.deepEqual(log.reads.sort(), ['c1', 'c2'])
  })
})

describe('findGmailReceipt — what is read', () => {
  test('reading stops at the PDF of the debit’s amount — the terms beside it, whose text shows no debit, are not read', async () => {
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-d1', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'd1'), pdf('2', 'AGB.pdf', 'd2')])] },
      texts: { d1: { text: 'Gesamt 23,45 €', pages: 1 }, d2: { text: 'Allgemeine Geschäftsbedingungen', pages: 3 } },
      reads: { d1: { amount: 23.45 }, d2: { amount: null } },
    })
    const found = await findGmailReceipt(debit('x'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.partId, log.reads], ['amount', '1', ['d1']])
  })
  test('a match the row cannot attach (a credit note of the amount) does not end the reading: the scan after it is read and attached', async () => {
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-d3', 'Gutschrift', [pdf('1', 'Gutschrift.pdf', 'd3')]), msg('msg-d4', 'Rechnung', [pdf('1', 'Scan.pdf', 'd4')])] },
      texts: { d3: { text: 'Gutschrift 23,45 €', pages: 1 }, d4: { text: '', pages: 1 } },
      reads: { d3: { amount: 23.45, document_type: 'credit_note' }, d4: { amount: 23.45 } },
    })
    const found = await findGmailReceipt(debit('x'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.messageId, log.reads], ['amount', 'msg-d4', ['d3', 'd4']])
    assert.deepEqual(found.pick.candidates.map(c => [c.message_id, c.why]), [['msg-d3', 'credit_note']])
  })
  test('at most 4 reads a row: the rest listed „nicht geprüft“', async () => {
    const tx = debit('x')
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    const labels = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']
    const { deps, log } = standIn({
      keyword: labels.map(l => msg(`msg-${l}`, 'Ihre Rechnung', [pdf('1', `${l}.pdf`, l)])),
      reads: Object.fromEntries(labels.map(l => [l, { amount: 30 }])),
    })
    const found = await findGmailReceipt(tx, { paths: [{ kind: 'keyword', name: 'MUSTER TELEKOM' }], run, row: 0 }, deps)
    assert.equal(MAX_READS_PER_ROW, 4)
    assert.deepEqual(log.reads, ['e1', 'e2', 'e3', 'e4'])
    assert.equal(found.pick.chosen, null)
    assert.equal(found.pick.note, '⚠ 6 Belege in Gmail gefunden, 2 davon nicht geprüft, keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    assert.deepEqual(found.pick.candidates.map(c => c.why), ['amount', 'amount', 'amount', 'amount', 'unchecked', 'unchecked'])
  })
  test('more than 10 pages: not read — the sender’s only PDF attached unchecked (D2)', async () => {
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-g1', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'g1')])] },
      texts: { g1: { text: 'Einzelverbindungen …', pages: 14 } },
    })
    const found = await findGmailReceipt(debit('x'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, log.reads], ['unchecked', []])
    assert.equal(found.pick.note, '⚠ Beleg von @muster.example angehängt, Betrag nicht geprüft (mehr als 10 Seiten) — Beleg prüfen')
  })
  test('one e-mail, two PDFs of the amount, its subject naming the bank’s number: each part knows the e-mail has two — the one read with the number attached, never the first by MIME order (review GMAIL-01)', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-z1', 'Ihre Rechnung 910000000123', [pdf('1', 'Rechnung_910000000201.pdf', 'z1'), pdf('2', 'Rechnung.pdf', 'z2')])] },
      // the second a scan: its text shows no amount
      texts: { z1: { text: 'Rechnung 910000000201 Summe 23,45 €', pages: 1 }, z2: { text: '', pages: 1 } },
      reads: { z1: { amount: 23.45, invoice_number: '910000000201' }, z2: { amount: 23.45, invoice_number: '910000000123' } },
    })
    const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.partId, found.pick.chosen?.pdfParts], ['amount', '2', 2])
    // the other invoice is no match: the scan beside it read too
    assert.deepEqual(log.reads, ['z1', 'z2'])
    assert.deepEqual(found.pick.candidates.map(c => [c.part_id, c.why]), [['1', 'number']])
  })
  test('one e-mail, a PDF whose text shows the debit and a scan: the scan is read after the match too — the invoice read with the bank’s number attached, never the first by its text (review check GMAIL-01)', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    // a payment confirmation of the amount, or another purchase's invoice read without a number, then the own invoice as a scan
    for (const [file, read] of [['Zahlungsbestaetigung.pdf', { amount: 23.45, document_type: 'receipt' }], ['Rechnung_A.pdf', { amount: 23.45 }]] as const) {
      const run = newAnalyseRun([tx], { maxDurationS: 60 })
      const { deps, log } = standIn({
        senders: { '@muster.example': [msg('msg-z3', 'Ihre Rechnung 910000000123', [pdf('1', file, 'z3'), pdf('2', 'Rechnung.pdf', 'z4')])] },
        texts: { z3: { text: 'Betrag 23,45 EUR', pages: 1 }, z4: { text: '', pages: 1 } },
        reads: { z3: read, z4: { amount: 23.45, invoice_number: '910000000123' } },
      })
      const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
      assert.deepEqual([found.pick.check, found.pick.chosen?.partId, log.reads], ['amount', '2', ['z3', 'z4']], file)
      assert.deepEqual(found.pick.candidates.map(c => [c.part_id, c.why]), [['1', 'amount']], file)
    }
    // no number in the bank text: two documents of the amount — said, the nearest attached, never ticked
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { '@muster.example': [msg('msg-z5', 'Ihre Rechnung', [pdf('1', 'Zahlungsbestaetigung.pdf', 'z5'), pdf('2', 'Rechnung.pdf', 'z6')])] },
      texts: { z5: { text: 'Betrag 23,45 EUR', pages: 1 }, z6: { text: '', pages: 1 } },
      reads: { z5: { amount: 23.45, document_type: 'receipt' }, z6: { amount: 23.45 } },
    })
    const found = await findGmailReceipt(debit('x'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, log.reads], ['ambiguous', ['z5', 'z6']])
    // a scan in another e-mail after the match: not read (the read stop stands)
    const other = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const two = standIn({
      senders: { '@muster.example': [msg('msg-z7', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'z7')]), msg('msg-z8', 'Ihre Rechnung', [pdf('1', 'Scan.pdf', 'z8')], { date: DAY(10) })] },
      texts: { z7: { text: 'Gesamt 23,45 €', pages: 1 }, z8: { text: '', pages: 1 } },
      reads: { z7: { amount: 23.45 }, z8: { amount: 23.45 } },
    })
    const alone = await findGmailReceipt(debit('x'), { paths: SENDER, run: other, row: 0 }, two.deps)
    assert.deepEqual([alone.pick.check, alone.pick.chosen?.messageId, two.log.reads], ['amount', 'msg-z7', ['z7']])
  })
  test('a scan is what pdf-parse gives it, „\\n\\n“ a page, not „“: beside a confirmation of the amount it is read too, and attached with no text for the classifier (repair check GI-1)', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    for (const [scanText, pages] of [['\n\n', 1], ['\n\n\n\n', 2]] as const) {
      for (const [file, read] of [['Zahlungsbestaetigung.pdf', { amount: 23.45, document_type: 'receipt' }], ['Rechnung_A.pdf', { amount: 23.45 }]] as const) {
        const run = newAnalyseRun([tx], { maxDurationS: 60 })
        const { deps, log } = standIn({
          senders: { '@muster.example': [msg('msg-z3', 'Ihre Rechnung 910000000123', [pdf('1', file, 'z3'), pdf('2', 'Rechnung.pdf', 'z4')])] },
          texts: { z3: { text: 'Betrag 23,45 EUR', pages: 1 }, z4: { text: scanText, pages } },
          reads: { z3: read, z4: { amount: 23.45, invoice_number: '910000000123' } },
        })
        const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
        assert.deepEqual([found.pick.check, found.pick.chosen?.partId, log.reads], ['amount', '2', ['z3', 'z4']], `${file} ${JSON.stringify(scanText)}`)
        // no text layer: the matcher says „Scan“ and the guards know the receipt unread
        assert.equal(found.chosenText, '', file)
      }
    }
  })
  test('the name search asks for the bank text’s number too: its downloads ranked by it (review GMAIL-B2)', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    const { deps, log } = standIn({})
    await findGmailReceipt(tx, { paths: [{ kind: 'keyword', name: 'MUSTER TELEKOM' }], run, row: 0 }, deps)
    assert.deepEqual([log.searches, log.params[0].invoiceNumber], [['name:MUSTER TELEKOM'], '910000000123'])
    // without one in the bank text: none asked for
    await findGmailReceipt(debit('x'), { paths: [{ kind: 'keyword', name: 'MUSTER TELEKOM' }], run, row: 0 }, deps)
    assert.equal(log.params[1].invoiceNumber, undefined)
  })
  test('a PDF another row of the run has: not read for this row — listed as that row’s', async () => {
    const tx = debit('x')
    const run = newAnalyseRun([tx, tx], { maxDurationS: 60 })
    run.claims.claim(['gmail:msg-l1:1'], 0, 'Zeile 1')
    const { deps, log } = standIn({ senders: { '@muster.example': [msg('msg-l1', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'l1')])] }, reads: { l1: { amount: 23.45 } } })
    const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 1 }, deps)
    assert.deepEqual([found.pick.chosen, log.reads], [null, []])
    assert.deepEqual(found.pick.candidates.map(c => [c.why, c.claimed_by]), [['claimed', 'Zeile 1']])
  })
})

describe('findGmailReceipt — the run’s time and a dead connection', () => {
  test('after the Gmail stop (20 s) no search starts: „Analyse-Zeit aufgebraucht“; after the read stop (35 s) no read — the sender’s only PDF attached unchecked (D2)', async () => {
    const tx = debit('x')
    const clock = { ms: 0 }
    const run = newAnalyseRun([tx], { maxDurationS: 60, now: () => clock.ms })
    const { deps, log } = standIn({ senders: { '@muster.example': [msg('msg-f1', 'Rechnung', [pdf('1', 'Rechnung.pdf', 'f1')])] }, reads: { f1: { amount: 23.45 } } })
    clock.ms = 20_001
    const late = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([late.pick.note, late.pick.chosen, log.searches], [GMAIL_TIME_NOTE, null, []])
    assert.equal(late.pick.plainNote, 'Analyse-Zeit aufgebraucht — kein Beleg nötig')
    // In Mado the Gmail stop (20 s) comes before the read stop (35 s): a search that starts at
    // 19 s and ends at 36 s leaves no time to read
    clock.ms = 19_000
    const slowSearch: GmailReceiptDeps = { ...deps, searchInvoices: async (params, opts) => { const r = await deps.searchInvoices(params, opts); clock.ms = 36_000; return r } }
    const unread = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, slowSearch)
    assert.deepEqual([unread.pick.check, log.searches, log.reads], ['unchecked', ['from:@muster.example'], []])
    assert.equal(unread.pick.note, '⚠ Beleg von @muster.example angehängt, Betrag nicht geprüft (Analyse-Zeit aufgebraucht) — Beleg prüfen')
  })
  test('a search left out for time after another ran: „Gmail nicht vollständig durchsucht“ — the name search after the processor’s, a tied rule’s second sender; not when a receipt was picked (review GMAIL-04)', async () => {
    const tx = debit('PADDLE.NET* ACME\\LISBOA', { counterparty: 'PADDLE.NET* ACME\\LISBOA' })
    const clock = { ms: 0 }
    // each search takes the clock past the Gmail stop (20 s)
    const late = (deps: GmailReceiptDeps): GmailReceiptDeps => ({
      ...deps,
      searchInvoices: async (params, opts) => {
        const emails = await deps.searchInvoices(params, opts)
        clock.ms = 21_000
        return emails
      },
    })
    const ai = standIn({})
    const run = newAnalyseRun([tx], { maxDurationS: 60, now: () => clock.ms })
    const found = await findGmailReceipt(tx, { paths: [{ kind: 'processor', domain: 'paddle.com', name: 'ACME' }, { kind: 'keyword', name: 'ACME' }], run, row: 0 }, late(ai.deps))
    assert.deepEqual([found.failed, found.pick.chosen, ai.log.searches], [[GMAIL_TIME_PARTIAL_NOTE], null, ['from:paddle.com']])
    assert.equal(GMAIL_TIME_PARTIAL_NOTE, '⚠ Analyse-Zeit aufgebraucht — Gmail nicht vollständig durchsucht: Beleg selbst anhängen oder neu analysieren')
    // a tie of two rules with their own senders: the first finds nothing, the second left out
    const tie: GmailPath[] = [{ kind: 'sender', rules: [MU, rule('ze', 'Zeta Telekom', { email_sender: '@zeta.example' })] }]
    clock.ms = 0
    const tied = standIn({})
    const cut = await findGmailReceipt(debit('x'), { paths: tie, run: newAnalyseRun([tx], { maxDurationS: 60, now: () => clock.ms }), row: 0 }, late(tied.deps))
    assert.deepEqual([cut.failed, cut.pick.chosen, tied.log.searches], [[GMAIL_TIME_PARTIAL_NOTE], null, ['from:@muster.example']])
    // the first sender's only PDF picked (unread for time: D2's): nothing more to say
    clock.ms = 0
    const hit = standIn({ senders: { '@muster.example': [msg('msg-t2', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 't2')])] } })
    const picked = await findGmailReceipt(debit('x'), { paths: tie, run: newAnalyseRun([tx], { maxDurationS: 60, now: () => clock.ms }), row: 0 }, late(hit.deps))
    assert.deepEqual([picked.failed, picked.pick.check, picked.pick.chosen?.messageId], [[], 'unchecked', 'msg-t2'])
  })
  test('the scan beside a confirmation of the amount left unread by the read stop or the run’s reads: the confirmation attached „ambiguous“, the scan listed, never ticked as proof (repair check GI-4)', async () => {
    const tx = debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026')
    const world: World = {
      senders: { '@muster.example': [msg('msg-z3', 'Ihre Rechnung 910000000123', [pdf('1', 'Zahlungsbestaetigung.pdf', 'z3'), pdf('2', 'Rechnung.pdf', 'z4')])] },
      texts: { z3: { text: 'Betrag 23,45 EUR', pages: 1 }, z4: { text: '\n\n', pages: 1 } },
      reads: { z3: { amount: 23.45, document_type: 'receipt' }, z4: { amount: 23.45, invoice_number: '910000000123' } },
    }
    // the confirmation's read starts at 19 s and ends at 36 s: past the read stop (35 s)
    const clock = { ms: 19_000 }
    const timed = standIn(world)
    const slow: GmailReceiptDeps = { ...timed.deps, readPdf: async (base64, opts) => { const r = await timed.deps.readPdf(base64, opts); clock.ms = 36_000; return r } }
    const late = await findGmailReceipt(tx, { paths: SENDER, run: newAnalyseRun([tx], { maxDurationS: 60, startedAt: 0, now: () => clock.ms }), row: 0 }, slow)
    assert.deepEqual([late.pick.check, late.pick.chosen?.partId, timed.log.reads], ['ambiguous', '1', ['z3']])
    assert.equal(late.pick.note, '⚠ In derselben E-Mail „Rechnung.pdf“ nicht geprüft (Analyse-Zeit aufgebraucht) — angehängt nach dem Betrag: Beleg prüfen · Gmail: @muster.example · Betrag 23,45 € stimmt')
    assert.deepEqual(late.pick.candidates.map(c => [c.part_id, c.why]), [['2', 'unchecked']])
    // the run's reads used up after the confirmation's
    const budget = standIn(world)
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    run.reads.left = 1
    const spent = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, budget.deps)
    assert.deepEqual([spent.pick.check, spent.pick.chosen?.partId, budget.log.reads], ['ambiguous', '1', ['z3']])
    assert.match(spent.pick.note!, /^⚠ In derselben E-Mail „Rechnung\.pdf“ nicht geprüft \(Lesebudget der Analyse aufgebraucht\)/)
    assert.deepEqual(spent.pick.candidates.map(c => [c.part_id, c.why]), [['2', 'unchecked']])
  })
  test('a download or a read cut by the run’s deadline: not read for time — „nicht geprüft“, never „nicht lesbar“ (review GMAIL-04)', async () => {
    const tx = debit('x')
    // the deadline passed while the search's downloads ran
    const run = { ...newAnalyseRun([tx], { maxDurationS: 60 }), signal: AbortSignal.abort() }
    const { deps } = standIn({ keyword: [msg('msg-u1', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'u1', { base64: null, sha256: null, skipped: 'download_failed' })])] })
    const cut = await findGmailReceipt(tx, { paths: [{ kind: 'keyword', name: 'MUSTER TELEKOM' }], run, row: 0 }, deps)
    assert.deepEqual(cut.pick.candidates.map(c => [c.why, gmailCandidateLabel(c, tx)]), [['unchecked', 'nicht geprüft']])
    // the row says it was time (review check GMAIL-B5): the preview run's gate counts it
    assert.equal(cut.pick.note, '⚠ 1 Beleg in Gmail gefunden, 1 davon nicht geprüft (Analyse-Zeit aufgebraucht), keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    // a read the SDK gave up when the signal aborted: the sender's only PDF unchecked for time
    const reader = standIn({ senders: { '@muster.example': [msg('msg-u2', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'u2')])] }, reads: { u2: new Error('Request was aborted.') } })
    const unread = await findGmailReceipt(tx, { paths: SENDER, run: { ...newAnalyseRun([tx], { maxDurationS: 60 }), signal: AbortSignal.abort() }, row: 0 }, reader.deps)
    assert.deepEqual([unread.pick.check, unread.pick.note], ['unchecked', '⚠ Beleg von @muster.example angehängt, Betrag nicht geprüft (Analyse-Zeit aufgebraucht) — Beleg prüfen'])
    // before the deadline a failed download is „nicht lesbar“, as before
    const failed = standIn({ keyword: [msg('msg-u3', 'Ihre Rechnung', [pdf('1', 'Rechnung.pdf', 'u3', { base64: null, sha256: null, skipped: 'download_failed' })])] })
    const before = await findGmailReceipt(tx, { paths: [{ kind: 'keyword', name: 'MUSTER TELEKOM' }], run: newAnalyseRun([tx], { maxDurationS: 60 }), row: 0 }, failed.deps)
    assert.deepEqual(before.pick.candidates.map(c => c.why), ['unreadable'])
  })
  test('a dead connection (invalid_grant): said, kept for the run — later rows search no more and say the first error; a rate limit is no dead connection', async () => {
    const dead = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } })
    const run = newAnalyseRun([debit('a'), debit('b')], { maxDurationS: 60 })
    const { deps, log } = standIn({ senders: { '@muster.example': dead } })
    const first = await findGmailReceipt(debit('a'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([first.failed, first.pick.chosen], [[gmailFailedNote(dead)], null])
    assert.equal(run.gmailAuthError, dead)
    const later = await findGmailReceipt(debit('b'), { paths: [{ kind: 'keyword', name: 'MUSTER' }], run, row: 1 }, deps)
    assert.deepEqual([later.failed, later.pick.chosen, log.searches], [[gmailFailedNote(dead)], null, ['from:@muster.example']])
    const limited = Object.assign(new Error('User Rate Limit Exceeded'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })
    const run2 = newAnalyseRun([debit('a')], { maxDurationS: 60 })
    const busy = standIn({ senders: { '@muster.example': limited } })
    const once = await findGmailReceipt(debit('a'), { paths: SENDER, run: run2, row: 0 }, busy.deps)
    assert.deepEqual([once.failed, run2.gmailAuthError], [[gmailFailedNote(limited)], null])
    await findGmailReceipt(debit('a'), { paths: SENDER, run: run2, row: 0 }, busy.deps)
    assert.deepEqual(busy.log.searches, ['from:@muster.example', 'from:@muster.example'])
  })
})

describe('findGmailReceipt — an AI row: the processor, then the name', () => {
  const tx = debit('PADDLE.NET* ACME\\LISBOA', { counterparty: 'PADDLE.NET* ACME\\LISBOA' })
  const paths: GmailPath[] = [{ kind: 'processor', domain: 'paddle.com', name: 'ACME' }, { kind: 'keyword', name: 'ACME' }]
  test('the processor’s e-mails that do not name the vendor are none; none picked → the name search runs — its hits read too', async () => {
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { 'paddle.com': [msg('msg-h1', 'Your receipt', [pdf('1', 'receipt.pdf', 'h1')], { from: 'Paddle <receipts@paddle.example>', bodyText: 'Your purchase from Other Shop' })] },
      keyword: [msg('msg-h2', 'Ihre Rechnung von ACME', [pdf('1', 'invoice.pdf', 'h2')], { from: 'ACME <billing@acme.example>' })],
      reads: { h1: { amount: 23.45 }, h2: { amount: 23.45 } },
    })
    const found = await findGmailReceipt(tx, { paths, run, row: 0 }, deps)
    assert.deepEqual(log.searches, ['from:paddle.com', 'name:ACME'])
    assert.deepEqual([found.pick.check, found.pick.chosen?.messageId, log.reads], ['amount', 'msg-h2', ['h2']])
    assert.equal(found.pick.note, 'Gmail-Suche nach „ACME“ · Betrag 23,45 € stimmt')
  })
  test('the processor’s e-mail naming the vendor, of the amount: attached — no name search', async () => {
    const run = newAnalyseRun([tx], { maxDurationS: 60 })
    const { deps, log } = standIn({
      senders: { 'paddle.com': [msg('msg-h3', 'Your receipt', [pdf('1', 'receipt.pdf', 'h3')], { from: 'Paddle <receipts@paddle.example>', bodyText: 'Thank you for your purchase from ACME' })] },
      reads: { h3: { amount: 23.45 } },
    })
    const found = await findGmailReceipt(tx, { paths, run, row: 0 }, deps)
    assert.deepEqual([log.searches, found.pick.check], [['from:paddle.com'], 'amount'])
    assert.equal(found.pick.note, 'Gmail: paddle.com · „ACME“ im E-Mail-Text · Betrag 23,45 € stimmt')
  })
})

describe('findGmailReceipt — the claim', () => {
  test('should the claim fail all the same, the pick is made once more with the claims as they are', async () => {
    const tx = debit('x')
    const run = newAnalyseRun([tx, tx], { maxDurationS: 60 })
    const { deps } = standIn({
      senders: { '@muster.example': [msg('msg-i1', 'Rechnung', [pdf('1', 'a.pdf', 'i1')]), msg('msg-i2', 'Rechnung', [pdf('1', 'b.pdf', 'i2')])] },
      texts: { i1: { text: 'Gesamt 23,45 €', pages: 1 }, i2: { text: 'Gesamt 23,45 €', pages: 1 } },
      reads: { i1: { amount: 23.45 }, i2: { amount: 23.45 } },
    })
    const claim = run.claims.claim.bind(run.claims)
    let faster = true
    run.claims.claim = (keys, row, label) => {
      if (!faster) return claim(keys, row, label)
      // another row took it a moment before
      faster = false
      claim(keys, 1, 'Zeile 2')
      return false
    }
    const found = await findGmailReceipt(tx, { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.messageId], ['ambiguous', 'msg-i2'])
    assert.deepEqual(run.claims.ownerOf('gmail:msg-i2:1')?.row, 0)
  })
})

describe('findGmailReceipt — through the Gmail layer (lib/gmail.ts readMessages)', () => {
  test('the critic’s case [„Rechnung.pdf“, „AGB.PDF“ octet-stream]: the invoice attached by its amount, with its part id — the terms not read', async () => {
    const RECHNUNG = Buffer.from('%PDF-1.4 Rechnung')
    const AGB = Buffer.from('%PDF-1.4 AGB')
    const calls: GmailCalls = {
      list: async () => ['msg-k1'],
      message: async () => ({
        partId: '', mimeType: 'multipart/mixed', filename: '', body: { size: 0 },
        headers: [{ name: 'Subject', value: 'Ihre Rechnung' }, { name: 'From', value: 'Muster GmbH <rechnung@muster.example>' }, { name: 'Date', value: DAY(15) }],
        parts: [
          { partId: '1', mimeType: 'application/pdf', filename: 'Rechnung.pdf', body: { attachmentId: 'att-1', size: 2048 } },
          { partId: '2', mimeType: 'application/octet-stream', filename: 'AGB.PDF', body: { attachmentId: 'att-2', size: 2048 } },
        ],
      }),
      attachment: async (_m, id) => (id === 'att-1' ? RECHNUNG : AGB).toString('base64url'),
    }
    const isInvoice = (b64: string) => Buffer.from(b64, 'base64').toString().includes('Rechnung')
    const reads: string[] = []
    const deps: GmailReceiptDeps = {
      searchInvoices: async params => readMessages(calls, ['msg-k1'], params.invoiceNumber),
      searchInvoicesByKeyword: async () => [],
      pdfText: async b64 => ({ text: isInvoice(b64) ? 'Rechnung\nGesamt 23,45 €' : 'AGB', pages: 1 }),
      readPdf: async b64 => {
        reads.push(isInvoice(b64) ? 'Rechnung' : 'AGB')
        return { ...NOTHING, amount: isInvoice(b64) ? 23.45 : null, document_type: 'invoice' }
      },
    }
    const run = newAnalyseRun([debit('x')], { maxDurationS: 60 })
    const found = await findGmailReceipt(debit('x'), { paths: SENDER, run, row: 0 }, deps)
    assert.deepEqual([found.pick.check, found.pick.chosen?.partId, found.pick.chosen?.fileName, reads], ['amount', '1', 'Rechnung.pdf', ['Rechnung']])
    assert.equal(found.chosenBase64, RECHNUNG.toString('base64'))
  })
})

// ─── Wiring: read from the source (it loads googleapis, unpdf and the SDK) ───────────────
// Bookmatic's checks of its enrich route, matcher and upload route are not ported: in Mado one
// line is searched per request (src/app/api/bank-lines/[id]/receipts), tested in its own file.

const DIR = join(import.meta.dirname, '..')
// The code without its comments (those on lines of their own)
const code = (src: string) => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '')
const count = (s: string, piece: string) => s.split(piece).length - 1

describe('wiring: the search of one line', () => {
  test('gmail-receipt.ts: every search with the run’s limiter and signal; the pick claimed with no await between them', () => {
    const src = code(readFileSync(join(DIR, 'gmail-receipt.ts'), 'utf8'))
    assert.match(src, /const gmail: GmailCallOptions = \{ limit: run\.gmailLimit, signal: run\.signal \}/)
    assert.equal(count(src, ', gmail))'), 3)
    const pick = src.slice(src.indexOf('const pickAndClaim = (): ReceiptPick => {'), src.indexOf('let pick: ReceiptPick | null = null'))
    assert.doesNotMatch(pick, /\bawait\b/)
    assert.match(pick, /let pick = pickGmailReceipt\(cands, withoutPdf, ctx\)\s*if \(pick\.chosen && !run\.claims\.claim\(pick\.claimKeys, row, label\)\)/)
    // a dead connection kept for the run (lib/gmail-parts.ts)
    assert.match(src, /if \(isGmailAuthError\(e\) && !run\.gmailAuthError\) run\.gmailAuthError = e/)
  })
})
