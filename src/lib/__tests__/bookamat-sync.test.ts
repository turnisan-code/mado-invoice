// The sync looks in Bookamat before it posts (Bookmatic audit P0-2): money Bookamat already has
// from a booking Mado did not make is never booked again, and a search that fails books nothing.
// A stand-in database and a stand-in Bookamat log every call in one sequence. Synthetic data only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { autoSyncBookamat, resetBookamatSync, syncBookamatDocument, type BookamatSettings } from '@/lib/bookamat'
import { fakeSupabase, hasFilter, type Op } from './fake-supabase'

const DOC = '00000000-0000-4000-8000-000000000001'
const P1 = '00000000-0000-4000-8000-0000000000b1'
const P2 = '00000000-0000-4000-8000-0000000000b2'
const settings = {
  id: 's1', ui_language: 'de', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 11, bookamat_cash_account_id: null, bookamat_cost_account_id: 22, bookamat_vat_account_0: 30,
  bookamat_vat_account_rc: 31, bookamat_vat_account_non_eu: 32, bookamat_vat_account_10: 33, bookamat_vat_account_13: 34,
  bookamat_vat_account_20: 88, bookamat_accounts_year: 2026, bookamat_auto_sync: false,
} as unknown as BookamatSettings

const doc = {
  id: DOC, type: 'invoice', number: 'RN-209906001', status: 'paid', currency: 'EUR', date: '2026-06-01',
  service_date: null, service_date_end: null, tax_treatment: 'at_vat', discount_type: null, discount_value: null,
  document_items: [{ line_type: 'item', sort_order: 0, quantity: 1, unit_price: 700, vat_rate: 20, discount_type: null, discount_value: null }],
  payments: [{ id: P1, date: '2026-06-15', amount: 840, kind: 'payment', method: 'bank' }] as { id: string; date: string; amount: number; kind: string; method: string }[],
  clients: { name: 'Muster Client', company: null, uid_number: null },
  bookamat_pending: null, bookamat_bookings: [] as unknown[],
}

const income = (id: number, date: string, title: string, amount: string) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '1', amount }] })

type World = {
  // A year's bookings as Bookamat lists them; 'fail' answers 500, 'missing' 404.
  years?: Record<number, unknown[] | 'fail' | 'missing'>
  // `on: 'line'`: recorded on a statement line (PR 9a), not on a document
  recordedElsewhere?: { year: number; booking_id: string; on?: 'line' }[]
  // What a post answers: 'ok' (default) or a 502 from a gateway
  postAnswer?: 'ok' | '502'
  // Another sync took the claim over before the journal was written.
  claimLost?: boolean
  payments?: typeof doc.payments
  status?: string
  // What the document has recorded already.
  bookings?: unknown[]
  // The journal an earlier attempt left (documents.bookamat_pending).
  pending?: unknown[]
  // What Bookamat answers a search by title and date with.
  titled?: unknown[]
  // Booking ids some document has recorded (the lost-answer lookup skips them).
  taken?: string[]
}

