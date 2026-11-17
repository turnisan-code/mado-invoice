/**
 * Which Gmail PDF a debit's row gets (P2-11, PR „Job 1 fixes“ § 2.1 D).
 *
 * A PDF found in Gmail is attached only with proof: its euro total or amount due equals the
 * debit (gross, or net of the bank's SPESEN), its foreign total equals the card stamp's own
 * amount, or the invoice number in the bank text is on it. The one exception is a
 * Buchungsregel's sender's only PDF whose amount could not be checked (owner decision D2):
 * attached as 'unchecked'. Anything doubtful is marked (receipt_check) and never ticked for
 * the owner; what is not attached is listed on the row with why. Several PDFs of the debit's
 * amount are counted before the run's claims hide any of them, so a second identical
 * purchase is never matched silently.
 *
 * Also here: the run's claims and limiter, the doubt the page and the booking route test,
 * a draft's Gmail receipts from before the update, and every text of P2-11.
 *
 * Pure and client-safe: imports only ./money, ./booking-dates, ./invoice-parsing and types
 * (lib/import-drafts.ts reaches it through lib/rule-match.ts; the import page uses it).
 */

import type { EasybankTransaction, GmailCandidate, MatchedTransaction, ReceiptCheck } from './types'
import type { PdfInvoiceData } from './pdf-reader'
import { amountIn, amountMatchesTransaction, amountsInText, cents, eur } from './money'
import { cardForeignAmount, deDate, payDay } from './booking-dates'
import { cleanCounterparty, emailDateToIso, invoiceNumberInText, RECEIPT_UNREADABLE_NOTE } from './invoice-parsing'

type TxLike = Pick<EasybankTransaction, 'date' | 'amount' | 'counterparty' | 'reference' | 'raw'> & Partial<Pick<EasybankTransaction, 'fee' | 'net_amount'>>

// ─── The bank text's invoice number ───────────────────────────────────────────────

// An invoice number as receipts are compared with it: no spaces or separators, upper case,
// leading zeros dropped; null under 6 characters (a 4-digit „Rechnungsnr 2026“ would be on
// every receipt of the year)
export function normInvoiceNo(s: string | null | undefined): string | null {
  const n = String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^0+/, '')
  return n.length >= 6 ? n : null
}

// The invoice number a debit's bank text names (column 1, else the reference): `number` as
// written there, `key` normalised. Read as the text is, else with easybank's line breaks
// („|“, every 57 characters) removed, which can cut a number in two. null without one.
export type BankInvoice = { number: string; key: string }
export function bankInvoice(tx: Pick<TxLike, 'reference' | 'raw'>): BankInvoice | null {
  const text = tx.raw?.col1 ?? tx.reference ?? ''
  for (const t of [text, text.replace(/\|/g, '')]) {
    const number = invoiceNumberInText(t)
    const key = normInvoiceNo(number)
    if (number && key) return { number, key }
  }
  return null
}
export const bankInvoiceKey = (tx: Pick<TxLike, 'reference' | 'raw'>): string | null => bankInvoice(tx)?.key ?? null

// Digit groups split by one space, dot or hyphen, joined: „9201 9184 0126“ → „920191840126“
const joinDigitGroups = (s: string) => s.replace(/(\d)[ .\-](?=\d)/g, '$1')

/**
 * Whether a document (a subject, a file name, a PDF's text, a read invoice number) shows the
 * invoice number `key` (normalised): as a whole token — no digit right before or after a
 * number, no letter or digit around one with letters —, leading zeros allowed, any case; in
 * the text as it is, or with its digit groups joined.
 */
export function numberOnDocument(key: string | null | undefined, text: string | null | undefined): boolean {
  if (!key || !text || !/^[A-Z0-9]+$/.test(key)) return false
  const re = /^\d+$/.test(key)
    ? new RegExp(`(?<!\\d)0*${key}(?!\\d)`)
    : new RegExp(`(?<![A-Za-z0-9])0*${key}(?![A-Za-z0-9])`, 'i')
  return re.test(text) || re.test(joinDigitGroups(text))
}

// The number a reader read is the bank's: equal once normalised, or the bank's on it as a
// token („RE-910000000123“)
export const sameInvoiceNumber = (key: string | null | undefined, read: string | null | undefined): boolean =>
  !!key && !!read && (normInvoiceNo(read) === key || numberOnDocument(key, read))

// ─── Candidates ─────────────────────────────────────────────────────────────────────

// What the PDF reader read of a candidate (lib/ai-extractor.ts pdfInvoiceFields)
export type ReceiptRead = Pick<PdfInvoiceData, 'amount' | 'amount_due' | 'currency' | 'foreign_total' | 'invoice_number' | 'date' | 'vatin' | 'document_type'>

// How a candidate was found: a Buchungsregel's sender (`ruleIds`: the rules whose search
// found it), a payment processor's domain with the vendor's name in the e-mail, a search for
// the vendor's name
export type ReceiptVia =
  | { kind: 'sender'; sender: string; ruleIds: string[] }
  | { kind: 'processor'; domain: string; name: string }
  | { kind: 'keyword'; name: string }

// One PDF part of an e-mail Analyse found for a debit
export type PdfCandidate = {
  messageId: string
  partId: string | null
  fileName: string
  subject: string
  from: string
  date: string | null          // the e-mail's Date header
  order: number                // Gmail's order, then MIME order
  // The PDF parts of its e-mail (none said: one). The subject speaks for a part only when it
  // is the e-mail's only one: of two invoices, or an invoice and a payment's confirmation,
  // the subject's number proves neither.
  pdfParts?: number
  size: number | null
  sha256: string | null
  // pdf-parse's text: '' for a PDF without a text layer (a scan); null when its bytes are not here
  text: string | null
  pages: number | null
  downloaded: boolean          // its bytes are here: Analyse can attach it
  via: ReceiptVia
  bodyText?: string            // the e-mail's own text
  read?: ReceiptRead | null    // what the reader read
  readError?: string | null    // why the reader failed
  // Why it was not read: over 10 MB, beyond what its search downloads, a failed download,
  // more than 10 pages, the run's read time or its reads used up, the row's reads used up,
  // another row's, or another PDF matched already
  notRead?: 'too_large' | 'not_downloaded' | 'download_failed' | 'pages' | 'time' | 'budget' | 'row_cap' | 'owned' | 'matched'
}
// An e-mail found without a PDF part
export type EmailWithoutPdf = { messageId: string; subject: string; from: string; date: string | null; via: ReceiptVia }

