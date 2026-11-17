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
// line gets it. A dry run („Probelauf“) searches and reads as a search does and keeps nothing.
//
// Gmail is only read. Server only: the route passes the Gmail API and the reader (deps).
import { createHash } from 'node:crypto'
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
import type { EasybankTransaction, GmailCandidate, Vendor } from './types'

// The route's time (src/app/api/bank-lines/[id]/receipts/*)
export const SEARCH_MAX_DURATION_S = 60
// What a line keeps of the receipt's text and of its e-mail's
export const RECEIPT_TEXT_MAX = 6000
export const EMAIL_TEXT_MAX = 4000
// The lines around a line whose invoice numbers and receipts are not its own
const AROUND_DAYS = 40
const CHUNK = 500

const BUCKET = 'receipts'
const day = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const cap = (s: string | null | undefined, max: number): string | null => (s ? s.slice(0, max) : null)
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
  claimedMeanwhile: (label: string) => `⚠ Der gefundene Beleg hängt inzwischen an ${label} — nicht angehängt`,
  notListed: 'Dieser Beleg steht nicht in der Liste der Zeile — erneut suchen',
  notAttachable: 'Dieser Beleg ist kein PDF bis 10 MB — nicht anhängbar',
  notPdf: 'Die Datei aus Gmail ist kein PDF — nicht angehängt',
  gone: 'Der Beleg ist in Gmail nicht mehr zu finden — erneut suchen',
  claimed: (label: string) => `Dieser Beleg hängt schon an ${label} — dort entfernen, dann hier anhängen`,
  changed: 'Die Zeile hat sich inzwischen geändert — Seite neu laden',
} as const