const saved = process.env.VERCEL_ENV
const realFetch = globalThis.fetch
let log: string[] = []
// What was posted to Bookamat, in order.
let bodies: { title: string; date: string; description: string; amounts: { amount: string; tax_percent: string }[] }[] = []
beforeEach(() => { process.env.VERCEL_ENV = 'production'; log = []; bodies = [] })
afterEach(() => {
  if (saved === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = saved
  globalThis.fetch = realFetch
})

function setup(world: World) {
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}${op.action === 'update' ? ` ${Object.keys(op.values as object).join(',')}` : ''}`)
    if (op.table === 'documents' && op.action === 'select') {
      return { data: { ...doc, payments: world.payments ?? doc.payments, status: world.status ?? doc.status, bookamat_bookings: world.bookings ?? [], bookamat_pending: world.pending ?? null } }
    }
    if (op.table === 'documents' && op.action === 'update' && op.returning) {
      const journal = 'bookamat_pending' in (op.values as object)
      return { data: journal && world.claimLost ? [] : [{ bookamat_pending: journal ? null : world.pending ?? null }] }
    }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      if (op.columns === 'booking_id') return { data: (world.taken ?? []).map(booking_id => ({ booking_id })) }
      const elsewhere = (world.recordedElsewhere ?? []).filter(r => !(hasFilter(op, 'not', 'document_id') && r.on === 'line'))
      return { data: op.columns === 'year, booking_id' ? elsewhere : [] }
    }
    return { error: null }
  })
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.replace('https://www.bookamat.com/api/v1/at/', '')
    log.push(`http ${method} ${path}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (path.includes('preferences/bankaccounts/')) return json({ results: [{ id: 11, title: 'Geschäftskonto' }], next: null })
    if (path.includes('preferences/costaccounts/')) return json({ results: [{ id: 22, title: 'Einnahmen' }], next: null })
    if (path.includes('preferences/purchasetaxaccounts/')) return json({ results: [{ id: 88, title: 'Umsatzsteuer Inland' }], next: null })
    const yearRead = method === 'GET' ? path.match(/^(\d{4})\/bookings\/\?format=json&limit=100$/) : null
    if (yearRead) {
      const list = world.years?.[Number(yearRead[1])] ?? []
      if (list === 'fail') return new Response('{"detail":"Server error"}', { status: 500 })
      if (list === 'missing') return new Response('{"detail":"Nicht gefunden."}', { status: 404 })
      return json({ count: list.length, next: null, results: list })
    }
    if (method === 'GET' && /^2026\/bookings\/\?title=/.test(path)) return json({ count: (world.titled ?? []).length, next: null, results: world.titled ?? [] })
    if (method === 'POST' && path === '2026/bookings/') {
      if (world.postAnswer === '502') return new Response('{"detail":"Bad gateway"}', { status: 502 })
      bodies.push(JSON.parse(String(init?.body)))
      return json({ id: 99000 + bodies.length }, 201)
    }
    throw new Error(`unexpected request ${method} ${url}`)
  }) as typeof fetch
  return db
}

const posts = () => log.filter(l => l.startsWith('http POST'))
const journalWrites = () => log.filter(l => l === 'db documents update bookamat_pending')

