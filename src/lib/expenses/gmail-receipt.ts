/**
 * A debit's receipt from Gmail, within one Analyse (P2-11, PR „Job 1 fixes“ § 2.1 E).
 *
 * The row's paths are searched in turn — a Buchungsregel's senders, or a payment processor's
 * domain and then the vendor's name —, every PDF part found is read by pdf-parse, and the
 * PDF reader reads them in the order they are likely the receipt (lib/receipt-match.ts
 * rankCandidates): stopping at the first whose amount is the debit, unless another one's
 * text shows the debit too. lib/receipt-match.ts pickGmailReceipt picks, and the row claims
 * its pick at once — no other row of the run gets it. Gmail is only read.
 *
 * Every Gmail call goes through the run's limiter with its signal; a search starts only
 * before the run's Gmail stop, a read only before its read stop and while reads are left
 * (lib/analyse-run.ts). A Gmail error that means the connection is gone is kept for the run:
 * later rows skip Gmail and say so.
 *
 * Server only. Tests pass their own searches, pdf-parse and reader (`deps`): no network.
 */

import { extractText, getDocumentProxy } from 'unpdf'
import { parseISO } from 'date-fns'
import type { EasybankTransaction, Vendor } from './types'
import { gmailSearches, type GmailCallOptions, type GmailMessage, type KeywordSearch, type SenderSearch } from './gmail'
import { isGmailAuthError } from './gmail-parts'
import { readPdfInvoice, type PdfInvoiceData } from './pdf-reader'
import type { AiCallOptions } from './ai-call'
import { payDay } from './booking-dates'
import { extractInvoiceNumberFromReference } from './invoice-parsing'
import { ruleEmailPool, ruleReceiptSenders, type RuleSender } from './rule-match'
import {
  claimedByOther, gmailMayStart, otherNumbers, runRead, type AnalyseRun, type PdfText, type ReadOutcome,
} from './analyse-run'
import {
  bankInvoice, debitInText, gmailFailedNote, GMAIL_TIME_NOTE, GMAIL_TIME_PARTIAL_NOTE, matchesDebit, noReceipt, ownClaimKeys, partKey, pickGmailReceipt,
  noTextLayer, rankCandidates, rowLabel, timeUpPick, type EmailWithoutPdf, type PdfCandidate, type PickContext, type ReceiptPick, type ReceiptRead,
  type ReceiptVia,
} from './receipt-match'

// The paths a row's receipt is searched on: the senders of a Buchungsregel's row's rules (the
// one that applies, or each that ties), a payment processor's domain with the vendor's name
// in the e-mail, the vendor's name
export type GmailPath =
  | { kind: 'sender'; rules: Vendor[] }
  | { kind: 'processor'; domain: string; name: string }
  | { kind: 'keyword'; name: string }

// PDFs one row reads at most (copies, and what other rows read, are free)
export const MAX_READS_PER_ROW = 4
// A PDF of more pages is not read
export const MAX_PAGES_TO_READ = 10
// The search window: from the day of payment less this, to the bank date plus that
export const DAYS_BEFORE_PAYMENT = 10
export const DAYS_AFTER_BANK_DATE = 3

// What the search reads with: Gmail's two searches, pdf-parse, the PDF reader
export type GmailReceiptDeps = {
  searchInvoices: (params: SenderSearch, opts: GmailCallOptions) => Promise<GmailMessage[]>
  searchInvoicesByKeyword: (params: KeywordSearch, opts: GmailCallOptions) => Promise<GmailMessage[]>
  pdfText: (base64: string) => Promise<PdfText>
  readPdf: (base64: string, opts: AiCallOptions) => Promise<PdfInvoiceData>
}

// A PDF's text layer and its pages (unpdf, PDF.js's serverless build; Bookmatic used pdf-parse)
export async function pdfTextOf(base64: string): Promise<PdfText> {
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, 'base64')))
  const { totalPages, text } = await extractText(pdf, { mergePages: true })
  return { text: text ?? '', pages: totalPages ?? null }
}

