import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bankInvoice, bankInvoiceKey, checkDraftGmailReceipts, gmailCandidateLabel, gmailCandidateLine, gmailDraftNotice, gmailFailedNote,
  gmailReceiptRefusal, gmailSameReceiptNote, isGmailReceiptNote, makeLimiter, normInvoiceNo, noteSafe, numberOnDocument, ownClaimKeys,
  pickGmailReceipt, rankCandidates, receiptDoubt, rowLabel, sameInvoiceNumber, timeUpPick, ReceiptClaims,
  CLASSIFIER_TIME_NOTE, GMAIL_ATTACH, GMAIL_CANDIDATES_TITLE, GMAIL_DRAFT_ROW_NOTE, GMAIL_PREVIEW, GMAIL_PREVIEW_TOO_LARGE, GMAIL_TIME_NOTE, GMAIL_TIME_PARTIAL_NOTE,
  OLD_PAGE_TEXT, RECEIPT_DOUBT_CHIP, STALE_GMAIL_RECEIPT_TEXT, gmailAttachedNote, gmailReceiptLoadError,
  gmailAttachable, gmailHasPdf, gmailPreviewable, isGmailSearchNote, GMAIL_PREVIEW_MAX_BYTES, RECEIPT_NO_TEXT_NOTE,
  type PdfCandidate, type PickContext, type ReceiptRead, type ReceiptVia,
} from '../receipt-match'
import { RECEIPT_UNREADABLE_NOTE } from '../invoice-parsing'
import type { EasybankTransaction, GmailCandidate, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// The Gmail receipt pick of P2-11 (PR „Job 1 fixes“ § 2.1 D, lib/receipt-match.ts). Synthetic
// debits and PDFs: made-up senders (muster.example, netzcom.example, acme.example), message
// ids msg-…, invoice numbers 910000000xxx, example IBANs AT00 0000 ….

const debit = (over: Partial<EasybankTransaction> = {}): EasybankTransaction => ({
  date: '2026-07-16', counterparty: 'MUSTER TELEKOM', amount: 23.45, type: 'expense', currency: 'EUR',
  reference: 'Abbuchung SEPA-Lastschrift OG/000000701|BKAUATWWXXX AT000000000000000020 Muster Telekom GmbH|Kundennr 4711', raw: {}, ...over,
})
// The same debit, its bank text naming its invoice
const NUMBERED = (over: Partial<EasybankTransaction> = {}) =>
  debit({ reference: 'Abbuchung SEPA-Lastschrift OG/000000702|BKAUATWWXXX AT000000000000000020 Muster Telekom GmbH|Rechnung 910000000123 vom 10.07.2026', ...over })

const SENDER: ReceiptVia = { kind: 'sender', sender: '@muster.example', ruleIds: ['mu'] }
const KEYWORD: ReceiptVia = { kind: 'keyword', name: 'MUSTER TELEKOM' }
const PROCESSOR: ReceiptVia = { kind: 'processor', domain: 'paddle.com', name: 'ACME' }
// The e-mails' dates: the debit is posted on 16.07.
const DATE = (day: number) => `Wed, ${day} Jul 2026 08:00:00 +0200`

let order = 0
const cand = (messageId: string, over: Partial<PdfCandidate> = {}): PdfCandidate => ({
  messageId, partId: '1', fileName: 'Rechnung.pdf', subject: 'Ihre Rechnung', from: 'Muster GmbH <rechnung@muster.example>',
  date: DATE(15), order: order++, size: 2048, sha256: `sha-${messageId}-${over.partId ?? '1'}`, text: '', pages: 1,
  downloaded: true, via: SENDER, ...over,
})
const read = (over: Partial<ReceiptRead> = {}): ReceiptRead => ({
  amount: null, amount_due: null, currency: 'EUR', foreign_total: null, invoice_number: null, date: '2026-07-14', vatin: null, document_type: 'invoice', ...over,
})
const ctx = (tx: EasybankTransaction, over: Partial<PickContext> = {}): PickContext =>
  ({ tx, bank: bankInvoice(tx), label: rowLabel(tx), claimedBy: () => null, otherNumbers: [], ...over })
const whys = (cs: GmailCandidate[]) => cs.map(c => [c.message_id, c.part_id, c.why])

describe('the bank text’s invoice number: read, normalised, ≥ 6 characters', () => {
  test('as the vendor wrote it, and as receipts are compared with it', () => {
    assert.deepEqual(bankInvoice(NUMBERED()), { number: '910000000123', key: '910000000123' })
    assert.equal(bankInvoiceKey(debit({ reference: 'Muster Festnetz Rechnung 910000000777 vom 05.01.2026' })), '910000000777')
    assert.equal(bankInvoiceKey(debit()), null)
    // column 1 is read, not the reference
    assert.equal(bankInvoiceKey(debit({ reference: 'irrelevant', raw: { col1: 'Netzcom|Rechnungsnr: 910000000555' } })), '910000000555')
  })
  test('a number cut at easybank’s line break („|“) is joined; a short or zero-padded one normalised', () => {
    assert.deepEqual(bankInvoice(debit({ raw: { col1: 'Muster Telekom Rechnung 9100|00000777 vom 05.01.2026' } })), { number: '910000000777', key: '910000000777' })
    // a 4-digit „number“ is on every receipt of the year: none
    assert.equal(bankInvoiceKey(debit({ reference: 'Rechnungsnr 2026 Juli' })), null)
    assert.deepEqual(bankInvoice(debit({ reference: 'Rechnungsnr 0012345678' })), { number: '0012345678', key: '12345678' })
    assert.equal(normInvoiceNo(' re-9100 0000-0123 '), 'RE910000000123')
    assert.equal(normInvoiceNo('00012345'), null)
    assert.equal(normInvoiceNo(null), null)
  })
  test('numberOnDocument: a whole token, digit groups joined first; leading zeros allowed', () => {
    assert.equal(numberOnDocument('910000000777', 'Rechnungsnummer 9100 0000 0777'), true)
    assert.equal(numberOnDocument('910000000777', 'Nr. 9100.0000.0777 vom 05.01.'), true)
    assert.equal(numberOnDocument('910000000123', 'RE-910000000123.pdf'), true)
    assert.equal(numberOnDocument('910000000123', 'RE910000000123.pdf'), true)
    assert.equal(numberOnDocument('12345678', 'Rechnung 0012345678'), true)
    // part of a longer number: none
    assert.equal(numberOnDocument('910000000123', 'Rechnung 9100000001234'), false)
    assert.equal(numberOnDocument('910000000123', 'Konto 19100000001230'), false)
    // the number followed by a quantity: found in the text as it is
    assert.equal(numberOnDocument('910000000123', 'Rechnung 910000000123 1 Stück'), true)
    assert.equal(numberOnDocument(null, 'Rechnung 910000000123'), false)
    assert.equal(numberOnDocument('910000000123', null), false)
    // the reader's number: equal once normalised, or the bank's in it
    assert.equal(sameInvoiceNumber('910000000123', 'RE-910000000123'), true)
    assert.equal(sameInvoiceNumber('910000000123', '9100 0000 0123'), true)
    assert.equal(sameInvoiceNumber('910000000123', '910000000456'), false)
  })
})

describe('pickGmailReceipt — attached only with proof (§ 2.1 D)', () => {
  test('one match: 23,45 vs 23,45 → „amount“, its provenance, nothing listed', () => {
    const tx = debit()
    const pick = pickGmailReceipt([cand('msg-a1', { read: read({ amount: 23.45 }) })], [], ctx(tx))
    assert.deepEqual([pick.check, pick.matchedOn, pick.chosen?.messageId], ['amount', 'gross', 'msg-a1'])
    assert.equal(pick.note, 'Gmail: @muster.example · Betrag 23,45 € stimmt')
    assert.equal(pick.plainNote, null)
    assert.deepEqual(pick.candidates, [])
    assert.equal(pick.read?.amount, 23.45)
  })
  test('the newer e-mail is the wrong one: [newer 25,90, older 23,45] → the older; the newer listed as another amount', () => {
    const tx = debit()
    const newer = cand('msg-b1', { date: DATE(18), read: read({ amount: 25.9 }) })
    const older = cand('msg-b2', { date: DATE(10), read: read({ amount: 23.45 }) })
    const pick = pickGmailReceipt([newer, older], [], ctx(tx))
    assert.deepEqual([pick.check, pick.chosen?.messageId], ['amount', 'msg-b2'])
    assert.deepEqual(whys(pick.candidates), [['msg-b1', '1', 'amount']])
    assert.equal(gmailCandidateLabel(pick.candidates[0], tx), '25,90 € — anderer Betrag')
  })
  test('the debit without the bank’s SPESEN: 27,60 with 0,41 fee, a receipt of 27,19 → „amount“ on the net', () => {
    const tx = debit({ amount: 27.6, fee: 0.41, net_amount: 27.19 })
    const pick = pickGmailReceipt([cand('msg-c1', { read: read({ amount: 27.19 }) })], [], ctx(tx))
    assert.deepEqual([pick.check, pick.matchedOn], ['amount', 'net'])
    assert.equal(pick.note, 'Gmail: @muster.example · Betrag 27,19 € + 0,41 € Spesen stimmt')
  })
  test('the amount due: a total of 30,00 and a Zahlbetrag of 21,00 for a debit of 21,00 → „amount“', () => {
    const tx = debit({ amount: 21 })
    const pick = pickGmailReceipt([cand('msg-c2', { read: read({ amount: 30, amount_due: 21 }) })], [], ctx(tx))
    assert.deepEqual([pick.check, pick.matchedOn, pick.read?.amount], ['amount', 'due', 30])
    assert.equal(pick.note, 'Gmail: @muster.example · Zahlbetrag 21,00 € stimmt')
  })
  test('within 2 cents: 23,47 → „amount“; 23,48 → none attached, said', () => {
    const tx = debit()
    assert.equal(pickGmailReceipt([cand('msg-d1', { read: read({ amount: 23.47 }) })], [], ctx(tx)).check, 'amount')
    const off = pickGmailReceipt([cand('msg-d2', { read: read({ amount: 23.48 }) })], [], ctx(tx))
    assert.equal(off.chosen, null)
    assert.equal(off.note, '⚠ 1 Beleg in Gmail gefunden, aber keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    assert.equal(off.plainNote, '1 Beleg in Gmail gefunden, aber keiner mit Betrag 23,45 € — kein Beleg nötig')
    assert.deepEqual(whys(off.candidates), [['msg-d2', '1', 'amount']])
    // with SPESEN: both amounts named
    const fee = pickGmailReceipt([cand('msg-d3', { read: read({ amount: 30 }) })], [], ctx(debit({ amount: 27.6, fee: 0.41, net_amount: 27.19 })))
    assert.equal(fee.note, '⚠ 1 Beleg in Gmail gefunden, aber keiner mit Betrag 27,60 € oder 27,19 € ohne Spesen — nicht angehängt: Beleg prüfen und anhängen')
  })
  test('the invoice and the terms in one e-mail: [part 1 23,45; part 2 not read] → part 1', () => {
    const pick = pickGmailReceipt([
      cand('msg-e1', { partId: '1', fileName: 'Rechnung_2026-07.pdf', read: read({ amount: 23.45 }) }),
      cand('msg-e1', { partId: '2', fileName: 'AGB.pdf', notRead: 'matched' }),
    ], [], ctx(debit()))
    assert.deepEqual([pick.check, pick.chosen?.partId], ['amount', '1'])
    assert.deepEqual(whys(pick.candidates), [['msg-e1', '2', 'unchecked']])
  })
  test('a foreign total: without the card stamp or the number → not attached, said; the stamp’s own amount → „amount“; the number in the file name → „number“', () => {
    const usd = read({ amount: null, currency: 'USD', foreign_total: 25 })
    const none = pickGmailReceipt([cand('msg-f1', { via: KEYWORD, read: usd })], [], ctx(debit()))
    assert.equal(none.chosen, null)
    assert.equal(none.note, '⚠ 1 Beleg in Gmail gefunden, Betrag in USD (25,00 USD) — mit der Abbuchung 23,45 € nicht vergleichbar, nicht angehängt: Beleg prüfen und anhängen')
    assert.deepEqual(whys(none.candidates), [['msg-f1', '1', 'foreign']])
    assert.equal(gmailCandidateLabel(none.candidates[0], debit()), '25,00 USD — nicht mit € vergleichbar')
    const card = debit({ counterparty: 'ACME CLOUD', reference: 'x', raw: { col1: 'Bezahlung Karte                              MC/000000702|E-COMM        25,00 USD K002 15.07. 10:51|ACME CLOUD\\DUBLIN' } })
    const stamp = pickGmailReceipt([cand('msg-f2', { via: { kind: 'keyword', name: 'ACME CLOUD' }, read: usd })], [], ctx(card))
    assert.deepEqual([stamp.check, stamp.matchedOn], ['amount', 'foreign'])
    assert.equal(stamp.note, 'Gmail-Suche nach „ACME CLOUD“ · Betrag 25,00 USD stimmt (Kartenumsatz)')
    // a cent off is still it; two cents are not
    assert.equal(pickGmailReceipt([cand('msg-f3', { via: KEYWORD, read: { ...usd, foreign_total: 25.01 } })], [], ctx(card)).check, 'amount')
    assert.equal(pickGmailReceipt([cand('msg-f4', { via: KEYWORD, read: { ...usd, foreign_total: 25.02 } })], [], ctx(card)).check, null)
    const numbered = pickGmailReceipt([cand('msg-f5', { fileName: 'Invoice-910000000123.pdf', read: usd })], [], ctx(NUMBERED()))
    assert.equal(numbered.check, 'number')
    assert.equal(numbered.note, '⚠ Beleg über Rechnungsnr. 910000000123 gefunden, Betrag 25,00 USD — mit 23,45 € nicht vergleichbar, Beleg prüfen · Gmail: @muster.example · Rechnungsnr. 910000000123')
  })
  test('a foreign total compared with the card stamp’s own amount: listed with it — „… — anderer Betrag“ when it is not the stamp’s, never „nicht geprüft“', () => {
    const card = debit({ counterparty: 'ACME CLOUD', amount: 8.9, reference: 'x', raw: { col1: 'Bezahlung Karte MC/000000702|E-COMM        9,57 USD K002 15.07. 10:51|ACME CLOUD' } })
    const other = pickGmailReceipt([cand('msg-f6', { via: KEYWORD, read: read({ currency: 'USD', foreign_total: 12 }) })], [], ctx(card))
    assert.deepEqual([other.chosen, whys(other.candidates)], [null, [['msg-f6', '1', 'amount']]])
    assert.equal(gmailCandidateLabel(other.candidates[0], card), '12,00 USD — anderer Betrag')
    // two of the stamp's amount: the one nearer the payment attached, the other listed by its amount
    const two = pickGmailReceipt([
      cand('msg-f7', { via: KEYWORD, date: DATE(15), read: read({ currency: 'USD', foreign_total: 9.57 }) }),
      cand('msg-f8', { via: KEYWORD, date: DATE(9), read: read({ currency: 'usd', foreign_total: 9.57 }) }),
    ], [], ctx(card))
    assert.deepEqual([two.check, two.chosen?.messageId], ['ambiguous', 'msg-f7'])
    assert.equal(gmailCandidateLabel(two.candidates[0], card), '9,57 USD')
    // without a card stamp: not compared at all
    assert.equal(gmailCandidateLabel({ ...other.candidates[0], why: 'foreign' }, debit()), '12,00 USD — nicht mit € vergleichbar')
  })
  test('a credit note, a negative total, an order confirmation — of the debit’s amount: never attached, listed', () => {
    const tx = debit()
    const credit = pickGmailReceipt([cand('msg-g1', { via: KEYWORD, read: read({ amount: 23.45, document_type: 'credit_note' }) })], [], ctx(tx))
    assert.deepEqual([credit.chosen, whys(credit.candidates)], [null, [['msg-g1', '1', 'credit_note']]])
    assert.equal(gmailCandidateLabel(credit.candidates[0], tx), 'Gutschrift')
    const negative = pickGmailReceipt([cand('msg-g2', { read: read({ amount: -23.45 }) })], [], ctx(tx))
    assert.deepEqual([negative.chosen, whys(negative.candidates)], [null, [['msg-g2', '1', 'credit_note']]])
    const order = pickGmailReceipt([cand('msg-g3', { read: read({ amount: 23.45, document_type: 'order_confirmation' }) })], [], ctx(tx))
    assert.deepEqual([order.chosen, whys(order.candidates)], [null, [['msg-g3', '1', 'not_invoice']]])
    assert.equal(gmailCandidateLabel(order.candidates[0], tx), 'keine Rechnung (Bestellbestätigung)')
    for (const [type, art] of [['reminder', 'Mahnung'], ['delivery_note', 'Lieferschein'], ['quote', 'Angebot']] as const) {
      const p = pickGmailReceipt([cand('msg-g4', { read: read({ amount: 23.45, document_type: type }) })], [], ctx(tx))
      assert.equal(gmailCandidateLabel(p.candidates[0], tx), `keine Rechnung (${art})`)
    }
    // a receipt and „other“ are no reason to leave it
    for (const type of ['receipt', 'other', null] as const) {
      assert.equal(pickGmailReceipt([cand('msg-g5', { read: read({ amount: 23.45, document_type: type }) })], [], ctx(tx)).check, 'amount', String(type))
    }
  })
  test('another invoice number than the bank’s, not on it either: excluded; the one with the bank’s number chosen, said', () => {
    const tx = NUMBERED()
    const a = cand('msg-h1', { read: read({ amount: 23.45, invoice_number: '910000000456' }) })
    const b = cand('msg-h2', { read: read({ amount: 23.45, invoice_number: '910000000123' }) })
    const pick = pickGmailReceipt([a, b], [], ctx(tx))
    assert.deepEqual([pick.check, pick.chosen?.messageId], ['amount', 'msg-h2'])
    assert.equal(pick.note, 'Gmail: @muster.example · Betrag 23,45 € stimmt · Rechnungsnr. 910000000123')
    assert.deepEqual(whys(pick.candidates), [['msg-h1', '1', 'number']])
    assert.equal(gmailCandidateLabel(pick.candidates[0], tx, '910000000123'), 'Rechnungsnr. 910000000456 statt 910000000123')
    // the bank's number on the document after all (its text): no conflict
    const onIt = cand('msg-h3', { text: 'Rechnung 910000000123\nGesamt 23,45 €', read: read({ amount: 23.45, invoice_number: 'K-4711-0815' }) })
    assert.equal(pickGmailReceipt([onIt], [], ctx(tx)).check, 'amount')
  })
  test('the only match another row of the run has: none attached, its row named — „der anderen Zeile“ when the labels are the same', () => {
    const tx = debit()
    const taken = cand('msg-i1', { read: read({ amount: 23.45 }) })
    const other = '15.06.2026 MUSTER TELEKOM 23,45 €'
    const pick = pickGmailReceipt([taken], [], ctx(tx, { claimedBy: k => (k === 'gmail:msg-i1:1' ? other : null) }))
    assert.equal(pick.chosen, null)
    assert.equal(pick.note, '⚠ Beleg „Rechnung.pdf“ (23,45 €) passt, ist aber schon der Zeile „15.06.2026 MUSTER TELEKOM 23,45 €“ zugeordnet — nicht doppelt angehängt, Beleg prüfen')
    assert.deepEqual(pick.candidates.map(c => [c.why, c.claimed_by]), [['claimed', other]])
    assert.equal(gmailCandidateLabel(pick.candidates[0], tx), 'schon bei „15.06.2026 MUSTER TELEKOM 23,45 €“')
    const same = pickGmailReceipt([taken], [], ctx(tx, { claimedBy: () => rowLabel(tx) }))
    assert.equal(same.note, `⚠ Beleg „Rechnung.pdf“ (23,45 €) passt, ist aber schon der anderen Zeile „${rowLabel(tx)}“ zugeordnet — nicht doppelt angehängt, Beleg prüfen`)
    // its line too: never the row's own label as if it were this row (review GMAIL-06)
    assert.equal(gmailCandidateLabel(same.candidates[0], tx), 'schon bei der anderen Zeile „16.07.2026 MUSTER TELEKOM 23,45 €“')
  })
  test('two identical purchases: [m1 23,45, m2 23,45], m1 claimed by the first row → the second gets m2, „ambiguous“, not silently', () => {
    const tx = debit()
    const m1 = cand('msg-j1', { date: DATE(15), read: read({ amount: 23.45 }) })
    const m2 = cand('msg-j2', { date: DATE(14), read: read({ amount: 23.45 }) })
    const first = pickGmailReceipt([m1, m2], [], ctx(tx))
    assert.deepEqual([first.check, first.chosen?.messageId], ['ambiguous', 'msg-j1'])
    const second = pickGmailReceipt([m1, m2], [], ctx(tx, { claimedBy: k => (k.includes('msg-j1') ? 'Zeile 1' : null) }))
    assert.deepEqual([second.check, second.chosen?.messageId], ['ambiguous', 'msg-j2'])
    assert.equal(second.note, '⚠ 2 Belege mit Betrag 23,45 € in Gmail — angehängt ist „Rechnung.pdf“ vom 14.07.2026, der Zahlung am nächsten: prüfen · Gmail: @muster.example · Betrag 23,45 € stimmt')
    assert.deepEqual(second.candidates.map(c => [c.message_id, c.why, c.claimed_by]), [['msg-j1', 'claimed', 'Zeile 1']])
    // the alternative of the same amount is listed as that amount
    assert.equal(gmailCandidateLabel(first.candidates[0], tx), '23,45 €')
  })
  test('copies: the same invoice sent twice (sender domain and number) is one document — „amount“, claimed by all its keys', () => {
    const tx = NUMBERED()
    const r = read({ amount: 23.45, invoice_number: '910000000123' })
    const pick = pickGmailReceipt([cand('msg-k1', { fileName: 'Kopie.pdf', read: r }), cand('msg-k2', { fileName: 'Rechnung_910000000123.pdf', read: r })], [], ctx(tx))
    assert.deepEqual([pick.check, pick.chosen?.messageId], ['amount', 'msg-k2'])
    assert.deepEqual(pick.claimKeys.sort(), [
      'gmail:msg-k1:1', 'gmail:msg-k2:1', 'inv:muster.example:910000000123', 'sha:sha-msg-k1-1', 'sha:sha-msg-k2-1',
    ])
    // the same bytes in two e-mails: one document too
    const bytes = pickGmailReceipt([cand('msg-k3', { sha256: 'same', read: read({ amount: 23.45 }) }), cand('msg-k4', { sha256: 'same', read: read({ amount: 23.45 }) })], [], ctx(debit()))
    assert.equal(bytes.check, 'amount')
    assert.deepEqual(bytes.candidates, [])
  })
  test('copies by sender domain and number read with different amounts: the one of the debit’s amount is attached, with what was read of it — never the other', () => {
    // an invoice of 50,00 and a payment's receipt of 23,45, both naming one invoice number:
    // one document by its keys; the invoice-like name and Gmail's order would take the invoice
    const pick = pickGmailReceipt([
      cand('msg-k5', { partId: '1', fileName: 'Rechnung_910000000123.pdf', read: read({ amount: 50, invoice_number: '910000000123' }) }),
      cand('msg-k5', { partId: '2', fileName: 'Zahlung.pdf', read: read({ amount: 23.45, invoice_number: '910000000123', document_type: 'receipt' }) }),
    ], [], ctx(debit()))
    assert.deepEqual([pick.check, pick.chosen?.partId, pick.chosen?.fileName, pick.read?.amount], ['amount', '2', 'Zahlung.pdf', 23.45])
    assert.equal(pick.note, 'Gmail: @muster.example · Betrag 23,45 € stimmt')
    // still one document: claimed by both parts' keys
    assert.deepEqual(pick.claimKeys.sort(), ['gmail:msg-k5:1', 'gmail:msg-k5:2', 'inv:muster.example:910000000123', 'sha:sha-msg-k5-1', 'sha:sha-msg-k5-2'])
  })
  test('two different invoices of one amount in one e-mail (different numbers): two documents — the nearer attached, „ambiguous“', () => {
    const pick = pickGmailReceipt([
      cand('msg-l1', { partId: '1', fileName: 'Rechnung_Vertrag_A.pdf', read: read({ amount: 23.45, invoice_number: '910000000201' }) }),
      cand('msg-l1', { partId: '2', fileName: 'Rechnung_Vertrag_B.pdf', read: read({ amount: 23.45, invoice_number: '910000000202' }) }),
    ], [], ctx(debit()))
    assert.deepEqual([pick.check, pick.chosen?.partId], ['ambiguous', '1'])
    assert.deepEqual(whys(pick.candidates), [['msg-l1', '2', 'amount']])
  })
  test('the bank’s number in the subject of an e-mail with two PDFs speaks for neither: the part read with it is attached — never the first by MIME order (review GMAIL-01)', () => {
    const tx = NUMBERED()
    const subject = 'Ihre Rechnung 910000000123'
    // (a) another purchase's invoice of the same amount first, then the row's own
    const other = cand('msg-z1', { partId: '1', subject, pdfParts: 2, fileName: 'Rechnung_910000000201.pdf', read: read({ amount: 23.45, invoice_number: '910000000201' }) })
    const own = cand('msg-z1', { partId: '2', subject, pdfParts: 2, fileName: 'Rechnung_910000000123.pdf', read: read({ amount: 23.45, invoice_number: '910000000123' }) })
    const a = pickGmailReceipt([other, own], [], ctx(tx))
    assert.deepEqual([a.check, a.chosen?.partId], ['amount', '2'])
    assert.deepEqual(whys(a.candidates), [['msg-z1', '1', 'number']])
    assert.equal(gmailCandidateLabel(a.candidates[0], tx, '910000000123'), 'Rechnungsnr. 910000000201 statt 910000000123')
    // (b) a payment confirmation of the amount first, then the invoice
    const confirmation = cand('msg-z2', { partId: '1', subject, pdfParts: 2, fileName: 'Zahlungsbestaetigung.pdf', read: read({ amount: 23.45, document_type: 'receipt' }) })
    const invoice = cand('msg-z2', { partId: '2', subject, pdfParts: 2, read: read({ amount: 23.45, invoice_number: '910000000123' }) })
    const b = pickGmailReceipt([confirmation, invoice], [], ctx(tx))
    assert.deepEqual([b.check, b.chosen?.partId], ['amount', '2'])
    // (c) no number in the subject: a payment slip whose own text prints it, then the invoice read with it
    const slip = cand('msg-z3', { partId: '1', pdfParts: 2, fileName: 'Zahlschein.pdf', text: 'Verwendungszweck 910000000123 Betrag 23,45', read: read({ amount: 23.45, document_type: 'other' }) })
    const billed = cand('msg-z3', { partId: '2', pdfParts: 2, read: read({ amount: 23.45, invoice_number: '910000000123' }) })
    const c = pickGmailReceipt([slip, billed], [], ctx(tx))
    assert.deepEqual([c.check, c.chosen?.partId], ['amount', '2'])
    // (d) neither read with the number: two documents of the amount — „ambiguous“, never „amount“
    const x = cand('msg-z4', { partId: '1', subject, pdfParts: 2, read: read({ amount: 23.45 }) })
    const y = cand('msg-z4', { partId: '2', subject, pdfParts: 2, read: read({ amount: 23.45 }) })
    assert.equal(pickGmailReceipt([x, y], [], ctx(tx)).check, 'ambiguous')
    // two parts whose own texts both print the number, neither read with it: „ambiguous“ too
    const slips = [1, 2].map(p => cand('msg-z5', { partId: String(p), pdfParts: 2, text: 'Rechnung 910000000123', read: read({ amount: 23.45 }) }))
    assert.equal(pickGmailReceipt(slips, [], ctx(tx)).check, 'ambiguous')
    // (e) the e-mail's only PDF: its subject still speaks for it, a misread number all the same
    const single = cand('msg-z6', { subject, pdfParts: 1, read: read({ amount: 23.45, invoice_number: 'K-4711-0815' }) })
    assert.equal(pickGmailReceipt([single], [], ctx(tx)).check, 'amount')
  })
  test('the bank’s number, no amount (rule 3): the part read with it — not the terms beside it the subject names too (review GMAIL-B2)', () => {
    const tx = NUMBERED()
    const subject = 'Ihre Rechnung 910000000123'
    // (f) [AGB, the invoice of another amount read with the number]
    const agb = cand('msg-z7', { partId: '1', subject, pdfParts: 2, fileName: 'AGB.pdf', read: read({ document_type: 'other' }) })
    const invoice = cand('msg-z7', { partId: '2', subject, pdfParts: 2, read: read({ amount: 25.9, invoice_number: '910000000123' }) })
    const f = pickGmailReceipt([agb, invoice], [], ctx(tx))
    assert.deepEqual([f.check, f.chosen?.partId], ['number', '2'])
    assert.match(f.note ?? '', /^⚠ Beleg über Rechnungsnr\. 910000000123 gefunden, aber Betrag 25,90 € statt 23,45 € — Beleg prüfen · /)
    // two whose texts print the number, one read with it: that one, though the other is nearer
    const near = cand('msg-z8', { date: DATE(16), text: 'Rechnung 910000000123', read: read({ amount: 21 }) })
    const read123 = cand('msg-z9', { date: DATE(3), text: 'Rechnung 910000000123', read: read({ amount: 21, invoice_number: '910000000123' }) })
    assert.deepEqual(pickGmailReceipt([near, read123], [], ctx(tx)).chosen?.messageId, 'msg-z9')
  })
  test('a number another row’s bank text names: claimed — read, or on the document', () => {
    const tx = debit()
    const others = [{ key: '910000000999', label: '15.07.2026 MUSTER TELEKOM 23,45 € · Rechnungsnr. 910000000999' }]
    const byRead = pickGmailReceipt([cand('msg-m1', { read: read({ amount: 23.45, invoice_number: '910000000999' }) })], [], ctx(tx, { otherNumbers: others }))
    assert.deepEqual([byRead.chosen, byRead.candidates.map(c => [c.why, c.claimed_by])], [null, [['claimed', others[0].label]]])
    // the row label goes into the note note-safe: no „ · “ inside it
    assert.equal(byRead.note, '⚠ Beleg „Rechnung.pdf“ (23,45 €) passt, ist aber schon der Zeile „15.07.2026 MUSTER TELEKOM 23,45 € - Rechnungsnr. 910000000999“ zugeordnet — nicht doppelt angehängt, Beleg prüfen')
    const inName = pickGmailReceipt([cand('msg-m2', { fileName: 'RE_910000000999.pdf', notRead: 'time' })], [], ctx(tx, { otherNumbers: others }))
    assert.deepEqual(whys(inName.candidates), [['msg-m2', '1', 'claimed']])
    // this row's own number (also another's): its own — not excluded
    const own = debit({ reference: 'Rechnung 910000000999' })
    assert.equal(pickGmailReceipt([cand('msg-m3', { read: read({ amount: 23.45, invoice_number: '910000000999' }) })], [], ctx(own)).check, 'amount')
  })
  test('a PDF read with this row’s own number is its own, though its text names another row’s number; one read with the other’s stays off it (review GMAIL-03)', () => {
    const july = debit({ reference: 'Muster Telekom Rechnung 910000000777 vom 05.07.2026' })
    const others = [{ key: '910000000666', label: '16.06.2026 MUSTER TELEKOM 23,45 € · Rechnungsnr. 910000000666' }]
    // (a) the July invoice prints the June one's number („Ihre letzte Rechnung …“)
    const own = cand('msg-aa1', {
      fileName: 'Rechnung_910000000777.pdf', text: 'Rechnung 910000000777 Summe 23,45 € Ihre letzte Rechnung 910000000666 wurde abgebucht',
      read: read({ amount: 23.45, invoice_number: '910000000777' }),
    })
    const a = pickGmailReceipt([own], [], ctx(july, { otherNumbers: others }))
    assert.deepEqual([a.check, a.chosen?.messageId, a.note], ['amount', 'msg-aa1', 'Gmail: @muster.example · Betrag 23,45 € stimmt · Rechnungsnr. 910000000777'])
    // (b) the June invoice, read with June's number, whose text names July's: the June row's
    const theirs = cand('msg-aa2', { text: 'Rechnung 910000000666 … nächste Rechnung 910000000777', read: read({ amount: 23.45, invoice_number: '910000000666' }) })
    const b = pickGmailReceipt([theirs], [], ctx(july, { otherNumbers: others }))
    assert.deepEqual([b.chosen, b.candidates.map(c => [c.why, c.claimed_by])], [null, [['claimed', others[0].label]]])
    // (c) one e-mail holding both rows' invoices, its subject naming both numbers: each row its own part
    const subject = 'Ihre Rechnungen 910000000123 und 910000000124'
    const label124 = '16.07.2026 MUSTER TELEKOM 23,45 € · Rechnungsnr. 910000000124'
    const p124 = cand('msg-aa3', { partId: '1', subject, pdfParts: 2, fileName: 'Rechnung_910000000124.pdf', read: read({ amount: 23.45, invoice_number: '910000000124' }) })
    const p123 = cand('msg-aa3', { partId: '2', subject, pdfParts: 2, fileName: 'Rechnung_910000000123.pdf', read: read({ amount: 23.45, invoice_number: '910000000123' }) })
    const c = pickGmailReceipt([p124, p123], [], ctx(NUMBERED(), { otherNumbers: [{ key: '910000000124', label: label124 }] }))
    assert.deepEqual([c.check, c.chosen?.partId, c.candidates.map(x => [x.part_id, x.why, x.claimed_by])], ['amount', '2', [['1', 'claimed', label124]]])
  })
  test('the bank’s number on it, no amount: „number“ — the nearest of several; its amount, or why none, said', () => {
    const tx = NUMBERED()
    const other = pickGmailReceipt([cand('msg-n1', { subject: 'Ihre Rechnung 910000000123', read: read({ amount: 21 }) })], [], ctx(tx))
    assert.equal(other.check, 'number')
    assert.equal(other.note, '⚠ Beleg über Rechnungsnr. 910000000123 gefunden, aber Betrag 21,00 € statt 23,45 € — Beleg prüfen · Gmail: @muster.example · Rechnungsnr. 910000000123')
    const unread = pickGmailReceipt([cand('msg-n2', { subject: 'Rechnung 910000000123', readError: 'Request timed out.' })], [], ctx(tx))
    assert.equal(unread.check, 'number')
    assert.equal(unread.note, `${RECEIPT_UNREADABLE_NOTE} · Gmail: @muster.example · Rechnungsnr. 910000000123`)
    const nearest = pickGmailReceipt([
      cand('msg-n3', { date: DATE(2), text: 'Rechnung 910000000123', notRead: 'budget' }),
      cand('msg-n4', { date: DATE(14), text: 'Rechnung 9100 0000 0123', notRead: 'budget' }),
    ], [], ctx(tx))
    assert.deepEqual([nearest.check, nearest.chosen?.messageId], ['number', 'msg-n4'])
    // on the name search too
    const keyword = pickGmailReceipt([cand('msg-n5', { via: KEYWORD, fileName: '910000000123.pdf', notRead: 'time' })], [], ctx(tx))
    assert.equal(keyword.note, `${RECEIPT_UNREADABLE_NOTE} · Gmail-Suche nach „MUSTER TELEKOM“ · Rechnungsnr. 910000000123`)
  })
  test('D2: a Buchungsregel’s sender’s only PDF whose amount could not be checked → „unchecked“, why said', () => {
    const tx = debit()
    const cases: [Partial<PdfCandidate>, string][] = [
      [{ readError: 'Request timed out.' }, 'nicht lesbar'],
      [{ notRead: 'time' }, 'Analyse-Zeit aufgebraucht'],
      [{ notRead: 'budget' }, 'Analyse-Zeit aufgebraucht'],
      [{ notRead: 'pages', pages: 14 }, 'mehr als 10 Seiten'],
      [{ read: read() }, 'kein Betrag gelesen'],
      [{ read: read({ currency: 'USD', foreign_total: 25 }) }, 'Betrag in USD'],
    ]
    for (const [over, reason] of cases) {
      const pick = pickGmailReceipt([cand('msg-o1', over)], [], ctx(tx))
      assert.equal(pick.check, 'unchecked', reason)
      assert.equal(pick.note, `⚠ Beleg von @muster.example angehängt, Betrag nicht geprüft (${reason}) — Beleg prüfen`, reason)
    }
    // its amount checked and another: not attached; two PDFs: none; another path: none
    assert.equal(pickGmailReceipt([cand('msg-o2', { read: read({ amount: 30 }) })], [], ctx(tx)).check, null)
    assert.equal(pickGmailReceipt([cand('msg-o3', { readError: 'x' }), cand('msg-o4', { readError: 'x' })], [], ctx(tx)).check, null)
    const keyword = pickGmailReceipt([cand('msg-o5', { via: KEYWORD, readError: 'x' })], [], ctx(tx))
    assert.equal(keyword.check, null)
    assert.equal(keyword.note, '⚠ 1 Beleg in Gmail gefunden, aber nicht lesbar — nicht angehängt: Beleg prüfen und anhängen')
    assert.deepEqual(whys(keyword.candidates), [['msg-o5', '1', 'unreadable']])
    // one not downloaded (beyond the search's budget) cannot be attached
    assert.equal(pickGmailReceipt([cand('msg-o6', { downloaded: false, text: null, notRead: 'not_downloaded' })], [], ctx(tx)).check, null)
  })
  test('D2 not beside a PDF of the debit’s amount left out for its invoice number alone: an AGB is never attached instead of the invoice read with a misread number — both listed (review check)', () => {
    const tx = NUMBERED()
    // one e-mail „Ihre Rechnung 910000000123“: the invoice a scan read at 23,45 € with a misread number, and the AGB
    const both = { subject: 'Ihre Rechnung 910000000123', pdfParts: 2 }
    const invoice = cand('msg-o7', { ...both, read: read({ amount: 23.45, invoice_number: 'K-4711-0815' }) })
    const agb = cand('msg-o7', { ...both, partId: '2', fileName: 'AGB.pdf', text: 'Allgemeine Geschäftsbedingungen', read: read({ document_type: 'other' }) })
    const pick = pickGmailReceipt([invoice, agb], [], ctx(tx))
    assert.deepEqual([pick.chosen, pick.check], [null, null])
    assert.deepEqual(whys(pick.candidates), [['msg-o7', '2', 'unchecked'], ['msg-o7', '1', 'number']])
    assert.equal(pick.note, '⚠ 2 Belege in Gmail gefunden, 1 davon nicht geprüft, keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    // the AGB alone, or beside a PDF of another amount left out for its number: D2 as before
    assert.equal(pickGmailReceipt([agb], [], ctx(tx)).check, 'unchecked')
    const other = cand('msg-o7', { ...both, read: read({ amount: 99, invoice_number: 'K-4711-0815' }) })
    assert.equal(pickGmailReceipt([other, agb], [], ctx(tx)).check, 'unchecked')
  })
  test('none read: „{k} davon nicht geprüft“ — two unread, none matched', () => {
    const pick = pickGmailReceipt([cand('msg-p1', { notRead: 'budget' }), cand('msg-p2', { notRead: 'budget' })], [], ctx(debit()))
    assert.equal(pick.chosen, null)
    assert.equal(pick.note, '⚠ 2 Belege in Gmail gefunden, 2 davon nicht geprüft, keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    assert.deepEqual(pick.candidates.map(c => gmailCandidateLabel(c, debit())), ['nicht geprüft', 'nicht geprüft'])
  })
  test('some not read for time (the read stop, the deadline): „nicht geprüft (Analyse-Zeit aufgebraucht)“ — not for the read budget, the row cap or a match before them (review check GMAIL-B5)', () => {
    const tx = debit()
    const timeCut = pickGmailReceipt([cand('msg-p3', { read: read({ amount: 30 }) }), cand('msg-p4', { notRead: 'time' })], [], ctx(tx))
    assert.equal(timeCut.note, '⚠ 2 Belege in Gmail gefunden, 1 davon nicht geprüft (Analyse-Zeit aufgebraucht), keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen')
    assert.equal(timeCut.plainNote, '2 Belege in Gmail gefunden, 1 davon nicht geprüft (Analyse-Zeit aufgebraucht), keiner mit Betrag 23,45 € — kein Beleg nötig')
    assert.equal(isGmailSearchNote(timeCut.note!), true)
    for (const notRead of ['budget', 'row_cap', 'matched', 'not_downloaded'] as const) {
      const other = pickGmailReceipt([cand('msg-p5', { read: read({ amount: 30 }) }), cand('msg-p6', { notRead, downloaded: notRead !== 'not_downloaded' })], [], ctx(tx))
      assert.equal(other.note, '⚠ 2 Belege in Gmail gefunden, 1 davon nicht geprüft, keiner mit Betrag 23,45 € — nicht angehängt: Beleg prüfen und anhängen', notRead)
    }
  })
  test('a scan left unread (time, the run’s reads, the row’s) in the e-mail of a PDF proven by its amount alone: attached by the amount as „ambiguous“, said, never proof (repair check GI-4)', () => {
    const conf = (over: Partial<PdfCandidate> = {}) =>
      cand('msg-s1', { partId: '1', fileName: 'Zahlungsbestaetigung.pdf', pdfParts: 2, text: 'Betrag 23,45 EUR', read: read({ amount: 23.45, document_type: 'receipt' }), ...over })
    const scan = (notRead: PdfCandidate['notRead']) => cand('msg-s1', { partId: '2', fileName: 'Rechnung.pdf', pdfParts: 2, text: '', notRead })
    const reasons = { time: 'Analyse-Zeit aufgebraucht', budget: 'Lesebudget der Analyse aufgebraucht', row_cap: 'Leselimit der Zeile erreicht' } as const
    for (const tx of [debit(), NUMBERED()]) {
      for (const [notRead, reason] of Object.entries(reasons) as [keyof typeof reasons, string][]) {
        const pick = pickGmailReceipt([conf(), scan(notRead)], [], ctx(tx))
        assert.deepEqual([pick.check, pick.chosen?.partId], ['ambiguous', '1'], notRead)
        assert.equal(pick.note, `⚠ In derselben E-Mail „Rechnung.pdf“ nicht geprüft (${reason}) — angehängt nach dem Betrag: Beleg prüfen · Gmail: @muster.example · Betrag 23,45 € stimmt`, notRead)
        assert.deepEqual(whys(pick.candidates), [['msg-s1', '2', 'unchecked']], notRead)
        assert.equal(receiptDoubt({ gmail_message_id: 'msg-s1', receipt_check: pick.check! }), true)
        assert.equal(pick.note!.split(' · ').every(isGmailReceiptNote), true, notRead)
      }
    }
    // the confirmation's text names the bank's number, its read does not: the amount alone all the same
    const named = pickGmailReceipt([conf({ text: 'Zahlung zu Rechnung 910000000123: 23,45 EUR' }), scan('time')], [], ctx(NUMBERED()))
    assert.equal(named.check, 'ambiguous')
    // read with the bank's number: proof, whatever is left unread beside it
    const byNumber = pickGmailReceipt([conf({ read: read({ amount: 23.45, invoice_number: '910000000123' }) }), scan('time')], [], ctx(NUMBERED()))
    assert.deepEqual([byNumber.check, byNumber.note], ['amount', 'Gmail: @muster.example · Betrag 23,45 € stimmt · Rechnungsnr. 910000000123'])
    // a scan read, or one in another e-mail, or not read for its pages or another match: proof as before
    for (const other of [
      cand('msg-s1', { partId: '2', fileName: 'Rechnung.pdf', pdfParts: 2, text: '', read: read({ amount: 30 }) }),
      cand('msg-s2', { fileName: 'Scan.pdf', text: '', notRead: 'time' }),
      cand('msg-s1', { partId: '2', fileName: 'Rechnung.pdf', pdfParts: 2, text: '', notRead: 'pages', pages: 12 }),
      cand('msg-s1', { partId: '2', fileName: 'AGB.pdf', pdfParts: 2, text: 'Allgemeine Geschäftsbedingungen', notRead: 'time' }),
    ]) {
      assert.equal(pickGmailReceipt([conf(), other], [], ctx(debit())).check, 'amount', other.fileName)
    }
  })
  test('e-mails without PDF: said on a sender’s or a processor’s search, on the name search only when the subject names a receipt', () => {
    const tx = debit()
    const mail = (messageId: string, subject: string, via: ReceiptVia) => ({ messageId, subject, from: 'Muster <info@muster.example>', date: DATE(15), via })
    const one = pickGmailReceipt([], [mail('msg-q1', 'Zahlungsbestätigung · Juli', SENDER)], ctx(tx))
    assert.equal(one.note, '⚠ E-Mail „Zahlungsbestätigung - Juli“ vom 15.07.2026 gefunden, aber ohne PDF — Rechnung beim Händler holen und anhängen (eine Bestell- oder Zahlungsbestätigung ist keine Rechnung)')
    assert.equal(one.plainNote, 'E-Mail „Zahlungsbestätigung - Juli“ vom 15.07.2026 gefunden, aber ohne PDF — kein Beleg nötig')
    assert.deepEqual(whys(one.candidates), [['msg-q1', null, 'no_pdf']])
    assert.equal(gmailCandidateLabel(one.candidates[0], tx), 'ohne PDF')
    const two = pickGmailReceipt([], [mail('msg-q2', 'Ihr Beleg', PROCESSOR), mail('msg-q3', 'Receipt', PROCESSOR)], ctx(tx))
    assert.equal(two.note, '⚠ 2 E-Mails gefunden, aber ohne PDF — Rechnung beim Händler holen und anhängen (eine Bestell- oder Zahlungsbestätigung ist keine Rechnung)')
    const newsletter = pickGmailReceipt([], [mail('msg-q4', 'Newsletter', KEYWORD)], ctx(tx))
    assert.deepEqual([newsletter.note, newsletter.candidates], [null, []])
    assert.equal(pickGmailReceipt([], [mail('msg-q5', 'Ihre Rechnung', KEYWORD)], ctx(tx)).candidates.length, 1)
    // nothing found at all: nothing said
    assert.deepEqual(pickGmailReceipt([], [], ctx(tx)).note, null)
  })
  test('over 10 MB and more than 10 pages: listed with what to do', () => {
    const tx = debit()
    const pick = pickGmailReceipt([
      cand('msg-r1', { via: KEYWORD, downloaded: false, text: null, notRead: 'too_large', size: 11 * 1024 * 1024 }),
      cand('msg-r2', { via: KEYWORD, pages: 14, notRead: 'pages' }),
    ], [], ctx(tx))
    assert.equal(pick.chosen, null)
    assert.deepEqual(pick.candidates.map(c => gmailCandidateLabel(c, tx)), ['mehr als 10 Seiten — nicht geprüft', 'PDF über 10 MB — in bookamat anhängen'])
  })
  test('the list never carries a PDF’s data; a foreign currency only with a foreign total', () => {
    const pick = pickGmailReceipt([cand('msg-s1', { via: KEYWORD, read: read({ amount: 30, currency: 'EUR' }) })], [], ctx(debit()))
    assert.deepEqual(Object.keys(pick.candidates[0]).sort(), [
      'amount', 'currency', 'date', 'document_type', 'file_name', 'foreign_total', 'from', 'invoice_number', 'message_id', 'part_id', 'size', 'subject', 'why',
    ])
    assert.equal(pick.candidates[0].currency, null)
    assert.equal(gmailCandidateLine(pick.candidates[0], debit()), '„Rechnung.pdf“ · muster.example · 15.07.2026 · 30,00 € — anderer Betrag')
  })
})

describe('rankCandidates — the order Analyse reads in', () => {
  test('the bank’s number, then the debit in the text, then no text layer, then the nearest e-mail, then Gmail’s order; not downloaded last', () => {
    const tx = NUMBERED()
    const plain = cand('msg-t1', { text: 'AGB', date: DATE(16) })
    const scan = cand('msg-t2', { text: '', date: DATE(16) })
    const debitText = cand('msg-t3', { text: 'Gesamt 23,45 €', date: DATE(1) })
    const numberText = cand('msg-t4', { text: 'Rechnung 910000000123', date: DATE(1) })
    const near = cand('msg-t5', { text: 'AGB', date: DATE(15) })
    const lost = cand('msg-t6', { downloaded: false, text: null, subject: 'Rechnung 910000000123' })
    const ranked = rankCandidates([lost, plain, near, scan, debitText, numberText], { tx, bank: bankInvoice(tx) })
    assert.deepEqual(ranked.map(c => c.messageId), ['msg-t4', 'msg-t3', 'msg-t2', 'msg-t1', 'msg-t5', 'msg-t6'])
    // pdf-parse's text of a scan is „\n\n“ a page: no text layer all the same (repair check GI-1)
    const parsedScan = cand('msg-t2', { text: '\n\n\n\n', date: DATE(16) })
    assert.deepEqual(rankCandidates([plain, near, parsedScan], { tx, bank: bankInvoice(tx) }).map(c => c.messageId), ['msg-t2', 'msg-t1', 'msg-t5'])
    // the card stamp's own amount in the text counts as the debit
    const card = debit({ raw: { col1: 'Bezahlung Karte MC/000000702|E-COMM        25,00 USD K002 15.07. 10:51|ACME' } })
    assert.deepEqual(rankCandidates([plain, cand('msg-t7', { text: 'Total USD 25.00' })], { tx: card, bank: null }).map(c => c.messageId), ['msg-t7', 'msg-t1'])
  })
})

describe('the run’s claims and limiter', () => {
  test('ReceiptClaims: all of a document’s keys or none; the owner; a failed row gives its receipts back', () => {
    const claims = new ReceiptClaims()
    assert.equal(claims.claim(['gmail:msg-a1:1', 'sha:x'], 0, 'Zeile 0'), true)
    assert.deepEqual(claims.ownerOf('sha:x'), { row: 0, label: 'Zeile 0' })
    // another row: one key taken → none of them
    assert.equal(claims.claim(['gmail:msg-a2:1', 'sha:x'], 1, 'Zeile 1'), false)
    assert.equal(claims.ownerOf('gmail:msg-a2:1'), null)
    // the same row again: fine
    assert.equal(claims.claim(['gmail:msg-a1:1', 'inv:muster.example:910000000123'], 0, 'Zeile 0'), true)
    claims.release(0)
    assert.equal(claims.ownerOf('sha:x'), null)
    assert.equal(claims.claim(['gmail:msg-a2:1', 'sha:x'], 1, 'Zeile 1'), true)
    assert.deepEqual(ownClaimKeys({ messageId: 'msg-a3', partId: '2', sha256: 'abc', from: 'X <a@Muster.Example>', read: read({ invoice_number: 'RE-910000000123' }) }),
      ['gmail:msg-a3:2', 'sha:abc', 'inv:muster.example:RE910000000123'])
  })
  test('makeLimiter(2): five tasks, never more than two at a time, in the order asked; a failed one frees its place', async () => {
    const limit = makeLimiter(2)
    let running = 0
    let most = 0
    const started: number[] = []
    const out = await Promise.allSettled([0, 1, 2, 3, 4].map(k => limit(async () => {
      started.push(k)
      running += 1
      most = Math.max(most, running)
      await new Promise(r => setTimeout(r, 5))
      running -= 1
      if (k === 1) throw new Error('fehlgeschlagen')
      return k
    })))
    assert.equal(most, 2)
    assert.deepEqual(started, [0, 1, 2, 3, 4])
    assert.deepEqual(out.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
  })
})

describe('the page and the booking route: a doubtful Gmail receipt', () => {
  const tx = debit()
  const row = (over: Partial<MatchedTransaction> = {}): MatchedTransaction => ({
    transaction: tx, vendor: null, confidence: 0, gmail_message_id: 'msg-u1', gmail_subject: 'Ihre Rechnung', gmail_date: DATE(15),
    pdf_attachment_name: 'Rechnung.pdf', pdf_base64: null, extracted_invoice_date: null, extracted_invoice_number: null,
    extracted_amount: null, title: 'Muster', status: 'needs_review', ...over,
  })
  test('receiptDoubt: proven by its amount or attached by the owner — no; its number only, the nearest of several, D2’s, from before the update — yes; none attached — no', () => {
    assert.equal(receiptDoubt(row({ receipt_check: 'amount' })), false)
    assert.equal(receiptDoubt(row({ receipt_check: 'owner' })), false)
    for (const receipt_check of ['number', 'ambiguous', 'unchecked', undefined] as const) assert.equal(receiptDoubt(row({ receipt_check })), true, String(receipt_check))
    assert.equal(receiptDoubt(row({ gmail_message_id: null, receipt_check: 'number' })), false)
    assert.equal(receiptDoubt(null), false)
  })
  test('gmailReceiptRefusal: none attached or proven — null; doubtful from a page open since before the update — OLD_PAGE_TEXT; unmarked: from such a page — STALE, whatever its amount (review SAFE-1) —, from this page not the debit’s amount — STALE', () => {
    // a page from before the update: two rows the old Analyse gave one PDF of the amount would both pass
    assert.equal(gmailReceiptRefusal(row({ extracted_amount: 23.45 }), false), STALE_GMAIL_RECEIPT_TEXT)
    assert.equal(gmailReceiptRefusal(row({ extracted_amount: null }), false), STALE_GMAIL_RECEIPT_TEXT)
    assert.equal(gmailReceiptRefusal(row({ extracted_amount: 23.45 }), true), null)
    assert.equal(gmailReceiptRefusal(row({ extracted_amount: null }), true), STALE_GMAIL_RECEIPT_TEXT)
    assert.equal(gmailReceiptRefusal(row({ extracted_amount: 25.9 }), true), STALE_GMAIL_RECEIPT_TEXT)
    for (const receipt_check of ['number', 'ambiguous', 'unchecked'] as const) {
      assert.equal(gmailReceiptRefusal(row({ receipt_check }), true), null)
      assert.equal(gmailReceiptRefusal(row({ receipt_check }), false), OLD_PAGE_TEXT)
    }
    assert.equal(gmailReceiptRefusal(row({ receipt_check: 'amount' }), false), null)
    assert.equal(gmailReceiptRefusal(row({ receipt_check: 'owner' }), false), null)
    assert.equal(gmailReceiptRefusal(row({ gmail_message_id: null }), false), null)
    assert.equal(STALE_GMAIL_RECEIPT_TEXT, 'Beleg aus Gmail vor dem Update ohne Betragsprüfung angehängt — Entwurf speichern, Seite neu laden, Beleg prüfen, dann buchen')
    assert.equal(OLD_PAGE_TEXT, 'Seite vor dem Update geöffnet — Entwurf speichern, Seite neu laden, Zeile prüfen, dann buchen')
  })
})

describe('checkDraftGmailReceipts — a draft’s Gmail receipts from before the update', () => {
  const RULE = { id: 'mu', name: 'Muster Telekom', skip_invoice_search: false } as Vendor
  const old = (over: Partial<MatchedTransaction> = {}): MatchedTransaction => ({
    transaction: debit(), vendor: RULE, confidence: 1, gmail_message_id: 'msg-v1', gmail_subject: 'Ihre Rechnung', gmail_date: DATE(15),
    pdf_attachment_name: 'Rechnung.pdf', pdf_base64: null, extracted_invoice_date: '2026-07-14', extracted_invoice_number: null,
    extracted_amount: 23.45, title: 'Muster Telekom 07/2026', status: 'ready', match_note: 'Gmail: @muster.example', rule_tie_checked: true, ...over,
  })
  test('read 23,45 = debit: „amount“, nothing else changed, still ticked; read none: „unchecked“, the rule’s row „Prüfen“, the note first, unticked', () => {
    const { rows, changed } = checkDraftGmailReceipts([old(), old({ gmail_message_id: 'msg-v2', extracted_amount: null })], {})
    assert.deepEqual(rows[0], { ...old(), receipt_check: 'amount' })
    assert.deepEqual([rows[1].receipt_check, rows[1].status], ['unchecked', 'needs_review'])
    assert.equal(rows[1].match_note, `${GMAIL_DRAFT_ROW_NOTE} · Gmail: @muster.example`)
    assert.deepEqual(changed, [1])
    assert.equal(gmailDraftNotice(1), 'Ein Beleg aus Gmail war vor dem Update ohne Betragsprüfung angehängt — jetzt „Prüfen“, nicht mehr angekreuzt. Bitte Beleg prüfen oder entfernen.')
    assert.equal(gmailDraftNotice(3, false), '3 Belege aus Gmail waren vor dem Update ohne Betragsprüfung angehängt — jetzt „Prüfen“. Bitte Beleg prüfen oder entfernen.')
    // the route refuses none of them from the page that loaded the draft
    for (const t of rows) assert.equal(gmailReceiptRefusal(t, true), null)
  })
  test('two rows on one e-mail: the later one flagged first — its amount fits all the same', () => {
    const second = old({ transaction: debit({ date: '2026-07-17' }) })
    const { rows, changed } = checkDraftGmailReceipts([old(), second], {})
    assert.equal(rows[0].receipt_check, 'amount')
    assert.equal(rows[1].receipt_check, 'unchecked')
    assert.equal(rows[1].match_note, `${gmailSameReceiptNote(rowLabel(debit()))} · Gmail: @muster.example`)
    assert.equal(gmailSameReceiptNote('16.07.2026 MUSTER TELEKOM 23,45 €'), '⚠ Derselbe Beleg aus Gmail hängt auch an Zeile „16.07.2026 MUSTER TELEKOM 23,45 €“ — prüfen oder entfernen')
    assert.deepEqual(changed, [1])
  })
  test('two rows of one day, name and amount on one e-mail share a label: the later one names „der anderen Zeile“ (review check)', () => {
    const { rows } = checkDraftGmailReceipts([old(), old()], {})
    assert.equal(rows[1].match_note, `${gmailSameReceiptNote(rowLabel(debit()), rowLabel(debit()))} · Gmail: @muster.example`)
    assert.equal(gmailSameReceiptNote('16.07.2026 MUSTER TELEKOM 23,45 €', '16.07.2026 MUSTER TELEKOM 23,45 €'),
      '⚠ Derselbe Beleg aus Gmail hängt auch an der anderen Zeile „16.07.2026 MUSTER TELEKOM 23,45 €“ — prüfen oder entfernen')
    assert.equal(gmailSameReceiptNote('16.07.2026 MUSTER TELEKOM 23,45 €', '17.07.2026 MUSTER TELEKOM 23,45 €'), gmailSameReceiptNote('16.07.2026 MUSTER TELEKOM 23,45 €'))
  })
  test('removed, replaced by hand, analysed since, without a receipt — untouched; held as booked: its status behind the hold, not counted; an AI row keeps its status', () => {
    const rows = [old(), old({ gmail_message_id: 'msg-v3' }), old({ receipt_check: 'number' }), old({ gmail_message_id: null })]
    const out = checkDraftGmailReceipts(rows, { cleared_gmail: [0], uploads: { 1: { extracted: { amount: 23.45 } } } })
    assert.deepEqual(out.rows, rows)
    assert.deepEqual(out.changed, [])
    const duplicate_of = { id: 191020, title: 'Muster Telekom 07/2026', date: '2026-07-16', total: 23.45, certain: true }
    const held = checkDraftGmailReceipts([old({ status: 'duplicate', own_status: 'ready', duplicate_of, extracted_amount: 25.9 })], {})
    assert.deepEqual([held.rows[0].status, held.rows[0].own_status, held.rows[0].receipt_check, held.changed], ['duplicate', 'needs_review', 'unchecked', []])
    const ai = checkDraftGmailReceipts([old({ vendor: null, status: 'needs_review', extracted_amount: null })], {})
    assert.deepEqual([ai.rows[0].status, ai.rows[0].receipt_check, ai.changed], ['needs_review', 'unchecked', [0]])
  })
  test('held as booked, but booked anyway by the owner („Trotzdem buchen“: review.acked): counted — the row changed as a held one (review SAFE-2)', () => {
    const duplicate_of = { id: 191020, title: 'Muster Telekom 07/2026', date: '2026-07-16', total: 23.45, certain: true }
    const rows = [old({ status: 'duplicate', own_status: 'ready', duplicate_of, extracted_amount: 25.9 }), old({ gmail_message_id: 'msg-v5', status: 'duplicate', own_status: 'ready', duplicate_of, extracted_amount: null })]
    const out = checkDraftGmailReceipts(rows, { acked: [1] })
    assert.deepEqual(out.rows, checkDraftGmailReceipts(rows, {}).rows)
    assert.deepEqual([out.rows[1].status, out.rows[1].own_status, out.rows[1].receipt_check], ['duplicate', 'needs_review', 'unchecked'])
    assert.deepEqual(out.changed, [1])
  })
  test('twice: no change', () => {
    const once = checkDraftGmailReceipts([old(), old({ gmail_message_id: 'msg-v4', extracted_amount: null }), old({ transaction: debit({ date: '2026-07-17' }) })], {})
    const twice = checkDraftGmailReceipts(once.rows, {})
    assert.deepEqual(twice.rows, once.rows)
    assert.deepEqual(twice.changed, [])
  })
})

describe('texts (exact, „…“ quotes) and the notes a pick of another rule drops', () => {
  test('rowLabel: „TT.MM.JJJJ Name Betrag“, with the bank text’s invoice number', () => {
    assert.equal(rowLabel(debit({ date: '2026-06-15' })), '15.06.2026 MUSTER TELEKOM 23,45 €')
    assert.equal(rowLabel(NUMBERED()), '16.07.2026 MUSTER TELEKOM 23,45 € · Rechnungsnr. 910000000123')
    assert.equal(rowLabel(debit({ counterparty: 'KLARNA*MUSTER SHOP\\WIEN', amount: 1250 })), '16.07.2026 MUSTER SHOP 1.250,00 €')
    assert.equal(noteSafe('Rechnung · Juli · 2026'), 'Rechnung - Juli - 2026')
  })
  test('the time, the classifier, a failed search, the list, the chip', () => {
    assert.equal(GMAIL_TIME_NOTE, '⚠ Analyse-Zeit aufgebraucht — Beleg nicht gesucht: Beleg selbst anhängen oder neu analysieren')
    assert.equal(timeUpPick().plainNote, 'Analyse-Zeit aufgebraucht — kein Beleg nötig')
    assert.equal(CLASSIFIER_TIME_NOTE, 'Analyse-Zeit aufgebraucht — KI-Vorschlag übersprungen: Konten selbst wählen oder neu analysieren')
    assert.equal(gmailFailedNote(new Error('invalid_grant')), '⚠ Gmail-Suche fehlgeschlagen — Beleg selbst anhängen (invalid_grant)')
    assert.deepEqual([GMAIL_CANDIDATES_TITLE, GMAIL_PREVIEW, GMAIL_ATTACH, GMAIL_PREVIEW_TOO_LARGE, RECEIPT_DOUBT_CHIP],
      ['In Gmail gefunden, nicht angehängt', 'Vorschau', 'Anhängen', 'zu groß für die Vorschau (über 3 MB)', 'Beleg prüfen'])
    assert.equal(gmailReceiptLoadError('404'), 'Beleg aus Gmail nicht ladbar (404)')
    assert.equal(gmailAttachedNote('Rechnung · Juli.pdf'), 'Gmail: „Rechnung - Juli.pdf“ von Hand angehängt')
    assert.equal(GMAIL_DRAFT_ROW_NOTE, '⚠ Beleg aus Gmail vor dem Update ohne Betragsprüfung angehängt — prüfen oder entfernen')
  })
  test('every note about an attached receipt is one (provenance split at „ · “, the doubtful ones); the rule notes are not', () => {
    for (const part of ['Gmail: @muster.example', 'Gmail-Suche nach „ACME“', '„ACME“ im E-Mail-Text', 'Betrag 23,45 € stimmt', 'Betrag 27,19 € + 0,41 € Spesen stimmt',
      'Zahlbetrag 21,00 € stimmt', 'Betrag 25,00 USD stimmt (Kartenumsatz)', 'Rechnungsnr. 910000000123', RECEIPT_UNREADABLE_NOTE,
      '⚠ Beleg über Rechnungsnr. 910000000123 gefunden, aber Betrag 21,00 € statt 23,45 € — Beleg prüfen',
      '⚠ 2 Belege mit Betrag 23,45 € in Gmail — angehängt ist „Rechnung.pdf“ vom 14.07.2026, der Zahlung am nächsten: prüfen',
      '⚠ Beleg von @muster.example angehängt, Betrag nicht geprüft (nicht lesbar) — Beleg prüfen']) {
      assert.equal(isGmailReceiptNote(part), true, part)
    }
    for (const part of ['Regel „Acme“ gewählt (mehrere passten)', 'Zuordnung über Rechnungsadresse („Acme“)', '⚠ Mehrere Buchungsregeln passen: „A“, „B“ — Regel wählen']) {
      assert.equal(isGmailReceiptNote(part), false, part)
    }
  })
  test('no straight quote in a German text', () => {
    const texts = [GMAIL_TIME_NOTE, GMAIL_TIME_PARTIAL_NOTE, CLASSIFIER_TIME_NOTE, GMAIL_DRAFT_ROW_NOTE, OLD_PAGE_TEXT, STALE_GMAIL_RECEIPT_TEXT, gmailDraftNotice(2),
      gmailSameReceiptNote('x'), gmailAttachedNote('x.pdf'), GMAIL_CANDIDATES_TITLE, GMAIL_PREVIEW_TOO_LARGE]
    for (const t of texts) assert.doesNotMatch(t, /"/, t)
  })
})

describe('the list on the page: who found each candidate, which can be shown or attached, the notes „Anhängen“ replaces (§ 2.1 F)', () => {
  test('a candidate a Buchungsregel’s sender search found carries that sender and the rules whose search found it; the name and processor searches’ carry none', () => {
    const tx = debit()
    const found: ReceiptVia = { kind: 'sender', sender: '@muster.example', ruleIds: ['mu', 'mu2'] }
    const pick = pickGmailReceipt([
      cand('msg-w1', { via: found, read: read({ amount: 25.9 }) }),
      cand('msg-w2', { via: KEYWORD, read: read({ amount: 26.9 }) }),
      cand('msg-w3', { via: PROCESSOR, read: read({ amount: 27.9 }) }),
    ], [], ctx(tx))
    assert.equal(pick.chosen, null)
    assert.deepEqual(pick.candidates.map(c => [c.message_id, c.found_by ?? null]), [
      ['msg-w1', { sender: '@muster.example', rule_ids: ['mu', 'mu2'] }], ['msg-w2', null], ['msg-w3', null],
    ])
    // its own copy: the search's list is not the row's
    pick.candidates[0].found_by!.rule_ids.push('x')
    assert.deepEqual(found.ruleIds, ['mu', 'mu2'])
    // listed beside a doubtful receipt too (the nearest of two of the debit's amount)
    const ambiguous = pickGmailReceipt([cand('msg-w4', { read: read({ amount: 23.45 }) }), cand('msg-w5', { date: DATE(2), read: read({ amount: 23.45 }) })], [], ctx(tx))
    assert.deepEqual([ambiguous.check, ambiguous.candidates.map(c => c.found_by?.rule_ids)], ['ambiguous', [['mu']]])
  })

  test('„Vorschau“ for a PDF up to 3 MB, its button off above (its title says why); „Anhängen“ for every PDF but one over 10 MB; neither for an e-mail without PDF', () => {
    const c = (over: Partial<GmailCandidate>): GmailCandidate => ({
      message_id: 'msg-x1', part_id: '2', file_name: 'Rechnung.pdf', subject: 'Ihre Rechnung', from: 'Muster GmbH <rechnung@muster.example>',
      date: DATE(15), size: 2048, amount: 25.9, currency: null, foreign_total: null, invoice_number: null, why: 'amount', ...over,
    })
    const MB = 1024 * 1024
    assert.equal(GMAIL_PREVIEW_MAX_BYTES, 3 * MB)
    const cases: [GmailCandidate, boolean, boolean, boolean][] = [
      [c({}), true, true, true],
      [c({ size: 3 * MB }), true, true, true],
      [c({ size: 3 * MB + 1, why: 'unchecked' }), true, false, true],
      [c({ size: 11 * MB, why: 'too_large' }), true, false, false],
      [c({ why: 'claimed', claimed_by: '15.06.2026 MUSTER TELEKOM 23,45 €' }), true, true, true],
      [c({ why: 'pages', size: null }), true, true, true],
      [c({ part_id: null, file_name: null, size: null, why: 'no_pdf' }), false, false, false],
    ]
    for (const [cand, pdf, preview, attach] of cases) {
      assert.deepEqual([gmailHasPdf(cand), gmailPreviewable(cand), gmailAttachable(cand)], [pdf, preview, attach], `${cand.why} ${cand.size}`)
    }
  })

  test('isGmailSearchNote: every note about the receipt attached and about the search — as Analyse and a draft’s load write them —; the rules’, the page’s and the others not', () => {
    const tx = debit()
    const mail = (messageId: string, via: ReceiptVia) => ({ messageId, subject: 'Ihre Bestellung', from: 'Muster <info@muster.example>', date: DATE(15), via })
    const notes = [
      // attached, and how proven or why doubtful
      ...pickGmailReceipt([cand('msg-y1', { read: read({ amount: 23.45 }) })], [], ctx(tx)).note!.split(' · '),
      ...pickGmailReceipt([cand('msg-y2', { read: read({ amount: 23.45 }) }), cand('msg-y3', { date: DATE(3), read: read({ amount: 23.45 }) })], [], ctx(tx)).note!.split(' · '),
      ...pickGmailReceipt([cand('msg-y4', { readError: 'timeout' })], [], ctx(tx)).note!.split(' · '),
      // found and not attached, warned and plainly
      ...(['note', 'plainNote'] as const).flatMap(k => [
        pickGmailReceipt([cand('msg-y5', { read: read({ amount: 30 }) })], [], ctx(tx))[k]!,
        pickGmailReceipt([cand('msg-y6', { via: KEYWORD, read: read({ foreign_total: 25, currency: 'USD' }) })], [], ctx(tx))[k]!,
        pickGmailReceipt([cand('msg-y7', { via: KEYWORD, readError: 'timeout' })], [], ctx(tx))[k]!,
        pickGmailReceipt([cand('msg-y8', { read: read({ amount: 23.45 }) })], [], ctx(tx, { claimedBy: () => 'Zeile 1' }))[k]!,
        pickGmailReceipt([], [mail('msg-y9', SENDER)], ctx(tx))[k]!,
        pickGmailReceipt([], [mail('msg-y10', SENDER), mail('msg-y11', SENDER)], ctx(tx))[k]!,
        timeUpPick()[k]!,
      ]),
      gmailFailedNote(new Error('invalid_grant')), RECEIPT_NO_TEXT_NOTE, GMAIL_DRAFT_ROW_NOTE, GMAIL_TIME_PARTIAL_NOTE, gmailSameReceiptNote('15.06.2026 MUSTER TELEKOM 23,45 €'),
      gmailSameReceiptNote('15.06.2026 MUSTER TELEKOM 23,45 €', '15.06.2026 MUSTER TELEKOM 23,45 €'), gmailAttachedNote('Rechnung.pdf'),
    ]
    assert.ok(notes.length >= 20)
    for (const n of notes) assert.equal(isGmailSearchNote(n), true, n)
    for (const n of [
      '⚠ Mehrere Buchungsregeln passen: „A“, „B“ — Regel wählen', 'Zuordnung über Rechnungsadresse („A“)', 'Regel „A“ gewählt (mehrere passten)',
      'Gefundener Beleg kam von „A“ — entfernt', '⚠ Mit dem Beleg neu bewertet — bitte prüfen und ankreuzen', '⚠ Beleg angehängt, Neubewertung fehlgeschlagen (500)',
      'Gebucht ist „A“ — diese Zahlung ist laut Rechnung „B“', '⚠ Rechnungsadresse von „A“ / „B“ nicht im Beleg gefunden — Regel wählen oder die Adresse unter Buchungsregeln anpassen',
    ]) assert.equal(isGmailSearchNote(n), false, n)
    assert.equal(RECEIPT_NO_TEXT_NOTE, '⚠ Beleg angehängt, aber Text nicht lesbar — Einschätzung basiert nur auf den Kontodaten')
  })
})

describe('client-safe: lib/receipt-match.ts', () => {
  test('imports only ./money, ./booking-dates, ./invoice-parsing — and types', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'receipt-match.ts'), 'utf8')
    const specs = Array.from(src.matchAll(/^import\s+(type\s+)?[^'"]*['"]([^'"]+)['"]/gm)).map(m => ({ type: !!m[1], spec: m[2] }))
    for (const { type, spec } of specs) {
      assert.ok(['./money', './booking-dates', './invoice-parsing'].includes(spec) || (type && ['./types', './pdf-reader'].includes(spec)), spec)
    }
    assert.doesNotMatch(src, /process\.env|\brequire\(|\bimport\(/)
  })
})
