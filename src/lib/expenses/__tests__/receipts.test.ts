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
import { BookamatError } from '@/lib/bookamat'
import {
  attachGmailCandidate, copyPath, ownReceipt, ReceiptError, searchLineReceipt, searchPaths, setHandReceipt, storedName,
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
  // set_line_receipt meets a key another line claimed just now
  insertConflict?: boolean
  // the line changed between the load and the step (booked, held, its receipt another)
  changed?: boolean
  // the step throws: before it saved anything (the database failing), or after (its answer lost)
  stepThrows?: 'before' | 'after'
  documents?: { type: string; number: string }[]
}
type StepArgs = {
  p_line: string; p_expected_path: string | null; p_expected_search_at: string | null; p_expected_gmail: boolean
  p_keys: string[] | null; p_label: string; p_path: string | null; p_name: string | null; p_search: BankLineReceiptSearch | null; p_gmail: unknown
}
const inValues = (op: Op, column: string) => (op.filters.find(f => f[0] === 'in' && f[1] === column)?.[2] ?? []) as string[]
function setup(world: DbWorld) {
  const writes: string[] = []
  const steps: StepArgs[] = []
  const db = fakeSupabase((op: Op) => {
    if (op.table === 'bank_lines' && op.action === 'select') {
      if (hasFilter(op, 'eq', 'id')) return { data: world.line }
      return { data: world.around ?? [] }
    }
    if (op.table === 'documents') return { data: world.documents ?? [] }
    if (op.table === 'booking_rules') return { data: world.rules ?? RULES }
    if (op.table === 'receipt_claims' && op.action === 'select') {
      const all = hasFilter(op, 'in', 'key') ? (world.claims ?? []).filter(c => inValues(op, 'key').includes(c.key)) : world.claims ?? []
      const range = op.filters.find(f => f[0] === 'range') as [string, number, number] | undefined
      return { data: range ? all.slice(range[1], range[2] + 1) : all }
    }
    writes.push(`${op.action} ${op.table}`)
    return {}
  })
  // set_line_receipt (20261118_receipts.sql), as its SQL says
  ;(db.client as unknown as { rpc: (name: string, args: StepArgs) => Promise<{ data: unknown; error: { message: string } | null }> }).rpc = async (name, args) => {
    assert.equal(name, 'set_line_receipt')
    steps.push(args)
    if (world.stepThrows === 'before') return { data: null, error: { message: 'connection reset' } }
    const l = world.line
    const same = (l.receipt_path ?? null) === args.p_expected_path && (l.receipt_search?.at ?? null) === args.p_expected_search_at && !!l.receipt_gmail === args.p_expected_gmail
    if (world.changed || l.status !== 'open' || l.bookamat_pending || !same) return { data: { status: 'changed' }, error: null }
    if (args.p_keys) {
      const other = (world.claims ?? []).find(c => args.p_keys!.includes(c.key) && c.bank_line_id !== l.id)
      if (other) return { data: { status: 'held', label: other.label }, error: null }
      if (world.insertConflict) return { data: { status: 'held', label: '' }, error: null }
      world.claims = [...(world.claims ?? []).filter(c => c.bank_line_id !== l.id), ...args.p_keys.map(key => ({ key, bank_line_id: l.id, label: args.p_label }))]
      writes.push(`claims ${args.p_keys.length}`)
    }
    world.line = { ...l, receipt_path: args.p_path, receipt_name: args.p_name, receipt_search: args.p_search, receipt_gmail: args.p_gmail as BankLine['receipt_gmail'] }
    writes.push('line receipt')
    if (world.stepThrows === 'after') return { data: null, error: { message: 'connection reset' } }
    return { data: { status: 'ok' }, error: null }
  }
  const storage = {
    uploads: [] as string[],
    removes: [] as string[][],
    upload: async (path: string) => { storage.uploads.push(path) },
    remove: async (paths: string[]) => { storage.removes.push(paths) },
  }
  return { db, storage, writes, steps, world }
}
const COPY = new RegExp(`^${LINE_ID}/gmail-[0-9a-f]{8}-shaa1abc-Rechnung\\.pdf$`)
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
  test('a line Mado never books (another account, another currency): not searched, the route’s gate says why', async () => {
    const gate = async () => 'Konto AT000000000000000099 ist keines deiner Geschäftskonten (Einstellungen → Buchungsregeln) — nicht gebucht'
    const r = await refused(bankLine(), { accountGate: gate })
    assert.deepEqual(r, { status: 'not_searched', reason: await gate() })
  })
  test('by itself only once: a line searched before is searched again on „Erneut“, or by itself when its search only failed', async () => {
    const searched: BankLineReceiptSearch = { at: NOW, chosen: null, check: null, read: null, text: null, note: null, plain_note: null, candidates: [], failed: [] }
    assert.deepEqual(await refused(bankLine({ receipt_search: searched }), { auto: true, expensesFrom: '2026-07-01' }), { status: 'not_searched', reason: RECEIPT_TEXT.searchedBefore })
    const failed = setup({ line: bankLine({ receipt_search: { ...searched, failed: ['⚠ Gmail-Suche fehlgeschlagen'] } }) })
    assert.equal((await run(failed, gmail(PROVEN).deps, { auto: true, expensesFrom: '2026-07-01' })).status, 'searched')
    const again = setup({ line: bankLine({ receipt_search: searched }) })
    assert.equal((await run(again, gmail(PROVEN).deps)).status, 'searched')
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
  test('a receipt proven by its amount: copied under a name of its own, claimed by all its keys and kept on the line in one step', async () => {
    const s = setup({ line: bankLine() })
    const g = gmail(PROVEN)
    const r = await run(s, g.deps)
    assert.equal(r.status, 'searched')
    if (r.status !== 'searched') return
    assert.deepEqual(g.log.searches, ['from:rechnung@muster.example'])
    assert.match(r.attached?.path ?? '', COPY)
    assert.deepEqual(s.storage.uploads, [r.attached!.path])
    // the step: the line as loaded, the three keys, the copy
    assert.deepEqual(s.writes, ['claims 3', 'line receipt'])
    assert.deepEqual([s.steps[0].p_expected_path, s.steps[0].p_expected_search_at, s.steps[0].p_expected_gmail], [null, null, false])
    const line = s.world.line
    assert.deepEqual([line.receipt_path, line.receipt_name, line.receipt_gmail], [r.attached!.path, 'Rechnung.pdf', null])
    const kept = line.receipt_search!
    assert.deepEqual([kept.chosen?.message_id, kept.chosen?.part_id, kept.chosen?.via.kind, kept.check], ['msg-a1', '1', 'sender', 'amount'])
    assert.deepEqual([kept.read?.amount, kept.read?.invoice_number, kept.read?.date], [23.45, '910000000123', '2026-07-10'])
    assert.match(kept.text ?? '', /Gesamt 23,45 EUR/)
    assert.equal(kept.chosen?.body_text, 'Ihre Rechnung')
    // Never the PDF's data; the page's answer without the receipt's text and its e-mail's
    assert.doesNotMatch(JSON.stringify(line), new RegExp(bytesOf('a1')))
    assert.deepEqual([r.search.text, r.search.chosen?.body_text], [null, null])
  })
  test('every copy has a name of its own (the same receipt found twice too)', () => {
    assert.notEqual(copyPath(LINE_ID, 'abcdef12', 'R.pdf'), copyPath(LINE_ID, 'abcdef12', 'R.pdf'))
  })
  test('a dry run („Probelauf“): searched and read as a search is, nothing written, nothing stored', async () => {
    const s = setup({ line: bankLine() })
    const g = gmail(PROVEN)
    const r = await run(s, g.deps, { dryRun: true })
    assert.ok(r.status === 'searched' && r.dryRun)
    assert.deepEqual(r.status === 'searched' && r.attached, { path: null, name: 'Rechnung.pdf' })
    assert.deepEqual([g.log.searches, g.log.reads], [['from:rechnung@muster.example'], ['a1']])
    assert.deepEqual([s.writes, s.steps, s.storage.uploads, s.storage.removes], [[], [], [], []])
    assert.equal(r.status === 'searched' && r.search.check, 'amount')
  })
  test('a receipt another line holds is not this line’s: listed as that line’s, nothing attached, the claims as they were', async () => {
    const s = setup({ line: bankLine(), claims: [{ key: 'gmail:msg-a1:1', bank_line_id: OTHER_ID, label: '02.07.2026 · Muster · 23,45 €' }] })
    const r = await run(s, gmail(PROVEN).deps)
    assert.ok(r.status === 'searched')
    if (r.status !== 'searched') return
    assert.deepEqual([r.attached, r.search.chosen, s.storage.uploads], [null, null, []])
    assert.deepEqual(r.search.candidates.map(c => [c.message_id, c.why, c.claimed_by]), [['msg-a1', 'claimed', '02.07.2026 · Muster · 23,45 €']])
    assert.equal(s.steps[0].p_keys, null)
  })
  test('the claims are read page by page: a receipt claimed after the first thousand is still another line’s', async () => {
    const many = Array.from({ length: 1000 }, (_, k) => ({ key: `gmail:msg-x${String(k).padStart(4, '0')}:1`, bank_line_id: OTHER_ID, label: 'x' }))
    const s = setup({ line: bankLine(), claims: [...many, { key: 'gmail:msg-a1:1', bank_line_id: OTHER_ID, label: 'die andere Zeile' }] })
    const r = await run(s, gmail(PROVEN).deps)
    assert.ok(r.status === 'searched' && !r.attached)
  })
  test('a receipt another line’s search claimed meanwhile: its copy goes, the line keeps the search without it, said', async () => {
    const s = setup({ line: bankLine(), insertConflict: true })
    const r = await run(s, gmail(PROVEN).deps)
    assert.ok(r.status === 'searched')
    if (r.status !== 'searched') return
    assert.equal(r.attached, null)
    assert.equal(s.storage.uploads.length, 1)
    assert.deepEqual(s.storage.removes, [[s.storage.uploads[0]]])
    assert.deepEqual([s.world.line.receipt_path, s.world.line.receipt_search?.chosen], [null, null])
    assert.equal(s.world.line.receipt_search?.note, RECEIPT_TEXT.claimedMeanwhile('einer anderen Zeile'))
  })
  test('a line booked, held or given a receipt meanwhile: only the search’s own copy goes; the line and its claims stay as they are', async () => {
    const before = bankLine({ receipt_path: `${LINE_ID}/gmail-0000-old-Rechnung.pdf`, receipt_name: 'Rechnung.pdf', receipt_search: { at: NOW, chosen: { message_id: 'msg-a1', part_id: '1', file_name: 'Rechnung.pdf', subject: 'x', from: 'y', date: null, sha256: 'shaa1abcdef', via: { kind: 'keyword', name: 'x' } }, check: 'amount', read: null, text: null, note: null, plain_note: null, candidates: [], failed: [] } })
    const s = setup({ line: before, changed: true, claims: [{ key: 'gmail:msg-a1:1', bank_line_id: LINE_ID, label: '' }] })
    await assert.rejects(run(s, gmail(PROVEN).deps), (e: unknown) => e instanceof ReceiptError && e.code === 'line_changed' && e.status === 409)
    // the same receipt found again: its new copy (a name of its own) goes, never the line's
    assert.equal(s.storage.removes.length, 1)
    assert.notEqual(s.storage.removes[0][0], before.receipt_path)
    assert.deepEqual([s.world.line, s.world.claims], [before, [{ key: 'gmail:msg-a1:1', bank_line_id: LINE_ID, label: '' }]])
  })
  test('a step that throws: its copy goes when the line, read again, does not hold it; kept when only the answer was lost (verifier finding, PR 9b)', async () => {
    const failed = setup({ line: bankLine(), stepThrows: 'before' })
    await assert.rejects(run(failed, gmail(PROVEN).deps), (e: unknown) => e instanceof BookamatError && e.code === 'database')
    assert.equal(failed.storage.uploads.length, 1)
    assert.deepEqual([failed.storage.removes, failed.world.line.receipt_path], [[failed.storage.uploads], null])
    const lost = setup({ line: bankLine(), stepThrows: 'after' })
    await assert.rejects(run(lost, gmail(PROVEN).deps), (e: unknown) => e instanceof BookamatError && e.code === 'database')
    assert.deepEqual([lost.storage.removes, lost.world.line.receipt_path], [[], lost.storage.uploads[0]])
  })
  test('what a line stores holds no NUL and no lone surrogate (jsonb refuses both); a „\\u0000“ written in the text stays as written', async () => {
    const s = setup({ line: bankLine() })
    const g = gmail({ ...PROVEN, senders: { 'rechnung@muster.example': [msg('msg-a1', 'Ihre Rechnung\u0000 910000000123 \ud800', [pdf('1', 'Rech\u0000nung.pdf', 'a1')])] } })
    g.deps.pdfText = async () => ({ text: 'Muster\u0000 GmbH Pfad C:\\u0000x Gesamt 23,45 EUR', pages: 1 })
    const r = await run(s, g.deps)
    assert.ok(r.status === 'searched' && r.attached)
    const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    assert.ok(strings(s.steps[0]).every(x => !x.includes('\u0000') && x.isWellFormed()))
    const kept = s.world.line.receipt_search!
    assert.equal(kept.chosen?.subject, 'Ihre Rechnung 910000000123 \ufffd')
    assert.equal(kept.text, 'Muster GmbH Pfad C:\\u0000x Gesamt 23,45 EUR')
    assert.equal(s.world.line.receipt_name, 'Rechnung.pdf')
  })
  test('searched again: the earlier search’s receipt is replaced, its copy removed once the new one is kept', async () => {
    const earlier = bankLine({ receipt_path: `${LINE_ID}/gmail-old-Rechnung.pdf`, receipt_name: 'Rechnung.pdf', receipt_search: { at: NOW, chosen: { message_id: 'msg-old', part_id: '1', file_name: 'Rechnung.pdf', subject: 'x', from: 'y', date: null, sha256: 'old', via: { kind: 'keyword', name: 'x' } }, check: 'number', read: null, text: 'alt', note: 'Rechnungsnr. 910000000123', plain_note: null, candidates: [], failed: [] } })
    const s = setup({ line: earlier })
    await run(s, gmail(PROVEN).deps)
    assert.deepEqual(s.storage.removes, [[`${LINE_ID}/gmail-old-Rechnung.pdf`]])
    assert.match(s.world.line.receipt_path ?? '', COPY)
  })
  test('searched again and nothing picked (Gmail failing, time out, the e-mail gone): the earlier receipt stays, with what was said of it', async () => {
    const earlier = bankLine({ receipt_path: `${LINE_ID}/gmail-old-Rechnung.pdf`, receipt_name: 'Rechnung.pdf', receipt_search: { at: NOW, chosen: { message_id: 'msg-old', part_id: '1', file_name: 'Rechnung.pdf', subject: 'x', from: 'y', date: null, sha256: 'old', via: { kind: 'keyword', name: 'x' } }, check: 'amount', read: { amount: 23.45, amount_due: null, currency: 'EUR', foreign_total: null, invoice_number: null, date: '2026-07-10', vatin: null, document_type: 'invoice' }, text: 'alt', note: 'Gmail: muster · Betrag 23,45 € stimmt', plain_note: null, candidates: [], failed: [] } })
    const s = setup({ line: earlier, claims: [{ key: 'gmail:msg-old:1', bank_line_id: LINE_ID, label: '' }] })
    const r = await run(s, gmail({}).deps)
    assert.ok(r.status === 'searched' && !r.attached)
    const line = s.world.line
    assert.deepEqual([line.receipt_path, line.receipt_search?.chosen?.message_id, line.receipt_search?.check, line.receipt_search?.note],
      [`${LINE_ID}/gmail-old-Rechnung.pdf`, 'msg-old', 'amount', 'Gmail: muster · Betrag 23,45 € stimmt'])
    assert.notEqual(line.receipt_search?.at, NOW)
    assert.deepEqual([s.storage.removes, s.steps[0].p_keys, s.world.claims?.length], [[], null, 1])
  })
  test('the text kept is capped generously (the invoice address may stand far down); a file name is made safe for the path', () => {
    assert.equal(RECEIPT_TEXT_MAX, 50_000)
    assert.equal(storedName('Rechnung 05/2026 (Kopie).pdf'), 'Rechnung_05_2026_Kopie_.pdf')
    assert.equal(storedName('///'), '_')
  })
})

