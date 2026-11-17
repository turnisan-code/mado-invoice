import './owner'
// One statement line's receipt from Gmail (PR 9b, lib/expenses/receipts.ts) against a stand-in
// Supabase, Gmail, PDF reader and storage: which lines are searched and on which paths, what a
// search keeps (the receipt's copy, its claims, what it found), a dry run that keeps nothing, a
// receipt another line holds, a line changed meanwhile, „Anhängen“, and the line's row built
// from what was kept. Made-up senders (muster.example), message ids msg-…, invoice numbers
// 910000000xxx, amounts and IBANs only.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeSupabase, hasFilter, type Op } from '@/lib/__tests__/fake-supabase'
import {
  attachGmailCandidate, ownReceipt, releaseGmailReceipt, ReceiptError, searchLineReceipt, searchPaths, storedName,
  RECEIPT_TEXT, RECEIPT_TEXT_MAX, SEARCH_MAX_DURATION_S, type AttachDeps,
} from '../receipts'
import { lineRow, receiptKept, storedFind } from '../lines'
import { gmailAttachedNote, receiptDoubt } from '../receipt-match'
import type { GmailReceiptDeps } from '../gmail-receipt'
import type { GmailMessage, GmailPdf } from '../gmail'
import type { PdfInvoiceData } from '../pdf-reader'
import { vendorsOf } from '../rules'
import type { EasybankTransaction, Vendor } from '@/lib/expenses/types'
import type { BankLine, BankLineReceiptSearch, BookingRule } from '@/types'

const LINE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const IBAN = 'AT611904300234573201'
const TEXT = 'Abbuchung SEPA-Lastschrift OG/000000701|BKAUATWWXXX AT000000000000000020 Muster Telekom GmbH|Rechnung 910000000123 vom 10.07.2026'
const NOW = '2026-11-17T08:00:00Z'

const bankLine = (o: Partial<BankLine> = {}, text = TEXT, amount = -23.45): BankLine => ({
  id: LINE_ID, line_key: 'key-1', cells: [IBAN, text, '16.07.2026', '16.07.2026', amount.toFixed(2).replace('.', ','), 'EUR'],
  statement_iban: IBAN, booked_on: '2026-07-16', value_on: '2026-07-16', amount, currency: 'EUR', counterparty: '', bank_text: text, fee: null,
  status: 'open', review: {}, receipt_path: null, receipt_name: null, receipt_search: null, receipt_gmail: null,
  bookamat_claim: null, bookamat_pending: null, created_at: NOW, updated_at: NOW, ...o,
})
const rule = (o: Partial<BookingRule> & Pick<BookingRule, 'id' | 'name'>): BookingRule => ({
  active: true, category: '', match_strings: ['MUSTER TELEKOM'], email_sender: 'rechnung@muster.example', email_body_keywords: [],
  cost_account: 'Internet', tax_account: 'Vorsteuer Inland', bank_account: '', tax_percent: 20, ba_amount: 100, ba_tax: 100,
  country: '', vatin: '', title_template: `${o.name} {month_short}`, notes_template: '', amount_min: null, amount_max: null,
  invoice_address_match: '', skip_receipt: false, created_at: NOW, updated_at: NOW, ...o,
})
const RULES = [rule({ id: 'r-tel', name: 'Telefon Büro' })]

// A PDF part as lib/expenses/gmail.ts gives it: its bytes name it, so the stand-ins know which it is
const bytesOf = (label: string) => Buffer.from(`%PDF-1.4 ${label}`).toString('base64')
const labelOf = (base64: string) => Buffer.from(base64, 'base64').toString().replace('%PDF-1.4 ', '')
const pdf = (partId: string, filename: string, label: string): GmailPdf => ({ partId, filename, base64: bytesOf(label), size: 2048, sha256: `sha${label}abcdef` })
const msg = (messageId: string, subject: string, pdfs: GmailPdf[]): GmailMessage =>
  ({ messageId, subject, from: 'Muster GmbH <rechnung@muster.example>', date: 'Wed, 15 Jul 2026 08:00:00 +0200', bodyText: 'Ihre Rechnung', pdfs })