// What a line's search reads with on Mado's Google connection: the Gmail API, the owner's UID
// for the reader's prompt; `readPdf` null without ANTHROPIC_API_KEY (nothing is read, nothing
// proven by a read)
export function gmailReceiptDeps(gmail: Parameters<typeof gmailSearches>[0], ownVatin: string): GmailReceiptDeps {
  const searches = gmailSearches(gmail)
  return {
    searchInvoices: searches.searchInvoices,
    searchInvoicesByKeyword: searches.searchInvoicesByKeyword,
    pdfText: pdfTextOf,
    readPdf: (base64, opts) => readPdfInvoice(base64, { ...opts, ownVatin }),
  }
}

// The receipt found: the pick (with what the row lists), the attached PDF's text and data and
// what was read of it; `failed`: the searches that failed, said on the row
export type GmailFind = {
  pick: ReceiptPick
  chosenText: string | null
  chosenBase64: string | null
  read: ReceiptRead | null
  failed: string[]
}

// The window searched: from the day of payment (a card payment of 29.12. posted on 04.01.
// is found) less 10 days, to the bank date plus 3
export function searchWindow(tx: Pick<EasybankTransaction, 'date' | 'reference' | 'raw'>): { dateFrom: Date; dateTo: Date } {
  const dateFrom = parseISO(payDay(tx).payDate ?? tx.date)
  dateFrom.setDate(dateFrom.getDate() - DAYS_BEFORE_PAYMENT)
  const dateTo = parseISO(tx.date)
  dateTo.setDate(dateTo.getDate() + DAYS_AFTER_BANK_DATE)
  return { dateFrom, dateTo }
}

// What the reader read, as the pick uses it
const readOf = (d: PdfInvoiceData): ReceiptRead => ({
  amount: d.amount, amount_due: d.amount_due, currency: d.currency, foreign_total: d.foreign_total,
  invoice_number: d.invoice_number, date: d.date, vatin: d.vatin, document_type: d.document_type,
})

/**
 * The receipt of the debit `tx` — row `row` of the run's expenses — on its `paths`, in turn:
 * the next path (the name search after the processor's) only while none is picked.
 */