describe('attachGmailCandidate — „Anhängen“ of a PDF the search found', () => {
  const listedLine = (o: Partial<BankLine> = {}) => bankLine({
    receipt_search: {
      at: NOW, chosen: null, check: null, read: null, text: null, note: null, plain_note: null, failed: [],
      candidates: [{ message_id: 'msg-c1', part_id: '2', file_name: 'Rechnung_Juli.pdf', subject: 'Ihre Rechnung', from: 'Muster GmbH <rechnung@muster.example>', date: 'Wed, 15 Jul 2026 08:00:00 +0200', size: 2048, amount: 25, currency: null, foreign_total: null, invoice_number: null, why: 'amount', found_by: { sender: 'rechnung@muster.example', rule_ids: ['r-tel'] } }],
    },
    ...o,
  })
  const deps = (over: Partial<AttachDeps> = {}): AttachDeps => ({
    fetchPdf: async () => ({ base64: bytesOf('c1'), filename: 'Rechnung_Juli.pdf' }),
    pdfText: async () => ({ text: 'Muster GmbH Rechnung', pages: 1 }),
    readPdf: async () => ({ ...NOTHING, amount: 25, invoice_number: '910000000999', date: '2026-07-14', document_type: 'invoice' }),
    ...over,
  })
  test('fetched, read, copied, claimed and kept as the owner’s in one step; the search’s own receipt replaced, its list kept', async () => {
    const s = setup({ line: listedLine() })
    const out = await attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: s.storage })
    assert.match(out.path, new RegExp(`^${LINE_ID}/gmail-[0-9a-f]{8}-[0-9a-f]{8}-Rechnung_Juli\\.pdf$`))
    assert.deepEqual(s.storage.uploads, [out.path])
    assert.deepEqual(s.writes, ['claims 3', 'line receipt'])
    const line = s.world.line
    assert.equal(line.receipt_gmail?.candidate.message_id, 'msg-c1')
    assert.deepEqual(line.receipt_gmail?.extracted, { invoice_number: '910000000999', date: '2026-07-14', amount: 25 })
    assert.equal(line.receipt_gmail?.unreadable, false)
    assert.deepEqual([line.receipt_search?.chosen, line.receipt_search?.note], [null, null])
    assert.equal(line.receipt_search?.candidates.length, 1)
  })
  test('an e-mail that is only a PDF (its part \'\'): attached as any other', async () => {
    const line = listedLine()
    line.receipt_search!.candidates[0] = { ...line.receipt_search!.candidates[0], part_id: '' }
    const s = setup({ line })
    await attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '', deps(), { storage: s.storage })
    assert.equal(s.world.line.receipt_gmail?.candidate.part_id, '')
  })
  test('not in the line’s list, no PDF, another line’s: refused, its copy gone, nothing kept', async () => {
    const s = setup({ line: listedLine() })
    await assert.rejects(attachGmailCandidate(s.db.client, LINE_ID, 'msg-zz', '1', deps(), { storage: s.storage }), (e: unknown) => e instanceof ReceiptError && e.code === 'not_listed' && e.status === 404)
    await assert.rejects(attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps({ fetchPdf: async () => ({ base64: Buffer.from('GIF89a').toString('base64'), filename: 'x.pdf' }) }), { storage: s.storage }),
      (e: unknown) => e instanceof ReceiptError && e.code === 'not_attachable' && e.status === 400)
    const held = setup({ line: listedLine(), claims: [{ key: 'gmail:msg-c1:2', bank_line_id: OTHER_ID, label: '02.07.2026 · Muster · 25,00 €' }] })
    await assert.rejects(attachGmailCandidate(held.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: held.storage }),
      (e: unknown) => e instanceof ReceiptError && e.code === 'claimed' && e.message === RECEIPT_TEXT.claimed('02.07.2026 · Muster · 25,00 €'))
    assert.deepEqual([s.storage.uploads, held.storage.removes, held.world.line.receipt_gmail], [[], [held.storage.uploads], null])
  })
  test('over a Beleg uploaded by hand: refused (remove it first); over one from Gmail: replaced and its copy removed', async () => {
    const hand = setup({ line: listedLine({ receipt_path: `${LINE_ID}/Beleg.pdf`, receipt_name: 'Beleg.pdf' }) })
    await assert.rejects(attachGmailCandidate(hand.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: hand.storage }),
      (e: unknown) => e instanceof ReceiptError && e.code === 'not_attachable' && e.status === 409 && e.message === RECEIPT_TEXT.handReceipt)
    assert.deepEqual([hand.storage.uploads, hand.steps], [[], []])
    const fromSearch = listedLine({ receipt_path: `${LINE_ID}/gmail-old-R.pdf`, receipt_name: 'R.pdf' })
    fromSearch.receipt_search!.chosen = { message_id: 'msg-old', part_id: '1', file_name: 'R.pdf', subject: 's', from: 'f', date: null, sha256: 'x', via: { kind: 'keyword', name: 'x' } }
    const g = setup({ line: fromSearch })
    await attachGmailCandidate(g.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: g.storage })
    assert.deepEqual(g.storage.removes, [[`${LINE_ID}/gmail-old-R.pdf`]])
  })
  test('a step that throws: its copy goes unless the line holds it (verifier finding, PR 9b)', async () => {
    const failed = setup({ line: listedLine(), stepThrows: 'before' })
    await assert.rejects(attachGmailCandidate(failed.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: failed.storage }), (e: unknown) => e instanceof BookamatError && e.code === 'database')
    assert.deepEqual(failed.storage.removes, [failed.storage.uploads])
    const lost = setup({ line: listedLine(), stepThrows: 'after' })
    await assert.rejects(attachGmailCandidate(lost.db.client, LINE_ID, 'msg-c1', '2', deps(), { storage: lost.storage }))
    assert.deepEqual([lost.storage.removes, lost.world.line.receipt_path], [[], lost.storage.uploads[0]])
  })
  test('the reader failing (or no key): attached all the same, its data not read', async () => {
    const s = setup({ line: listedLine() })
    await attachGmailCandidate(s.db.client, LINE_ID, 'msg-c1', '2', deps({ readPdf: async () => null }), { storage: s.storage })
    assert.equal(s.world.line.receipt_gmail?.unreadable, true)
  })
})