const NOTHING: PdfInvoiceData = { date: null, invoice_number: null, amount: null, currency: null, vatin: null, amount_due: null, foreign_total: null, document_type: null }

type GmailWorld = { senders?: Record<string, GmailMessage[]>; keyword?: GmailMessage[]; reads?: Record<string, Partial<PdfInvoiceData>> }
function gmail(world: GmailWorld) {
  const log = { searches: [] as string[], reads: [] as string[] }
  const deps: GmailReceiptDeps = {
    searchInvoices: async params => { log.searches.push(`from:${params.senderDomain}`); return world.senders?.[params.senderDomain] ?? [] },
    searchInvoicesByKeyword: async params => { log.searches.push(`name:${params.keyword}`); return world.keyword ?? [] },
    pdfText: async base64 => ({ text: `Muster GmbH Rechnung ${labelOf(base64)} Gesamt 23,45 EUR`, pages: 1 }),
    readPdf: async base64 => { const label = labelOf(base64); log.reads.push(label); return { ...NOTHING, document_type: 'invoice', ...world.reads?.[label] } },
  }
  return { deps, log }
}
const PROVEN: GmailWorld = {
  senders: { 'rechnung@muster.example': [msg('msg-a1', 'Ihre Rechnung 910000000123', [pdf('1', 'Rechnung.pdf', 'a1')])] },
  reads: { a1: { amount: 23.45, invoice_number: '910000000123', date: '2026-07-10' } },
}

type DbWorld = {
  line: BankLine
  around?: BankLine[]
  rules?: BookingRule[]
  claims?: { key: string; bank_line_id: string; label: string }[]
  insertConflict?: boolean
  changed?: boolean
  documents?: { type: string; number: string }[]
}
const inValues = (op: Op, column: string) => (op.filters.find(f => f[0] === 'in' && f[1] === column)?.[2] ?? []) as string[]
const eqValue = (op: Op, column: string) => op.filters.find(f => f[0] === 'eq' && f[1] === column)?.[2]
function setup(world: DbWorld) {
  const writes: string[] = []
  const updates: Record<string, unknown>[] = []
  const db = fakeSupabase((op: Op) => {
    if (op.table === 'bank_lines' && op.action === 'select') {
      if (hasFilter(op, 'eq', 'id')) return { data: world.line }
      return { data: world.around ?? [] }
    }
    if (op.table === 'documents') return { data: world.documents ?? [] }
    if (op.table === 'booking_rules') return { data: world.rules ?? RULES }
    if (op.table === 'receipt_claims') {
      if (op.action === 'select') return { data: hasFilter(op, 'in', 'key') ? (world.claims ?? []).filter(c => inValues(op, 'key').includes(c.key)) : world.claims ?? [] }
      if (op.action === 'delete') {
        writes.push('claims delete')
        world.claims = (world.claims ?? []).filter(c => c.bank_line_id !== eqValue(op, 'bank_line_id'))
        return {}
      }
      if (op.action === 'insert') {
        if (world.insertConflict) return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        const rows = op.values as { key: string; bank_line_id: string; label: string }[]
        writes.push(`claims insert ${rows.length}`)
        world.claims = [...(world.claims ?? []), ...rows]
        return {}
      }
    }
    if (op.table === 'bank_lines' && op.action === 'update') {
      writes.push('line update')
      updates.push(op.values as Record<string, unknown>)
      return { data: world.changed ? [] : [{ id: world.line.id }] }
    }
    return {}
  })
  const storage = {
    uploads: [] as string[],
    removes: [] as string[][],
    upload: async (path: string) => { storage.uploads.push(path) },
    remove: async (paths: string[]) => { storage.removes.push(paths) },
  }
  return { db, storage, writes, updates }
}
const run = (s: ReturnType<typeof setup>, deps: GmailReceiptDeps, opts: Parameters<typeof searchLineReceipt>[3] = {}) =>
  searchLineReceipt(s.db.client, LINE_ID, deps, { storage: s.storage, ...opts })

