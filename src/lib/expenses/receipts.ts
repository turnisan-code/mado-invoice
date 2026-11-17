// The receipt of a statement line from Gmail (PR 9b „Belege aus Gmail“): one line's search per
// request (Bookmatic's search of a debit's receipt, lib/expenses/gmail-receipt.ts), „Anhängen“
// of a PDF it found and did not attach, and „Beleg entfernen“.
//
// A line is searched on the paths Bookmatic's Analyse took (lib/matcher.ts enrichExpense): a
// Buchungsregel's senders (the rule that fits, or every rule that ties), else a payment
// processor's domain and the vendor's name. Never an own transfer, a card issuer's settlement (its
// statement lies in the issuer's portal), a credit, a line that names a Mado document, a line
// booked, skipped or with a booking attempt open, nor one whose receipt the owner attached.
//
// What a search finds is kept on the line (bank_lines.receipt_search) and its row is built from
// it (lib/expenses/lines.ts lineRow). The receipt it attaches is copied into the private
// 'receipts' bucket as a Beleg uploaded by hand is (decision D12), and claimed for the line
// (receipt_claims): by its Gmail part, its bytes and its sender's invoice number, so no other
// line gets it. Claims and the line's receipt change in one step, against the line as it was
// loaded (set_line_receipt, 20261118_receipts.sql); every copy has a name of its own, so a step
// refused removes only its own copy. A search that attaches nothing never takes away the receipt
// an earlier search attached. A dry run („Probelauf“) searches and reads as a search does and
// keeps nothing.
//
// Gmail is only read. Server only: the route passes the Gmail API and the reader (deps).
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankLine, BankLineGmailReceipt, BankLineReceiptSearch, BookingRule } from '@/types'
import { BookamatError } from '@/lib/bookamat'
import { newAnalyseRun } from './analyse-run'
import { findGmailReceipt, type GmailPath, type GmailReceiptDeps } from './gmail-receipt'
import { cleanCounterparty } from './invoice-parsing'
import { lineKind, lineTransaction, LINE_COLUMNS, type StoredLine } from './lines'
import { madoDocumentText, namedDocument, readMadoNumbers } from './mado-numbers'
import { cardSettlement } from './card-settlement'
import { ownTransfer } from './own-transfer'
import { gmailAttachable, ownClaimKeys, rowLabel, type ReceiptRead } from './receipt-match'
import { matchRules } from './rule-match'
import { vendorsOf } from './rules'
import { sniffAttachmentType } from './attachment'
import { handReceipt, onlyFailed, receiptSearchForPage } from './receipt-state'
import type { EasybankTransaction, GmailCandidate, Vendor } from './types'

// The route's time (src/app/api/bank-lines/[id]/receipts/*)
export const SEARCH_MAX_DURATION_S = 60
// What a line keeps of the receipt's text and of its e-mail's: the invoice address of tied rules
// and the rules' „E-Mail enthält“ are looked for in them (Bookmatic looked in the whole text)
export const RECEIPT_TEXT_MAX = 50_000
export const EMAIL_TEXT_MAX = 20_000
// A copy's path: the line's folder, a name of its own (lib/expenses/input.ts receiptPathOk)
export const copyPath = (lineId: string, sha256: string, name: string): string =>
  `${lineId}/gmail-${randomUUID().slice(0, 8)}-${sha256.slice(0, 8)}-${storedName(name)}`
// The lines around a line whose invoice numbers and receipts are not its own
const AROUND_DAYS = 40
const CHUNK = 500

const BUCKET = 'receipts'
const day = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const cap = (s: string | null | undefined, max: number): string | null => (s ? s.replace(/\u0000/g, '').slice(0, max) : null)
// What a step sends goes into text and jsonb, which refuse the NUL character and a lone surrogate
// (a PDF's text, a header, a file name): each string without NUL, a lone surrogate as U+FFFD
const dbSafe = <T>(v: T): T => (v == null ? v
  : JSON.parse(JSON.stringify(v), (_k, x: unknown) => (typeof x === 'string' ? x.replace(/\u0000/g, '').toWellFormed() : x)) as T)
// The name a receipt is stored under: its file name, safe for a storage path, as the page names an
// upload (lib/expenses/input.ts receiptPathOk)
export const storedName = (name: string) => name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-120) || 'beleg.pdf'

