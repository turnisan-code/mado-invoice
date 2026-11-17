import './owner'
// Booking statement lines (PR 9a) against a stand-in Supabase and a stand-in Bookamat: what is
// posted, what holds a line (a booking Bookamat has, a check that cannot run, a problem, an open
// rule choice, the switch-over, an account that is no business account), the self-heal of a
// refused booking, the journal, the lost answer, and what the page showed being what is booked.
// Made-up accounts, names, IBANs, amounts and credentials only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeSupabase, hasFilter, type Op } from '@/lib/__tests__/fake-supabase'
import { bookLines, CHECK_FAILED, discardLinePending, forgetLineBooking, INVOICE_PAYMENT_TEXT, type LineResult, type LineSettings } from '../book'
import { payloadFingerprint } from '../fingerprint'
import type { BankLine, BankLinePending, BookingRule } from '@/types'

const OWN = 'AT611904300234573201'
const SETTINGS = {
  id: 's1', ui_language: 'de', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 41, bookamat_cash_account_id: null, bookamat_cost_account_id: 12, bookamat_vat_account_0: null,
  bookamat_vat_account_rc: null, bookamat_vat_account_non_eu: null, bookamat_vat_account_10: null, bookamat_vat_account_13: null,
  bookamat_vat_account_20: null, bookamat_accounts_year: 2026, bookamat_auto_sync: false,
  owner_name: 'Konrad Testmann', uid_number: 'ATU12345675', iban: OWN, own_ibans: ['AT990000000000000777'], expenses_from: '2026-01-01',
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

const bankLine = (id: string, text: string, amount: number, o: Partial<BankLine> = {}, iban = OWN, currency = 'EUR'): BankLine => ({
  id, line_key: `key-${id}`, cells: [iban, text, '15.06.2026', '15.06.2026', amount.toFixed(2).replace('.', ','), currency],
  statement_iban: iban, booked_on: '2026-06-15', value_on: '2026-06-15', amount, currency, counterparty: '', bank_text: text, fee: null,
  status: 'open', review: {}, receipt_path: null, receipt_name: null, receipt_search: null, receipt_gmail: null, bookamat_claim: null, bookamat_pending: null,
  created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z', ...o,
})
const RENT_TEXT = 'Abbuchung Dauerauftrag BG/000000651|BKAUATWWXXX AT000000000000000002 Hausmann Peter|Miete Juni'
const RENT = bankLine('l-rent', RENT_TEXT, -700)
const booking = (id: number, title: string, amount: string, group = '2', date = '2026-06-15') => ({ id, title, date, amounts: [{ group, amount, tax_percent: '20.00' }] })
const OLD = '2026-06-20T10:00:00Z' // long enough ago: an answer lost then is taken as never arrived
const pendingOf = (o: Partial<BankLinePending> = {}): BankLinePending =>
  ({ year: 2026, kind: 'expense', booking_id: null, amount: -700, date: '2026-06-15', title: 'Studio Miete 06/2026', at: OLD, ...o })

type World = {
  lines: BankLine[]
  // Bookamat's bookings in the window, 'fail' (a 500), or 'garbage' (an answer that is no list)
  window?: unknown[] | 'fail' | 'garbage'
  // What Bookamat answers a search by title and date with
  titled?: unknown[]
  // What each post answers, in order: 'ok', 'timeout', '502', or a 400's body
  posts?: ('ok' | 'timeout' | '502' | object)[]
  invoicePaid?: string[]
  claimTaken?: boolean
  // The line as it is when read again by its id (its receipt changed meanwhile)
  now?: Partial<BankLine>
  pending?: BankLinePending | null
  // The ledger: bookings Mado recorded, on documents or lines
  recorded?: { year: number; booking_id: string; bank_line_id: string | null; document_id?: string | null; payment_id?: string | null }[]
  // Invoice payments by id, with the statement line the import recorded them from
  payments?: { id: string; import_ref: string | null }[]
  live?: 'deleted' | 'missing' | 'live'
  documents?: { type: 'invoice' | 'credit_note'; number: string }[]
  reopened?: boolean
}

const savedEnv = process.env.VERCEL_ENV
const realFetch = globalThis.fetch
let log: string[] = []
let posted: { title: string; date: string; country: string; amounts: { costaccount: number; purchasetaxaccount?: number; bankaccount: number; amount: string; deductibility_amount_percent?: string }[] }[] = []
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
  'preferences/costaccounts/?group=1': [
    { id: 31, name: 'Privateinlagen (allgemein)', group: '1', deductibility_tax_percent: '0.00', deductibility_amount_percent: '0.00' },
    { id: 32, name: 'Erlöse 20 %', group: '1', purchasetaxaccounts: [{ id: 25, name: 'Umsatzsteuer Inland' }] },
  ],
  'preferences/purchasetaxaccounts/': [
    { id: 21, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00'] }, { id: 22, name: 'IG Erwerb von Leistungen', group: '2' },
    { id: 23, name: 'Keine Vorsteuer', group: '2' }, { id: 24, name: 'Keine Umsatzsteuer', group: '1' }, { id: 25, name: 'Umsatzsteuer Inland', group: '1', tax_values: ['20.00'] },
  ],
  'preferences/bankaccounts/': [{ id: 40, name: 'Geschäftskonto - Musterbank' }, { id: 41, name: 'Geschäftskonto - Easybank', iban: OWN }],
}

function setup(world: World) {
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}${op.action === 'update' ? ` ${Object.keys(op.values as object).join(',')}` : ''}`)
    if (op.table === 'bank_lines' && op.action === 'select') {
      if (hasFilter(op, 'eq', 'status', 'open')) return { data: world.lines.filter(l => l.status === 'open') }
      // One line by its id, as it is now
      if (op.single === 'maybe' && hasFilter(op, 'eq', 'id')) {
        const line = world.lines.find(l => l.id === op.filters.find(f => f[0] === 'eq' && f[1] === 'id')![2])
        return { data: line ? { ...line, ...world.now } : null }
      }
      return { data: world.lines }
    }
    if (op.table === 'booking_rules') return { data: RULES }
    if (op.table === 'documents') return { data: world.documents ?? [] }
    if (op.table === 'payments' && hasFilter(op, 'in', 'id')) {
      const ids = op.filters.find(f => f[0] === 'in' && f[1] === 'id')![2] as string[]
      return { data: (world.payments ?? []).filter(p => ids.includes(p.id)) }
    }
    if (op.table === 'payments') return { data: (world.invoicePaid ?? []).map(import_ref => ({ import_ref })) }
    if (op.table === 'bank_lines' && op.action === 'update' && op.returning) {
      const values = op.values as Record<string, unknown>
      if (values.bookamat_claim) return { data: world.claimTaken ? [] : [{ bookamat_pending: world.pending ?? null }] }
      if (values.status === 'open') return { data: world.reopened === false ? [] : [{ id: 'x' }] }
      return { data: [{ id: 'x' }] }
    }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      const recorded = world.recorded ?? []
      if (hasFilter(op, 'eq', 'bank_line_id')) {
        const id = op.filters.find(f => f[0] === 'eq' && f[1] === 'bank_line_id')![2]
        return { data: recorded.filter(r => r.bank_line_id === id).map(r => ({ year: r.year, booking_id: r.booking_id, booked_on: '2026-06-15', amount: -700 })) }
      }
      if (hasFilter(op, 'in', 'year')) {
        // Page by page, as Supabase answers a range
        const range = op.filters.find(f => f[0] === 'range') as [string, number, number] | undefined
        return { data: range ? recorded.slice(range[1], range[2] + 1) : recorded }
      }
      if (op.columns === 'booking_id') return { data: recorded.map(r => ({ booking_id: r.booking_id })) }
      return { data: recorded }
    }
    return { error: null }
  })
  const posts = [...(world.posts ?? ['ok'])]
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.replace('https://www.bookamat.com/api/v1/at/2026/', '')
    log.push(`http ${method} ${path.split('?')[0]}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    for (const [prefix, list] of Object.entries(ACCOUNTS)) if (path.startsWith(prefix)) return json({ results: list, next: null })
    if (method === 'GET' && path.startsWith('bookings/?date_from=')) {
      if (world.window === 'fail') return new Response('{"detail":"Server error"}', { status: 500 })
      if (world.window === 'garbage') return new Response('<html>Wartung</html>', { status: 200 })
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
      if (next === '502') return new Response('{"detail":"Bad gateway"}', { status: 502 })
      if (next !== 'ok') return json(next, 400)
      posted.push(JSON.parse(String(init?.body)))
      return json({ id: 9000 + posted.length }, 201)
    }
    if (method === 'POST' && path === 'bookings/attachments/') return json({ id: 1 }, 201)
    throw new Error(`unexpected request ${method} ${url}`)
  }) as typeof fetch
  return db
}