test('Bookmatic booked it first: nothing is posted, the booking is named', async () => {
  const db = setup({ years: { 2026: [income(71001, '2026-06-15', 'RN_209906001 - Muster Client', '840.00')] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'external_duplicate')
  assert.equal(res.status, 409)
  assert.deepEqual(res.candidates?.map(c => [c.year, c.bookingId, c.reason, c.fit]), [[2026, '71001', 'number', 'exact']])
  assert.deepEqual(posts(), [])
  assert.deepEqual(journalWrites(), [])
  // The document says why, in the owner's language, naming the booking.
  const stored = db.ops.find(o => o.table === 'documents' && o.action === 'update' && 'bookamat_error' in (o.values as object))
  assert.match(String((stored?.values as { bookamat_error: string }).bookamat_error), /Möglicherweise schon gebucht — Bookamat hat #71001 · 15\.06\.2026 · 840,00 €/)
  // The claim was released.
  assert.ok(log.includes('db documents update bookamat_claimed_at'))
})

test('a booking under another title with the same amount nearby is named too', async () => {
  const db = setup({ years: { 2026: [income(71002, '2026-06-08', 'Gutschrift Muster', '840.00')] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(!res.ok && res.candidates?.map(c => c.reason), ['amount'])
  assert.deepEqual(posts(), [])
})

test('the number at any date of the year counts, and says it is only part of the money', async () => {
  const db = setup({ years: { 2026: [income(71003, '2026-03-02', 'RN_209906001 - Muster Client', '420.00')] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(!res.ok && res.candidates?.map(c => [c.fit, c.planned]), [['part', 840]])
  assert.deepEqual(posts(), [])
})

test('a transfer recorded as payment plus dunning fee is found by its sum', async () => {
  const db = setup({
    years: { 2026: [income(71007, '2026-06-15', 'Gutschrift', '850.00')] },
    payments: [{ id: P1, date: '2026-06-15', amount: 840, kind: 'payment', method: 'bank' }, { id: P2, date: '2026-06-15', amount: 10, kind: 'fee', method: 'bank' }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(posts(), [])
})

test('a payment year Bookamat answers 404 for books nothing; a missing neighbour year is empty', async () => {
  const db = setup({ years: { 2026: 'missing' } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'duplicate_check_failed')
  assert.deepEqual(posts(), [])
})

test('a sync that lost its claim while Bookamat was searched posts nothing', async () => {
  const db = setup({ claimLost: true })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'in_progress')
  assert.deepEqual(posts(), [])
})

test('Bookamat cannot be searched: nothing is posted (fail closed)', async () => {
  const db = setup({ years: { 2026: 'fail' } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'duplicate_check_failed')
  assert.equal(!res.ok && res.status, 502)
  assert.deepEqual(posts(), [])
  assert.deepEqual(journalWrites(), [])
})

test('a booking the owner said is other money no longer stops the sync', async () => {
  const db = setup({ years: { 2026: [income(71001, '2026-06-15', 'RN_209906001 - Muster Client', '840.00')] } })
  const res = await syncBookamatDocument(db.client, settings, DOC, { acknowledge: [{ year: 2026, bookingId: '71001' }] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(posts(), ['http POST 2026/bookings/'])
  // Journaled before the post, then recorded.
  const post = log.indexOf('http POST 2026/bookings/')
  assert.ok(log.indexOf('db documents update bookamat_pending') < post)
  assert.ok(log.indexOf('db bookamat_bookings insert') > post)
})

test('Mado\'s own booking of another document is not a duplicate', async () => {
  const db = setup({ years: { 2026: [income(71004, '2026-06-15', 'RN-209906002 – Other Client', '840.00')] }, recordedElsewhere: [{ year: 2026, booking_id: '71004' }] })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(posts(), ['http POST 2026/bookings/'])
})

test('a booking Mado made from a statement line is other money for a document: the sync stops and names it', async () => {
  const db = setup({ years: { 2026: [income(71005, '2026-06-15', 'Honorar Muster Client', '840.00')] }, recordedElsewhere: [{ year: 2026, booking_id: '71005', on: 'line' }] })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(posts(), [])
})

test('a 502 after the post keeps the journal: the booking may exist, the next sync looks it up first', async () => {
  const db = setup({ postAnswer: '502' })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'unconfirmed')
  // Written before the post, never taken back
  assert.equal(journalWrites().length, 1)
})

test('unrelated bookings nearby do not stop the sync', async () => {
  const db = setup({ years: { 2026: [income(71005, '2026-06-15', 'MDW MIETE 06/26', '633.60'), { id: 71006, status: '1', title: 'Studio', date: '2026-06-14', amounts: [{ group: '2', amount: '840.00' }] }] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(posts().length, 1)
})

// ─── One booking per payment (PR 8b) ─────────────────────────────────────────

const parts = [
  { id: P1, date: '2026-06-15', amount: 420, kind: 'payment', method: 'bank' },
  { id: P2, date: '2026-07-15', amount: 420, kind: 'payment', method: 'bank' },
]
const inserts = (db: ReturnType<typeof setup>) =>
  db.ops.filter(o => o.table === 'bookamat_bookings' && o.action === 'insert').map(o => o.values as { payment_id: string; booking_id: string; booked_on: string; amount: number })
const journalEntries = (db: ReturnType<typeof setup>) =>
  db.ops.filter(o => o.table === 'documents' && o.action === 'update' && Array.isArray((o.values as { bookamat_pending?: unknown }).bookamat_pending))
    .flatMap(o => (o.values as { bookamat_pending: { payment_id: string }[] }).bookamat_pending)

test('part payments: one booking each, on its own date, named as a part', async () => {
  const db = setup({ payments: parts, status: 'sent' })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(bodies.map(b => [b.title, b.date]), [
    ['RN-209906001 (Teilzahlung 1) – Muster Client', '2026-06-15'],
    ['RN-209906001 (Teilzahlung 2) – Muster Client', '2026-07-15'],
  ])
  assert.match(bodies[1].description, /Teilzahlung 2 vom 15\.07\.2026/)
  assert.deepEqual(bodies.map(b => b.amounts.map(l => [l.tax_percent, l.amount])), [[['20.00', '420.00']], [['20.00', '420.00']]])
  // Each journal entry and each recorded booking names its payment.
  assert.deepEqual(inserts(db).map(i => [i.payment_id, i.booking_id, i.booked_on, i.amount]), [[P1, '99001', '2026-06-15', 420], [P2, '99002', '2026-07-15', 420]])
  assert.deepEqual([...new Set(journalEntries(db).map(e => e.payment_id))], [P1, P2])
})

test('a booked payment is not booked again; the new part payment is', async () => {
  const db = setup({
    payments: parts,
    status: 'paid',
    bookings: [{ year: 2026, booking_id: '99001', amount: 420, kind: 'income', booked_on: '2026-06-15', pdf_attached_at: null, payment_id: P1 }],
    // Bookamat has Mado's own booking of the first part.
    years: { 2026: [income(99001, '2026-06-15', 'RN-209906001 (Teilzahlung 1) – Muster Client', '420.00')] },
    recordedElsewhere: [{ year: 2026, booking_id: '99001' }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(bodies.map(b => b.title), ['RN-209906001 (Teilzahlung 2) – Muster Client'])
  assert.deepEqual(inserts(db).map(i => i.payment_id), [P2])
})

test('a booking from before bookings per payment covers its year: nothing is posted', async () => {
  const db = setup({
    payments: parts,
    status: 'paid',
    bookings: [{ year: 2026, booking_id: '70001', amount: 840, kind: 'income', booked_on: '2026-07-15', pdf_attached_at: null, payment_id: null }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(posts(), [])
})

test('a hand booking of one part payment stops the sync and names that payment', async () => {
  const db = setup({ payments: parts, status: 'paid', years: { 2026: [income(71010, '2026-07-16', 'Überweisung Muster', '420.00')] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(!res.ok && res.candidates?.map(c => [c.bookingId, c.fit, c.paymentId]), [['71010', 'exact', P2]])
  assert.deepEqual(posts(), [])
})

// ─── What an earlier attempt left behind ─────────────────────────────────────

const longAgo = '2026-06-15T08:00:00Z'

test('a journal entry from before bookings per payment, its booking recorded meanwhile, is not recorded again', async () => {
  const db = setup({
    status: 'paid',
    bookings: [{ year: 2026, booking_id: '95074', amount: 840, kind: 'income', booked_on: '2026-06-15', pdf_attached_at: null, payment_id: P1 }],
    pending: [{ year: 2026, kind: 'income', booking_id: '95074', amount: 840, date: '2026-06-15', title: 'RN-209906001 – Muster Client', at: longAgo }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(inserts(db), [])
  assert.deepEqual(posts(), [])
})

test('a lost answer is found among bookings no document has recorded, deleted ones aside', async () => {
  const title = 'RN-209906001 (Teilzahlung 2) – Muster Client'
  const db = setup({
    payments: parts,
    status: 'paid',
    bookings: [{ year: 2026, booking_id: '99001', amount: 420, kind: 'income', booked_on: '2026-06-15', pdf_attached_at: null, payment_id: P1 }],
    pending: [{ year: 2026, kind: 'income', payment_id: P2, booking_id: null, amount: 420, date: '2026-07-15', title, at: longAgo }],
    titled: [
      { id: 99001, status: '1', title, date: '2026-07-15' },
      { id: 99007, status: '3', title, date: '2026-07-15' },
      { id: 99009, status: '1', title, date: '2026-07-15' },
    ],
    taken: ['99001'],
    years: { 2026: [income(99001, '2026-06-15', title, '420.00'), income(99009, '2026-07-15', title, '420.00')] },
    recordedElsewhere: [{ year: 2026, booking_id: '99001' }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(inserts(db).map(i => [i.booking_id, i.payment_id]), [['99009', P2]])
  assert.deepEqual(posts(), [])
})

test('two bookings that may be the lost answer: only the owner can tell, nothing is booked', async () => {
  const title = 'RN-209906001 – Muster Client'
  const db = setup({
    pending: [{ year: 2026, kind: 'income', payment_id: P1, booking_id: null, amount: 840, date: '2026-06-15', title, at: longAgo }],
    titled: [{ id: 99003, status: '1', title, date: '2026-06-15' }, { id: 99004, status: '1', title, date: '2026-06-15' }],
  })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(!res.ok && res.code, 'unknown_outcome')
  assert.deepEqual(inserts(db), [])
  assert.deepEqual(posts(), [])
})

test('a booking handed back is recorded for the payment it names, and never guessed', async () => {
  const named = setup({ payments: parts, status: 'paid', years: { 2026: [income(99010, '2026-07-15', 'RN-209906001 (Teilzahlung 1) – Muster Client', '420.00')] }, recordedElsewhere: [{ year: 2026, booking_id: '99010' }] })
  await syncBookamatDocument(named.client, settings, DOC, { adopt: [{ year: 2026, kind: 'income', bookingId: '99010', paymentId: P2 }] })
  assert.deepEqual(inserts(named)[0] && [inserts(named)[0].booking_id, inserts(named)[0].payment_id], ['99010', P2])
  // From an older tab, without its payment, with two payments unbooked: not recorded on either.
  log = []; bodies = []
  const guess = setup({ payments: parts, status: 'paid', years: { 2026: [income(99011, '2026-07-15', 'RN-209906001 (Teilzahlung 2) – Muster Client', '420.00')] } })
  const res = await syncBookamatDocument(guess.client, settings, DOC, { adopt: [{ year: 2026, kind: 'income', bookingId: '99011' }] })
  assert.equal(inserts(guess).some(i => i.booking_id === '99011'), false)
  // And the booking stops the sync as a possible duplicate instead of being booked again.
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(posts(), [])
})

test('„trotzdem buchen“ counts for the payment it was said for', async () => {
  const both = { years: { 2026: [income(71020, '2026-06-16', 'Überweisung Muster', '420.00')] }, payments: parts, status: 'paid' }
  // Said for the second part: the first part's search still sees it.
  const db = setup(both)
  const res = await syncBookamatDocument(db.client, settings, DOC, { acknowledge: [{ year: 2026, bookingId: '71020', paymentId: P2 }] })
  assert.equal(!res.ok && res.code, 'external_duplicate')
  assert.deepEqual(!res.ok && res.candidates?.map(c => [c.bookingId, c.foundFor]), [['71020', P1]])
  assert.deepEqual(posts(), [])
})

// ─── The daily job, „Buchung vergessen“ ──────────────────────────────────────

test('the daily job books money from 1 January of last year on; older money is left to the owner', async () => {
  const OLD = '00000000-0000-4000-8000-000000000003'
  const thisYear = Number(new Date().toISOString().slice(0, 4))
  const old = { ...doc, id: OLD, number: 'RN-209901001', date: `${thisYear - 3}-03-01`, mcp_payments_at: null, payments: [{ id: P2, date: `${thisYear - 3}-03-20`, amount: 840, kind: 'payment', method: 'bank' }], bookamat_bookings: [] }
  const recent = { ...doc, mcp_payments_at: null, payments: [{ id: P1, date: `${thisYear}-01-15`, amount: 840, kind: 'payment', method: 'bank' }], bookamat_bookings: [] }
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}`)
    if (op.table === 'documents' && op.action === 'select') return { data: op.single ? (op.filters.some(f => f[2] === OLD) ? old : recent) : [old, recent] }
    if (op.table === 'documents' && op.action === 'update' && op.returning) return { data: [{ bookamat_pending: null }] }
    if (op.table === 'bookamat_bookings' && op.action === 'select') return { data: [] }
    return { error: null }
  })
  setup({})
  const yearRead = globalThis.fetch
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('https://www.bookamat.com/api/v1/at/', '')
    if ((init?.method ?? 'GET') === 'GET' && /^\d{4}\/bookings\/\?format=json&limit=100$/.test(path)) return new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 })
    if ((init?.method ?? 'GET') === 'POST' && /^\d{4}\/bookings\/$/.test(path)) { log.push(`http POST ${path}`); return new Response(JSON.stringify({ id: 99100 }), { status: 201 }) }
    return yearRead(input, init)
  }) as typeof fetch
  const results = await autoSyncBookamat(db.client, { ...settings, bookamat_accounts_year: thisYear } as BookamatSettings, async () => { throw new Error('no PDF here') })
  const byNumber = Object.fromEntries(results.map(r => [r.number, r]))
  assert.match(String(byNumber['RN-209901001']?.held), /money from before/)
  assert.equal(byNumber['RN-209906001']?.ok, true, JSON.stringify(results))
  assert.deepEqual(log.filter(l => l.startsWith('http POST')), [`http POST ${thisYear}/bookings/`])
})

test('„Buchung vergessen“ forgets only what is recorded here and gone from Bookamat', async () => {
  const creds = { username: 'synthetic', apiKey: 'not-a-key', country: 'at' }
  const world = (row: unknown, answer: () => Response) => {
    const db = fakeSupabase((op: Op) => {
      log.push(`db ${op.table} ${op.action}`)
      if (op.table === 'bookamat_bookings' && op.action === 'select') return { data: row }
      if (op.table === 'bookamat_bookings' && op.action === 'delete') return { data: [{ id: 'r1' }] }
      if (op.table === 'documents' && op.action === 'update' && op.returning) return { data: [{ id: DOC }] }
      return { error: null }
    })
    globalThis.fetch = (async () => { log.push('http GET booking'); return answer() }) as typeof fetch
    return db
  }
  const target = { booking: { year: 2026, bookingId: '99001' } }
  // Not recorded here (forgotten in another window): said so, Bookamat not asked.
  log = []
  assert.equal((await resetBookamatSync(world(null, () => new Response('{}')).client, DOC, target, creds))?.code, 'forget_not_found')
  assert.equal(log.includes('http GET booking'), false)
  // Bookamat still has it: refused, nothing deleted.
  log = []
  const live = world({ id: 'r1' }, () => new Response(JSON.stringify({ id: 99001, status: '1' }), { status: 200 }))
  assert.equal((await resetBookamatSync(live.client, DOC, target, creds))?.code, 'forget_still_booked')
  assert.equal(live.ops.some(o => o.action === 'delete'), false)
  // Deleted there (404, or status 3): forgotten.
  for (const answer of [() => new Response('{"detail":"Nicht gefunden."}', { status: 404 }), () => new Response(JSON.stringify({ id: 99001, status: '3' }), { status: 200 })]) {
    const gone = world({ id: 'r1' }, answer)
    assert.equal(await resetBookamatSync(gone.client, DOC, target, creds), null)
    assert.equal(gone.ops.some(o => o.table === 'bookamat_bookings' && o.action === 'delete'), true)
  }
})