// Bookmatic's payment processors (lib/matcher.ts): they send every shop's receipts from their own
// domain
export const PROCESSOR_DOMAINS: Record<string, string> = {
  'PADDLE.NET': 'paddle.com',
  'KLARNA': 'klarna.com',
  'STRIPE': 'stripe.com',
  'PAYPAL': 'paypal.com',
}

export const RECEIPT_TEXT = {
  notDebit: 'Nur Ausgaben werden in Gmail gesucht',
  notOpen: 'Diese Zeile ist nicht offen — nichts gesucht',
  pending: 'Ein Buchungsversuch ist offen — nichts gesucht',
  ownReceipt: 'Diese Zeile hat einen Beleg, den du angehängt hast — zuerst entfernen, dann suchen',
  ownTransfer: 'Überweisung auf dein eigenes Konto — kein Beleg zu suchen',
  cardSettlement: 'Kreditkartenabrechnung — die Abrechnung liegt im Portal des Kartenausstellers, nicht in Gmail',
  beforeSwitch: 'Vor dem Umstellungsdatum wird nur auf „In Gmail suchen“ gesucht',
  searchedBefore: 'Schon in Gmail gesucht — „Erneut in Gmail suchen“ sucht nochmals',
  handReceipt: 'Diese Zeile hat einen Beleg, den du hochgeladen hast — zuerst entfernen, dann anhängen',
  claimedMeanwhile: (label: string) => `⚠ Der gefundene Beleg hängt inzwischen an ${label} — nicht angehängt`,
  notListed: 'Dieser Beleg steht nicht in der Liste der Zeile — erneut suchen',
  notAttachable: 'Dieser Beleg ist kein PDF bis 10 MB — nicht anhängbar',
  notPdf: 'Die Datei aus Gmail ist kein PDF — nicht angehängt',
  gone: 'Der Beleg ist in Gmail nicht mehr zu finden — erneut suchen',
  claimed: (label: string) => `Dieser Beleg hängt schon an ${label} — dort entfernen, dann hier anhängen`,
  changed: 'Die Zeile hat sich inzwischen geändert (gebucht, ein Buchungsversuch läuft, oder ihr Beleg ist ein anderer) — Seite neu laden',
} as const

// What a receipt route answers when the owner's step can't be done: the line changed meanwhile,
// a receipt another line holds, a PDF that is none, Gmail not connected (src/lib/expenses/api.ts)
export class ReceiptError extends Error {
  // Codes of their own: the page shows the server's words for them (never a generic text)
  constructor(readonly code: 'line_changed' | 'not_searchable' | 'not_attachable' | 'claimed' | 'not_listed', message: string, readonly status: number) {
    super(message)
    this.name = 'ReceiptError'
    Object.setPrototypeOf(this, ReceiptError.prototype)
  }
}

export type LineSearchResult =
  | { status: 'not_searched'; reason: string }
  | {
    status: 'searched'; search: BankLineReceiptSearch; attached: { path: string | null; name: string } | null; dryRun: boolean; ms: number
    // A Gmail error that means the connection is gone or lacks its permission (lib/expenses/gmail-parts.ts)
    gmailError?: unknown
  }

// The storage the copies go to (tests pass a stand-in)
export type ReceiptStorage = {
  upload(path: string, bytes: Buffer): Promise<void>
  remove(paths: string[]): Promise<void>
}
export const bucketStorage = (supabase: SupabaseClient): ReceiptStorage => ({
  upload: async (path, bytes) => {
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { upsert: true, contentType: 'application/pdf' })
    if (error) throw new BookamatError('database', `Beleg nicht gespeichert: ${error.message}`)
  },
  remove: async paths => {
    if (!paths.length) return
    const { error } = await supabase.storage.from(BUCKET).remove(paths)
    if (error) console.error('[receipts] old copy not removed:', error.message)
  },
})

// The paths a line's receipt is searched on (Bookmatic lib/matcher.ts enrichExpense), or why none
export function searchPaths(tx: EasybankTransaction, vendors: readonly Vendor[]): { paths: GmailPath[] } | { reason: string } {
  if (ownTransfer(tx)) return { reason: RECEIPT_TEXT.ownTransfer }
  if (cardSettlement(tx)) return { reason: RECEIPT_TEXT.cardSettlement }
  const fast = matchRules(tx, [...vendors])
  if (fast.rule || fast.tie.length) return { paths: [{ kind: 'sender', rules: fast.rule ? [fast.rule] : fast.tie }] }
  const name = cleanCounterparty(tx.counterparty)
  const domain = Object.entries(PROCESSOR_DOMAINS).find(([prefix]) => tx.counterparty.toUpperCase().includes(prefix))?.[1]
  return { paths: domain ? [{ kind: 'processor', domain, name }, { kind: 'keyword', name }] : [{ kind: 'keyword', name }] }
}