// A candidate's claim key, and the ones its copies share
export const partKey = (messageId: string, partId: string | null) => `gmail:${messageId}:${partId ?? ''}`
const shaKey = (sha: string) => `sha:${sha}`
const invKey = (domain: string, no: string) => `inv:${domain}:${no}`
// A candidate's own claim keys: its part, its bytes, its sender domain with the invoice
// number read (≥ 6 characters)
export function ownClaimKeys(c: Pick<PdfCandidate, 'messageId' | 'partId' | 'sha256' | 'from' | 'read'>): string[] {
  const domain = senderDomain(c.from)
  const no = normInvoiceNo(c.read?.invoice_number)
  return [partKey(c.messageId, c.partId), ...(c.sha256 ? [shaKey(c.sha256)] : []), ...(no && domain ? [invKey(domain, no)] : [])]
}

// The sender's domain of a From header („Muster GmbH <rechnung@muster.example>“), lower case
export function senderDomain(from: string | null | undefined): string {
  const addr = /<([^>]*)>/.exec(from ?? '')?.[1] ?? from ?? ''
  const at = addr.lastIndexOf('@')
  return at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : ''
}

// ─── Evidence ───────────────────────────────────────────────────────────────────────

export type MatchedOn = 'gross' | 'net' | 'due' | 'foreign'
const within = (a: number, b: number, c: number) => Math.abs(cents(a) - cents(b)) <= c

// A foreign total is the card stamp's own amount: the same currency, within a cent
function foreignIsDebit(total: number, currency: string | null | undefined, tx: TxLike): boolean {
  const card = cardForeignAmount(tx)
  return !!card && (currency ?? '').trim().toUpperCase() === card.currency && within(total, card.amount, 1)
}

/**
 * The amount evidence of what the reader read: its euro total equals the debit ('gross') or
 * the debit without the bank's SPESEN ('net'), within 2 cents; else its amount due does
 * ('due'); else its foreign total and currency equal the card stamp's own amount, within a
 * cent ('foreign'). No exchange rate is used. null without.
 */
export function amountEvidence(read: ReceiptRead | null | undefined, tx: TxLike): MatchedOn | null {
  if (!read) return null
  const net = tx.net_amount
  if (read.amount != null && within(read.amount, tx.amount, 2)) return 'gross'
  if (read.amount != null && net != null && within(read.amount, net, 2)) return 'net'
  if (read.amount_due != null && (within(read.amount_due, tx.amount, 2) || (net != null && within(read.amount_due, net, 2)))) return 'due'
  if (read.foreign_total != null && foreignIsDebit(read.foreign_total, read.currency, tx)) return 'foreign'
  return null
}

// The debit — gross, net or the card stamp's own amount — among the amounts a text shows
export function debitInText(text: string | null | undefined, tx: TxLike): boolean {
  if (!text) return false
  const wanted = [tx.amount, tx.net_amount, cardForeignAmount(tx)?.amount].filter((n): n is number => n != null).map(cents)
  return amountsInText(text).some(a => wanted.includes(cents(a)))
}

// The number evidence of a candidate: the bank's number in its subject, file name or text,
// or the number the reader read
const numberEvidence = (c: PdfCandidate, key: string | null) =>
  !!key && ([c.subject, c.fileName, c.text].some(d => numberOnDocument(key, d)) || sameInvoiceNumber(key, c.read?.invoice_number))