const VENDORS: Vendor[] = vendorsOf(RULES, null)
const txOf = (text: string, counterparty: string): EasybankTransaction =>
  ({ date: '2026-07-16', counterparty, reference: text, amount: 23.45, type: 'expense', currency: 'EUR', raw: { col0: IBAN, col1: text } })

describe('searchPaths — where a line’s receipt is searched (Bookmatic’s Analyse)', () => {
  test('a Buchungsregel: its sender; rules that tie: each of theirs', () => {
    const r = searchPaths(txOf(TEXT, 'Muster Telekom GmbH'), VENDORS)
    assert.ok('paths' in r)
    assert.deepEqual(r.paths.map(p => [p.kind, p.kind === 'sender' ? p.rules.map(x => x.id) : null]), [['sender', ['r-tel']]])
    const tie = vendorsOf([...RULES, rule({ id: 'r-tel-b', name: 'Telefon Studio' })], null)
    const t = searchPaths(txOf(TEXT, 'Muster Telekom GmbH'), tie)
    assert.ok('paths' in t && t.paths[0].kind === 'sender')
    assert.deepEqual(t.paths[0].kind === 'sender' && t.paths[0].rules.map(x => x.id).sort(), ['r-tel', 'r-tel-b'])
  })
  test('no rule: the vendor’s name; a payment processor first, then the name', () => {
    const name = searchPaths(txOf('Bezahlung Karte MC/000000653|ACME SHOP\\\\WIEN', 'ACME SHOP\\\\WIEN'), VENDORS)
    assert.ok('paths' in name)
    assert.deepEqual(name.paths.map(p => p.kind), ['keyword'])
    const paddle = searchPaths(txOf('Bezahlung Karte MC/000000654|PADDLE.NET* ACME\\\\LISBOA', 'PADDLE.NET* ACME\\\\LISBOA'), VENDORS)
    assert.ok('paths' in paddle)
    assert.deepEqual(paddle.paths.map(p => [p.kind, p.kind === 'processor' ? p.domain : null]), [['processor', 'paddle.com'], ['keyword', null]])
  })
  test('a transfer to the owner’s own account and a card issuer’s settlement: nothing to search', () => {
    const own = searchPaths(txOf('Abbuchung Echtzeitüberweisung FE/000000662|NTSBDEB1XXX DE89370400440532013000 Konrad Testmann|Private Auszahlung', 'Konrad Testmann'), VENDORS)
    assert.deepEqual(own, { reason: RECEIPT_TEXT.ownTransfer })
    const card = searchPaths(txOf('PAYLIFE ABRECHNUNG VOM 18.10.2026 OG/000000660|BAWAATWWXXX AT000000000000000099 PayLife', 'PayLife'), VENDORS)
    assert.deepEqual(card, { reason: RECEIPT_TEXT.cardSettlement })
  })
})