// A receipt the owner attached: by hand, or from the list
export const ownReceipt = (line: Pick<BankLine, 'receipt_path' | 'receipt_search' | 'receipt_gmail'>): boolean =>
  !!line.receipt_gmail || (!!line.receipt_path && !line.receipt_search?.chosen)

async function loadLine(supabase: SupabaseClient, lineId: string): Promise<StoredLine> {
  const { data, error } = await supabase.from('bank_lines').select(LINE_COLUMNS).eq('id', lineId).maybeSingle()
  if (error) throw new BookamatError('database', error.message)
  if (!data) throw new BookamatError('not_found', 'Kontozeile nicht gefunden', 404)
  return data as StoredLine
}

// Why Mado never books a line, its account and currency alone (lib/expenses/statement.ts
// accountGate with the owner's IBANs and Bookamat's accounts): the route's to say
export type AccountGate = (tx: EasybankTransaction, year: number) => Promise<string | null>

// Why a line is not searched, or null: a credit, a line booked, skipped or held, one on an
// account Mado never books or in another currency, one that names a Mado document
async function refusal(supabase: SupabaseClient, line: StoredLine, tx: EasybankTransaction, gate?: AccountGate): Promise<string | null> {
  if (lineKind(line) !== 'expense') return RECEIPT_TEXT.notDebit
  if (line.status !== 'open') return RECEIPT_TEXT.notOpen
  if (line.bookamat_pending) return RECEIPT_TEXT.pending
  const account = gate ? await gate(tx, Number(String(line.booked_on).slice(0, 4))) : null
  if (account) return account
  const named = namedDocument(tx, await readMadoNumbers(supabase))
  if (named) return madoDocumentText(named, false)
  return null
}

export { handReceipt, onlyFailed, receiptSearchForPage } from './receipt-state'

// The run of a line's search: the line (row 0) and the lines around it — their invoice numbers
// are not its receipts' — with the receipts other lines hold
async function lineRun(supabase: SupabaseClient, line: StoredLine, tx: EasybankTransaction, opts: { startedAt?: number; now?: () => number }) {
  const around: StoredLine[] = []
  const { data, error } = await supabase.from('bank_lines').select('id, cells, amount, booked_on')
    .gte('booked_on', day(String(line.booked_on), -AROUND_DAYS)).lte('booked_on', day(String(line.booked_on), AROUND_DAYS))
    .neq('id', line.id).order('booked_on').order('id').limit(CHUNK)
  if (error) throw new BookamatError('database', error.message)
  for (const l of (data ?? []) as StoredLine[]) {
    try { if (lineKind(l) === 'expense') { lineTransaction(l); around.push(l) } } catch { /* unreadable: not the line's concern */ }
  }
  const expenses = [tx, ...around.map(lineTransaction)]
  const run = newAnalyseRun(expenses, { maxDurationS: SEARCH_MAX_DURATION_S, startedAt: opts.startedAt, now: opts.now })
  const rowOf = new Map(around.map((l, k) => [l.id, k + 1]))
  let elsewhere = expenses.length
  for (let from = 0; ; from += CLAIM_PAGE) {
    const { data: claims, error: claimErr } = await supabase.from('receipt_claims').select('key, bank_line_id, label')
      .order('key').range(from, from + CLAIM_PAGE - 1)
    if (claimErr) throw new BookamatError('database', claimErr.message)
    const rows = (claims ?? []) as { key: string; bank_line_id: string; label: string }[]
    for (const c of rows) {
      const row = c.bank_line_id === line.id ? 0 : rowOf.get(c.bank_line_id) ?? elsewhere++
      run.claims.claim([c.key], row, c.bank_line_id === line.id ? run.labels[0] : c.label || 'einer anderen Zeile')
    }
    if (rows.length < CLAIM_PAGE) break
  }
  return run
}
// What Supabase answers at most per read
const CLAIM_PAGE = 1000

