/**
 * One Analyse (P2-11, PR „Job 1 fixes“ § 2.1 E, § 3.2): its deadline, its rows' claims on
 * Gmail receipts, its limiters and its budget of PDF reads.
 *
 * The deadline is the route's maxDuration less 25 s (enrich: 95 s), counted from the route's
 * request — its reads before the rows included —, and the run's signal
 * aborts every Gmail and AI call still running then: the SDK and googleapis send a request
 * that timed out again, so without it one call could outlast the route. Before it:
 * - no Gmail search starts in the last 30 s (enrich: after 65 s);
 * - no PDF read starts in the last 35 s (after 60 s); a read gets at most 20 s and 1 retry
 *   while more than 50 s are left, else none;
 * - the classifier is asked only with 8 s left, for at most 30 s and 1 retry while more
 *   than 40 s are left.
 * Six Gmail calls and six PDF reads run at a time, run-wide; at most 150 PDFs are read per
 * Analyse (≈ $1,35). What one row read is the others' too, by the PDF's bytes (sha256).
 *
 * Server only (lib/gmail-receipt.ts, lib/matcher.ts, the enrich route).
 */

import type { EasybankTransaction } from './types'
import type { AiCallOptions } from './ai-call'
import { bankInvoiceKey, makeLimiter, rowLabel, ReceiptClaims, type Limiter, type ReceiptRead } from './receipt-match'

// The run's deadline: the route's maxDuration less this, for the last rows to be sent
export const RUN_MARGIN_S = 25
// No Gmail search starts later than this before the deadline
export const GMAIL_STOP_MS = 30_000
// No PDF read starts later than this before the deadline
export const READ_STOP_MS = 35_000
// The classifier is not asked with less than this left
export const CLASSIFIER_MIN_MS = 8_000
// PDF reads per Analyse
export const MAX_READS_PER_RUN = 150
// Gmail calls, and PDF reads, in flight run-wide
export const RUN_CONCURRENCY = 6

// A PDF read: what the reader read, why it failed, or why it was not read
export type ReadOutcome = { read: ReceiptRead } | { error: string } | { notRead: 'time' | 'budget' }
// pdf-parse's text of a PDF ('' without a text layer) and its pages
export type PdfText = { text: string; pages: number | null }

export type AnalyseRun = {
  start: number
  deadline: number
  // Aborted at the deadline: every Gmail and AI call of the run carries it
  signal: AbortSignal
  claims: ReceiptClaims
  // Each expense row's bank invoice number (lib/receipt-match.ts bankInvoiceKey) → the rows
  // whose bank text names it
  reserved: Map<string, Set<number>>
  // Each expense row as other rows' notes name it (lib/receipt-match.ts rowLabel)
  labels: string[]
  // PDF reads left, and every read made or started, by the PDF's sha256
  reads: { left: number; bySha: Map<string, Promise<ReadOutcome>> }
  // pdf-parse's text of every PDF parsed, by its sha256
  texts: Map<string, Promise<PdfText>>
  readLimit: Limiter
  gmailLimit: Limiter
  // The first Gmail error that means the connection is gone (lib/gmail-parts.ts
  // isGmailAuthError): later rows skip Gmail and say it (the free part of P2-9)
  gmailAuthError: unknown
  now: () => number
}

/**
 * The run of one Analyse of `expenses` (their positions are its rows), in a route whose
 * maxDuration is `maxDurationS`. `startedAt`: when the route's request came in — maxDuration
 * counts from there, so what the route did before its rows (the Buchungsregeln, bookamat's
 * lists, the duplicate check) is part of the Analyse's time; without it, now. `now`: the
 * clock (tests pass their own).
 */
export function newAnalyseRun(
  expenses: readonly EasybankTransaction[],
  { maxDurationS, startedAt, now = Date.now }: { maxDurationS: number; startedAt?: number; now?: () => number },
): AnalyseRun {
  const start = startedAt ?? now()
  const deadline = start + (maxDurationS - RUN_MARGIN_S) * 1000
  const reserved = new Map<string, Set<number>>()
  expenses.forEach((tx, i) => {
    const key = bankInvoiceKey(tx)
    if (!key) return
    const rows = reserved.get(key) ?? new Set<number>()
    rows.add(i)
    reserved.set(key, rows)
  })
  return {
    start,
    deadline,
    // At the deadline, however much of the run's time is gone already. The timer does not
    // keep the process alive.
    signal: AbortSignal.timeout(Math.max(0, deadline - now())),
    claims: new ReceiptClaims(),
    reserved,
    labels: expenses.map(rowLabel),
    reads: { left: MAX_READS_PER_RUN, bySha: new Map() },
    texts: new Map(),
    readLimit: makeLimiter(RUN_CONCURRENCY),
    gmailLimit: makeLimiter(RUN_CONCURRENCY),
    gmailAuthError: null,
    now,
  }
}

const remaining = (run: Pick<AnalyseRun, 'deadline' | 'now'>) => run.deadline - run.now()

// Whether a Gmail search may start now
export const gmailMayStart = (run: Pick<AnalyseRun, 'deadline' | 'now'>): boolean => remaining(run) >= GMAIL_STOP_MS

// The options of a PDF read starting now, or null when none may start any more
export function readOptions(run: Pick<AnalyseRun, 'deadline' | 'now' | 'signal'>): AiCallOptions | null {
  const left = remaining(run)
  if (left < READ_STOP_MS) return null
  return { timeoutMs: Math.min(20_000, left - 15_000), maxRetries: left > 50_000 ? 1 : 0, signal: run.signal }
}

// The options of the classifier asked now, or null when there is no time left for it
export function classifierOptions(run: Pick<AnalyseRun, 'deadline' | 'now' | 'signal'>): AiCallOptions | null {
  const left = remaining(run)
  if (left < CLASSIFIER_MIN_MS) return null
  return { timeoutMs: Math.min(30_000, left - 3_000), maxRetries: left > 40_000 ? 1 : 0, signal: run.signal }
}

/**
 * One PDF read of the run: through its read limiter; once its turn comes, started only while
 * reads may start and reads are left (counted), with the options for that moment. A failed
 * read throws, as `read` does.
 */
export function runRead<T>(run: AnalyseRun, read: (opts: AiCallOptions) => Promise<T>): Promise<{ ok: T } | { notRead: 'time' | 'budget' }> {
  return run.readLimit(async () => {
    const opts = readOptions(run)
    if (!opts) return { notRead: 'time' as const }
    if (run.reads.left <= 0) return { notRead: 'budget' as const }
    run.reads.left -= 1
    return { ok: await read(opts) }
  })
}

// The invoice numbers other rows' bank texts name and this row's does not, each with the
// first such row's label
export function otherNumbers(run: Pick<AnalyseRun, 'reserved' | 'labels'>, row: number): { key: string; label: string }[] {
  return Array.from(run.reserved.entries())
    .filter(([, rows]) => !rows.has(row))
    .map(([key, rows]) => ({ key, label: run.labels[Math.min(...Array.from(rows))] }))
}

// The label of another row that claimed a key, or null
export const claimedByOther = (run: Pick<AnalyseRun, 'claims'>, row: number) => (key: string): string | null => {
  const owner = run.claims.ownerOf(key)
  return owner && owner.row !== row ? owner.label : null
}