describe('searchLineReceipt — which lines are searched', () => {
  const refused = async (line: BankLine, opts: Parameters<typeof searchLineReceipt>[3] = {}, world: Partial<DbWorld> = {}) => {
    const s = setup({ line, ...world })
    const g = gmail(PROVEN)
    const r = await run(s, g.deps, opts)
    assert.deepEqual([s.writes, g.log.searches, s.storage.uploads], [[], [], []])
    return r
  }
  test('a credit, a line booked or skipped, a booking attempt open: not searched, nothing written', async () => {
    assert.deepEqual(await refused(bankLine({}, TEXT, 23.45)), { status: 'not_searched', reason: RECEIPT_TEXT.notDebit })
    assert.deepEqual(await refused(bankLine({ status: 'booked' })), { status: 'not_searched', reason: RECEIPT_TEXT.notOpen })
    assert.deepEqual(await refused(bankLine({ status: 'skipped' })), { status: 'not_searched', reason: RECEIPT_TEXT.notOpen })
    const pending = { year: 2026, kind: 'expense' as const, booking_id: null, amount: -23.45, date: '2026-07-16', title: 'x', at: NOW }
    assert.deepEqual(await refused(bankLine({ bookamat_pending: pending })), { status: 'not_searched', reason: RECEIPT_TEXT.pending })
  })
  test('a line that names a Mado document: that document’s money, not searched', async () => {
    const r = await refused(bankLine({}, `${TEXT} AN-2026001`), {}, { documents: [{ type: 'credit_note', number: 'AN-2026001' }] })
    assert.equal(r.status, 'not_searched')
    assert.match(r.status === 'not_searched' ? r.reason : '', /^Nennt AN-2026001 aus Mado/)
  })
  test('a Beleg the owner attached (by hand or from the list): not searched until it is removed', async () => {
    assert.deepEqual(await refused(bankLine({ receipt_path: `${LINE_ID}/Rechnung.pdf`, receipt_name: 'Rechnung.pdf' })), { status: 'not_searched', reason: RECEIPT_TEXT.ownReceipt })
    assert.equal(ownReceipt({ receipt_path: `${LINE_ID}/x.pdf`, receipt_search: null, receipt_gmail: null }), true)
    assert.equal(ownReceipt({ receipt_path: null, receipt_search: null, receipt_gmail: { candidate: {} as never, name: 'x', extracted: {}, unreadable: false, sha256: null, text: null } }), true)
  })
  test('the page’s search after an upload (auto): only from the switch-over date on (D11); „In Gmail suchen“ any time', async () => {
    assert.deepEqual(await refused(bankLine(), { auto: true, expensesFrom: null }), { status: 'not_searched', reason: RECEIPT_TEXT.beforeSwitch })
    assert.deepEqual(await refused(bankLine(), { auto: true, expensesFrom: '2026-08-01' }), { status: 'not_searched', reason: RECEIPT_TEXT.beforeSwitch })
    const s = setup({ line: bankLine() })
    const r = await run(s, gmail(PROVEN).deps, { auto: true, expensesFrom: '2026-07-01' })
    assert.equal(r.status, 'searched')
  })
})