const DAY = 86_400_000
// Days between an e-mail's date and the day of payment; unknown dates last
function daysFrom(date: string | null | undefined, payRef: string): number {
  const iso = emailDateToIso(date)
  if (!iso) return Infinity
  return Math.abs(Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${payRef}T00:00:00Z`)) / DAY
}
const payRefOf = (tx: TxLike) => payDay(tx).payDate ?? tx.date

// A PDF without a text layer (a scan): pdf-parse gives it „\n\n“ a page, never '' (repair
// check GI-1); null is a PDF whose bytes are not here
export const noTextLayer = (text: string | null | undefined): boolean => text != null && !text.trim()

/**
 * The order Analyse reads candidates in: the bank's number on it, then the debit (gross, net
 * or foreign) among the amounts its text shows, then no text layer (a scan may be it; a text
 * without the debit hardly is), then the e-mail nearest the day of payment, then Gmail's
 * order. A PDF whose bytes are not here comes last.
 */
export function rankCandidates<C extends PdfCandidate>(cands: readonly C[], ctx: { tx: TxLike; bank: BankInvoice | null }): C[] {
  const payRef = payRefOf(ctx.tx)
  const score = (c: C): number[] => [
    c.downloaded ? 0 : 1,
    numberEvidence(c, ctx.bank?.key ?? null) ? 0 : 1,
    debitInText(c.text, ctx.tx) ? 0 : 1,
    noTextLayer(c.text) ? 0 : 1,
    daysFrom(c.date, payRef),
    c.order,
  ]
  return cands.map(c => ({ c, s: score(c) })).sort((a, b) => {
    for (let k = 0; k < a.s.length; k++) if (a.s[k] !== b.s[k]) return a.s[k] < b.s[k] ? -1 : 1
    return 0
  }).map(x => x.c)
}

// ─── The pick ───────────────────────────────────────────────────────────────────────

export type PickContext = {
  tx: TxLike
  bank: BankInvoice | null
  label: string                                        // this row's (rowLabel)
  claimedBy: (key: string) => string | null            // the label of another row owning a claim key
  otherNumbers: readonly { key: string; label: string }[]  // invoice numbers other rows' bank texts name, this row's not
}

export type ReceiptPick = {
  chosen: PdfCandidate | null
  read: ReceiptRead | null                             // what was read of the document attached
  check: Exclude<ReceiptCheck, 'owner'> | null
  matchedOn: MatchedOn | null
  claimKeys: string[]
  note: string | null                                  // match_note's part on the receipt: the warning first, then where it came from
  plainNote: string | null                             // for a row that needs no Beleg: the not-attached warning, plain
  candidates: GmailCandidate[]                         // found and not attached
}

// The documents a reader never attaches
const NOT_INVOICE = ['order_confirmation', 'reminder', 'delivery_note', 'quote']
// A file name that looks like an invoice: the copy attached of several
const INVOICE_NAME = /rechnung|invoice|receipt|beleg|quittung|bill/i
// An e-mail without PDF whose subject names a receipt: said also on the name search
const INVOICE_SUBJECT = /rechnung|invoice|receipt|beleg|quittung/i

type Facts = {
  c: PdfCandidate
  keys: string[]
  domain: string
  readNo: string | null
  number: boolean
  amount: MatchedOn | null
  excluded: 'number' | 'credit_note' | 'not_invoice' | 'too_large' | null
  claimedBy: string | null
}
type Group = {
  members: Facts[]
  rep: Facts
  matched: Facts | null        // the member whose amount matched
  number: boolean
  claimedBy: string | null
  keys: string[]
}

const isNegative = (r: ReceiptRead | null | undefined) =>
  !!r && ((r.amount ?? 0) < 0 || (r.amount_due ?? 0) < 0 || (r.foreign_total ?? 0) < 0)

// What speaks for a part as its own: its subject only when it is its e-mail's only PDF, its
// file name, its text
const ownDocuments = (c: PdfCandidate) => [(c.pdfParts ?? 1) > 1 ? null : c.subject, c.fileName, c.text]

// Whether a group's document was read with the bank's invoice number: of several with number
// evidence, the one that is the bank's invoice — another's text or subject can name it too
const readWithBankNumber = (g: Group, key: string | null | undefined) => g.members.some(m => sameInvoiceNumber(key, m.c.read?.invoice_number))

function factsOf(c: PdfCandidate, ctx: PickContext): Facts {
  const key = ctx.bank?.key ?? null
  const read = c.read ?? null
  const domain = senderDomain(c.from)
  const readNo = normInvoiceNo(read?.invoice_number)
  const onDoc = !!key && ownDocuments(c).some(d => numberOnDocument(key, d))
  const conflict = !!key && !!readNo && !sameInvoiceNumber(key, read?.invoice_number) && !onDoc
  const docType = read?.document_type ?? null
  const excluded = conflict ? 'number'
    : docType === 'credit_note' || isNegative(read) ? 'credit_note'
    : docType && NOT_INVOICE.includes(docType) ? 'not_invoice'
    : c.notRead === 'too_large' ? 'too_large'
    : null
  const keys = ownClaimKeys(c)
  // Another row's: claimed, or carrying a number another row's bank text names — never one
  // read with this row's own number (an invoice that prints the one before it is its own)
  const carried = sameInvoiceNumber(key, read?.invoice_number) ? undefined
    : ctx.otherNumbers.find(o => sameInvoiceNumber(o.key, read?.invoice_number) || ownDocuments(c).some(d => numberOnDocument(o.key, d)))
  const claimedBy = keys.map(k => ctx.claimedBy(k)).find((l): l is string => !!l) ?? carried?.label ?? null
  return { c, keys, domain, readNo, number: onDoc || sameInvoiceNumber(key, read?.invoice_number), amount: amountEvidence(read, ctx.tx), excluded, claimedBy }
}

// Whether a candidate, as far as it was read, proves itself by the debit's amount and could
// be attached: not excluded (another invoice number, a credit note, no invoice), no other
// row's. Analyse stops reading at the first (lib/gmail-receipt.ts).
export function matchesDebit(c: PdfCandidate, ctx: PickContext): boolean {
  const f = factsOf(c, ctx)
  return !!f.amount && !f.excluded && !f.claimedBy
}

// Copies of one document: the same bytes, or the same sender domain and invoice number
function copyGroups(list: Facts[]): Group[] {
  const parent = list.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const seen = new Map<string, number>()
  list.forEach((f, i) => {
    const ids = [...(f.c.sha256 ? [shaKey(f.c.sha256)] : []), ...(f.readNo && f.domain ? [invKey(f.domain, f.readNo)] : [])]
    for (const id of ids) {
      const j = seen.get(id)
      if (j == null) seen.set(id, i)
      else parent[find(i)] = find(j)
    }
  })
  const byRoot = new Map<number, Facts[]>()
  list.forEach((f, i) => {
    const r = find(i)
    byRoot.set(r, [...(byRoot.get(r) ?? []), f])
  })
  return Array.from(byRoot.values()).map(members => {
    // The copy attached: one whose amount is the debit's — two PDFs of one sender and one
    // invoice number can be read with different amounts (an invoice and a payment's receipt),
    // and the one attached for its amount is the one that has it —, then one Analyse has the
    // bytes of, an invoice-like name, then MIME / Gmail order
    const rep = [...members].sort((a, b) =>
      Number(!a.amount) - Number(!b.amount)
      || Number(!a.c.downloaded) - Number(!b.c.downloaded)
      || Number(!INVOICE_NAME.test(a.c.fileName)) - Number(!INVOICE_NAME.test(b.c.fileName))
      || a.c.order - b.c.order)[0]
    return {
      members,
      rep,
      matched: rep.amount ? rep : null,
      number: members.some(m => m.number),
      claimedBy: members.map(m => m.claimedBy).find((l): l is string => !!l) ?? null,
      keys: Array.from(new Set(members.flatMap(m => m.keys))),
    }
  })
}

// What was read of a group's document: its copy attached, else a copy read
const readOfGroup = (g: Group): ReceiptRead | null => g.rep.c.read ?? g.members.map(m => m.c.read).find(r => !!r) ?? null

// The amount a candidate matched on, as the texts write it
function matchedAmountText(on: MatchedOn, r: ReceiptRead): string {
  if (on === 'foreign') return amountIn(r.foreign_total ?? 0, (r.currency ?? '').trim().toUpperCase())
  return eur((on === 'due' ? r.amount_due : r.amount) ?? 0)
}

// ─── Texts (exact, „…“ quotes; one note part each — the page splits notes at „ · “) ───

// A subject, file name, sender or row label inside a note: „ · “ would split it
export const noteSafe = (s: string | null | undefined): string => String(s ?? '').replace(/ · /g, ' - ')

// A row as other rows' notes name it: „TT.MM.JJJJ Name Betrag“, with the bank text's invoice
// number when it has one (two debits of one day and amount differ by it)
export function rowLabel(tx: TxLike): string {
  const bank = bankInvoice(tx)
  const base = `${deDate(tx.date)} ${cleanCounterparty(tx.counterparty)} ${eur(tx.amount)}`
  return bank ? `${base} · Rechnungsnr. ${bank.number}` : base
}

const belege = (n: number) => `${n} ${n === 1 ? 'Beleg' : 'Belege'}`
const emailDay = (date: string | null | undefined) => {
  const iso = emailDateToIso(date)
  return iso ? deDate(iso) : null
}

// Where the receipt came from (provenance, no ⚠): the parts before „Betrag … stimmt“
function provenancePrefix(via: ReceiptVia): string[] {
  if (via.kind === 'sender') return [`Gmail: ${noteSafe(via.sender)}`]
  if (via.kind === 'processor') return [`Gmail: ${noteSafe(via.domain)}`, `„${noteSafe(via.name)}“ im E-Mail-Text`]
  return [`Gmail-Suche nach „${noteSafe(via.name)}“`]
}
// Its amount, as it matched
function amountProvenance(on: MatchedOn, r: ReceiptRead, tx: TxLike): string {
  if (on === 'net') {
    const fee = tx.fee ?? (tx.net_amount != null ? (cents(tx.amount) - cents(tx.net_amount)) / 100 : 0)
    return `Betrag ${eur(r.amount ?? 0)} + ${eur(fee)} Spesen stimmt`
  }
  if (on === 'due') return `Zahlbetrag ${eur(r.amount_due ?? 0)} stimmt`
  if (on === 'foreign') return `Betrag ${matchedAmountText(on, r)} stimmt (Kartenumsatz)`
  return `Betrag ${eur(r.amount ?? 0)} stimmt`
}

// A warning about receipts found but not attached: what was found, then what to do. A row
// that needs no Beleg (an AI suggestion without requires_invoice) says it plainly instead.
type Warning = { statement: string; tail: string }
const warned = (w: Warning) => `⚠ ${w.statement} — ${w.tail}`
const plainly = (w: Warning) => `${w.statement} — kein Beleg nötig`
const NOT_ATTACHED_TAIL = 'nicht angehängt: Beleg prüfen und anhängen'

export const ambiguousNote = (k: number, amount: string, file: string, day: string | null): string =>
  `⚠ ${k} Belege mit Betrag ${amount} in Gmail — angehängt ist „${noteSafe(file)}“${day ? ` vom ${day}` : ''}, der Zahlung am nächsten: prüfen`
export const numberAmountNote = (n: string, read: number, debit: number): string =>
  `⚠ Beleg über Rechnungsnr. ${n} gefunden, aber Betrag ${eur(read)} statt ${eur(debit)} — Beleg prüfen`
export const numberForeignNote = (n: string, foreign: string, debit: number): string =>
  `⚠ Beleg über Rechnungsnr. ${n} gefunden, Betrag ${foreign} — mit ${eur(debit)} nicht vergleichbar, Beleg prüfen`
export const uncheckedNote = (sender: string, reason: string): string =>
  `⚠ Beleg von ${noteSafe(sender)} angehängt, Betrag nicht geprüft (${reason}) — Beleg prüfen`
// A scan in the e-mail of the receipt attached by its amount alone, left unread: it may be the
// invoice, the one attached its payment's confirmation (repair check GI-4)
export const unreadScanBesideNote = (file: string, reason: string): string =>
  `⚠ In derselben E-Mail „${noteSafe(file)}“ nicht geprüft (${reason}) — angehängt nach dem Betrag: Beleg prüfen`
// Why the amount of an 'unchecked' receipt was not checked
export const UNCHECKED_REASONS = {
  unreadable: 'nicht lesbar',
  time: 'Analyse-Zeit aufgebraucht',
  pages: 'mehr als 10 Seiten',
  noTotal: 'kein Betrag gelesen',
  foreign: (cur: string) => `Betrag in ${cur}`,
}
// Why a scan beside the receipt attached by its amount was not read: the read stop or the
// deadline, the run's reads, the row's
const UNREAD_SCAN_REASONS: Partial<Record<NonNullable<PdfCandidate['notRead']>, string>> = {
  time: UNCHECKED_REASONS.time,
  budget: 'Lesebudget der Analyse aufgebraucht',
  row_cap: 'Leselimit der Zeile erreicht',
}
// `timeCut`: some of the unchecked were not read for time (the read stop, the deadline) — said,
// as the D2 note says it (review check GMAIL-B5)
const noneFound = (n: number, unchecked: number, tx: TxLike, timeCut = false): Warning => ({
  statement: `${belege(n)} in Gmail gefunden, ${unchecked ? `${unchecked} davon nicht geprüft${timeCut ? ` (${UNCHECKED_REASONS.time})` : ''}, ` : 'aber '}keiner mit Betrag ${eur(tx.amount)}${tx.net_amount != null ? ` oder ${eur(tx.net_amount)} ohne Spesen` : ''}`,
  tail: NOT_ATTACHED_TAIL,
})
const foreignFound = (n: number, currency: string, foreign: string, tx: TxLike): Warning => ({
  statement: `${belege(n)} in Gmail gefunden, Betrag in ${currency} (${foreign})`,
  tail: `mit der Abbuchung ${eur(tx.amount)} nicht vergleichbar, ${NOT_ATTACHED_TAIL}`,
})
const unreadableFound = (n: number): Warning => ({ statement: `${belege(n)} in Gmail gefunden, aber nicht lesbar`, tail: NOT_ATTACHED_TAIL })
const claimedFound = (file: string, amount: string, label: string, own: string): Warning => ({
  statement: `Beleg „${noteSafe(file)}“ (${amount}) passt, ist aber schon der ${label === own ? 'anderen ' : ''}Zeile „${noteSafe(label)}“ zugeordnet`,
  tail: 'nicht doppelt angehängt, Beleg prüfen',
})
const NO_PDF_TAIL = 'Rechnung beim Händler holen und anhängen (eine Bestell- oder Zahlungsbestätigung ist keine Rechnung)'
const withoutPdfFound = (emails: readonly EmailWithoutPdf[]): Warning => {
  const day = emailDay(emails[0].date)
  return {
    statement: emails.length === 1
      ? `E-Mail „${noteSafe(emails[0].subject)}“${day ? ` vom ${day}` : ''} gefunden, aber ohne PDF`
      : `${emails.length} E-Mails gefunden, aber ohne PDF`,
    tail: NO_PDF_TAIL,
  }
}
const TIME_UP: Warning = { statement: 'Analyse-Zeit aufgebraucht', tail: 'Beleg nicht gesucht: Beleg selbst anhängen oder neu analysieren' }
export const GMAIL_TIME_NOTE = warned(TIME_UP)
// A search of the row ran, the next one (a path, a tied rule's sender) was left out for time
// and nothing was picked: what was searched did not have it, what was not may
export const GMAIL_TIME_PARTIAL_NOTE = '⚠ Analyse-Zeit aufgebraucht — Gmail nicht vollständig durchsucht: Beleg selbst anhängen oder neu analysieren'
// The classifier not asked for lack of time (ai_error)
export const CLASSIFIER_TIME_NOTE = 'Analyse-Zeit aufgebraucht — KI-Vorschlag übersprungen: Konten selbst wählen oder neu analysieren'
// A Gmail search that failed (the quota, a dead token): the row then has no receipt for a
// reason the owner must know, not because there is none
export const gmailFailedNote = (e: unknown): string =>
  `⚠ Gmail-Suche fehlgeschlagen — Beleg selbst anhängen (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`

// The candidate list (the details of a row with candidates)
export const GMAIL_CANDIDATES_TITLE = 'In Gmail gefunden, nicht angehängt'
export const GMAIL_PREVIEW = 'Vorschau'
export const GMAIL_ATTACH = 'Anhängen'
export const GMAIL_PREVIEW_TOO_LARGE = 'zu groß für die Vorschau (über 3 MB)'
export const gmailReceiptLoadError = (error: string): string => `Beleg aus Gmail nicht ladbar (${error})`
export const gmailAttachedNote = (file: string): string => `Gmail: „${noteSafe(file)}“ von Hand angehängt`
// „Vorschau“ shows a candidate up to this size: /api/import/refetch-pdf answers the PDF as
// base64 in JSON (a third larger), and Vercel refuses a response over 4.5 MB
export const GMAIL_PREVIEW_MAX_BYTES = 3 * 1024 * 1024
// A candidate that is a PDF part (an e-mail without one has nothing to show or attach)
export const gmailHasPdf = (c: Pick<GmailCandidate, 'part_id' | 'why'>): boolean => c.part_id != null && c.why !== 'no_pdf'
// „Vorschau“: a PDF of at most 3 MB — a larger one's button is off, its title says why
export const gmailPreviewable = (c: Pick<GmailCandidate, 'part_id' | 'why' | 'size'>): boolean =>
  gmailHasPdf(c) && (c.size ?? 0) <= GMAIL_PREVIEW_MAX_BYTES
// „Anhängen“: every PDF but one over 10 MB (bookamat's to take by hand). The booking route
// fetches the part itself, so a PDF over 3 MB is attached all the same.
export const gmailAttachable = (c: Pick<GmailCandidate, 'part_id' | 'why'>): boolean => gmailHasPdf(c) && c.why !== 'too_large'
// The collapsed row's chip of a doubtful Gmail receipt
export const RECEIPT_DOUBT_CHIP = 'Beleg prüfen'
const NOT_INVOICE_KIND: Record<string, string> = {
  order_confirmation: 'Bestellbestätigung', reminder: 'Mahnung', delivery_note: 'Lieferschein', quote: 'Angebot',
}
// Why a candidate is listed, as its line says it. One whose amount was compared with the
// debit („amount“) says it: in euros, or a foreign total in its currency — that is compared
// with the card stamp's own amount —, „… — anderer Betrag“ when it is not the debit's.
export function gmailCandidateLabel(c: GmailCandidate, tx: TxLike, bankNumber?: string | null): string {
  switch (c.why) {
    case 'amount': {
      if (c.amount != null) return amountMatchesTransaction(tx, c.amount) ? eur(c.amount) : `${eur(c.amount)} — anderer Betrag`
      const cur = (c.currency ?? '').trim().toUpperCase()
      if (c.foreign_total == null || !cur) return 'nicht geprüft'
      const foreign = amountIn(c.foreign_total, cur)
      return foreignIsDebit(c.foreign_total, cur, tx) ? foreign : `${foreign} — anderer Betrag`
    }
    case 'foreign': return `${amountIn(c.foreign_total ?? 0, c.currency ?? '')} — nicht mit € vergleichbar`
    case 'unreadable': return 'nicht lesbar'
    case 'unchecked': return 'nicht geprüft'
    // Another row of the same label (same day, name and amount): said to be the other one
    case 'claimed': return c.claimed_by === rowLabel(tx) ? `schon bei der anderen Zeile „${noteSafe(c.claimed_by)}“` : `schon bei „${noteSafe(c.claimed_by)}“`
    case 'credit_note': return 'Gutschrift'
    case 'not_invoice': return `keine Rechnung (${NOT_INVOICE_KIND[c.document_type ?? ''] ?? 'kein Rechnungsbeleg'})`
    case 'number': return `Rechnungsnr. ${c.invoice_number ?? '?'} statt ${bankNumber ?? '?'}`
    case 'no_pdf': return 'ohne PDF'
    case 'too_large': return 'PDF über 10 MB — in bookamat anhängen'
    case 'pages': return 'mehr als 10 Seiten — nicht geprüft'
  }
}
// A candidate's line: „{Datei}“ · {Absender-Domain} · {TT.MM.JJJJ} · {Label}
export const gmailCandidateLine = (c: GmailCandidate, tx: TxLike, bankNumber?: string | null): string =>
  [`„${c.file_name ?? c.subject}“`, senderDomain(c.from), emailDay(c.date), gmailCandidateLabel(c, tx, bankNumber)].filter(Boolean).join(' · ')

/**
 * The notes Analyse writes about a Gmail receipt it attached — where it came from, how its
 * amount or number proved it, or why it is doubtful —, and those written before P2-11: they
 * go with the receipt when a pick of another rule drops it (lib/rule-match.ts pickRule)
 */
export function isGmailReceiptNote(part: string): boolean {
  return part.startsWith('Gmail: ') || part.startsWith('Gmail-Suche nach ') || / im E-Mail-Text$/.test(part)
    || /^(?:Betrag|Zahlbetrag) .+ stimmt(?: \(Kartenumsatz\))?$/.test(part)
    || part.startsWith('Rechnungsnr. ') || part === RECEIPT_UNREADABLE_NOTE
    || part.startsWith('⚠ Beleg über Rechnungsnr. ') || /^⚠ \d+ Belege mit Betrag /.test(part) || part.startsWith('⚠ Beleg von ')
    || part.startsWith('⚠ In derselben E-Mail „')
}

// An AI row's Gmail receipt without a text layer (a scan): the classifier read the bank line
// only (lib/matcher.ts)
export const RECEIPT_NO_TEXT_NOTE = '⚠ Beleg angehängt, aber Text nicht lesbar — Einschätzung basiert nur auf den Kontodaten'

/**
 * Every note about a row's Gmail receipt and its search: the receipt attached and how it was
 * proven or why it is doubtful (isGmailReceiptNote), a scan's (RECEIPT_NO_TEXT_NOTE), the
 * receipts found and not attached — also plainly, on a row that needs no Beleg —, the search
 * not made or not finished for lack of time, a search that failed, and a draft's notes from
 * before the update.
 * „Anhängen“ replaces them with the receipt the owner attached (lib/gmail-attach.ts): they
 * speak of a state the row is no longer in.
 */
export function isGmailSearchNote(part: string): boolean {
  const p = part.replace(/^⚠ /, '')
  return isGmailReceiptNote(part) || part === RECEIPT_NO_TEXT_NOTE
    || /^\d+ Belege? in Gmail gefunden, /.test(p)
    || /^Beleg „.*“ \(.*\) passt, ist aber schon der (?:anderen )?Zeile „/.test(p)
    || /^(?:E-Mail „.*“(?: vom \d{2}\.\d{2}\.\d{4})?|\d+ E-Mails) gefunden, aber ohne PDF — /.test(p)
    || part === GMAIL_TIME_NOTE || part === plainly(TIME_UP) || part === GMAIL_TIME_PARTIAL_NOTE
    || part.startsWith('⚠ Gmail-Suche fehlgeschlagen — ')
    || part === GMAIL_DRAFT_ROW_NOTE || /^⚠ Derselbe Beleg aus Gmail hängt auch an (?:der anderen )?Zeile „/.test(part)
}

// ─── pickGmailReceipt ───────────────────────────────────────────────────────────────

// A candidate as the row lists it
function listed(f: Facts, why: GmailCandidate['why'], claimedBy?: string | null): GmailCandidate {
  const r = f.c.read ?? null
  return {
    message_id: f.c.messageId,
    part_id: f.c.partId,
    file_name: f.c.fileName,
    subject: f.c.subject,
    from: f.c.from,
    date: f.c.date,
    size: f.c.size,
    amount: r ? (f.amount === 'due' ? r.amount_due : r.amount ?? r.amount_due) : null,
    currency: r?.foreign_total != null ? r.currency : null,
    foreign_total: r?.foreign_total ?? null,
    invoice_number: r?.invoice_number ?? null,
    document_type: r?.document_type ?? null,
    why,
    ...(claimedBy ? { claimed_by: claimedBy } : {}),
    // A Buchungsregel's sender search found it: „Anhängen“ ties it to those rules, as a
    // receipt Analyse attaches is tied to them (lib/gmail-attach.ts)
    ...(f.c.via.kind === 'sender' ? { found_by: { sender: f.c.via.sender, rule_ids: [...f.c.via.ruleIds] } } : {}),
  }
}
const listedEmail = (e: EmailWithoutPdf): GmailCandidate => ({
  message_id: e.messageId, part_id: null, file_name: null, subject: e.subject, from: e.from, date: e.date, size: null,
  amount: null, currency: null, foreign_total: null, invoice_number: null, why: 'no_pdf',
})

// How far a group's amount could be checked: compared with the debit (a euro total or amount
// due, or a foreign total with a card stamp), a foreign total without a stamp, unreadable, or
// not checked (not read, nothing read of its amount)
type Checked = 'checked' | 'foreign' | 'unreadable' | 'unchecked'
function checkedOf(g: Group, tx: TxLike): Checked {
  const reads = g.members.map(m => m.c.read).filter((r): r is ReceiptRead => !!r)
  if (reads.some(r => r.amount != null || r.amount_due != null || (r.foreign_total != null && !!cardForeignAmount(tx)))) return 'checked'
  if (reads.some(r => r.foreign_total != null)) return 'foreign'
  if (!reads.length && g.members.some(m => m.c.readError || m.c.notRead === 'download_failed')) return 'unreadable'
  return 'unchecked'
}
// Why a group not attached is listed
function whyOfGroup(g: Group, tx: TxLike): GmailCandidate['why'] {
  if (g.claimedBy) return 'claimed'
  if (g.matched) return 'amount'
  const checked = checkedOf(g, tx)
  if (checked === 'checked') return 'amount'
  if (checked === 'foreign') return 'foreign'
  if (checked === 'unreadable') return 'unreadable'
  return g.members.some(m => m.c.notRead === 'pages') ? 'pages' : 'unchecked'
}
// Why the amount of the D2 receipt was not checked
function uncheckedReason(g: Group): string {
  const read = readOfGroup(g)
  if (read) return read.foreign_total != null ? UNCHECKED_REASONS.foreign((read.currency ?? '').trim().toUpperCase()) : UNCHECKED_REASONS.noTotal
  if (g.members.some(m => m.c.readError || m.c.notRead === 'download_failed')) return UNCHECKED_REASONS.unreadable
  if (g.members.some(m => m.c.notRead === 'pages')) return UNCHECKED_REASONS.pages
  return UNCHECKED_REASONS.time
}

/**
 * The receipt of a debit among the PDF parts Gmail gave (`cands`, read as far as Analyse got)
 * and the e-mails without one. In order:
 * 1. Never attached, listed with why: another row's (claimed, or carrying an invoice number
 *    another row's bank text names); another invoice number than the bank's that is not on
 *    it either; a credit note or a negative total; an order confirmation, reminder, delivery
 *    note or quote; over 10 MB.
 * 2. By amount (copies of one document count once; the claimed ones count too): with the
 *    bank's number as well → 'amount' (of several, the one read with it; several alike → the
 *    nearest, 'ambiguous'); the only one → 'amount'; several → the one nearest the day of
 *    payment not claimed, 'ambiguous'; all claimed → none, said. An e-mail's subject speaks
 *    for its PDF only when it has no other. One not read with the bank's number beside a scan
 *    of its e-mail left unread (time, the run's reads, the row's) → 'ambiguous', said.
 * 3. No amount, the bank's number → 'number' (the one read with it, else the nearest).
 * 4. A Buchungsregel's sender's only document, its amount not checkable → 'unchecked' (D2) —
 *    not while a document of the debit's amount was left out for its invoice number alone:
 *    which one is the Beleg is the owner's to say.
 * 5. Otherwise none; everything listed.
 */
export function pickGmailReceipt(cands: readonly PdfCandidate[], withoutPdf: readonly EmailWithoutPdf[], ctx: PickContext): ReceiptPick {
  const tx = ctx.tx
  const facts = cands.map(c => factsOf(c, ctx))
  const excluded = facts.filter(f => f.excluded)
  const groups = copyGroups(facts.filter(f => !f.excluded))
  const payRef = payRefOf(tx)
  const nearest = (gs: Group[]) => [...gs].sort((a, b) => daysFrom(a.rep.c.date, payRef) - daysFrom(b.rep.c.date, payRef) || a.rep.c.order - b.rep.c.order)[0]
  const emails = withoutPdf.filter(e => e.via.kind !== 'keyword' || INVOICE_SUBJECT.test(e.subject))

  const list = (except: Group | null): GmailCandidate[] => [
    ...groups.filter(g => g !== except).map(g => listed(g.rep, whyOfGroup(g, tx), g.claimedBy)),
    ...excluded.map(f => listed(f, f.claimedBy ? 'claimed' : f.excluded!, f.claimedBy)),
    ...emails.map(listedEmail),
  ]

  const attach = (g: Group, check: Exclude<ReceiptCheck, 'owner'>, note: string | null, provenance: string[]): ReceiptPick => {
    const read = readOfGroup(g)
    return {
      chosen: g.rep.c,
      read,
      check,
      matchedOn: g.matched?.amount ?? null,
      claimKeys: g.keys,
      note: [note, ...provenance].filter(Boolean).join(' · ') || null,
      plainNote: null,
      candidates: list(g),
    }
  }
  const none = (w: Warning | null): ReceiptPick => ({
    chosen: null, read: null, check: null, matchedOn: null, claimKeys: [],
    note: w ? warned(w) : null, plainNote: w ? plainly(w) : null, candidates: list(null),
  })
  const numberPart = (g: Group) => (g.number && ctx.bank ? [`Rechnungsnr. ${ctx.bank.number}`] : [])
  const proven = (g: Group, check: 'amount' | 'ambiguous', k = 0, said: string | null = null): ReceiptPick => {
    const m = g.matched!
    const read = m.c.read!
    const note = said ?? (check === 'ambiguous' ? ambiguousNote(k, matchedAmountText(m.amount!, read), g.rep.c.fileName, emailDay(g.rep.c.date)) : null)
    return attach(g, check, note, [...provenancePrefix(g.rep.c.via), amountProvenance(m.amount!, read, tx), ...numberPart(g)])
  }
  // The only one of the amount: proof — unless it was not read with the bank's number and a
  // scan in its e-mail was left unread (the read stop, the run's reads, the row's): the scan
  // may be the invoice, this its payment's confirmation; attached by the amount, said, never
  // proof (repair check GI-4)
  const onlyOne = (g: Group): ReceiptPick => {
    const unreadScan = readWithBankNumber(g, ctx.bank?.key) ? undefined : facts.find(f =>
      !g.members.includes(f) && !f.excluded && !f.claimedBy && noTextLayer(f.c.text)
      && !!f.c.notRead && !!UNREAD_SCAN_REASONS[f.c.notRead]
      && g.members.some(m => m.c.messageId === f.c.messageId))
    if (!unreadScan) return proven(g, 'amount')
    return proven(g, 'ambiguous', 0, unreadScanBesideNote(unreadScan.c.fileName, UNREAD_SCAN_REASONS[unreadScan.c.notRead!]!))
  }

  // 2. By amount: the groups that match, claimed ones included, and those free to attach
  const matching = groups.filter(g => g.matched && g.rep.c.downloaded)
  const free = matching.filter(g => !g.claimedBy)
  if (matching.length) {
    // With the bank's number as well: the one read with it, of several; only one is proof —
    // two that the number speaks for alike are two documents of the amount
    const numbered = free.filter(g => g.number)
    const byRead = numbered.filter(g => readWithBankNumber(g, ctx.bank?.key))
    const proof = byRead.length ? byRead : numbered
    if (proof.length === 1) return onlyOne(proof[0])
    if (proof.length > 1) return proven(nearest(proof), 'ambiguous', matching.length)
    if (matching.length === 1 && free.length === 1) return onlyOne(free[0])
    if (free.length) return proven(nearest(free), 'ambiguous', matching.length)
    const taken = nearest(matching)
    return none(claimedFound(taken.rep.c.fileName, matchedAmountText(taken.matched!.amount!, taken.matched!.c.read!), taken.claimedBy!, ctx.label))
  }

  // 3. The bank's invoice number on it, no amount: the one read with it first
  const numbered = groups.filter(g => g.number && !g.claimedBy && g.rep.c.downloaded)
  if (numbered.length) {
    const byRead = numbered.filter(g => readWithBankNumber(g, ctx.bank?.key))
    const g = nearest(byRead.length ? byRead : numbered)
    const read = readOfGroup(g)
    const n = ctx.bank!.number
    const euro = read?.amount ?? read?.amount_due ?? null
    const warning = euro != null ? numberAmountNote(n, euro, tx.amount)
      : read?.foreign_total != null ? numberForeignNote(n, amountIn(read.foreign_total, (read.currency ?? '').trim().toUpperCase()), tx.amount)
      : RECEIPT_UNREADABLE_NOTE
    return attach(g, 'number', warning, [...provenancePrefix(g.rep.c.via), `Rechnungsnr. ${n}`])
  }

  // 4. D2: a Buchungsregel's sender's only document, its amount not checkable — not beside
  // one of the debit's amount left out for its number alone (a misread number, maybe: an AGB
  // is never attached instead of the invoice; review check)
  const open = groups.filter(g => !g.claimedBy)
  const amountLeftOut = excluded.some(f => f.excluded === 'number' && !!f.amount && !f.claimedBy)
  if (open.length === 1 && open[0].rep.c.via.kind === 'sender' && open[0].rep.c.downloaded && !amountLeftOut) {
    const g = open[0]
    const checked = checkedOf(g, tx)
    if (checked !== 'checked') return attach(g, 'unchecked', uncheckedNote((g.rep.c.via as { sender: string }).sender, uncheckedReason(g)), [])
  }

  // 5. None attached: what was found, and why none fits
  const docs = groups.length + excluded.length
  if (!docs) return none(emails.length ? withoutPdfFound(emails) : null)
  const states = groups.map(g => checkedOf(g, tx))
  if (!excluded.length && states.every(s => s === 'unreadable')) return none(unreadableFound(docs))
  if (!excluded.length && states.every(s => s === 'foreign')) {
    const read = readOfGroup(groups[0])!
    const cur = (read.currency ?? '').trim().toUpperCase()
    return none(foreignFound(docs, cur, amountIn(read.foreign_total ?? 0, cur), tx))
  }
  const timeCut = groups.some((g, k) => states[k] === 'unchecked' && g.members.some(m => m.c.notRead === 'time'))
  return none(noneFound(docs, states.filter(s => s === 'unchecked' || s === 'unreadable').length, tx, timeCut))
}

// No receipt, nothing found to say
export const noReceipt = (): ReceiptPick => ({
  chosen: null, read: null, check: null, matchedOn: null, claimKeys: [], note: null, plainNote: null, candidates: [],
})
// The pick when Gmail could not be searched in time
export const timeUpPick = (): ReceiptPick => ({ ...noReceipt(), note: GMAIL_TIME_NOTE, plainNote: plainly(TIME_UP) })

// ─── The run: claims, limiters ──────────────────────────────────────────────────────

/**
 * Which row of one Analyse a receipt is attached to, by its claim keys (a part, its bytes,
 * its sender domain and invoice number). A row claims all of a document's keys or none.
 */
export class ReceiptClaims {
  private owners = new Map<string, { row: number; label: string }>()
  claim(keys: readonly string[], row: number, label: string): boolean {
    if (keys.some(k => { const o = this.owners.get(k); return !!o && o.row !== row })) return false
    keys.forEach(k => this.owners.set(k, { row, label }))
    return true
  }
  ownerOf(key: string): { row: number; label: string } | null {
    return this.owners.get(key) ?? null
  }
  // A row whose analysis failed gives its receipts back
  release(row: number): void {
    Array.from(this.owners.entries()).forEach(([k, o]) => { if (o.row === row) this.owners.delete(k) })
  }
}

// Runs a task when fewer than `max` are running, in the order asked
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>
export function makeLimiter(max: number): Limiter {
  let active = 0
  const waiting: (() => void)[] = []
  const next = () => {
    if (active >= max) return
    const start = waiting.shift()
    if (!start) return
    active += 1
    start()
  }
  return <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      Promise.resolve().then(task).then(resolve, reject).then(() => {
        active -= 1
        next()
      })
    })
    next()
  })
}

// ─── The page and the booking route ─────────────────────────────────────────────────

// A Gmail receipt attached without proof (P2-11): its number only, the nearest of several,
// D2's unchecked one — or attached by an Analyse before the update. Never ticked for the
// owner; „Alle“ and „Trotzdem buchen“ leave it to him.
export const receiptDoubt = (t: Pick<MatchedTransaction, 'gmail_message_id' | 'receipt_check'> | null | undefined): boolean =>
  !!t?.gmail_message_id && t.receipt_check !== 'amount' && t.receipt_check !== 'owner'

// The booking route's refusals (§ 3.1): a doubtful receipt from a page open since before the
// update (it ticks it), and a Gmail receipt an Analyse before the update attached unproven
export const OLD_PAGE_TEXT = 'Seite vor dem Update geöffnet — Entwurf speichern, Seite neu laden, Zeile prüfen, dann buchen'
export const STALE_GMAIL_RECEIPT_TEXT = 'Beleg aus Gmail vor dem Update ohne Betragsprüfung angehängt — Entwurf speichern, Seite neu laden, Beleg prüfen, dann buchen'

/**
 * Why the booking route refuses an expense row for its Gmail receipt, or null: none
 * attached, or proven ('amount', 'owner'); a doubtful one ('number', 'ambiguous',
 * 'unchecked') from a page open since before the update (`currentPage` false); one an
 * Analyse before the update attached (no receipt_check): from such a page whatever its
 * amount — that Analyse gave two same-day debits of one amount the same PDF, and each row
 * alone would pass —, from this page when its read amount is not the debit.
 */
export function gmailReceiptRefusal(
  t: Pick<MatchedTransaction, 'transaction' | 'gmail_message_id' | 'receipt_check' | 'extracted_amount'> | null | undefined,
  currentPage: boolean,
): string | null {
  if (!t?.gmail_message_id) return null
  const check = t.receipt_check
  if (check === 'amount' || check === 'owner') return null
  if (check === 'number' || check === 'ambiguous' || check === 'unchecked') return currentPage ? null : OLD_PAGE_TEXT
  if (!currentPage) return STALE_GMAIL_RECEIPT_TEXT
  return t.extracted_amount != null && amountMatchesTransaction(t.transaction, t.extracted_amount) ? null : STALE_GMAIL_RECEIPT_TEXT
}

// ─── A draft analysed before the update (lib/import-drafts.ts convertDraftRows) ───────

export const GMAIL_DRAFT_ROW_NOTE = '⚠ Beleg aus Gmail vor dem Update ohne Betragsprüfung angehängt — prüfen oder entfernen'
// `own`: the label of the row the note goes on — the other row's, the same (two debits of one
// day, name and amount), is „der anderen Zeile“, as claimedFound says it
export const gmailSameReceiptNote = (label: string, own?: string): string =>
  `⚠ Derselbe Beleg aus Gmail hängt auch an ${label === own ? 'der anderen ' : ''}Zeile „${noteSafe(label)}“ — prüfen oder entfernen`
export const gmailDraftNotice = (n: number, unticked = true): string =>
  `${n === 1 ? 'Ein Beleg aus Gmail war' : `${n} Belege aus Gmail waren`} vor dem Update ohne Betragsprüfung angehängt — jetzt „Prüfen“${unticked ? ', nicht mehr angekreuzt' : ''}. Bitte Beleg prüfen oder entfernen.`
// A draft a page open since before the update saved: the rows that page ticked whose Gmail
// receipt is in doubt (receiptDoubt), unticked on load (lib/import-drafts.ts convertDraftRows)
export const gmailOldPageTickNotice = (n: number): string =>
  `${n === 1 ? 'Eine Zeile mit nicht nachgewiesenem Beleg aus Gmail war' : `${n} Zeilen mit nicht nachgewiesenem Beleg aus Gmail waren`} von einer Seite vor dem Update angekreuzt — jetzt nicht mehr angekreuzt. Bitte Beleg prüfen, dann ankreuzen.`

/**
 * A draft analysed before P2-11: each Gmail receipt it kept (not removed, no receipt attached
 * by hand instead) gets its receipt_check. First the same e-mail on several rows: each but the
 * first is 'unchecked', with the first row's label. Then the amounts: the one read is the
 * debit → 'amount', unchanged otherwise; else 'unchecked', the note first, a Buchungsregel's
 * row „Prüfen“ (one held as booked keeps its hold, the status behind it). `changed`: the rows
 * made doubtful — the page unticks them and counts them in its notice —, not one held as
 * booked: the page never sends that, unless the owner booked it anyway („Trotzdem buchen“,
 * `review.acked`), which is counted as any other row. Converting twice changes nothing.
 */
export function checkDraftGmailReceipts(
  rows: MatchedTransaction[],
  review: { cleared_gmail?: readonly number[] | null; uploads?: { readonly [row: number]: unknown } | null; acked?: readonly number[] | null },
): { rows: MatchedTransaction[]; changed: number[] } {
  const cleared = new Set((review.cleared_gmail ?? []).map(Number))
  const acked = new Set((review.acked ?? []).map(Number))
  const old = (t: MatchedTransaction, i: number) =>
    !!t?.transaction && !!t.gmail_message_id && !t.receipt_check && !cleared.has(i) && !review.uploads?.[i]
  const changed: number[] = []
  const doubtful = (t: MatchedTransaction, i: number, note: string): MatchedTransaction => {
    const held = t.status === 'duplicate'
    if (!held || acked.has(i)) changed.push(i)
    const row: MatchedTransaction = { ...t, receipt_check: 'unchecked', match_note: [note, t.match_note].filter(Boolean).join(' · ') }
    if (!t.vendor) return row
    return held ? { ...row, own_status: 'needs_review' } : { ...row, status: 'needs_review' }
  }
  const firstOf = new Map<string, number>()
  const out = rows.map((t, i): MatchedTransaction => {
    if (!old(t, i)) return t
    const first = firstOf.get(t.gmail_message_id!)
    if (first == null) {
      firstOf.set(t.gmail_message_id!, i)
      return t
    }
    return doubtful(t, i, gmailSameReceiptNote(rowLabel(rows[first].transaction), rowLabel(t.transaction)))
  })
  return {
    rows: out.map((t, i) => {
      if (!old(t, i)) return t
      return t.extracted_amount != null && amountMatchesTransaction(t.transaction, t.extracted_amount)
        ? { ...t, receipt_check: 'amount' }
        : doubtful(t, i, GMAIL_DRAFT_ROW_NOTE)
    }),
    changed: changed.sort((a, b) => a - b),
  }
}
