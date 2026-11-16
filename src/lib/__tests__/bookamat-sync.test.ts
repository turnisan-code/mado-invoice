// The sync looks in Bookamat before it posts (Bookmatic audit P0-2): money Bookamat already has
// from a booking Mado did not make is never booked again, and a search that fails books nothing.
// A stand-in database and a stand-in Bookamat log every call in one sequence. Synthetic data only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { syncBookamatDocument, type BookamatSettings } from '@/lib/bookamat'
import { fakeSupabase, type Op } from './fake-supabase'

const DOC = '00000000-0000-4000-8000-000000000001'
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
  payments: [{ date: '2026-06-15', amount: 840, kind: 'payment', method: 'bank' }],
  clients: { name: 'Muster Client', company: null, uid_number: null },
  bookamat_pending: null, bookamat_bookings: [],
}

const income = (id: number, date: string, title: string, amount: string) =>
  ({ id, status: '1', title, date, description: '', amounts: [{ group: '1', amount }] })

type World = {
  // A year's bookings as Bookamat lists them; 'fail' answers 500, 'missing' 404.
  years?: Record<number, unknown[] | 'fail' | 'missing'>
  recordedElsewhere?: { year: number; booking_id: string }[]
  // Another sync took the claim over before the journal was written.
  claimLost?: boolean
  payments?: typeof doc.payments
}

const saved = process.env.VERCEL_ENV
const realFetch = globalThis.fetch
let log: string[] = []
beforeEach(() => { process.env.VERCEL_ENV = 'production'; log = [] })
afterEach(() => {
  if (saved === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = saved
  globalThis.fetch = realFetch
})

function setup(world: World) {
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}${op.action === 'update' ? ` ${Object.keys(op.values as object).join(',')}` : ''}`)
    if (op.table === 'documents' && op.action === 'select') return { data: { ...doc, payments: world.payments ?? doc.payments } }
    if (op.table === 'documents' && op.action === 'update' && op.returning) {
      const journal = 'bookamat_pending' in (op.values as object)
      return { data: journal && world.claimLost ? [] : [{ bookamat_pending: null }] }
    }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      return { data: op.columns === 'year, booking_id' ? world.recordedElsewhere ?? [] : [] }
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
    if (method === 'POST' && path === '2026/bookings/') return json({ id: 99001 }, 201)
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
    payments: [{ date: '2026-06-15', amount: 840, kind: 'payment', method: 'bank' }, { date: '2026-06-15', amount: 10, kind: 'fee', method: 'bank' }],
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

test('unrelated bookings nearby do not stop the sync', async () => {
  const db = setup({ years: { 2026: [income(71005, '2026-06-15', 'MDW MIETE 06/26', '633.60'), { id: 71006, status: '1', title: 'Studio', date: '2026-06-14', amounts: [{ group: '2', amount: '840.00' }] }] } })
  const res = await syncBookamatDocument(db.client, settings, DOC)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(posts().length, 1)
})