describe('searchLineReceipt — what a search keeps', () => {
  test('a receipt proven by its amount: copied into the bucket, claimed for the line by all its keys, the search kept on the line', async () => {
    const s = setup({ line: bankLine() })
    const g = gmail(PROVEN)
    const r = await run(s, g.deps)
    assert.equal(r.status, 'searched')
    if (r.status !== 'searched') return
    assert.deepEqual(g.log.searches, ['from:rechnung@muster.example'])
    assert.deepEqual(r.attached, { path: `${LINE_ID}/gmail-shaa1abc-Rechnung.pdf`, name: 'Rechnung.pdf' })
    assert.deepEqual(s.storage.uploads, [`${LINE_ID}/gmail-shaa1abc-Rechnung.pdf`])
    assert.deepEqual(s.writes, ['claims delete', 'claims insert 3', 'line update'])
    const update = s.updates[0] as { receipt_search: BankLineReceiptSearch; receipt_gmail: null; receipt_path: string; receipt_name: string }
    assert.equal(update.receipt_gmail, null)
    assert.deepEqual([update.receipt_path, update.receipt_name], [`${LINE_ID}/gmail-shaa1abc-Rechnung.pdf`, 'Rechnung.pdf'])
    const kept = update.receipt_search
    assert.deepEqual([kept.chosen?.message_id, kept.chosen?.part_id, kept.chosen?.via.kind, kept.check], ['msg-a1', '1', 'sender', 'amount'])
    assert.deepEqual([kept.read?.amount, kept.read?.invoice_number, kept.read?.date], [23.45, '910000000123', '2026-07-10'])
    assert.match(kept.text ?? '', /Gesamt 23,45 EUR/)
    assert.equal(kept.chosen?.body_text, 'Ihre Rechnung')
    // Never the PDF's data
    assert.doesNotMatch(JSON.stringify(update), new RegExp(bytesOf('a1')))
  })
  test('a dry run („Probelauf“): searched and read as a search is, nothing written, nothing stored', async () => {
    const s = setup({ line: bankLine() })
    const g = gmail(PROVEN)
    const r = await run(s, g.deps, { dryRun: true })
    assert.ok(r.status === 'searched' && r.dryRun)
    assert.deepEqual(r.status === 'searched' && r.attached, { path: null, name: 'Rechnung.pdf' })
    assert.deepEqual([g.log.searches, g.log.reads], [['from:rechnung@muster.example'], ['a1']])
    assert.deepEqual([s.writes, s.storage.uploads, s.storage.removes], [[], [], []])
    assert.equal(r.status === 'searched' && r.search.check, 'amount')
  })
  test('a receipt another line holds is not this line’s: listed as that line’s, nothing attached', async () => {
    const s = setup({ line: bankLine(), claims: [{ key: 'gmail:msg-a1:1', bank_line_id: OTHER_ID, label: '02.07.2026 · Muster · 23,45 €' }] })
    const r = await run(s, gmail(PROVEN).deps)
    assert.ok(r.status === 'searched')
    if (r.status !== 'searched') return
    assert.deepEqual([r.attached, r.search.chosen, s.storage.uploads], [null, null, []])
    assert.deepEqual(r.search.candidates.map(c => [c.message_id, c.why, c.claimed_by]), [['msg-a1', 'claimed', '02.07.2026 · Muster · 23,45 €']])
  })
  test('a receipt another line’s search claimed meanwhile: not attached, said on the line', async () => {
    const s = setup({ line: bankLine(), insertConflict: true })
    const r = await run(s, gmail(PROVEN).deps)
    assert.ok(r.status === 'searched')
    if (r.status !== 'searched') return
    assert.deepEqual([r.attached, r.search.chosen, s.storage.uploads], [null, null, []])
    assert.equal(r.search.note, RECEIPT_TEXT.claimedMeanwhile('einer anderen Zeile'))
  })
  test('a line booked or held meanwhile: the copy and the claims go, nothing kept', async () => {
    const s = setup({ line: bankLine(), changed: true })
    await assert.rejects(run(s, gmail(PROVEN).deps), (e: unknown) => e instanceof ReceiptError && e.code === 'changed' && e.status === 409)
    assert.deepEqual(s.storage.removes, [[`${LINE_ID}/gmail-shaa1abc-Rechnung.pdf`]])
    assert.deepEqual(s.writes.slice(-1), ['claims delete'])
  })
  test('searched again: the earlier search’s receipt is replaced, its copy removed once the new one is kept', async () => {
    const earlier = bankLine({ receipt_path: `${LINE_ID}/gmail-old-Rechnung.pdf`, receipt_name: 'Rechnung.pdf', receipt_search: { at: NOW, chosen: { message_id: 'msg-old', part_id: '1', file_name: 'Rechnung.pdf', subject: 'x', from: 'y', date: null, sha256: 'old', via: { kind: 'keyword', name: 'x' } }, check: 'number', read: null, text: null, note: null, plain_note: null, candidates: [], failed: [] } })
    const s = setup({ line: earlier })
    await run(s, gmail(PROVEN).deps)
    assert.deepEqual(s.storage.removes, [[`${LINE_ID}/gmail-old-Rechnung.pdf`]])
    // and nothing found: the earlier receipt goes all the same
    const none = setup({ line: earlier })
    const r = await run(none, gmail({}).deps)
    assert.ok(r.status === 'searched' && !r.attached)
    assert.deepEqual([none.updates[0].receipt_path, none.updates[0].receipt_name], [null, null])
    assert.deepEqual(none.storage.removes, [[`${LINE_ID}/gmail-old-Rechnung.pdf`]])
  })
  test('the text kept is capped; a file name is made safe for the path', () => {
    assert.equal(RECEIPT_TEXT_MAX, 6000)
    assert.equal(storedName('Rechnung 05/2026 (Kopie).pdf'), 'Rechnung_05_2026_Kopie_.pdf')
    assert.equal(storedName('///'), '_')
  })
})