// The search as a line keeps it
function storedSearch(found: Awaited<ReturnType<typeof findGmailReceipt>>, at: string): BankLineReceiptSearch {
  const chosen = found.pick.chosen
  return {
    at,
    chosen: chosen ? {
      message_id: chosen.messageId, part_id: chosen.partId, file_name: chosen.fileName, subject: chosen.subject, from: chosen.from,
      date: chosen.date, sha256: chosen.sha256, via: chosen.via, ...(chosen.bodyText ? { body_text: cap(chosen.bodyText, EMAIL_TEXT_MAX) } : {}),
    } : null,
    check: chosen ? found.pick.check : null,
    read: chosen ? found.read : null,
    text: chosen ? cap(found.chosenText, RECEIPT_TEXT_MAX) : null,
    note: found.pick.note,
    plain_note: found.pick.plainNote,
    candidates: found.pick.candidates,
    failed: found.failed,
  }
}

// The line's receipt as it was loaded: the one step changes it only if it is still so
type Loaded = Pick<BankLine, 'id' | 'receipt_path' | 'receipt_search' | 'receipt_gmail'>
export type ReceiptStep = { status: 'ok' } | { status: 'changed' } | { status: 'not_found' } | { status: 'held'; label: string }

// set_line_receipt (20261118_receipts.sql): claims swapped (`keys` null: as they are; []: released)
// and the line's receipt fields set — or nothing, when the line changed since `loaded`
export async function setLineReceipt(
  supabase: SupabaseClient, loaded: Loaded,
  next: { keys: readonly string[] | null; label: string; path: string | null; name: string | null; search: BankLineReceiptSearch | null; gmail: BankLineGmailReceipt | null },
): Promise<ReceiptStep> {
  // The expected values are as the database holds them, so cleaning them changes nothing
  const { data, error } = await supabase.rpc('set_line_receipt', dbSafe({
    p_line: loaded.id, p_expected_path: loaded.receipt_path, p_expected_search_at: loaded.receipt_search?.at ?? null,
    p_expected_gmail: !!loaded.receipt_gmail, p_keys: next.keys ? [...next.keys] : null, p_label: next.label,
    p_path: next.path, p_name: next.name, p_search: next.search, p_gmail: next.gmail,
  }))
  if (error) throw new BookamatError('database', error.message)
  const step = data as ReceiptStep | null
  if (!step || !['ok', 'changed', 'not_found', 'held'].includes(step.status)) throw new BookamatError('database', 'set_line_receipt: unexpected answer')
  return step
}

// A step that threw (the database failing, the answer lost on the way): its outcome may be open,
// so its copy goes only when the line, read again, does not hold it. Unread, the copy stays: an
// unused copy harms nothing, a line whose copy is gone loses its receipt.
async function dropCopyUnlessKept(supabase: SupabaseClient, storage: ReceiptStorage, lineId: string, path: string): Promise<void> {
  const { data, error } = await supabase.from('bank_lines').select('receipt_path').eq('id', lineId).maybeSingle()
  if (error || (data as { receipt_path: string | null } | null)?.receipt_path === path) return
  await storage.remove([path])
}
const thrownStep = (supabase: SupabaseClient, storage: ReceiptStorage, lineId: string, path: string) => async (err: unknown): Promise<never> => {
  await dropCopyUnlessKept(supabase, storage, lineId, path).catch(() => undefined)
  throw err
}

// A search with no receipt of its own (a Beleg by hand in its place, or none): its list and notes
// stay, the receipt it attached and what was said of it go
export const withoutChosen = (s: BankLineReceiptSearch | null): BankLineReceiptSearch | null =>
  s ? { ...s, chosen: null, check: null, read: null, text: null, note: null, plain_note: null } : null

/**
 * Searches line `lineId`'s receipt in Gmail and keeps what it found (a dry run keeps nothing).
 * `auto`: the page's search after an upload, only for a line on or after the switch-over date
 * (decision D11); `expensesFrom`: that date.
 */
