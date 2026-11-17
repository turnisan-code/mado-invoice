import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimedByOther, classifierOptions, gmailMayStart, newAnalyseRun, otherNumbers, readOptions, runRead,
  CLASSIFIER_MIN_MS, GMAIL_STOP_MS, MAX_READS_PER_RUN, READ_STOP_MS, READ_MAX_MS, READ_END_MS, RUN_CONCURRENCY, RUN_MARGIN_S,
} from '../analyse-run'
import { rowLabel } from '../receipt-match'
import type { EasybankTransaction } from '@/lib/expenses/types'

// One Analyse's deadline, its rows' claims and its budget of reads (PR „Job 1 fixes“ § 2.1 E,
// § 3.2, lib/analyse-run.ts). A clock of the test's own; synthetic debits, invoice numbers
// 910000000xxx.

const debit = (reference: string, over: Partial<EasybankTransaction> = {}): EasybankTransaction =>
  ({ date: '2026-07-16', counterparty: 'MUSTER TELEKOM', reference, amount: 23.45, type: 'expense', currency: 'EUR', raw: {}, ...over })
const clockAt = (ms: number) => ({ ms, now() { return this.ms } })

describe('newAnalyseRun — the run of one Analyse', () => {
  test('the deadline: maxDuration less 10 s — a line’s search route’s 60 s → 50 s', () => {
    const clock = clockAt(1_000_000)
    const line = newAnalyseRun([], { maxDurationS: 60, now: () => clock.now() })
    assert.deepEqual([line.start, line.deadline - line.start, RUN_MARGIN_S], [1_000_000, 50_000, 10])
    assert.deepEqual([line.reads.left, MAX_READS_PER_RUN, RUN_CONCURRENCY, line.gmailAuthError], [150, 150, 6, null])
  })
  test('reserved: each bank text’s invoice number → the rows naming it; each row’s label', () => {
    const rows = [
      debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026'),
      // a SEPA re-debit of the same invoice
      debit('Muster Telekom|Rechnung 910000000123 vom 10.07.2026', { date: '2026-07-20' }),
      debit('Netzcom|Rechnungsnr: 910000000456'),
      debit('ohne Nummer'),
    ]
    const run = newAnalyseRun(rows, { maxDurationS: 120 })
    assert.deepEqual(Array.from(run.reserved.entries()).map(([k, s]) => [k, Array.from(s)]), [['910000000123', [0, 1]], ['910000000456', [2]]])
    assert.deepEqual(run.labels, rows.map(rowLabel))
    // the numbers of other rows a row's receipts must not carry: its own never, also when another names it too
    assert.deepEqual(otherNumbers(run, 0), [{ key: '910000000456', label: run.labels[2] }])
    assert.deepEqual(otherNumbers(run, 2), [{ key: '910000000123', label: run.labels[0] }])
    assert.deepEqual(otherNumbers(run, 3).map(o => o.key), ['910000000123', '910000000456'])
    run.claims.claim(['gmail:msg-a1:1'], 2, run.labels[2])
    assert.equal(claimedByOther(run, 0)('gmail:msg-a1:1'), run.labels[2])
    assert.equal(claimedByOther(run, 2)('gmail:msg-a1:1'), null)
    assert.equal(claimedByOther(run, 0)('gmail:msg-a2:1'), null)
  })
  test('the time rules of a line’s search: Gmail until 20 s, reads until 35 s (each at most 25 s, ending 5 s before the deadline), the classifier until 42 s', () => {
    const clock = clockAt(0)
    const run = newAnalyseRun([], { maxDurationS: 60, now: () => clock.now() })
    const at = (s: number) => { clock.ms = s * 1000; return { gmail: gmailMayStart(run), read: readOptions(run), ai: classifierOptions(run) } }
    const signal = run.signal
    // 50 s left: one try for a read; the classifier one too
    assert.deepEqual(at(0), { gmail: true, read: { timeoutMs: 25_000, maxRetries: 1, signal }, ai: { timeoutMs: 30_000, maxRetries: 1, signal } })
    assert.deepEqual(at(9.999).read, { timeoutMs: 25_000, maxRetries: 1, signal })
    assert.deepEqual(at(10).read, { timeoutMs: 25_000, maxRetries: 0, signal })
    assert.equal(at(20).gmail, true)
    assert.equal(at(20.001).gmail, false)
    // later reads end 5 s before the deadline; the last one starts at 35 s and gets 10 s
    assert.deepEqual(at(25).read, { timeoutMs: 20_000, maxRetries: 0, signal })
    assert.deepEqual(at(35).read, { timeoutMs: 10_000, maxRetries: 0, signal })
    assert.equal(at(35.001).read, null)
    // the classifier: what is left less 3 s, from 8 s left on
    assert.deepEqual(at(42).ai, { timeoutMs: 5_000, maxRetries: 0, signal })
    assert.equal(at(42.001).ai, null)
    assert.deepEqual([GMAIL_STOP_MS, READ_STOP_MS, READ_MAX_MS, READ_END_MS, CLASSIFIER_MIN_MS], [30_000, 15_000, 25_000, 5_000, 8_000])
  })
  test('the signal aborts at the deadline', async () => {
    const run = newAnalyseRun([], { maxDurationS: RUN_MARGIN_S + 0.03 })
    assert.equal(run.signal.aborted, false)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(run.signal.aborted, true)
  })
  test('from the request’s start: what the route did before the search (10 s of reads, say) is part of the run’s time', async () => {
    const clock = clockAt(1_010_000)
    const run = newAnalyseRun([], { maxDurationS: 60, startedAt: 1_000_000, now: () => clock.now() })
    assert.deepEqual([run.start, run.deadline], [1_000_000, 1_050_000])
    // Gmail until 20 s of the request, reads until 35 s — not of the run's creation
    clock.ms = 1_020_000
    assert.equal(gmailMayStart(run), true)
    clock.ms = 1_020_001
    assert.equal(gmailMayStart(run), false)
    clock.ms = 1_035_001
    assert.equal(readOptions(run), null)
    // the signal at that deadline: 1 s of time, 0,98 s of it gone before the run was made
    const late = newAnalyseRun([], { maxDurationS: RUN_MARGIN_S + 1, startedAt: Date.now() - 980 })
    assert.equal(late.signal.aborted, false)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(late.signal.aborted, true)
  })
})