// What a receipt route answers when the owner's step can't be done: the line changed meanwhile,
// a receipt another line holds, a PDF that is none, Gmail not connected (src/lib/expenses/api.ts)
export class ReceiptError extends Error {
  constructor(readonly code: 'changed' | 'invalid_status' | 'invalid_request' | 'claimed' | 'not_found' | 'gmail_not_connected' | 'gmail_scope', message: string, readonly status: number) {
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

// Why a line is not searched, or null
async function refusal(supabase: SupabaseClient, line: StoredLine, tx: EasybankTransaction): Promise<string | null> {
  if (lineKind(line) !== 'expense') return RECEIPT_TEXT.notDebit
  if (line.status !== 'open') return RECEIPT_TEXT.notOpen
  if (line.bookamat_pending) return RECEIPT_TEXT.pending
  const named = namedDocument(tx, await readMadoNumbers(supabase))
  if (named) return madoDocumentText(named, false)
  return null
}

// The run of a line's search: the line (row 0) and the lines around it — their invoice numbers
// are not its receipts' — with the receipts other lines hold
async function lineRun(supabase: SupabaseClient, line: StoredLine, tx: EasybankTransaction, opts: { startedAt?: number; now?: () => number }) {
  const around: StoredLine[] = []
  const { data, error } = await supabase.from('bank_lines').select(LINE_COLUMNS)
    .gte('booked_on', day(String(line.booked_on), -AROUND_DAYS)).lte('booked_on', day(String(line.booked_on), AROUND_DAYS))
    .neq('id', line.id).order('booked_on').order('id').limit(CHUNK)
  if (error) throw new BookamatError('database', error.message)
  for (const l of (data ?? []) as StoredLine[]) {
    try { if (lineKind(l) === 'expense') { lineTransaction(l); around.push(l) } } catch { /* unreadable: not the line's concern */ }
  }
  const expenses = [tx, ...around.map(lineTransaction)]
  const run = newAnalyseRun(expenses, { maxDurationS: SEARCH_MAX_DURATION_S, startedAt: opts.startedAt, now: opts.now })
  const rowOf = new Map(around.map((l, k) => [l.id, k + 1]))
  const { data: claims, error: claimErr } = await supabase.from('receipt_claims').select('key, bank_line_id, label')
  if (claimErr) throw new BookamatError('database', claimErr.message)
  let elsewhere = expenses.length
  for (const c of (claims ?? []) as { key: string; bank_line_id: string; label: string }[]) {
    const row = c.bank_line_id === line.id ? 0 : rowOf.get(c.bank_line_id) ?? elsewhere++
    run.claims.claim([c.key], row, c.bank_line_id === line.id ? run.labels[0] : c.label || 'einer anderen Zeile')
  }
  return run
}

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

// The line's claims replaced by `keys` (none: released). A key another line holds: its label.
async function claimFor(supabase: SupabaseClient, lineId: string, keys: readonly string[], label: string): Promise<{ held: string } | null> {
  if (keys.length) {
    const { data, error } = await supabase.from('receipt_claims').select('key, bank_line_id, label').in('key', [...keys])
    if (error) throw new BookamatError('database', error.message)
    const other = ((data ?? []) as { bank_line_id: string; label: string }[]).find(c => c.bank_line_id !== lineId)
    if (other) return { held: other.label || 'einer anderen Zeile' }
  }
  const { error: delErr } = await supabase.from('receipt_claims').delete().eq('bank_line_id', lineId)
  if (delErr) throw new BookamatError('database', delErr.message)
  if (!keys.length) return null
  const { error } = await supabase.from('receipt_claims').insert(keys.map(key => ({ key, bank_line_id: lineId, label })))
  if (error) {
    // Another line's search claimed one of the keys meanwhile
    if (error.code === '23505') return { held: 'einer anderen Zeile' }
    throw new BookamatError('database', error.message)
  }
  return null
}

/**
 * Searches line `lineId`'s receipt in Gmail and keeps what it found (a dry run keeps nothing).
 * `auto`: the page's search after an upload, only for a line on or after the switch-over date
 * (decision D11); `expensesFrom`: that date.
 */
export async function searchLineReceipt(
  supabase: SupabaseClient,
  lineId: string,
  deps: GmailReceiptDeps,
  opts: { dryRun?: boolean; auto?: boolean; expensesFrom?: string | null; startedAt?: number; now?: () => number; storage?: ReceiptStorage } = {},
): Promise<LineSearchResult> {
  const started = opts.startedAt ?? Date.now()
  const line = await loadLine(supabase, lineId)
  const tx = lineTransaction(line)
  const refused = await refusal(supabase, line, tx)
  if (refused) return { status: 'not_searched', reason: refused }
  if (ownReceipt(line)) return { status: 'not_searched', reason: RECEIPT_TEXT.ownReceipt }
  if (opts.auto && (!opts.expensesFrom || String(line.booked_on) < opts.expensesFrom)) return { status: 'not_searched', reason: RECEIPT_TEXT.beforeSwitch }

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
  if (opts.dryRun) return { status: 'searched', search, attached: chosen ? { path: null, name: chosen.fileName } : null, dryRun: true, ms, gmailError }

  // The receipt the line's earlier search attached goes; what this one attaches is claimed first
  const storage = opts.storage ?? bucketStorage(supabase)
  const old = line.receipt_search?.chosen ? line.receipt_path : null
  let attached: { path: string; name: string } | null = null
  if (chosen && found.chosenBase64) {
    const held = await claimFor(supabase, line.id, found.pick.claimKeys, run.labels[0])
    if (held) {
      Object.assign(search, { chosen: null, check: null, read: null, text: null, note: RECEIPT_TEXT.claimedMeanwhile(held.held) })
    } else {
      const bytes = Buffer.from(found.chosenBase64, 'base64')
      const path = `${line.id}/gmail-${(chosen.sha256 ?? createHash('sha256').update(bytes).digest('hex')).slice(0, 8)}-${storedName(chosen.fileName)}`
      await storage.upload(path, bytes)
      attached = { path, name: chosen.fileName }
    }
  } else {
    await claimFor(supabase, line.id, [], run.labels[0])
  }

  const { data: saved, error } = await supabase.from('bank_lines')
    .update({ receipt_search: search, receipt_gmail: null, ...(attached ? { receipt_path: attached.path, receipt_name: attached.name } : old ? { receipt_path: null, receipt_name: null } : {}) })
    .eq('id', line.id).eq('status', 'open').is('bookamat_pending', null).select('id')
  if (error || !saved?.length) {
    // Booked or held meanwhile: nothing kept
    if (attached) await storage.remove([attached.path])
    await claimFor(supabase, line.id, [], run.labels[0]).catch(() => null)
    if (error) throw new BookamatError('database', error.message)
    throw new ReceiptError('changed', RECEIPT_TEXT.changed, 409)
  }
  if (old && old !== attached?.path) await storage.remove([old])
  return { status: 'searched', search, attached, dryRun: false, ms, gmailError }
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
  opts: { storage?: ReceiptStorage } = {},
): Promise<{ path: string; name: string }> {
  const line = await loadLine(supabase, lineId)
  const tx = lineTransaction(line)
  const refused = await refusal(supabase, line, tx)
  if (refused) throw new ReceiptError('invalid_status', refused, 409)
  const c = listed(line, messageId, partId)
  if (!c) throw new ReceiptError('not_found', RECEIPT_TEXT.notListed, 404)
  if (!gmailAttachable(c)) throw new ReceiptError('invalid_request', RECEIPT_TEXT.notAttachable, 400)
  const pdf = await deps.fetchPdf(messageId, partId)
  if (!pdf) throw new ReceiptError('not_found', RECEIPT_TEXT.gone, 404)
  const bytes = Buffer.from(pdf.base64, 'base64')
  if (sniffAttachmentType(bytes) !== 'pdf') throw new ReceiptError('invalid_request', RECEIPT_TEXT.notPdf, 400)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const text = await deps.pdfText(pdf.base64).then(t => t.text).catch(() => '')
  const read = await deps.readPdf(pdf.base64).catch(() => null)
  const label = rowLabel(tx)
  const held = await claimFor(supabase, line.id, ownClaimKeys({ messageId, partId, sha256, from: c.from, read }), label)
  if (held) throw new ReceiptError('claimed', RECEIPT_TEXT.claimed(held.held), 409)

  const storage = opts.storage ?? bucketStorage(supabase)
  const name = pdf.filename || c.file_name || 'Beleg.pdf'
  const path = `${line.id}/gmail-${sha256.slice(0, 8)}-${storedName(name)}`
  await storage.upload(path, bytes)
  const gmail: BankLineGmailReceipt = {
    candidate: c, name, sha256, text: cap(text, RECEIPT_TEXT_MAX), unreadable: !read,
    extracted: { invoice_number: read?.invoice_number ?? null, date: read?.date ?? null, amount: read?.amount ?? null },
  }
  // The search's own receipt, if it had one, is replaced; its list stays
  const old = line.receipt_path && line.receipt_path !== path ? line.receipt_path : null
  const search = line.receipt_search ? { ...line.receipt_search, chosen: null, check: null, read: null, text: null } : null
  const { data: saved, error } = await supabase.from('bank_lines')
    .update({ receipt_gmail: gmail, receipt_search: search, receipt_path: path, receipt_name: name })
    .eq('id', line.id).eq('status', 'open').is('bookamat_pending', null).select('id')
  if (error || !saved?.length) {
    await storage.remove([path])
    await claimFor(supabase, line.id, [], label).catch(() => null)
    if (error) throw new BookamatError('database', error.message)
    throw new ReceiptError('changed', RECEIPT_TEXT.changed, 409)
  }
  if (old) await storage.remove([old])
  return { path, name }
}

/**
 * „Beleg entfernen“, or a Beleg uploaded by hand in its place: the line's claims go, a receipt
 * from Gmail is forgotten (its list stays). The copy in the bucket is the caller's to remove.
 * Returns the update the line's PATCH applies with its own fields.
 */
export async function releaseGmailReceipt(supabase: SupabaseClient, line: Pick<BankLine, 'id' | 'receipt_search'>): Promise<Pick<BankLine, 'receipt_gmail'> & Partial<Pick<BankLine, 'receipt_search'>>> {
  await claimFor(supabase, line.id, [], '')
  return {
    receipt_gmail: null,
    ...(line.receipt_search?.chosen ? { receipt_search: { ...line.receipt_search, chosen: null, check: null, read: null, text: null } } : {}),
  }
}