export async function searchLineReceipt(
  supabase: SupabaseClient,
  lineId: string,
  deps: GmailReceiptDeps,
  opts: {
    dryRun?: boolean; auto?: boolean; expensesFrom?: string | null; accountGate?: AccountGate
    startedAt?: number; now?: () => number; storage?: ReceiptStorage
  } = {},
): Promise<LineSearchResult> {
  const started = opts.startedAt ?? Date.now()
  const line = await loadLine(supabase, lineId)
  const tx = lineTransaction(line)
  const refused = await refusal(supabase, line, tx, opts.accountGate)
  if (refused) return { status: 'not_searched', reason: refused }
  if (ownReceipt(line)) return { status: 'not_searched', reason: RECEIPT_TEXT.ownReceipt }
  if (opts.auto && (!opts.expensesFrom || String(line.booked_on) < opts.expensesFrom)) return { status: 'not_searched', reason: RECEIPT_TEXT.beforeSwitch }
  // By itself only once: a line searched before is searched again on the owner's „Erneut“, or
  // when its search only failed
  if (opts.auto && line.receipt_search && !onlyFailed(line.receipt_search)) return { status: 'not_searched', reason: RECEIPT_TEXT.searchedBefore }

  const { data: ruleData, error: ruleErr } = await supabase.from('booking_rules').select('*').order('name').order('id')
  if (ruleErr) throw new BookamatError('database', ruleErr.message)
  const route = searchPaths(tx, vendorsOf((ruleData ?? []) as BookingRule[], null))
  if ('reason' in route) return { status: 'not_searched', reason: route.reason }

  const run = await lineRun(supabase, line, tx, { startedAt: started, now: opts.now })
  const found = await findGmailReceipt(tx, { paths: route.paths, run, row: 0 }, deps)
  const search = storedSearch(found, new Date((opts.now ?? Date.now)()).toISOString())
  const ms = (opts.now ?? Date.now)() - started
  const chosen = found.pick.chosen
  const gmailError = run.gmailAuthError ?? undefined
  if (opts.dryRun) return { status: 'searched', search: receiptSearchForPage(search)!, attached: chosen ? { path: null, name: chosen.fileName } : null, dryRun: true, ms, gmailError }

  // A new receipt: its copy first (a name of its own), then the one step; refused, its copy goes
  const storage = opts.storage ?? bucketStorage(supabase)
  const earlier = line.receipt_search?.chosen ? line.receipt_path : null
  if (chosen && found.chosenBase64) {
    const bytes = Buffer.from(found.chosenBase64, 'base64')
    const path = copyPath(line.id, chosen.sha256 ?? createHash('sha256').update(bytes).digest('hex'), chosen.fileName)
    await storage.upload(path, bytes)
    const step = await setLineReceipt(supabase, line, { keys: found.pick.claimKeys, label: run.labels[0], path, name: chosen.fileName, search, gmail: null })
      .catch(thrownStep(supabase, storage, line.id, path))
    if (step.status === 'ok') {
      if (earlier && earlier !== path) await storage.remove([earlier])
      return { status: 'searched', search: receiptSearchForPage(search)!, attached: { path, name: chosen.fileName }, dryRun: false, ms, gmailError }
    }
    await storage.remove([path])
    if (step.status !== 'held') throw new ReceiptError('line_changed', RECEIPT_TEXT.changed, 409)
    Object.assign(search, { chosen: null, check: null, read: null, text: null, note: RECEIPT_TEXT.claimedMeanwhile(step.label || 'einer anderen Zeile') })
  }
  // Nothing attached: the receipt an earlier search attached stays (Gmail failing, time running
  // out or the e-mail gone never take it away), with what was said of it; this search's list and
  // its failures beside it
  const kept = line.receipt_search?.chosen ?? null
  const stored: BankLineReceiptSearch = kept && line.receipt_search
    ? {
      ...search, chosen: kept, check: line.receipt_search.check, read: line.receipt_search.read, text: line.receipt_search.text,
      note: line.receipt_search.note, plain_note: line.receipt_search.plain_note,
      candidates: search.candidates.filter(c => !(c.message_id === kept.message_id && (c.part_id ?? null) === (kept.part_id ?? null))),
    }
    : search
  const step = await setLineReceipt(supabase, line, { keys: null, label: run.labels[0], path: line.receipt_path, name: line.receipt_name, search: stored, gmail: line.receipt_gmail })
  if (step.status !== 'ok') throw new ReceiptError('line_changed', RECEIPT_TEXT.changed, 409)
  return { status: 'searched', search: receiptSearchForPage(stored)!, attached: null, dryRun: false, ms, gmailError }
}

