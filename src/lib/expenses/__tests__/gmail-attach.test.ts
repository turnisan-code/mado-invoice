import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gmailBelegElsewhere, withGmailBelegElsewhere, withGmailCandidate, type GmailCandidateRead } from '../gmail-attach'
import {
  gmailAttachedNote, gmailFailedNote, gmailReceiptRefusal, gmailSameReceiptNote, receiptDoubt, rowLabel, GMAIL_DRAFT_ROW_NOTE, RECEIPT_NO_TEXT_NOTE,
} from '../receipt-match'
import { pickRule, receiptFromOtherRuleNote, recheckRuleChoice, ruleOutrankedNote, ruleTieAddressNote } from '../rule-match'
import { RECEIPT_UNREADABLE_NOTE } from '../invoice-parsing'
import type { EasybankTransaction, GmailCandidate, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// „Anhängen“ on the import page (PR „Job 1 fixes“ § 2.1 F, lib/gmail-attach.ts): a PDF Analyse
// found in Gmail and did not attach becomes the row's Gmail receipt. Synthetic debits, rules
// and e-mails: made-up senders (netzcom.example, acme.example, muster.example), message ids
// msg-…, invoice numbers 910000000xxx, addresses „Beispielgasse 2“ / „Musterweg 1“.

const debit = (over: Partial<EasybankTransaction> = {}): EasybankTransaction => ({
  date: '2026-07-16', counterparty: 'NETZCOM AUSTRIA GMBH', amount: 40.5, type: 'expense', currency: 'EUR',
  reference: 'Abbuchung SEPA-Lastschrift OG/000000701|BKAUATWWXXX AT000000000000000020 Netzcom|Rechnung 910000000123 vom 10.07.2026',
  raw: {}, ...over,
})
const rule = (id: string, name: string, over: Partial<Vendor> = {}): Vendor => ({
  id, name, match_strings: ['netzcom'], email_sender: '@netzcom.example', email_body_keywords: [], active: true, skip_invoice_search: false,
  title_template: '{vendor} {month_short}', invoice_address_match: null, amount_min: null, amount_max: null,
  cost_account_id: 39209, purchasetax_account_id: 7002, bank_account_id: 5002, tax_percent: 20,
  deductibility_tax_percent: 100, deductibility_amount_percent: 100, country: '', vatin: '', category: 'Telefon', ...over,
} as Vendor)
const STUDIO = rule('n1', 'Netzcom Studio', { invoice_address_match: 'Beispielgasse 2' })
const HOME = rule('n2', 'Netzcom Home Office', { invoice_address_match: 'Musterweg 1' })

// A row as Analyse made it (no receipt attached unless said)
const row = (over: Partial<MatchedTransaction> = {}): MatchedTransaction => ({
  transaction: debit(), vendor: STUDIO, confidence: 1, gmail_message_id: null, gmail_subject: null, gmail_date: null,
  pdf_attachment_name: null, pdf_base64: null, extracted_invoice_date: null, extracted_invoice_number: null, extracted_amount: null,
  title: 'Netzcom Studio 07/2026', status: 'no_invoice', rule_tie_checked: true, ...over,
})
// A candidate as the row lists it, found by the Netzcom rules' sender search
const cand = (messageId: string, over: Partial<GmailCandidate> = {}): GmailCandidate => ({
  message_id: messageId, part_id: '2', file_name: 'Rechnung_2026-07.pdf', subject: 'Ihre Rechnung Juli', from: 'Netzcom <rechnung@netzcom.example>',
  date: 'Wed, 15 Jul 2026 08:00:00 +0200', size: 48_000, amount: 38.9, currency: null, foreign_total: null, invoice_number: null, why: 'amount',
  found_by: { sender: '@netzcom.example', rule_ids: ['n1', 'n2'] }, ...over,
})
// What /api/import/gmail-receipt read of it
const READ: GmailCandidateRead = { name: 'Rechnung_2026-07.pdf', extracted: { invoice_number: '910000000124', date: '2026-07-10', amount: 40.5 }, unreadable: false }
const NONE_FOUND = '⚠ 2 Belege in Gmail gefunden, aber keiner mit Betrag 40,50 € — nicht angehängt: Beleg prüfen und anhängen'

describe('withGmailCandidate — „Anhängen“: the candidate becomes the row’s Gmail receipt', () => {
  test('a rule’s row waiting for its Beleg: the candidate’s e-mail and part, no data, proven by the owner; what was read; „Bereit“; the list without it; the note says where it came from', () => {
    const before = row({ match_note: NONE_FOUND, gmail_candidates: [cand('msg-a1'), cand('msg-a2', { amount: 41.9 })] })
    const out = withGmailCandidate(before, cand('msg-a1'), READ)
    assert.deepEqual(
      [out.gmail_message_id, out.gmail_part_id, out.gmail_subject, out.gmail_date, out.pdf_attachment_name, out.pdf_base64, out.receipt_check],
      ['msg-a1', '2', 'Ihre Rechnung Juli', 'Wed, 15 Jul 2026 08:00:00 +0200', 'Rechnung_2026-07.pdf', null, 'owner'],
    )
    assert.deepEqual([out.extracted_invoice_number, out.extracted_invoice_date, out.extracted_amount], ['910000000124', '2026-07-10', 40.5])
    assert.deepEqual([out.status, out.vendor, out.title], ['ready', STUDIO, 'Netzcom Studio 07/2026'])
    assert.deepEqual(out.gmail_candidates?.map(c => c.message_id), ['msg-a2'])
    assert.equal(out.match_note, 'Gmail: „Rechnung_2026-07.pdf“ von Hand angehängt')
    // proven: never a doubt, booked also from a page from before the update
    assert.equal(receiptDoubt(out), false)
    assert.equal(gmailReceiptRefusal(out, false), null)
    // pure: the row it was given stays as it was
    assert.deepEqual([before.gmail_message_id, before.status, before.gmail_candidates?.length], [null, 'no_invoice', 2])
  })

  test('nothing read: the bank text’s invoice number and the e-mail’s date, as Analyse fills them; the reader failed: „Beleg-Daten nicht lesbar“ before where it came from; no file name read: the candidate’s', () => {
    const unread = withGmailCandidate(row(), cand('msg-b1'), { name: null, extracted: {}, unreadable: true })
    assert.deepEqual([unread.extracted_invoice_number, unread.extracted_invoice_date, unread.extracted_amount], ['910000000123', '2026-07-15', null])
    assert.equal(unread.match_note, `${RECEIPT_UNREADABLE_NOTE} · ${gmailAttachedNote('Rechnung_2026-07.pdf')}`)
    assert.deepEqual([unread.receipt_check, unread.status], ['owner', 'ready'])
    // no file name at all: the subject
    assert.equal(withGmailCandidate(row(), cand('msg-b2', { file_name: null }), { ...READ, name: null }).pdf_attachment_name, 'Ihre Rechnung Juli')
    // the last candidate attached: no list left
    assert.equal('gmail_candidates' in withGmailCandidate(row({ gmail_candidates: [cand('msg-b3')] }), cand('msg-b3'), READ), false)
  })

  test('it replaces a doubtful receipt: the notes about that one and the search go, the rule’s stay; its finders, never the replaced receipt’s', () => {
    const before = row({
      gmail_message_id: 'msg-c0', gmail_part_id: '1', gmail_subject: 'Rechnung', pdf_attachment_name: 'R.pdf', receipt_check: 'ambiguous', status: 'needs_review',
      extracted_amount: 40.5, gmail_rule_ids: ['old'],
      match_note: [
        '⚠ 2 Belege mit Betrag 40,50 € in Gmail — angehängt ist „R.pdf“ vom 14.07.2026, der Zahlung am nächsten: prüfen',
        'Gmail: @netzcom.example', 'Betrag 40,50 € stimmt', ruleOutrankedNote(STUDIO, [HOME]),
      ].join(' · '),
      gmail_candidates: [cand('msg-c1', { amount: 40.5, found_by: { sender: '@netzcom.example', rule_ids: ['n1'] } })],
    })
    const out = withGmailCandidate(before, before.gmail_candidates![0], READ)
    assert.equal(out.match_note, `${ruleOutrankedNote(STUDIO, [HOME])} · ${gmailAttachedNote('Rechnung_2026-07.pdf')}`)
    assert.deepEqual([out.gmail_message_id, out.gmail_part_id, out.receipt_check, out.status], ['msg-c1', '2', 'owner', 'ready'])
    // found by STUDIO's search alone; the row was chosen among none: its finders as they are
    assert.deepEqual(out.gmail_rule_ids, ['n1'])
    assert.equal('gmail_candidates' in out, false)
  })

  test('every note about the receipt it had and its search goes — a scan’s, a failed search’s, a draft’s —; the page’s and the rule’s stay', () => {
    const notes = [
      RECEIPT_NO_TEXT_NOTE, gmailFailedNote(new Error('Backend Error')), GMAIL_DRAFT_ROW_NOTE, gmailSameReceiptNote('15.07.2026 NETZCOM AUSTRIA GMBH 40,50 €'),
      '⚠ E-Mail „Ihre Bestellung“ vom 15.07.2026 gefunden, aber ohne PDF — Rechnung beim Händler holen und anhängen (eine Bestell- oder Zahlungsbestätigung ist keine Rechnung)',
      '⚠ Analyse-Zeit aufgebraucht — Beleg nicht gesucht: Beleg selbst anhängen oder neu analysieren',
      '⚠ Mit dem Beleg neu bewertet — bitte prüfen und ankreuzen', receiptFromOtherRuleNote([HOME]),
    ]
    const out = withGmailCandidate(row({ match_note: notes.join(' · ') }), cand('msg-d1'), READ)
    assert.equal(out.match_note, ['⚠ Mit dem Beleg neu bewertet — bitte prüfen und ankreuzen', receiptFromOtherRuleNote([HOME]), gmailAttachedNote('Rechnung_2026-07.pdf')].join(' · '))
  })

  test('a row whose rules tie: „Prüfen“ with its receipt, still to choose for; its finders with every chosen-among rule of that sender — the address on it then decides, and the receipt stays', () => {
    const open = row({
      vendor: null, confidence: 0, title: 'NETZCOM AUSTRIA GMBH', status: 'no_invoice', rule_choices: [HOME, STUDIO],
      match_note: ruleTieAddressNote([HOME, STUDIO]), gmail_candidates: [cand('msg-e1', { found_by: { sender: '@netzcom.example', rule_ids: ['n1'] } })],
    })
    const out = withGmailCandidate(open, open.gmail_candidates![0], READ)
    assert.deepEqual([out.vendor, out.status, out.receipt_check], [null, 'needs_review', 'owner'])
    // HOME has the same sender and no „E-Mail enthält“: the receipt counts for it too
    assert.deepEqual(out.gmail_rule_ids, ['n1', 'n2'])
    assert.equal(out.match_note, `${ruleTieAddressNote([HOME, STUDIO])} · ${gmailAttachedNote('Rechnung_2026-07.pdf')}`)
    // the page then checks the address on it (lib/rule-match.ts recheckRuleChoice)
    const check = recheckRuleChoice(out, ['Beispielgasse 2'])
    assert.deepEqual([check.tick, check.row.vendor?.id, check.row.rule_pick, check.row.status, check.row.gmail_message_id], [true, 'n1', 'address', 'ready', 'msg-e1'])
  })

  test('tied rules of two senders: the candidate counts for its own sender’s rule — a pick of the other drops it, as a receipt Analyse attached', () => {
    const ALPHA = rule('a1', 'Acme Alpha', { match_strings: ['acme'], email_sender: '@alpha.example' })
    const BETA = rule('b1', 'Acme Beta', { match_strings: ['acme'], email_sender: '@beta.example' })
    const open = row({
      transaction: debit({ counterparty: 'ACME CLOUD', reference: 'ACME CLOUD 07/2026' }), vendor: null, confidence: 0, title: 'ACME CLOUD',
      rule_choices: [ALPHA, BETA], gmail_rule_ids: ['b1'],
    })
    const out = withGmailCandidate(open, cand('msg-f1', { from: 'Acme <billing@alpha.example>', found_by: { sender: '@alpha.example', rule_ids: ['a1'] } }), READ)
    // not the replaced receipt's ['b1']
    assert.deepEqual(out.gmail_rule_ids, ['a1'])
    const alpha = pickRule(out, 'a1', 'owner')
    assert.deepEqual([alpha.status, alpha.gmail_message_id, alpha.receipt_check], ['ready', 'msg-f1', 'owner'])
    const beta = pickRule(out, 'b1', 'owner')
    assert.deepEqual([beta.status, beta.gmail_message_id, 'receipt_check' in beta], ['no_invoice', null, false])
    assert.match(beta.match_note ?? '', /Gefundener Beleg kam von „Acme Alpha“ — entfernt/)
  })

  test('an AI row: no longer „Beleg fehlt“; a candidate of the name search has no finders — the field goes, never the replaced receipt’s; the suggestion stays for the re-classification', () => {
    const ai = {
      cost_account_id: 39209, purchasetax_account_id: 7002, bank_account_id: 5002, tax_percent: 20, deductibility_amount_percent: 100,
      country: 'AT', vatin: '', title: 'Muster Shop', category: 'Büro', reasoning: 'Laut Bankzeile.', requires_invoice: true, certainty: 'niedrig', source: 'ai',
    } as MatchedTransaction['ai_suggested']
    const aiRow = row({ vendor: null, confidence: 0, title: 'Muster Shop', status: 'missing_invoice', ai_suggested: ai, gmail_rule_ids: ['n1'] })
    const out = withGmailCandidate(aiRow, cand('msg-g1', { from: 'Muster <shop@muster.example>', found_by: undefined }), READ)
    assert.deepEqual([out.status, out.receipt_check, 'gmail_rule_ids' in out, out.ai_suggested], ['needs_review', 'owner', false, ai])
    // one that asks no Beleg keeps its status
    assert.equal(withGmailCandidate({ ...aiRow, status: 'needs_review' }, cand('msg-g2', { found_by: undefined }), READ).status, 'needs_review')
  })

  test('a row held as booked keeps its hold: the status the receipt makes goes behind it', () => {
    const duplicate_of = { id: 191040, title: 'Netzcom Studio 07/2026', date: '2026-07-16', total: 40.5, certain: true }
    const held = withGmailCandidate(row({ status: 'duplicate', own_status: 'no_invoice', duplicate_of }), cand('msg-h1'), READ)
    assert.deepEqual([held.status, held.own_status, held.duplicate_of], ['duplicate', 'ready', duplicate_of])
    const heldAi = withGmailCandidate(row({ vendor: null, status: 'duplicate', own_status: 'missing_invoice' }), cand('msg-h2', { found_by: undefined }), READ)
    assert.deepEqual([heldAi.status, heldAi.own_status], ['duplicate', 'needs_review'])
    // held without the status behind it (a draft from before it was kept): none made up
    const bare = withGmailCandidate(row({ vendor: null, status: 'duplicate' }), cand('msg-h3', { found_by: undefined }), READ)
    assert.deepEqual([bare.status, 'own_status' in bare], ['duplicate', false])
  })
})

describe('gmailBelegElsewhere — „Anhängen“ of a PDF another row already has (review GMAIL-06)', () => {
  // The Magenta pair: row 0 holds the Home Office PDF, row 1 the Studio one (msg-b, part 1)
  const pair = () => [
    row({ vendor: HOME, gmail_message_id: 'msg-a', gmail_part_id: '1', receipt_check: 'ambiguous', status: 'needs_review', match_note: 'Gmail: @netzcom.example' }),
    row({ transaction: debit({ date: '2026-07-17' }), gmail_message_id: 'msg-b', gmail_part_id: '1', receipt_check: 'amount', status: 'ready', match_note: 'Gmail: @netzcom.example · Betrag 40,50 € stimmt' }),
  ]
  const studioPdf = cand('msg-b', { part_id: '1' })

  test('the other row with the same e-mail and part: found — not one removed or replaced by hand, not another part, not the row itself', () => {
    const rows = pair()
    assert.deepEqual(gmailBelegElsewhere(rows, 0, studioPdf, new Set(), {}), [1])
    assert.deepEqual(gmailBelegElsewhere(rows, 0, studioPdf, new Set([1]), {}), [])
    assert.deepEqual(gmailBelegElsewhere(rows, 0, studioPdf, new Set(), { 1: { name: 'Rechnung.pdf' } }), [])
    assert.deepEqual(gmailBelegElsewhere(rows, 0, cand('msg-b', { part_id: '2' }), new Set(), {}), [])
    assert.deepEqual(gmailBelegElsewhere(rows, 1, studioPdf, new Set(), {}), [])
  })
  test('that row: its receipt „Prüfen“ (unchecked), the note naming the row that has it too first — once —; a rule’s row „Prüfen“, held as booked behind the hold; an AI row keeps its status', () => {
    const label = rowLabel(debit())
    const [, studio] = pair()
    const out = withGmailBelegElsewhere(studio, label)
    assert.deepEqual([out.receipt_check, out.status, out.gmail_message_id], ['unchecked', 'needs_review', 'msg-b'])
    assert.equal(out.match_note, `${gmailSameReceiptNote(label)} · Gmail: @netzcom.example · Betrag 40,50 € stimmt`)
    assert.equal(out.match_note?.split(' · ')[0], '⚠ Derselbe Beleg aus Gmail hängt auch an Zeile „16.07.2026 NETZCOM AUSTRIA GMBH 40,50 € - Rechnungsnr. 910000000123“ — prüfen oder entfernen')
    assert.equal(receiptDoubt(out), true)
    // twice: the note once
    assert.equal(withGmailBelegElsewhere(out, label).match_note, out.match_note)
    // two debits of one day, name and amount share a label: „der anderen Zeile“, as „schon bei der anderen Zeile“ says it (review check)
    const twin = withGmailBelegElsewhere({ ...studio, transaction: debit() }, label)
    assert.equal(twin.match_note?.split(' · ')[0], '⚠ Derselbe Beleg aus Gmail hängt auch an der anderen Zeile „16.07.2026 NETZCOM AUSTRIA GMBH 40,50 € - Rechnungsnr. 910000000123“ — prüfen oder entfernen')
    assert.equal(withGmailBelegElsewhere(twin, label).match_note, twin.match_note)
    const duplicate_of = { id: 191050, title: 'Netzcom Studio 07/2026', date: '2026-07-17', total: 40.5, certain: true }
    const held = withGmailBelegElsewhere({ ...studio, status: 'duplicate', own_status: 'ready', duplicate_of }, label)
    assert.deepEqual([held.status, held.own_status], ['duplicate', 'needs_review'])
    const ai = withGmailBelegElsewhere({ ...studio, vendor: null, status: 'ready' }, label)
    assert.deepEqual([ai.status, ai.receipt_check], ['ready', 'unchecked'])
  })
})

describe('client-safe: lib/gmail-attach.ts', () => {
  test('imports only ./rule-match, ./receipt-match, ./invoice-parsing — and types; no env variable', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'gmail-attach.ts'), 'utf8')
    const specs = Array.from(src.matchAll(/^import\s+(type\s+)?[^'"]*['"]([^'"]+)['"]/gm)).map(m => ({ type: !!m[1], spec: m[2] }))
    assert.ok(specs.length >= 4)
    for (const { type, spec } of specs) assert.ok(['./rule-match', './receipt-match', './invoice-parsing'].includes(spec) || (type && spec === './types'), spec)
    assert.doesNotMatch(src, /process\.env|\brequire\(|\bimport\(/)
  })
})