export async function findGmailReceipt(
  tx: EasybankTransaction,
  { paths, run, row }: { paths: GmailPath[]; run: AnalyseRun; row: number },
  deps: GmailReceiptDeps,
): Promise<GmailFind> {
  const found = (pick: ReceiptPick, failed: string[] = []): GmailFind => ({ pick, chosenText: null, chosenBase64: null, read: null, failed })
  // A dead Gmail connection, found by an earlier row: not searched again
  if (run.gmailAuthError) return found(noReceipt(), [gmailFailedNote(run.gmailAuthError)])

  const bank = bankInvoice(tx)
  const label = run.labels[row] ?? rowLabel(tx)
  // The Gmail query asks for the bank text's number as it is written there
  const queryNumber = extractInvoiceNumberFromReference(tx)
  const { dateFrom, dateTo } = searchWindow(tx)
  const gmail: GmailCallOptions = { limit: run.gmailLimit, signal: run.signal }
  // What the pick knows of the run, the claims as they are when it is asked
  const ctx: PickContext = { tx, bank, label, claimedBy: claimedByOther(run, row), otherNumbers: otherNumbers(run, row) }

  const cands: PdfCandidate[] = []
  const withoutPdf: EmailWithoutPdf[] = []
  const bytes = new Map<string, string>()
  const seen = new Set<string>()
  const failed: string[] = []
  let searched = false
  // A search of the row left out for time — a path, a tied rule's sender — after another ran
  let timeCut = false
  let order = 0
  let started = 0

  const fail = (note: string) => {
    if (!failed.includes(note)) failed.push(note)
  }
  // One search: null when it may not start any more (the run's Gmail stop, a dead connection
  // another row found meanwhile)
  const search = async (call: () => Promise<GmailMessage[]>): Promise<GmailMessage[] | null> => {
    if (run.gmailAuthError) {
      fail(gmailFailedNote(run.gmailAuthError))
      return null
    }
    if (!gmailMayStart(run)) return null
    searched = true
    try {
      return await call()
    } catch (e) {
      console.error('Gmail search failed for', tx.counterparty, e)
      if (isGmailAuthError(e) && !run.gmailAuthError) run.gmailAuthError = e
      fail(run.signal.aborted ? GMAIL_TIME_NOTE : gmailFailedNote(e))
      return []
    }
  }
  // The e-mails a search found, each once: their PDF parts, or the e-mail without one. A
  // download that failed once the run's deadline aborted it was not read for time — it is
  // „nicht geprüft“, not „nicht lesbar“.
  const add = (emails: GmailMessage[], via: ReceiptVia) => {
    for (const m of emails) {
      if (seen.has(m.messageId)) continue
      seen.add(m.messageId)
      const pdfs = m.pdfs.filter(p => p.skipped !== 'not_pdf')
      if (!pdfs.length) {
        withoutPdf.push({ messageId: m.messageId, subject: m.subject, from: m.from, date: m.date || null, via })
        continue
      }
      for (const p of pdfs) {
        if (p.base64) bytes.set(partKey(m.messageId, p.partId), p.base64)
        cands.push({
          messageId: m.messageId, partId: p.partId, fileName: p.filename, subject: m.subject, from: m.from, date: m.date || null,
          order: order++, pdfParts: pdfs.length, size: p.size, sha256: p.sha256, text: null, pages: null, downloaded: !!p.base64, via, bodyText: m.bodyText,
          ...(p.skipped === 'too_large' ? { notRead: 'too_large' as const }
            : p.skipped === 'row_budget' ? { notRead: 'not_downloaded' as const }
            : p.skipped === 'download_failed' ? (run.signal.aborted ? { notRead: 'time' as const } : { notRead: 'download_failed' as const })
            : {}),
        })
      }
    }
  }
  const searchPath = async (path: GmailPath) => {
    if (path.kind === 'sender') {
      const searches: (RuleSender & { emails: GmailMessage[] })[] = []
      for (const s of ruleReceiptSenders(path.rules)) {
        const emails = await search(() => deps.searchInvoices({ senderDomain: s.sender, dateFrom, dateTo, invoiceNumber: queryNumber || undefined }, gmail))
        if (!emails) {
          // Not for a dead connection (said already): for time
          if (!run.gmailAuthError) timeCut = true
          break
        }
        searches.push({ ...s, emails })
      }
      for (const p of ruleEmailPool(searches)) add([p.email], { kind: 'sender', sender: p.sender, ruleIds: p.ruleIds })
    } else if (path.kind === 'processor') {
      // Only e-mails that name the vendor: the processor sends every shop's receipts
      const name = path.name.toLowerCase()
      const emails = await search(() => deps.searchInvoices({ senderDomain: path.domain, dateFrom, dateTo }, gmail))
      add((emails ?? []).filter(m => m.subject.toLowerCase().includes(name) || m.bodyText.toLowerCase().includes(name)),
        { kind: 'processor', domain: path.domain, name: path.name })
    } else {
      // Its downloads ranked by the bank text's number too, as a sender's are
      add((await search(() => deps.searchInvoicesByKeyword({ keyword: path.name, dateFrom, dateTo, invoiceNumber: queryNumber || undefined }, gmail))) ?? [], { kind: 'keyword', name: path.name })
    }
  }

  // pdf-parse's text of every PDF downloaded, once per PDF in the run; one it cannot parse
  // has none, nor a scan, whose pdf-parse text is „\n\n“ a page (repair check GI-1)
  const parse = (c: PdfCandidate): Promise<PdfText> => {
    const base64 = bytes.get(partKey(c.messageId, c.partId))!
    const parsing = () => deps.pdfText(base64)
      .then((p): PdfText => (noTextLayer(p.text) ? { ...p, text: '' } : p))
      .catch((): PdfText => ({ text: '', pages: null }))
    if (!c.sha256) return parsing()
    let text = run.texts.get(c.sha256)
    if (!text) run.texts.set(c.sha256, (text = parsing()))
    return text
  }
  const parseAll = () => Promise.all(cands.filter(c => c.downloaded && c.text == null).map(async c => {
    const { text, pages } = await parse(c)
    c.text = text
    c.pages = pages
  }))

  // One read by the PDF reader, in the run; one the run's deadline aborted was not read for
  // time (not „nicht lesbar“)
  const readNow = async (base64: string): Promise<ReadOutcome> => {
    try {
      const r = await runRead(run, opts => deps.readPdf(base64, opts))
      return 'ok' in r ? { read: readOf(r.ok) } : r
    } catch (e) {
      if (run.signal.aborted) return { notRead: 'time' }
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  const apply = (c: PdfCandidate, outcome: ReadOutcome) => {
    if ('read' in outcome) c.read = outcome.read
    else if ('error' in outcome) c.readError = outcome.error
    else c.notRead = outcome.notRead
  }
  const ownedByOther = (c: PdfCandidate) => ownClaimKeys(c).some(k => claimedByOther(run, row)(k) !== null)
  // A scan (no text layer) beside a PDF of its e-mail that matched: the payment's invoice may
  // be the scan beside a confirmation of its amount (review check GMAIL-01)
  const besideMatch = (c: PdfCandidate) => noTextLayer(c.text) && (c.pdfParts ?? 1) > 1
    && cands.some(m => m !== c && m.messageId === c.messageId && matchesDebit(m, ctx))
  // The PDFs not read yet, in rank order: the first whose amount is the debit (one the row
  // could attach) ends the reading, unless another one's text shows the debit too, or it is a
  // scan in the e-mail of a match
  const readRanked = async () => {
    let matched = cands.some(c => matchesDebit(c, ctx))
    const unread = cands.filter(c => c.downloaded && !c.read && !c.readError && !c.notRead)
    for (const c of rankCandidates(unread, { tx, bank })) {
      const done = c.sha256 ? run.reads.bySha.get(c.sha256) : undefined
      if (done) apply(c, await done)
      else if (matched && !debitInText(c.text, tx) && !besideMatch(c)) c.notRead = 'matched'
      else if (c.pages != null && c.pages > MAX_PAGES_TO_READ) c.notRead = 'pages'
      else if (ownedByOther(c)) c.notRead = 'owned'
      else if (started >= MAX_READS_PER_ROW) c.notRead = 'row_cap'
      else {
        started += 1
        const reading = readNow(bytes.get(partKey(c.messageId, c.partId))!)
        if (c.sha256) run.reads.bySha.set(c.sha256, reading)
        apply(c, await reading)
      }
      if (matchesDebit(c, ctx)) matched = true
    }
  }

  // The pick, claimed at once: no await between them, so no other row takes it meanwhile;
  // should the claim fail all the same, picked once more with the claims as they are
  const pickAndClaim = (): ReceiptPick => {
    let pick = pickGmailReceipt(cands, withoutPdf, ctx)
    if (pick.chosen && !run.claims.claim(pick.claimKeys, row, label)) {
      pick = pickGmailReceipt(cands, withoutPdf, ctx)
      if (pick.chosen && !run.claims.claim(pick.claimKeys, row, label)) pick = { ...noReceipt(), candidates: pick.candidates }
    }
    return pick
  }

  let pick: ReceiptPick | null = null
  // A Buchungsregel without a sender, or that searches none, has nothing to search
  for (const path of paths.filter(p => p.kind !== 'sender' || ruleReceiptSenders(p.rules).length)) {
    if (pick?.chosen) break
    if (!run.gmailAuthError && !gmailMayStart(run)) {
      // Too late to search: no search of this row ran — none made; else not all were
      if (!searched) return found(timeUpPick(), failed)
      timeCut = true
      break
    }
    await searchPath(path)
    await parseAll()
    await readRanked()
    pick = pickAndClaim()
  }
  if (timeCut && !pick?.chosen) fail(GMAIL_TIME_PARTIAL_NOTE)
  const chosen = pick?.chosen ?? null
  return {
    pick: pick ?? noReceipt(),
    chosenText: chosen?.text ?? null,
    chosenBase64: chosen ? bytes.get(partKey(chosen.messageId, chosen.partId)) ?? null : null,
    read: pick?.read ?? null,
    failed,
  }
}