describe('attachGmailCandidate — „Anhängen“ of a PDF the search found', () => {
  const listedLine = () => bankLine({
    receipt_search: {
      at: NOW, chosen: null, check: null, read: null, text: null, note: null, plain_note: null, failed: [],
      candidates: [{ message_id: 'msg-c1', part_id: '2', file_name: 'Rechnung_Juli.pdf', subject: 'Ihre Rechnung', from: 'Muster GmbH <rechnung@muster.example>', date: 'Wed, 15 Jul 2026 08:00:00 +0200', size: 2048, amount: 25, currency: null, foreign_total: null, invoice_number: null, why: 'amount', found_by: { sender: 'rechnung@muster.example', rule_ids: ['r-tel'] } }],
    },
  })
  const deps = (over: Partial<AttachDeps> = {}): AttachDeps => ({
    fetchPdf: async () => ({ base64: bytesOf('c1'), filename: 'Rechnung_Juli.pdf' }),
    pdfText: async () => ({ text: 'Muster GmbH Rechnung', pages: 1 }),
    readPdf: async () => ({ ...NOTHING, amount: 25, invoice_number: '910000000999', date: '2026-07-14', document_type: 'invoice' }),
    ...over,
  })
  test('fetched, read, claimed, copied, kept as the owner’s; the search’s own receipt replaced, its list kept', async () => {
    const s = setup({ line: listedLine() })
    const out = await attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: s.storage })
    assert.match(out.path, new RegExp(`^${LINE_ID}/gmail-[0-9a-f]{8}-Rechnung_Juli\\.pdf$`))
    assert.deepEqual(s.storage.uploads, [out.path])
    assert.deepEqual(s.writes, ['claims delete', 'claims insert 3', 'line update'])
    const u = s.updates[0] as { receipt_gmail: { candidate: { message_id: string }; extracted: unknown; unreadable: boolean }; receipt_search: BankLineReceiptSearch }
    assert.equal(u.receipt_gmail.candidate.message_id, 'msg-c1')
    assert.deepEqual(u.receipt_gmail.extracted, { invoice_number: '910000000999', date: '2026-07-14', amount: 25 })
    assert.equal(u.receipt_gmail.unreadable, false)
    assert.equal(u.receipt_search.chosen, null)
    assert.equal(u.receipt_search.candidates.length, 1)
  })
  test('not in the line’s list, no PDF, another line’s: refused, nothing kept', async () => {
    const s = setup({ line: listedLine() })
    await assert.rejects(attachGmailCandidate(s.db.client, LINE_ID, 'msg-zz', '1', deps(), { storage: s.storage }), (e: unknown) => e instanceof ReceiptError && e.code === 'not_found')
    await assert.rejects(attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps({ fetchPdf: async () => ({ base64: Buffer.from('GIF89a').toString('base64'), filename: 'x.pdf' }) }), { storage: s.storage }),
      (e: unknown) => e instanceof ReceiptError && e.code === 'invalid_request')
    const held = setup({ line: listedLine(), claims: [{ key: 'gmail:msg-c1:2', bank_line_id: OTHER_ID, label: '02.07.2026 · Muster · 25,00 €' }] })
    await assert.rejects(attachGmailCandidate(held.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: held.storage }),
      (e: unknown) => e instanceof ReceiptError && e.code === 'claimed' && e.message === RECEIPT_TEXT.claimed('02.07.2026 · Muster · 25,00 €'))
    assert.deepEqual([s.storage.uploads, held.storage.uploads, held.updates], [[], [], []])
  })
  test('the reader failing (or no key): attached all the same, its data not read', async () => {
    const s = setup({ line: listedLine() })
    await attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps({ readPdf: async () => null }), { storage: s.storage })
    assert.equal((s.updates[0] as { receipt_gmail: { unreadable: boolean } }).receipt_gmail.unreadable, true)
  })
})

