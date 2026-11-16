// „Das ist diese Zahlung — übernehmen“: a booking Bookamat already has is recorded as the
// document's booking of its year, read again from Bookamat first, and nothing is posted.
// Synthetic data only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptExternalBooking, type BookamatSettings } from '@/lib/bookamat'
import { fakeSupabase, type Op } from './fake-supabase'

const DOC = '00000000-0000-4000-8000-000000000002'
const settings = {
  id: 's1', ui_language: 'en', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 11, bookamat_cash_account_id: null, bookamat_cost_account_id: 22, bookamat_vat_account_0: 30,
  bookamat_vat_account_rc: 31, bookamat_vat_account_non_eu: 32, bookamat_vat_account_10: 33, bookamat_vat_account_13: 34,
  bookamat_vat_account_20: 88, bookamat_accounts_year: 2026, bookamat_auto_sync: false,
} as unknown as BookamatSettings

const doc = {
  id: DOC, type: 'invoice', number: 'RN-209907001', status: 'paid', currency: 'EUR', date: '2026-07-01',
  service_date: null, service_date_end: null, tax_treatment: 'at_vat', discount_type: null, discount_value: null,
  document_items: [{ line_type: 'item', sort_order: 0, quantity: 1, unit_price: 500, vat_rate: 20, discount_type: null, discount_value: null }],
  payments: [{ date: '2026-07-10', amount: 600, kind: 'payment', method: 'bank' }],
  clients: { name: 'Muster Client', company: null, uid_number: null },
  bookamat_pending: null, bookamat_bookings: [],
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

function setup(booking: unknown | 404, opts: { takenBy?: string } = {}) {
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}`)
    if (op.table === 'documents' && op.action === 'select') return { data: doc }
    if (op.table === 'documents' && op.action === 'update' && op.returning) return { data: [{ id: DOC }] }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      return { data: op.columns === 'document_id' ? (opts.takenBy ? [{ document_id: opts.takenBy }] : []) : [] }
    }
    return { error: null }
  })
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    log.push(`http ${init?.method ?? 'GET'} ${url.replace('https://www.bookamat.com/api/v1/at/', '')}`)
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('nothing may be posted')
    if (booking === 404) return new Response('{"detail":"Nicht gefunden."}', { status: 404 })
    return new Response(JSON.stringify(booking), { status: 200 })
  }) as typeof fetch
  return db
}

const booking = (amount: string, group = '1') => ({ id: 71101, status: '1', title: 'RN_209907001 - Muster', date: '2026-07-10', description: '', amounts: [{ group, amount }] })

test('the booking is read again and recorded with its own date and amount; nothing is posted', async () => {
  const db = setup(booking('600.00'))
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.ok && res.adopted, { year: 2026, bookingId: '71101', amount: 600, date: '2026-07-10' })
  const insert = db.ops.find(o => o.table === 'bookamat_bookings' && o.action === 'insert')
  assert.deepEqual(insert?.values, { document_id: DOC, year: 2026, booking_id: '71101', amount: 600, kind: 'income', booked_on: '2026-07-10' })
  assert.ok(log.includes('http GET 2026/bookings/71101/?format=json'))
  assert.equal(log.filter(l => l.startsWith('http') && !l.startsWith('http GET')).length, 0)
  // The error the duplicate left on the document is cleared, and the claim released.
  assert.ok(db.ops.some(o => o.table === 'documents' && o.action === 'update' && (o.values as { bookamat_error?: unknown }).bookamat_error === null))
  assert.ok(db.ops.some(o => o.table === 'documents' && o.action === 'update' && (o.values as { bookamat_claimed_at?: unknown }).bookamat_claimed_at === null))
})

test('another amount is not this money', async () => {
  const db = setup(booking('480.00'))
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'adopt_mismatch')
  assert.deepEqual(!res.ok && res.detail, { id: '71101', booked: '480.00', planned: '600.00' })
  assert.equal(db.ops.some(o => o.action === 'insert' && o.table === 'bookamat_bookings'), false)
})

test('an expense is not this money', async () => {
  const db = setup(booking('600.00', '2'))
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'adopt_mismatch')
})

test('a booking Bookamat does not have', async () => {
  const db = setup(404)
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'adopt_not_found')
  assert.equal(!res.ok && res.status, 404)
})

test('a booking another document has recorded', async () => {
  const db = setup(booking('600.00'), { takenBy: '00000000-0000-4000-8000-000000000009' })
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'adopt_taken')
  assert.equal(db.ops.some(o => o.action === 'insert' && o.table === 'bookamat_bookings'), false)
})

test('a year with nothing left to book', async () => {
  const db = setup(booking('600.00'))
  const res = await adoptExternalBooking(db.client, settings, DOC, { year: 2025, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'nothing_to_book')
})

test('a preview takes nothing over and touches nothing', async () => {
  process.env.VERCEL_ENV = 'preview'
  const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched') } }) as never
  const res = await adoptExternalBooking(untouchable, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'preview')
})
