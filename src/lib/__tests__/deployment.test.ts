// Only production writes to Bookamat; a preview (production's data and key) and a local server
// without BOOKAMAT_ALLOW_WRITES=1 only read.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bookamatWritesAllowed, deploymentCommit, deploymentEnv } from '@/lib/deployment'
import { autoSyncBookamat, bookamatFetch, resetBookamatSync, syncBookamatDocument, type BookamatSettings } from '@/lib/bookamat'

const saved = { VERCEL_ENV: process.env.VERCEL_ENV, BOOKAMAT_ALLOW_WRITES: process.env.BOOKAMAT_ALLOW_WRITES }
const realFetch = globalThis.fetch
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  globalThis.fetch = realFetch
})

const creds = { username: 'synthetic', apiKey: 'not-a-key', country: 'at' }
// A database any touch of which fails the test: the guard must answer before it.
const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched') } }) as unknown as SupabaseClient
const settings = {
  id: 's1', ui_language: 'de', bookamat_username: 'synthetic', bookamat_api_key: 'not-a-key', bookamat_country: 'at',
  bookamat_bank_account_id: 1, bookamat_cash_account_id: null, bookamat_cost_account_id: 2, bookamat_vat_account_0: 3,
  bookamat_vat_account_rc: 4, bookamat_vat_account_non_eu: 5, bookamat_vat_account_10: 6, bookamat_vat_account_13: 7,
  bookamat_vat_account_20: 8, bookamat_accounts_year: 2026, bookamat_auto_sync: true,
} as unknown as BookamatSettings

test('where the build runs', () => {
  assert.equal(deploymentEnv({ VERCEL_ENV: 'production' }), 'production')
  assert.equal(deploymentEnv({ VERCEL_ENV: 'preview' }), 'preview')
  assert.equal(deploymentEnv({}), 'local')
  assert.equal(deploymentCommit({ VERCEL_GIT_COMMIT_SHA: 'abcdef0123456' }), 'abcdef0')
  assert.equal(deploymentCommit({}), null)
})

test('only production, or a local server that opts in, writes to Bookamat', () => {
  assert.equal(bookamatWritesAllowed({ VERCEL_ENV: 'production' }), true)
  assert.equal(bookamatWritesAllowed({ VERCEL_ENV: 'preview' }), false)
  assert.equal(bookamatWritesAllowed({ VERCEL_ENV: 'preview', BOOKAMAT_ALLOW_WRITES: '1' }), false)
  assert.equal(bookamatWritesAllowed({ VERCEL_ENV: 'development' }), false)
  assert.equal(bookamatWritesAllowed({}), false)
  assert.equal(bookamatWritesAllowed({ BOOKAMAT_ALLOW_WRITES: '1' }), true)
})

test('a preview reads from Bookamat but never posts', async () => {
  process.env.VERCEL_ENV = 'preview'
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
    return new Response('{"results":[]}', { status: 200 })
  }) as typeof fetch
  await bookamatFetch(creds, 2026, 'bookings/?format=json')
  await assert.rejects(bookamatFetch(creds, 2026, 'bookings/', { method: 'POST', body: {} }), (err: { code?: string }) => err.code === 'preview')
  assert.deepEqual(calls, ['GET https://www.bookamat.com/api/v1/at/2026/bookings/?format=json'])
})

test('on a preview the sync, the reset and the cron step stop before the database', async () => {
  process.env.VERCEL_ENV = 'preview'
  globalThis.fetch = (async () => { throw new Error('Bookamat was called') }) as typeof fetch
  const sync = await syncBookamatDocument(untouchable, settings, '00000000-0000-4000-8000-000000000001')
  assert.equal(sync.ok, false)
  assert.equal(!sync.ok && sync.code, 'preview')
  assert.equal(!sync.ok && sync.status, 403)
  const reset = await resetBookamatSync(untouchable, '00000000-0000-4000-8000-000000000001')
  assert.equal(reset?.code, 'preview')
  assert.deepEqual(await autoSyncBookamat(untouchable, settings, async () => { throw new Error('no PDF') }), [])
})