describe('releaseGmailReceipt — a Beleg by hand in its place, or none', () => {
  test('the claims go, a receipt from Gmail is forgotten, its list stays', async () => {
    const s = setup({ line: bankLine(), claims: [{ key: 'gmail:msg-a1:1', bank_line_id: LINE_ID, label: '' }] })
    const search: BankLineReceiptSearch = { at: NOW, chosen: { message_id: 'msg-a1', part_id: '1', file_name: 'R.pdf', subject: 's', from: 'f', date: null, sha256: null, via: { kind: 'keyword', name: 'x' } }, check: 'amount', read: null, text: 't', note: 'n', plain_note: null, candidates: [], failed: [] }
    const update = await releaseGmailReceipt(s.db.client, { id: LINE_ID, receipt_search: search })
    assert.deepEqual(s.writes, ['claims delete'])
    assert.equal(update.receipt_gmail, null)
    assert.deepEqual([update.receipt_search?.chosen, update.receipt_search?.check, update.receipt_search?.text, update.receipt_search?.note], [null, null, null, 'n'])
    assert.deepEqual(await releaseGmailReceipt(s.db.client, { id: LINE_ID, receipt_search: null }), { receipt_gmail: null })
  })
})

describe('lineRow — the row built from what the line keeps', () => {
  const kept = (check: BankLineReceiptSearch['check'], over: Partial<BankLineReceiptSearch> = {}): BankLineReceiptSearch => ({
    at: NOW, check, read: { amount: 23.45, amount_due: null, currency: 'EUR', foreign_total: null, invoice_number: '910000000123', date: '2026-07-10', vatin: null, document_type: 'invoice' },
    chosen: { message_id: 'msg-a1', part_id: '1', file_name: 'Rechnung.pdf', subject: 'Ihre Rechnung', from: 'rechnung@muster.example', date: 'Wed, 15 Jul 2026 08:00:00 +0200', sha256: 'x', via: { kind: 'sender', sender: 'rechnung@muster.example', ruleIds: ['r-tel'] }, body_text: '' },
    text: 'Rechnung', note: 'Gmail: rechnung@muster.example · Betrag 23,45 € stimmt', plain_note: null, candidates: [], failed: [], ...over,
  })
  const rowOf = (line: BankLine) => {
    const built = lineRow(line, VENDORS, null)
    assert.equal(built.kind, 'expense')
    return built.kind === 'expense' ? built.row : (null as never)
  }
  test('a rule’s receipt proven by its amount: the rule’s row is ready, the receipt’s data on it, nothing listed', () => {
    const row = rowOf(bankLine({ receipt_path: `${LINE_ID}/gmail-x-Rechnung.pdf`, receipt_search: kept('amount', { candidates: [{ message_id: 'msg-b', part_id: '1', file_name: 'B.pdf', subject: 's', from: 'f', date: null, size: 1, amount: 9, currency: null, foreign_total: null, invoice_number: null, why: 'amount' }] }) }))
    assert.deepEqual([row.vendor?.id, row.status, row.gmail_message_id, row.gmail_part_id, row.receipt_check], ['r-tel', 'ready', 'msg-a1', '1', 'amount'])
    assert.deepEqual([row.extracted_invoice_date, row.extracted_invoice_number, row.extracted_amount], ['2026-07-10', '910000000123', 23.45])
    assert.equal(row.gmail_candidates, undefined)
    assert.equal(receiptDoubt(row), false)
    assert.match(row.match_note ?? '', /Betrag 23,45 € stimmt/)
  })
  test('one attached by its number only: doubtful, never ticked, the list shown', () => {
    const cand = { message_id: 'msg-b', part_id: '1', file_name: 'B.pdf', subject: 's', from: 'f', date: null, size: 1, amount: 9, currency: null, foreign_total: null, invoice_number: null, why: 'amount' as const }
    const row = rowOf(bankLine({ receipt_path: `${LINE_ID}/gmail-x-Rechnung.pdf`, receipt_search: kept('number', { candidates: [cand] }) }))
    assert.equal(row.receipt_check, 'number')
    assert.equal(receiptDoubt(row), true)
    assert.notEqual(row.status, 'ready')
    assert.deepEqual(row.gmail_candidates?.map(c => c.message_id), ['msg-b'])
  })
  test('a PDF of the list the owner attached: proven by the owner, said where it came from', () => {
    const fromList = { candidate: { message_id: 'msg-c1', part_id: '2', file_name: 'Rechnung_Juli.pdf', subject: 'Ihre Rechnung', from: 'rechnung@muster.example', date: null, size: 1, amount: 23.45, currency: null, foreign_total: null, invoice_number: null, why: 'unchecked' as const }, name: 'Rechnung_Juli.pdf', extracted: { date: '2026-07-14', amount: 23.45 }, unreadable: false, sha256: 'x', text: null }
    const row = rowOf(bankLine({ receipt_path: `${LINE_ID}/gmail-x-Rechnung_Juli.pdf`, receipt_gmail: fromList, receipt_search: kept(null, { chosen: null, read: null, text: null, note: null }) }))
    assert.deepEqual([row.gmail_message_id, row.receipt_check, row.extracted_invoice_date, row.status], ['msg-c1', 'owner', '2026-07-14', 'ready'])
    assert.ok((row.match_note ?? '').includes(gmailAttachedNote('Rechnung_Juli.pdf')))
  })
  test('a Beleg uploaded by hand: the rule’s row ready, as in 9a', () => {
    const row = rowOf(bankLine({ receipt_path: `${LINE_ID}/Beleg.pdf`, receipt_name: 'Beleg.pdf' }))
    assert.deepEqual([row.status, row.gmail_message_id], ['ready', null])
  })
  test('storedFind: nothing kept, nothing found; a search without a pick keeps its notes and list only', () => {
    assert.equal(storedFind(null), null)
    const f = storedFind(kept(null, { chosen: null, note: '⚠ 2 Belege mit Betrag 23,45 €' }))
    assert.deepEqual([f?.chosen, f?.check, f?.read, f?.text, f?.note], [null, null, null, null, '⚠ 2 Belege mit Betrag 23,45 €'])
  })
})