// The candidate a line's list names (its e-mail and part)
const listed = (line: Pick<BankLine, 'receipt_search'>, messageId: string, partId: string | null): GmailCandidate | null =>
  (line.receipt_search?.candidates ?? []).find(c => c.message_id === messageId && (c.part_id ?? null) === (partId ?? null)) ?? null

// What „Anhängen“ fetches and reads: the part from Gmail, its text and what Claude reads of it
export type AttachDeps = {
  fetchPdf: (messageId: string, partId: string | null) => Promise<{ base64: string; filename: string } | null>
  pdfText: GmailReceiptDeps['pdfText']
  readPdf: (base64: string) => Promise<ReceiptRead | null>
}

/**
 * „Anhängen“: a PDF the line's search found and did not attach becomes its receipt (Bookmatic's
 * route /api/import/gmail-receipt and lib/gmail-attach.ts). Read by Claude for the row's fields;
 * proven by the owner (receipt_check 'owner'). A PDF another line holds is not attached.
 */
export async function attachGmailCandidate(
  supabase: SupabaseClient, lineId: string, messageId: string, partId: string | null, deps: AttachDeps,
  opts: { storage?: ReceiptStorage; accountGate?: AccountGate } = {},
): Promise<{ path: string; name: string }> {
  const line = await loadLine(supabase, lineId)
  const tx = lineTransaction(line)
  const refused = await refusal(supabase, line, tx, opts.accountGate)
  if (refused) throw new ReceiptError('not_searchable', refused, 409)
  if (handReceipt(line)) throw new ReceiptError('not_attachable', RECEIPT_TEXT.handReceipt, 409)
  const c = listed(line, messageId, partId)
  if (!c) throw new ReceiptError('not_listed', RECEIPT_TEXT.notListed, 404)
  if (!gmailAttachable(c)) throw new ReceiptError('not_attachable', RECEIPT_TEXT.notAttachable, 400)
  const pdf = await deps.fetchPdf(messageId, partId)
  if (!pdf) throw new ReceiptError('not_listed', RECEIPT_TEXT.gone, 404)
  const bytes = Buffer.from(pdf.base64, 'base64')
  if (sniffAttachmentType(bytes) !== 'pdf') throw new ReceiptError('not_attachable', RECEIPT_TEXT.notPdf, 400)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const text = await deps.pdfText(pdf.base64).then(t => t.text).catch(() => '')
  const read = await deps.readPdf(pdf.base64).catch(() => null)
  const label = rowLabel(tx)
  const storage = opts.storage ?? bucketStorage(supabase)
  const name = pdf.filename || c.file_name || 'Beleg.pdf'
  const path = copyPath(line.id, sha256, name)
  await storage.upload(path, bytes)
  const gmail: BankLineGmailReceipt = {
    candidate: c, name, sha256, text: cap(text, RECEIPT_TEXT_MAX), unreadable: !read,
    extracted: { invoice_number: read?.invoice_number ?? null, date: read?.date ?? null, amount: read?.amount ?? null },
  }
  // The search's own receipt, or one attached from the list before, is replaced; its list stays
  const step = await setLineReceipt(supabase, line, {
    keys: ownClaimKeys({ messageId, partId, sha256, from: c.from, read }), label, path, name, search: withoutChosen(line.receipt_search), gmail,
  }).catch(thrownStep(supabase, storage, line.id, path))
  if (step.status === 'ok') {
    if (line.receipt_path && line.receipt_path !== path) await storage.remove([line.receipt_path])
    return { path, name }
  }
  await storage.remove([path])
  if (step.status === 'held') throw new ReceiptError('claimed', RECEIPT_TEXT.claimed(step.label || 'einer anderen Zeile'), 409)
  throw new ReceiptError('line_changed', RECEIPT_TEXT.changed, 409)
}

/**
 * „Beleg entfernen“, or a Beleg uploaded by hand in its place (the line's PATCH): the line's claims
 * go, a receipt from Gmail is forgotten (its list stays), in one step against the line as loaded.
 * The copies in the bucket are the page's to remove.
 */
export async function setHandReceipt(
  supabase: SupabaseClient, line: Loaded, receipt: { path: string; name: string } | null,
): Promise<ReceiptStep> {
  return setLineReceipt(supabase, line, {
    keys: [], label: '', path: receipt?.path ?? null, name: receipt?.name ?? null, search: withoutChosen(line.receipt_search), gmail: null,
  })
}

