// „Das ist diese Zahlung — übernehmen“: a booking Bookamat already has is recorded as the
// document's booking of its year, read again from Bookamat first, and nothing is posted. Only a
// booking that is exactly the money is taken over; anything else is refused with what to do.
// Synthetic data only.
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptExternalBooking, type BookamatSettings } from '@/lib/bookamat'
import { fakeSupabase, type Op } from './fake-supabase'

const DOC = '00000000-0000-4000-8000-000000000002'
const P1 = '00000000-0000-4000-8000-0000000000a1'
const P2 = '00000000-0000-4000-8000-0000000000a2'
const settings = {
  id: 's1', ui_language: 'en', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 11, bookamat_cash_account_id: null, bookamat_cost_account_id: 22, bookamat_vat_account_0: 30,
  bookamat_vat_account_rc: 31, bookamat_vat_account_non_eu: 32, bookamat_vat_account_10: 33, bookamat_vat_account_13: 34,
  bookamat_vat_account_20: 88, bookamat_accounts_year: 2026, bookamat_auto_sync: false,
} as unknown as BookamatSettings

const baseDoc = {
  id: DOC, type: 'invoice', number: 'RN-209907001', status: 'paid', currency: 'EUR', date: '2026-07-01',
  service_date: null, service_date_end: null, tax_treatment: 'at_vat', discount_type: null, discount_value: null,
  document_items: [{ line_type: 'item', sort_order: 0, quantity: 1, unit_price: 500, vat_rate: 20, discount_type: null, discount_value: null }],
  payments: [{ id: P1, date: '2026-07-10', amount: 600, kind: 'payment', method: 'bank' }],
  clients: { name: 'Muster Client', company: null, uid_number: null },
  bookamat_pending: null as unknown, bookamat_bookings: [],
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

type Setup = { takenBy?: string; doc?: Partial<typeof baseDoc>; stored?: unknown[] }

function setup(booking: unknown | 404, opts: Setup = {}) {
  const doc = { ...baseDoc, ...opts.doc }
  const db = fakeSupabase((op: Op) => {
    log.push(`db ${op.table} ${op.action}`)
    if (op.table === 'documents' && op.action === 'select') return { data: doc }
    if (op.table === 'documents' && op.action === 'update' && op.returning) return { data: [{ id: DOC }] }
    if (op.table === 'bookamat_bookings' && op.action === 'select') {
      if (op.columns === 'document_id') return { data: opts.takenBy ? [{ document_id: opts.takenBy }] : [] }
      return { data: opts.stored ?? [] }
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

const booking = (amount: string, opts: { group?: string; title?: string; date?: string } = {}) => ({
  id: 71101, status: '1', title: opts.title ?? 'RN_209907001 - Muster', date: opts.date ?? '2026-07-10', description: '',
  amounts: [{ group: opts.group ?? '1', amount }],
})
const adopt = (db: ReturnType<typeof setup>, year = 2026, paymentId?: string) => adoptExternalBooking(db.client, settings, DOC, { year, bookingId: '71101', paymentId })
const inserted = (db: ReturnType<typeof setup>) => db.ops.some(o => o.action === 'insert' && o.table === 'bookamat_bookings')

test('the booking is read again and recorded with its own date and amount; nothing is posted', async () => {
  const db = setup(booking('600.00'))
  const res = await adopt(db)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.ok && res.adopted, { year: 2026, bookingId: '71101', amount: 600, date: '2026-07-10', paymentId: P1 })
  const insert = db.ops.find(o => o.table === 'bookamat_bookings' && o.action === 'insert')
  assert.deepEqual(insert?.values, { document_id: DOC, year: 2026, booking_id: '71101', amount: 600, kind: 'income', booked_on: '2026-07-10', payment_id: P1 })
  assert.ok(log.includes('http GET 2026/bookings/71101/?format=json'))
  assert.equal(log.filter(l => l.startsWith('http') && !l.startsWith('http GET')).length, 0)
  // Nothing is left to book: the error the duplicate left is cleared, and the claim released.
  assert.ok(db.ops.some(o => o.table === 'documents' && o.action === 'update' && (o.values as { bookamat_error?: unknown }).bookamat_error === null))
  assert.ok(db.ops.some(o => o.table === 'documents' && o.action === 'update' && (o.values as { bookamat_claimed_at?: unknown }).bookamat_claimed_at === null))
})

test('part of the money, or more than it, is refused with both amounts', async () => {
  for (const amount of ['300.00', '640.00']) {
    const db = setup(booking(amount))
    const res = await adopt(db)
    assert.equal(!res.ok && res.code, 'adopt_mismatch', amount)
    assert.equal(inserted(db), false)
  }
  const res = await adopt(setup(booking('480.00')))
  assert.deepEqual(!res.ok && res.detail, { id: '71101', booked: '480,00 €', planned: '600,00 €', year: 2026 })
})

test('an expense is not this money', async () => {
  const res = await adopt(setup(booking('600.00', { group: '2' })))
  assert.equal(!res.ok && res.code, 'adopt_kind')
})

test('a booking naming another invoice belongs to that one', async () => {
  const res = await adopt(setup(booking('600.00', { title: 'RN_209907002 - Andere' })))
  assert.equal(!res.ok && res.code, 'adopt_other_number')
  assert.deepEqual(!res.ok && res.detail, { id: '71101', other: 'RN_209907002' })
})

test('a booking in a year Mado books none of this money in', async () => {
  const res = await adopt(setup(booking('600.00', { date: '2025-12-31' })), 2025)
  assert.equal(!res.ok && res.code, 'adopt_other_year')
  assert.deepEqual(!res.ok && res.detail, { id: '71101', year: 2025, years: '2026' })
})

test('a booking Bookamat does not have', async () => {
  const res = await adopt(setup(404))
  assert.equal(!res.ok && res.code, 'adopt_not_found')
  assert.equal(!res.ok && res.status, 404)
})

test('a booking another document has recorded', async () => {
  const db = setup(booking('600.00'), { takenBy: '00000000-0000-4000-8000-000000000009' })
  const res = await adopt(db)
  assert.equal(!res.ok && res.code, 'adopt_taken')
  assert.equal(inserted(db), false)
})

test('nothing is taken over that the sync would not book', async () => {
  // No money recorded yet.
  assert.equal(await adopt(setup(booking('600.00'), { doc: { status: 'sent', payments: [] } })).then(r => !r.ok && r.code), 'not_settled')
  // Everything booked already.
  const stored = [{ year: 2026, booking_id: '70001', amount: 600, kind: 'income', booked_on: '2026-07-10', pdf_attached_at: null, payment_id: P1 }]
  assert.equal(await adopt(setup(booking('600.00'), { stored })).then(r => !r.ok && r.code), 'adopt_nothing_left')
  // An earlier sync's outcome still open.
  const pending = [{ year: 2026, kind: 'income', booking_id: null, amount: 600, date: '2026-07-10', title: 'x', at: '2026-07-10T10:00:00Z' }]
  assert.equal(await adopt(setup(booking('600.00'), { doc: { bookamat_pending: pending } })).then(r => !r.ok && r.code), 'adopt_unsettled')
})

test('another year still to book keeps the document\'s error', async () => {
  const db = setup(booking('300.00'), {
    doc: { payments: [{ id: P1, date: '2026-12-20', amount: 300, kind: 'payment', method: 'bank' }, { id: P2, date: '2027-01-08', amount: 300, kind: 'payment', method: 'bank' }] },
  })
  const res = await adopt(db)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(db.ops.some(o => o.table === 'documents' && o.action === 'update' && 'bookamat_error' in (o.values as object)), false)
})

test('a copy of a year Mado booked already is not taken over', async () => {
  const stored = [{ year: 2025, booking_id: '70002', amount: 300, kind: 'income', booked_on: '2025-12-20', pdf_attached_at: null, payment_id: null }]
  const res = await adopt(setup(booking('300.00', { date: '2025-12-20' }), {
    stored,
    doc: { payments: [{ id: P1, date: '2025-12-20', amount: 300, kind: 'payment', method: 'bank' }, { id: P2, date: '2026-01-08', amount: 300, kind: 'payment', method: 'bank' }] },
  }), 2025)
  assert.equal(!res.ok && res.code, 'adopt_booked_year')
  assert.deepEqual(!res.ok && res.detail, { id: '71101', year: 2025, bookings: '#70002' })
})

test('a part payment\'s booking is recorded for that payment', async () => {
  const parts = { status: 'sent', payments: [
    { id: P1, date: '2026-07-10', amount: 300, kind: 'payment', method: 'bank' },
    { id: P2, date: '2026-08-10', amount: 300, kind: 'payment', method: 'bank' },
  ] }
  // The one nearest its date, when the search named none.
  const db = setup(booking('300.00', { date: '2026-08-11' }), { doc: parts })
  const res = await adopt(db)
  assert.equal(res.ok && res.adopted.paymentId, P2, JSON.stringify(res))
  assert.equal((db.ops.find(o => o.action === 'insert')?.values as { payment_id: string }).payment_id, P2)
  // The payment the search named, when it is still unbooked.
  const named = setup(booking('300.00', { date: '2026-08-11' }), { doc: parts })
  assert.equal(await adopt(named, 2026, P1).then(r => r.ok && r.adopted.paymentId), P1)
  // The named payment was booked meanwhile: a possible second booking of it, never the other's.
  const stored = [{ year: 2026, booking_id: '70003', amount: 300, kind: 'income', booked_on: '2026-08-10', pdf_attached_at: null, payment_id: P2 }]
  const rest = setup(booking('300.00', { date: '2026-08-11' }), { doc: parts, stored })
  const refused = await adopt(rest, 2026, P2)
  assert.equal(!refused.ok && refused.code, 'adopt_payment_booked')
  assert.deepEqual(!refused.ok && refused.detail, { id: '71101', bookings: '#70003' })
  assert.equal(inserted(rest), false)
})

test('a preview takes nothing over and touches nothing', async () => {
  process.env.VERCEL_ENV = 'preview'
  const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched') } }) as never
  const res = await adoptExternalBooking(untouchable, settings, DOC, { year: 2026, bookingId: '71101' })
  assert.equal(!res.ok && res.code, 'preview')
})