const book = (db: ReturnType<typeof setup>, ids: string[], settings: LineSettings = SETTINGS, opts: Parameters<typeof bookLines>[3] = {}) =>
  bookLines(db.client, settings, ids.map(id => ({ id })), opts)
const journalWrites = (db: ReturnType<typeof setup>) =>
  db.ops.filter(o => o.table === 'bank_lines' && o.action === 'update' && 'bookamat_pending' in (o.values as object)).map(o => (o.values as { bookamat_pending: unknown }).bookamat_pending)
const isError = (r: LineResult, code: string) => r.status === 'error' && r.code === code

test('a Buchungsregel\'s line is booked on the rule\'s accounts, by their titles, on the statement\'s own bank account', async () => {
  const db = setup({ lines: [RENT] })
  const [r] = await book(db, ['l-rent'])
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

test('only as the page showed it: the fingerprint of the booking must be the server\'s own', async () => {
  const db = setup({ lines: [RENT] })
  const [dry] = await book(db, ['l-rent'], SETTINGS, { dryRun: true })
  assert.equal(dry.status, 'dry_run')
  const fingerprint = dry.status === 'dry_run' ? payloadFingerprint(dry.payload) : ''
  const stale = setup({ lines: [RENT] })
  const [changed] = await bookLines(stale.client, SETTINGS, [{ id: 'l-rent', fingerprint: '00000000' }])
  assert.ok(isError(changed, 'changed'))
  assert.equal(posted.length, 0)
  const fresh = setup({ lines: [RENT] })
  assert.equal((await bookLines(fresh.client, SETTINGS, [{ id: 'l-rent', fingerprint }]))[0].status, 'booked')
})

test('a booking Bookamat has of the payment holds the line; a check that cannot run books nothing', async () => {
  const booked = booking(7001, 'Studio Miete 06/2026', '700.00')
  let db = setup({ lines: [RENT], window: [booked] })
  const [held] = await book(db, ['l-rent'])
  assert.equal(held.status, 'duplicate')
  assert.equal(posted.length, 0)
  // Said not to be this payment („trotzdem buchen“): booked
  db = setup({ lines: [{ ...RENT, review: { ack_duplicate_ids: [7001] } }], window: [booked] })
  assert.equal((await book(db, ['l-rent']))[0].status, 'booked')
  for (const window of ['fail', 'garbage'] as const) {
    posted = []
    db = setup({ lines: [RENT], window })
    const [failed] = await book(db, ['l-rent'])
    assert.ok(failed.status === 'error' && failed.error.startsWith(CHECK_FAILED), window)
    assert.equal(posted.length, 0)
  }
  // A booking without its lines cannot be compared: the check fails rather than book
  db = setup({ lines: [RENT], window: [{ id: 7002, title: 'x', date: '2026-06-15' }] })
  assert.ok(isError((await book(db, ['l-rent']))[0], 'duplicate_check_failed'))
})

test('the page\'s check and the booking\'s agree: each booking to one line; a booking Mado recorded on another line is none of this one\'s', async () => {
  const twin = (id: string) => bankLine(id, RENT_TEXT, -700)
  const booked = booking(7001, 'Studio Miete 06/2026', '700.00')
  // Two open twins, one booking: it goes to the first (by date, then id); the second is booked
  let db = setup({ lines: [twin('l-a'), twin('l-b')], window: [booked] })
  const [b] = await book(db, ['l-b'])
  assert.equal(b.status, 'booked')
  db = setup({ lines: [twin('l-a'), twin('l-b')], window: [booked] })
  assert.equal((await book(db, ['l-a']))[0].status, 'duplicate')
  // The twin Mado booked itself: its booking is not the other's
  db = setup({ lines: [{ ...twin('l-a'), status: 'booked' }, twin('l-b')], window: [booked], recorded: [{ year: 2026, booking_id: '7001', bank_line_id: 'l-a' }] })
  assert.equal((await book(db, ['l-b']))[0].status, 'booked')
})

test('money Mado booked for a document is that document\'s, whatever the owner said', async () => {
  const credit = bankLine('l-in', 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|Honorar', 840,
    { review: { override: { revenue_account_id: '32', vat_account_id: '25', vat_percent: '20' }, ack_duplicate_ids: [8001] } })
  const db = setup({
    lines: [credit], window: [booking(8001, 'RN-209906001 – Agentur Beispiel GmbH', '840.00', '1')],
    recorded: [{ year: 2026, booking_id: '8001', bank_line_id: null, document_id: 'd1' }],
  })
  const [r] = await book(db, ['l-in'])
  assert.ok(isError(r, 'mado_booking'))
  assert.equal(posted.length, 0)
})

test('the ledger is read page by page: a booking recorded on a line after the first thousand is still that line\'s', async () => {
  const twin = (id: string) => bankLine(id, RENT_TEXT, -700)
  const many = Array.from({ length: 1000 }, (_, i) => ({ year: 2026, booking_id: String(50000 + i), bank_line_id: null, document_id: `d${i}` }))
  const db = setup({
    lines: [{ ...twin('l-a'), status: 'booked' }, twin('l-b')], window: [booking(7001, 'Studio Miete 06/2026', '700.00')],
    recorded: [...many, { year: 2026, booking_id: '7001', bank_line_id: 'l-a' }],
  })
  assert.equal((await book(db, ['l-b']))[0].status, 'booked')
  assert.ok(db.ops.filter(o => o.table === 'bookamat_bookings' && hasFilter(o, 'in', 'year')).length >= 2)
})

test('a booking of a payment the statement import recorded is that line\'s money, never another line\'s', async () => {
  const text = 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|Honorar'
  const other = bankLine('l-b', text, 840, { review: { override: { revenue_account_id: '32', vat_account_id: '25', vat_percent: '20' } } })
  // The twin the import recorded as an invoice's payment (its line sorts after the other)
  const paid = bankLine('l-z', text, 840)
  const world = (importRef: string | null): World => ({
    lines: [other, paid], window: [booking(8001, 'RN-209906001 – Agentur Beispiel GmbH', '840.00', '1')], invoicePaid: ['key-l-z'],
    recorded: [{ year: 2026, booking_id: '8001', bank_line_id: null, document_id: 'd1', payment_id: 'p1' }],
    payments: [{ id: 'p1', import_ref: importRef }],
  })
  assert.equal((await book(setup(world('key-l-z')), ['l-b']))[0].status, 'booked')
  // A payment recorded by hand: its booking may be this line's money, so the line is held
  posted = []
  assert.ok(isError((await book(setup(world(null)), ['l-b']))[0], 'mado_booking'))
  assert.equal(posted.length, 0)
})

test('the journal keeps the amount posted: a split a cent or two off the bank\'s amount is looked up by its own total', async () => {
  const split = { ...RENT, review: { lines: [{ label: 'Studio', amount_gross: 400.02, vat_percent: 20 }, { label: 'Lager', amount_gross: 300, vat_percent: 20 }] } }
  const db = setup({ lines: [split] })
  const [r] = await book(db, ['l-rent'])
  assert.equal(r.status, 'booked')
  assert.equal((journalWrites(db)[0] as BankLinePending).amount, -700.02)
})

test('what the engine refuses is not posted: an open rule choice, a line without accounts, one split line', async () => {
  const tel = bankLine('l-tel', 'Abbuchung Lastschrift|MUSTER TELEKOM Rechnung 0626', -49.9)
  const unknown = bankLine('l-shop', 'Bezahlung Karte MC/000000902|Musterladen Wien', -12.4)
  const split = { ...RENT, id: 'l-split', review: { lines: [{ label: 'Miete', amount_gross: 70, vat_percent: 20 }] } }
  const db = setup({ lines: [tel, unknown, split] })
  const [choice, empty, one] = await book(db, ['l-tel', 'l-shop', 'l-split'])
  assert.ok(isError(choice, 'rule_choice'))
  assert.ok(empty.status === 'error' && empty.error.startsWith('Nicht gebucht — '))
  assert.ok(isError(one, 'split'))
  assert.equal(posted.length, 0)
  // Picked by the owner: booked on that rule
  const picked = setup({ lines: [{ ...tel, review: { rule_id: 'r-tel-b' } }] })
  assert.equal((await book(picked, ['l-tel']))[0].status, 'booked')
  assert.deepEqual(posted[0].amounts.map(a => a.costaccount), [14])
  assert.match(posted[0].title, /^Telefon Studio /)
})

test('Mado books from the switch-over on, from a business account, in euros', async () => {
  let db = setup({ lines: [RENT] })
  assert.ok(isError((await book(db, ['l-rent'], { ...SETTINGS, expenses_from: null }))[0], 'not_switched'))
  db = setup({ lines: [RENT] })
  assert.ok(isError((await book(db, ['l-rent'], { ...SETTINGS, expenses_from: '2026-07-01' }))[0], 'before_switch'))
  db = setup({ lines: [bankLine('l-priv', RENT_TEXT, -700, {}, 'AT880000000000000123')] })
  assert.ok(isError((await book(db, ['l-priv']))[0], 'not_business_account'))
  db = setup({ lines: [bankLine('l-usd', RENT_TEXT, -700, {}, OWN, 'USD')] })
  assert.ok(isError((await book(db, ['l-usd']))[0], 'currency'))
  assert.equal(posted.length, 0)
  // His other business account counts
  db = setup({ lines: [bankLine('l-other', RENT_TEXT, -700, {}, 'AT990000000000000777')] })
  assert.equal((await book(db, ['l-other']))[0].status, 'booked')
})

test('a refused booking is healed where Bookamat names the cause — up to four corrections, every one said; the country first', async () => {
  const line = { ...RENT, review: { override: { country: 'XX' } } }
  const refusals = [
    { amounts: [{ non_field_errors: ['Deductibility amount percent is blocked for this account.'] }] },
    { amounts: [{ non_field_errors: ['Deductibility tax percent is blocked for this account.'] }] },
    { non_field_errors: ['Date invoice is required because of the selected purchasetax account.'] },
    { country: ['"XX" is not a valid choice.'] },
  ]
  const db = setup({ lines: [line], posts: [...refusals, 'ok'] })
  const [r] = await book(db, ['l-rent'])
  assert.equal(r.status, 'booked')
  assert.equal(r.status === 'booked' && r.corrections.length, 4)
  assert.deepEqual([posted[0].amounts[0].deductibility_amount_percent, posted[0].country], ['0.00', ''])
  // A country alias is corrected before the first post, and said
  const uk = setup({ lines: [{ ...RENT, review: { override: { country: 'uk' } } }] })
  const [first] = await book(uk, ['l-rent'])
  assert.ok(first.status === 'booked' && first.corrections[0] === 'Land „uk“ → „GB“')
  assert.equal(posted.at(-1)!.country, 'GB')
  // Refused without a cure: the refusal is the answer, the journal goes
  const other = setup({ lines: [RENT], posts: [{ non_field_errors: ['Something else entirely.'] }] })
  assert.equal((await book(other, ['l-rent']))[0].status, 'error')
  assert.equal(journalWrites(other).at(-1), null)
})

test('a lost answer keeps the journal — a 502 too; the next attempt records what Bookamat has, never within two minutes as never arrived', async () => {
  for (const post of ['timeout', '502'] as const) {
    const db = setup({ lines: [RENT], posts: [post] })
    const [lost] = await book(db, ['l-rent'])
    assert.ok(isError(lost, 'unconfirmed'), post)
    // What Bookamat said is kept for the owner
    if (post === '502') assert.ok(lost.status === 'error' && lost.error.includes('Bookamat 502') && lost.error.includes('Bad gateway'), lost.status === 'error' ? lost.error : '')
    assert.ok(!db.ops.some(o => o.table === 'bookamat_bookings' && o.action === 'insert'))
    assert.notEqual(journalWrites(db).at(-1), null, post)
  }
  // Bookamat has it (same title, date and amount): recorded, nothing posted again
  const pending = pendingOf()
  let db = setup({ lines: [{ ...RENT, bookamat_pending: pending }], pending, titled: [booking(9101, pending.title, '700.00')] })
  const [recovered] = await book(db, ['l-rent'])
  assert.deepEqual([recovered.status, recovered.status === 'booked' && recovered.bookingId, recovered.status === 'booked' && recovered.recovered], ['booked', '9101', true])
  assert.equal(posted.length, 0)
  // A booking of another amount under the same title and date is another payment's
  db = setup({ lines: [{ ...RENT, bookamat_pending: pending }], pending, titled: [booking(9102, pending.title, '6.00')] })
  const [again] = await book(db, ['l-rent'])
  assert.ok(again.status === 'booked' && again.bookingId !== '9102')
  assert.equal(posted.length, 1)
  // Sent a moment ago and not in Bookamat yet: not posted again
  posted = []
  const fresh = pendingOf({ at: new Date().toISOString() })
  db = setup({ lines: [{ ...RENT, bookamat_pending: fresh }], pending: fresh, titled: [] })
  assert.ok(isError((await book(db, ['l-rent']))[0], 'unconfirmed'))
  assert.equal(posted.length, 0)
})

test('nothing is claimed or posted in a run\'s last seconds; a line sent twice is booked once', async () => {
  let db = setup({ lines: [RENT] })
  const [late] = await book(db, ['l-rent'], SETTINGS, { deadline: Date.now() + 2000 })
  assert.ok(isError(late, 'timeout'))
  assert.ok(!db.ops.some(o => o.action === 'update'))
  db = setup({ lines: [RENT] })
  const results = await bookLines(db.client, SETTINGS, [{ id: 'l-rent' }, { id: 'l-rent' }])
  assert.deepEqual([results.length, posted.length], [1, 1])
})

test('a booking recorded on the line whose line was not marked: marked, nothing posted', async () => {
  const db = setup({ lines: [RENT], recorded: [{ year: 2026, booking_id: '7001', bank_line_id: 'l-rent' }] })
  const [r] = await book(db, ['l-rent'])
  assert.ok(r.status === 'booked' && r.recovered && r.bookingId === '7001')
  assert.equal(posted.length, 0)
})

test('a credit recorded on an invoice, a refund, a booked or skipped line: not booked here', async () => {
  const credit = bankLine('l-in', 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|RN-209906001', 840)
  const refund = bankLine('l-ref', 'Gutschrift Überweisung|MUSTER SOFTWARE Rückerstattung', 29.99)
  const db = setup({ lines: [credit, refund, { ...RENT, status: 'booked' }, { ...RENT, id: 'l-skip', status: 'skipped' }], invoicePaid: ['key-l-in'] })
  const results = await book(db, ['l-in', 'l-ref', 'l-rent', 'l-skip'])
  assert.deepEqual(results.map(r => r.status), ['skipped', 'skipped', 'skipped', 'skipped'])
  assert.ok(results[0].status === 'skipped' && results[0].reason === INVOICE_PAYMENT_TEXT)
  assert.equal(posted.length, 0)
})

test('a line naming a Mado invoice or credit note is that document\'s money: never booked here', async () => {
  const credit = bankLine('l-pay', 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|Zahlung RN-2099|06001', 840)
  const refund = bankLine('l-back', 'Abbuchung Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|GS-209906002', -120)
  const longer = bankLine('l-other', 'Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|RN-2099060011', 50)
  const db = setup({ lines: [credit, refund, longer], documents: [{ type: 'invoice', number: 'RN-209906001' }, { type: 'credit_note', number: 'GS-209906002' }] })
  const [pay, back, other] = await book(db, ['l-pay', 'l-back', 'l-other'])
  assert.ok(pay.status === 'skipped' && pay.reason.startsWith('Nennt RN-209906001 aus Mado — als Zahlung im Tab „Einnahmen“'))
  assert.ok(back.status === 'skipped' && back.reason.includes('Rückzahlung an der Gutschrift'))
  // A longer number is another one: this credit is the owner's to book (no Ertragskonto yet)
  assert.ok(isError(other, 'no_revenue_account'))
  assert.equal(posted.length, 0)
})

test('a preview writes nothing: no claim, no journal, no booking, no forget or discard; a dry run still reads', async () => {
  process.env.VERCEL_ENV = 'preview'
  const pending = pendingOf()
  const db = setup({ lines: [RENT, { ...RENT, id: 'l-held', bookamat_pending: pending }], pending })
  const refused = (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'preview'
  await assert.rejects(book(db, ['l-rent']), refused)
  await assert.rejects(forgetLineBooking(db.client, SETTINGS, 'l-rent'), refused)
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-held'), refused)
  assert.deepEqual(db.ops.filter(o => o.action !== 'select'), [])
  assert.ok(!log.some(l => l.startsWith('http POST')))
  assert.equal((await book(db, ['l-rent'], SETTINGS, { dryRun: true }))[0].status, 'dry_run')
  assert.deepEqual(db.ops.filter(o => o.action !== 'select'), [])
})

test('a dry run posts and claims nothing; a line another attempt holds is not booked twice', async () => {
  const db = setup({ lines: [RENT] })
  const [dry] = await book(db, ['l-rent'], SETTINGS, { dryRun: true })
  assert.equal(dry.status, 'dry_run')
  assert.ok(!db.ops.some(o => o.action === 'update'))
  const held = setup({ lines: [RENT], claimTaken: true })
  const [busy] = await book(held, ['l-rent'])
  assert.ok(isError(busy, 'in_progress'))
  assert.equal(posted.length, 0)
})

test('the claim holds the line only with the receipt it was loaded with: one put there meanwhile is „changed“, nothing booked', async () => {
  const claimOf = (db: ReturnType<typeof setup>) => db.ops.find(o => o.table === 'bank_lines' && o.action === 'update' && 'bookamat_claim' in (o.values as object))!
  const receiptFilters = (db: ReturnType<typeof setup>) => claimOf(db).filters.filter(f => String(f[1]).startsWith('receipt_'))
  const plain = setup({ lines: [RENT], claimTaken: true })
  const [busy] = await book(plain, ['l-rent'])
  assert.ok(isError(busy, 'in_progress'))
  assert.deepEqual(receiptFilters(plain), [['is', 'receipt_path', null], ['is', 'receipt_gmail', null], ['is', 'receipt_search', null]])
  const search = { at: '2026-11-17T08:00:00.000Z', chosen: null, check: null, read: null, text: null, note: null, plain_note: null, candidates: [], failed: [] }
  const loaded = { ...RENT, receipt_path: 'l-rent/Beleg.pdf', receipt_name: 'Beleg.pdf', receipt_search: search }
  const meanwhile = setup({ lines: [loaded], claimTaken: true, now: { receipt_path: 'l-rent/gmail-0000bbbb-33334444-R.pdf', receipt_search: { ...search, at: '2026-11-17T09:00:00.000Z' } } })
  const [changed] = await book(meanwhile, ['l-rent'])
  assert.ok(isError(changed, 'changed'), JSON.stringify(changed))
  assert.deepEqual(receiptFilters(meanwhile), [['eq', 'receipt_path', 'l-rent/Beleg.pdf'], ['is', 'receipt_gmail', null], ['eq', 'receipt_search->>at', search.at]])
  assert.equal(posted.length, 0)
})

test('„Buchung vergessen“ only once Bookamat no longer has the booking; a booked line without one is opened again', async () => {
  const recorded = [{ year: 2026, booking_id: '7001', bank_line_id: 'l-rent' }]
  let db = setup({ lines: [], recorded, live: 'live' })
  await assert.rejects(forgetLineBooking(db.client, SETTINGS, 'l-rent'), /zuerst dort löschen/)
  db = setup({ lines: [], recorded, live: 'deleted' })
  assert.deepEqual(await forgetLineBooking(db.client, SETTINGS, 'l-rent'), { forgotten: '7001' })
  assert.ok(db.ops.some(o => o.table === 'bookamat_bookings' && o.action === 'delete'))
  db = setup({ lines: [], recorded, live: 'missing' })
  assert.deepEqual(await forgetLineBooking(db.client, SETTINGS, 'l-rent'), { forgotten: '7001' })
  // An earlier forget that did not finish: the line is opened again; a line with nothing booked: not found
  db = setup({ lines: [], recorded: [] })
  assert.deepEqual(await forgetLineBooking(db.client, SETTINGS, 'l-rent'), { forgotten: null })
  db = setup({ lines: [], recorded: [], reopened: false })
  await assert.rejects(forgetLineBooking(db.client, SETTINGS, 'l-rent'), /keine Buchung zum Vergessen/)
})

test('an open attempt is discarded under the line\'s claim: never within two minutes, never while Bookamat has it — unless the owner checked', async () => {
  const pending = pendingOf()
  let db = setup({ lines: [], pending: pendingOf({ at: new Date().toISOString() }) })
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-rent'), /noch nicht bestätigt/)
  db = setup({ lines: [], pending, titled: [booking(9101, pending.title, '700.00')] })
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-rent'), /erneut buchen erfasst sie/)
  db = setup({ lines: [], pending, titled: [] })
  assert.deepEqual(await discardLinePending(db.client, SETTINGS, 'l-rent'), { discarded: true })
  // Two bookings Mado cannot tell apart: only the owner can, after looking in Bookamat
  db = setup({ lines: [], pending, titled: [booking(9101, pending.title, '700.00'), booking(9102, pending.title, '700.00')] })
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-rent'), /nicht eindeutig zu finden/)
  db = setup({ lines: [], pending, titled: [booking(9101, pending.title, '700.00'), booking(9102, pending.title, '700.00')] })
  assert.deepEqual(await discardLinePending(db.client, SETTINGS, 'l-rent', { force: true }), { discarded: true })
  // Accepted by Bookamat: never discarded, booked again it is recorded
  db = setup({ lines: [], pending: pendingOf({ booking_id: '9103' }) })
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-rent', { force: true }), /erneut buchen erfasst sie/)
  // Another tab holds the line
  db = setup({ lines: [], pending, claimTaken: true })
  await assert.rejects(discardLinePending(db.client, SETTINGS, 'l-rent'), /gerade gebucht/)
})