describe('receiptKept — what the booking attaches', () => {
  test('a Beleg by hand always; one from Gmail only while the row keeps it; none without a copy', () => {
    const search = { chosen: { message_id: 'm' } } as unknown as BankLineReceiptSearch
    assert.equal(receiptKept({ receipt_path: 'p', receipt_search: null, receipt_gmail: null }, { gmail_message_id: null }), true)
    assert.equal(receiptKept({ receipt_path: 'p', receipt_search: search, receipt_gmail: null }, { gmail_message_id: 'm' }), true)
    assert.equal(receiptKept({ receipt_path: 'p', receipt_search: search, receipt_gmail: null }, { gmail_message_id: null }), false)
    assert.equal(receiptKept({ receipt_path: null, receipt_search: search, receipt_gmail: null }, { gmail_message_id: 'm' }), false)
  })
})

describe('wiring: the receipt routes', () => {
  const route = (rel: string) => readFileSync(join(import.meta.dirname, '..', '..', '..', 'app', 'api', 'bank-lines', '[id]', 'receipts', rel), 'utf8')
  test('each in its own request of 60 s; the search takes dryRun and auto; every route checks Gmail may be read first', () => {
    assert.equal(SEARCH_MAX_DURATION_S, 60)
    for (const rel of ['route.ts', 'attach/route.ts', 'preview/route.ts']) {
      const src = route(rel)
      assert.match(src, /export const maxDuration = 60\n/, rel)
      assert.match(src, /const refusal = gmailReadRefusal\(s\)\n\s+if \(refusal\) return/, rel)
    }
    const search = route('route.ts')
    assert.match(search, /dryRun: body\.dryRun === true, auto: body\.auto === true, expensesFrom: s\.expenses_from \?\? null, startedAt/)
    // Only what the line's list names is shown or attached
    assert.match(route('preview/route.ts'), /const c = \(search\?\.candidates \?\? \[\]\)\.find\(/)
  })
})
