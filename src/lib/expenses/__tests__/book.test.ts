import './owner'
// Booking statement lines (PR 9a) against a stand-in Supabase and a stand-in Bookamat: what is
// posted, what holds a line (a booking Bookamat has, a check that cannot run, a problem, an open
// rule choice), the self-heal of a refused booking, the journal and the lost answer.
// Made-up accounts, names, IBANs, amounts and credentials only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeSupabase, hasFilter, type Op } from '@/lib/__tests__/fake-supabase'
import { bookLines, CHECK_FAILED, discardLinePending, forgetLineBooking, INVOICE_PAYMENT_TEXT, type LineSettings } from '../book'
import type { BankLine, BankLinePending, BookingRule } from '@/types'

const OWN = 'AT611904300234573201'
const settings = {
  id: 's1', ui_language: 'de', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 41, bookamat_cash_account_id: null, bookamat_cost_account_id: 12, bookamat_vat_account_0: null,
  bookamat_vat_account_rc: null, bookamat_vat_account_non_eu: null, bookamat_vat_account_10: null, bookamat_vat_account_13: null,
  bookamat_vat_account_20: null, bookamat_accounts_year: 2026, bookamat_auto_sync: false,
  owner_name: 'Konrad Testmann', uid_number: 'ATU12345675', iban: OWN, own_ibans: ['AT990000000000000777'],
} as unknown as LineSettings

const rule = (o: Partial<BookingRule> & Pick<BookingRule, 'id' | 'name' | 'match_strings'>): BookingRule => ({
  active: true, category: '', email_sender: '', email_body_keywords: [], cost_account: 'Miete und Pacht', tax_account: 'Vorsteuer Inland',
  bank_account: '', tax_percent: 20, ba_amount: 100, ba_tax: 100, country: '', vatin: '', title_template: `${o.name} {month_short}`,
  notes_template: '', amount_min: null, amount_max: null, invoice_address_match: '', skip_receipt: true,
  created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', ...o,
})
const RULES = [
  rule({ id: 'r-rent', name: 'Studio Miete', match_strings: ['HAUSMANN PETER'] }),
  rule({ id: 'r-tel-a', name: 'Telefon Büro', match_strings: ['MUSTER TELEKOM'], cost_account: 'Internet' }),
  rule({ id: 'r-tel-b', name: 'Telefon Studio', match_strings: ['MUSTER TELEKOM'], cost_account: 'Internet' }),
  rule({ id: 'r-soft', name: 'Software Abo', match_strings: ['MUSTER SOFTWARE'], cost_account: 'Lizenzgebühren', skip_receipt: false }),
]

const bankLine = (id: string, text: string, amount: number, o: Partial<BankLine> = {}): BankLine => ({
  id, line_key: `key-${id}`, cells: [OWN, text, '15.06.2026', '15.06.2026', amount.toFixed(2).replace('.', ','), 'EUR'],
  statement_iban: OWN, booked_on: '2026-06-15', value_on: '2026-06-15', amount, currency: 'EUR', counterparty: '', bank_text: text, fee: null,
  status: 'open', review: {}, receipt_path: null, receipt_name: null, bookamat_claim: null, bookamat_pending: null,
  created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', ...o,
})
const RENT = bankLine('l-rent', 'Abbuchung Dauerauftrag BG/000000651|BKAUATWWXXX AT000000000000000002 Hausmann Peter|Miete Juni', -700)

type World = {
  lines: BankLine[]
  // Bookamat's bookings in the window, or 'fail'
  window?: unknown[] | 'fail'
  // What Bookamat answers a search by title and date with
  titled?: unknown[]
  // What each post answers, in order: 'ok', 'timeout', or a 400's body
  posts?: ('ok' | 'timeout' | object)[]
  invoicePaid?: string[]
  claimTaken?: boolean
  pending?: BankLinePending | null
  recorded?: { year: number; booking_id: string; bank_line_id: string | null }[]
  live?: 'deleted' | 'missing' | 'live'
}