describe('runRead — one PDF read of the run', () => {
  test('with the options for its moment; counted; refused once the read stop passed or no reads are left (not counted); a failed read counted and thrown', async () => {
    const clock = clockAt(0)
    const run = newAnalyseRun([], { maxDurationS: 60, now: () => clock.now() })
    const seen: unknown[] = []
    assert.deepEqual(await runRead(run, async opts => { seen.push(opts); return 'gelesen' }), { ok: 'gelesen' })
    assert.deepEqual(seen, [{ timeoutMs: 25_000, maxRetries: 1, signal: run.signal }])
    assert.equal(run.reads.left, MAX_READS_PER_RUN - 1)
    run.reads.left = 0
    assert.deepEqual(await runRead(run, async () => 'nie'), { notRead: 'budget' })
    run.reads.left = 5
    clock.ms = 36_000
    assert.deepEqual(await runRead(run, async () => 'nie'), { notRead: 'time' })
    assert.equal(run.reads.left, 5)
    clock.ms = 0
    await assert.rejects(runRead(run, async () => { throw new Error('429 rate_limit_error') }), /429/)
    assert.equal(run.reads.left, 4)
  })
  test('six reads in flight run-wide, the others wait their turn', async () => {
    const run = newAnalyseRun([], { maxDurationS: 120 })
    let running = 0
    let most = 0
    await Promise.all(Array.from({ length: 9 }, () => runRead(run, async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running -= 1
    })))
    assert.equal(most, 6)
    assert.equal(run.reads.left, MAX_READS_PER_RUN - 9)
  })
})