describe('setHandReceipt — a Beleg by hand in its place, or none', () => {
  test('in one step: the claims go, a receipt from Gmail is forgotten with what was said of it, its list stays', async () => {
    const search: BankLineReceiptSearch = { at: NOW, chosen: { message_id: 'msg-a1', part_id: '1', file_name: 'R.pdf', subject: 's', from: 'f', date: null, sha256: null, via: { kind: 'keyword', name: 'x' } }, check: 'amount', read: null, text: 't', note: 'n', plain_note: 'p', candidates: [], failed: [] }
    const s = setup({ line: bankLine({ receipt_path: `${LINE_ID}/gmail-x-R.pdf`, receipt_search: search }), claims: [{ key: 'gmail:msg-a1:1', bank_line_id: LINE_ID, label: '' }] })
    assert.deepEqual(await setHandReceipt(s.db.client, s.world.line, { path: `${LINE_ID}/Beleg.pdf`, name: 'Beleg.pdf' }), { status: 'ok' })
    const line = s.world.line
    assert.deepEqual([line.receipt_path, line.receipt_gmail, s.world.claims], [`${LINE_ID}/Beleg.pdf`, null, []])
    assert.deepEqual([line.receipt_search?.chosen, line.receipt_search?.check, line.receipt_search?.text, line.receipt_search?.note, line.receipt_search?.plain_note], [null, null, null, null, null])
    // refused while the line changed (booked, an attempt open, its receipt another)
    const late = setup({ line: bankLine({ status: 'booked' }) })
    assert.deepEqual(await setHandReceipt(late.db.client, late.world.line, null), { status: 'changed' })
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
  // Two rules of one sender that fit equally, told apart by the invoice address on the receipt
  const TIE = [
    rule({ id: 'r-buero', name: 'Telefon Büro', invoice_address_match: 'Musterweg 1' }),
    rule({ id: 'r-studio', name: 'Telefon Studio', invoice_address_match: 'Beispielgasse 2' }),
  ]
  const tieRow = (line: BankLine) => {
    const built = lineRow(line, vendorsOf(TIE, null), null)
    return built.kind === 'expense' ? built.row : (null as never)
  }
  const fromList = (text: string | null, ruleIds: string[]) => ({
    candidate: { message_id: 'msg-c1', part_id: '2', file_name: 'Rechnung.pdf', subject: 'Ihre Rechnung', from: 'rechnung@muster.example', date: null, size: 1, amount: 23.45, currency: null, foreign_total: null, invoice_number: null, why: 'unchecked' as const, found_by: { sender: 'rechnung@muster.example', rule_ids: ruleIds } },
    name: 'Rechnung.pdf', extracted: { amount: 23.45 }, unreadable: false, sha256: 'x', text,
  })
  test('a PDF of the list attached: its invoice address decides between rules that tie, as Bookmatic’s „Anhängen“ did', () => {
    const open = tieRow(bankLine())
    assert.equal(open.vendor, null)
    const decided = tieRow(bankLine({ receipt_path: `${LINE_ID}/gmail-x-R.pdf`, receipt_gmail: fromList('Rechnung an Konrad Testmann, Beispielgasse 2, 1020 Wien', ['r-buero', 'r-studio']) }))
    assert.deepEqual([decided.vendor?.id, decided.rule_pick, decided.gmail_message_id], ['r-studio', 'address', 'msg-c1'])
    // a scan (no text): nothing decided by it
    assert.equal(tieRow(bankLine({ receipt_path: `${LINE_ID}/gmail-x-R.pdf`, receipt_gmail: fromList(null, ['r-buero', 'r-studio']) })).vendor, null)
  })
  test('the rule the owner picks comes after the receipt: a receipt the picked rule’s sender did not send drops out, and is not attached', () => {
    // the two rules with senders of their own (one sender's receipt counts for every rule it sends for)
    const OWN_SENDERS = [TIE[0], { ...TIE[1], email_sender: 'office@beispiel.example' }]
    const rowOwn = (line: BankLine) => {
      const built = lineRow(line, vendorsOf(OWN_SENDERS, null), null)
      return built.kind === 'expense' ? built.row : (null as never)
    }
    const line = bankLine({ receipt_path: `${LINE_ID}/gmail-x-R.pdf`, receipt_gmail: fromList(null, ['r-buero']), review: { rule_id: 'r-studio' } })
    const row = rowOwn(line)
    assert.deepEqual([row.vendor?.id, row.gmail_message_id], ['r-studio', null])
    assert.equal(receiptKept(line, row), false)
    // picked the rule whose sender sent it: kept
    const own = bankLine({ ...line, review: { rule_id: 'r-buero' } })
    assert.equal(receiptKept(own, rowOwn(own)), true)
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
    assert.match(search, /searchDeps\(s, supabase, \{ dryRun \}\), \{\n\s+dryRun, auto: body\.auto === true, expensesFrom: s\.expenses_from \?\? null, accountGate: receiptAccountGate\(s\), startedAt,/)
    // A dry run writes nothing: no Google error recorded (its token is not written back either)
    assert.match(search, /if \(gmailError && !dryRun\) await recordGmailError\(gmailError, supabase, s\.id\)/)
    // „Anhängen“ checks the account as the search does, within its deadline
    assert.match(route('attach/route.ts'), /const signal = AbortSignal\.timeout\(ATTACH_DEADLINE_MS\)\n\s+return NextResponse\.json\(await attachGmailCandidate\(supabase, id, messageId, partId as string \| null, attachDeps\(s, supabase, signal\), \{ accountGate: receiptAccountGate\(s\) \}\)\)/)
    // An e-mail that is only a PDF: its part '' kept
    assert.match(route('attach/route.ts'), /\/\^\[\\w\.-\]\{0,40\}\$\//)
    assert.match(route('preview/route.ts'), /const partId = req\.nextUrl\.searchParams\.get\('part_id'\)\n/)
    // Only what the line's list names is shown or attached
    assert.match(route('preview/route.ts'), /const c = \(search\?\.candidates \?\? \[\]\)\.find\(/)
  })
})