const savedEnv = process.env.VERCEL_ENV
const realFetch = globalThis.fetch
let log: string[] = []
let posted: { title: string; date: string; amounts: { costaccount: number; purchasetaxaccount?: number; bankaccount: number; amount: string; deductibility_amount_percent?: string }[] }[] = []
beforeEach(() => { process.env.VERCEL_ENV = 'production'; log = []; posted = [] })
afterEach(() => {
  if (savedEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = savedEnv
  globalThis.fetch = realFetch
})

const ACCOUNTS: Record<string, unknown[]> = {
  'preferences/costaccounts/?group=2': [
    { id: 11, name: 'Lizenzgebühren', group: '2', purchasetaxaccounts: [{ id: 21, name: 'Vorsteuer Inland' }, { id: 22, name: 'IG Erwerb von Leistungen' }] },
    { id: 12, name: 'Miete und Pacht', group: '2', purchasetaxaccounts: [{ id: 21, name: 'Vorsteuer Inland' }] },
    { id: 14, name: 'Internet', group: '2', purchasetaxaccounts: [{ id: 21, name: 'Vorsteuer Inland' }] },
  ],
  'preferences/costaccounts/?group=1': [{ id: 31, name: 'Privateinlagen (allgemein)', group: '1', deductibility_tax_percent: '0.00', deductibility_amount_percent: '0.00' }],
  'preferences/purchasetaxaccounts/': [
    { id: 21, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00'] }, { id: 22, name: 'IG Erwerb von Leistungen', group: '2' },
    { id: 23, name: 'Keine Vorsteuer', group: '2' }, { id: 24, name: 'Keine Umsatzsteuer', group: '1' },
  ],
  'preferences/bankaccounts/': [{ id: 40, name: 'Geschäftskonto - Musterbank' }, { id: 41, name: 'Geschäftskonto - Easybank', iban: OWN }],
}

function setup(world: World) {
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}${op.action === 'update' ? ` ${Object.keys(op.values as object).join(',')}` : ''}`)
    if (op.table === 'bank_lines' && op.action === 'select') {
      if (op.single) return { data: { bookamat_pending: world.pending ?? null } }
      return { data: world.lines }
    }
    if (op.table === 'booking_rules') return { data: RULES }
    if (op.table === 'payments') return { data: (world.invoicePaid ?? []).map(import_ref => ({ import_ref })) }
    if (op.table === 'bank_lines' && op.action === 'update' && op.returning) {
      const values = op.values as Record<string, unknown>
      if ('bookamat_claim' in values) return { data: world.claimTaken ? [] : [{ bookamat_pending: world.pending ?? null }] }
      return { data: [{ id: 'x' }] }
    }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      if (hasFilter(op, 'eq', 'bank_line_id')) return { data: (world.recorded ?? []).map(r => ({ year: r.year, booking_id: r.booking_id })) }
      if (op.columns === 'booking_id') return { data: (world.recorded ?? []).map(r => ({ booking_id: r.booking_id })) }
      return { data: world.recorded ?? [] }
    }
    return { error: null }
  })
  const posts = [...(world.posts ?? ['ok'])]
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.replace('https://www.bookamat.com/api/v1/at/2026/', '')
    log.push(`http ${method} ${path.replace(/&format=json|format=json&?|limit=100&?/g, '').replace(/[?&]$/, '')}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    for (const [prefix, list] of Object.entries(ACCOUNTS)) if (path.startsWith(prefix)) return json({ results: list, next: null })
    if (method === 'GET' && path.startsWith('bookings/?date_from=')) {
      if (world.window === 'fail') return new Response('{"detail":"Server error"}', { status: 500 })
      return json({ results: world.window ?? [], next: null })
    }
    if (method === 'GET' && path.startsWith('bookings/?title=')) return json({ count: (world.titled ?? []).length, next: null, results: world.titled ?? [] })
    if (method === 'GET' && /^bookings\/\d+\/\?/.test(path)) {
      if (world.live === 'missing') return new Response('{"detail":"Nicht gefunden."}', { status: 404 })
      return json({ id: 7001, status: world.live === 'deleted' ? '3' : '1' })
    }
    if (method === 'POST' && path === 'bookings/') {
      const next = posts.shift() ?? 'ok'
      if (next === 'timeout') throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
      if (next !== 'ok') return json(next, 400)
      posted.push(JSON.parse(String(init?.body)))
      return json({ id: 9000 + posted.length }, 201)
    }
    if (method === 'POST' && path === 'bookings/attachments/') return json({ id: 1 }, 201)
    throw new Error(`unexpected request ${method} ${url}`)
  }) as typeof fetch
  return db
}

test('a Buchungsregel\'s line is booked on the rule\'s accounts, by their titles, on the statement\'s own bank account', async () => {
  const db = setup({ lines: [RENT] })
  const [r] = await bookLines(db.client, settings, ['l-rent'])
  assert.equal(r.status, 'booked')
  assert.deepEqual(posted.map(p => p.amounts.map(a => [a.costaccount, a.purchasetaxaccount, a.bankaccount, a.amount])), [[[12, 21, 41, '700.00']]])
  assert.match(posted[0].title, /^Studio Miete /)
  // The journal is written before the post, the booking recorded on the line, the line marked
  const order = log.filter(l => /bank_lines update|POST bookings\/$|bookamat_bookings insert/.test(l))
  assert.deepEqual(order, [
    'db bank_lines update bookamat_claim', 'db bank_lines update bookamat_pending', 'http POST bookings/',
    'db bank_lines update bookamat_pending', 'db bookamat_bookings insert', 'db bank_lines update status,bookamat_pending,bookamat_claim',
    'db bank_lines update bookamat_claim',
  ])
  const insert = db.ops.find(o => o.table === 'bookamat_bookings' && o.action === 'insert')!
  assert.deepEqual(insert.values, { bank_line_id: 'l-rent', year: 2026, booking_id: '9001', amount: -700, kind: 'expense', booked_on: '2026-06-15' })
})

test('a booking Bookamat has of the payment holds the line; a check that cannot run books nothing', async () => {
  const booked = { id: 7001, title: 'Studio Miete Jun 26', date: '2026-06-15', amounts: [{ group: '2', amount: '700.00', tax_percent: '20.00' }] }
  let db = setup({ lines: [RENT], window: [booked] })
  const [held] = await bookLines(db.client, settings, ['l-rent'])
  assert.equal(held.status, 'duplicate')
  assert.equal(posted.length, 0)
  // Said not to be this payment („trotzdem buchen“): booked
  db = setup({ lines: [{ ...RENT, review: { ack_duplicate_ids: [7001] } }], window: [booked] })
  assert.equal((await bookLines(db.client, settings, ['l-rent']))[0].status, 'booked')
  db = setup({ lines: [RENT], window: 'fail' })
  posted = []
  const [failed] = await bookLines(db.client, settings, ['l-rent'])
  assert.equal(failed.status, 'error')
  assert.ok(failed.status === 'error' && failed.error.startsWith(CHECK_FAILED))
  assert.equal(posted.length, 0)
})

test('what the engine refuses is not posted: an open rule choice, a line without accounts', async () => {
  const tel = bankLine('l-tel', 'Abbuchung Lastschrift|MUSTER TELEKOM Rechnung 0626', -49.9)
  const unknown = bankLine('l-shop', 'Bezahlung Karte MC/000000902|Musterladen Wien', -12.4)
  const db = setup({ lines: [tel, unknown] })
  const [choice, empty] = await bookLines(db.client, settings, ['l-tel', 'l-shop'])
  assert.equal(choice.status, 'error')
  assert.equal(empty.status, 'error')
  assert.ok(empty.status === 'error' && empty.error.startsWith('Nicht gebucht — '))
  assert.equal(posted.length, 0)
  // Picked by the owner: booked on that rule
  const picked = setup({ lines: [{ ...tel, review: { rule_id: 'r-tel-b' } }] })
  assert.equal((await bookLines(picked.client, settings, ['l-tel']))[0].status, 'booked')
  assert.deepEqual(posted[0].amounts.map(a => a.costaccount), [14])
  assert.match(posted[0].title, /^Telefon Studio /)
})

test('a refused booking is healed where Bookamat names the cause, and every correction is said', async () => {
  const blocked = { amounts: [{ non_field_errors: ['Deductibility amount percent is blocked for this account.'] }] }
  const db = setup({ lines: [RENT], posts: [blocked, 'ok'] })
  const [r] = await bookLines(db.client, settings, ['l-rent'])
  assert.equal(r.status, 'booked')
  assert.ok(r.status === 'booked' && r.corrections.length === 1 && r.corrections[0].startsWith('BA Betrag auf 0 % gesetzt'))
  assert.equal(posted[0].amounts[0].deductibility_amount_percent, '0.00')
  // Refused without a cure: the refusal is the answer, the journal goes
  const other = setup({ lines: [RENT], posts: [{ non_field_errors: ['Something else entirely.'] }] })
  const [refused] = await bookLines(other.client, settings, ['l-rent'])
  assert.equal(refused.status, 'error')
  assert.ok(log.includes('db bank_lines update bookamat_pending'))
})

test('a lost answer keeps the journal; the next attempt records what Bookamat has instead of posting again', async () => {
  const db = setup({ lines: [RENT], posts: ['timeout'] })
  const [lost] = await bookLines(db.client, settings, ['l-rent'])
  assert.ok(lost.status === 'error' && lost.code === 'unconfirmed')
  assert.ok(!db.ops.some(o => o.table === 'bookamat_bookings' && o.action === 'insert'))
  const pending: BankLinePending = { year: 2026, kind: 'expense', booking_id: null, amount: -700, date: '2026-06-15', title: 'Studio Miete Jun 26', at: '2026-11-17T10:00:00Z' }
  const again = setup({ lines: [{ ...RENT, bookamat_pending: pending }], pending, titled: [{ id: 9101, title: pending.title, date: pending.date, status: '1' }] })
  const [recovered] = await bookLines(again.client, settings, ['l-rent'])
  assert.deepEqual([recovered.status, recovered.status === 'booked' && recovered.bookingId, recovered.status === 'booked' && recovered.recovered], ['booked', '9101', true])
  assert.equal(posted.length, 0)
})

test('a credit recorded on an invoice, a refund, a booked or skipped line: not booked here', async () => {
  const credit = bankLine('l-in', 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|RN-209906001', 840)
  const refund = bankLine('l-ref', 'Gutschrift Überweisung|MUSTER SOFTWARE Rückerstattung', 29.99)
  const db = setup({ lines: [credit, refund, { ...RENT, status: 'booked' }, { ...RENT, id: 'l-skip', status: 'skipped' }], invoicePaid: ['key-l-in'] })
  const results = await bookLines(db.client, settings, ['l-in', 'l-ref', 'l-rent', 'l-skip'])
  assert.deepEqual(results.map(r => r.status), ['skipped', 'skipped', 'skipped', 'skipped'])
  assert.ok(results[0].status === 'skipped' && results[0].reason === INVOICE_PAYMENT_TEXT)
  assert.equal(posted.length, 0)
})

test('a dry run posts and claims nothing; a line another attempt holds is not booked twice', async () => {
  const db = setup({ lines: [RENT] })
  const [dry] = await bookLines(db.client, settings, ['l-rent'], { dryRun: true })
  assert.equal(dry.status, 'dry_run')
  assert.ok(!db.ops.some(o => o.action === 'update'))
  const held = setup({ lines: [RENT], claimTaken: true })
  const [busy] = await bookLines(held.client, settings, ['l-rent'])
  assert.ok(busy.status === 'error' && busy.code === 'in_progress')
  assert.equal(posted.length, 0)
})

test('„Buchung vergessen“ only once Bookamat no longer has the booking; an open attempt is discarded only when Bookamat has none', async () => {
  const recorded = [{ year: 2026, booking_id: '7001', bank_line_id: 'l-rent' }]
  let db = setup({ lines: [], recorded, live: 'live' })
  await assert.rejects(forgetLineBooking(db.client, settings, 'l-rent'), /delete it there first/)
  db = setup({ lines: [], recorded, live: 'deleted' })
  assert.deepEqual(await forgetLineBooking(db.client, settings, 'l-rent'), { forgotten: '7001' })
  assert.ok(db.ops.some(o => o.table === 'bookamat_bookings' && o.action === 'delete'))
  db = setup({ lines: [], recorded, live: 'missing' })
  assert.deepEqual(await forgetLineBooking(db.client, settings, 'l-rent'), { forgotten: '7001' })

  const pending: BankLinePending = { year: 2026, kind: 'expense', booking_id: null, amount: -700, date: '2026-06-15', title: 'Studio Miete Jun 26', at: '2026-11-17T10:00:00Z' }
  db = setup({ lines: [], pending, titled: [{ id: 9101, title: pending.title, date: pending.date, status: '1' }] })
  await assert.rejects(discardLinePending(db.client, settings, 'l-rent'), /book the line again/)
  db = setup({ lines: [], pending, titled: [] })
  assert.deepEqual(await discardLinePending(db.client, settings, 'l-rent'), { discarded: true })
})
