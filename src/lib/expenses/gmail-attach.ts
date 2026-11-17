/**
 * „Anhängen“ on the import page (P2-11, PR „Job 1 fixes“ § 2.1 F): a PDF Analyse found in Gmail
 * and did not attach (the row's gmail_candidates) becomes the row's Gmail receipt.
 *
 * It is a reference, as Analyse attaches one — the e-mail and its PDF part, which the booking
 * route fetches again —, never a hand upload: that would meet the page's 3 MB limit, be left
 * out of a draft grown too large, never be fetched again and log no Gmail id. The owner proved
 * it by attaching it (receipt_check 'owner'): it is ticked and taken by „Alle“ as a receipt
 * proven by its amount is.
 *
 * Pure and client-safe: imports only ./rule-match, ./receipt-match, ./invoice-parsing and types
 * (the import page uses it).
 */

import type { GmailCandidate, MatchedTransaction } from './types'
import { isOpenRuleChoice, receiptRuleIds, ruleChoiceStatus, ruleRowStatus } from './rule-match'
import { gmailAttachedNote, gmailSameReceiptNote, isGmailSearchNote, rowLabel } from './receipt-match'
import { emailDateToIso, extractInvoiceNumberFromReference, RECEIPT_UNREADABLE_NOTE } from './invoice-parsing'

// What /api/import/gmail-receipt read of the PDF (lib/receipt-read.ts): its file name, the
// reader's fields the row keeps, and whether the reader failed
export type GmailCandidateRead = {
  name: string | null
  extracted: { invoice_number?: string | null; date?: string | null; amount?: number | null }
  unreadable: boolean
}

// One candidate: its e-mail and its part
const sameCandidate = (a: Pick<GmailCandidate, 'message_id' | 'part_id'>, b: Pick<GmailCandidate, 'message_id' | 'part_id'>) =>
  a.message_id === b.message_id && (a.part_id ?? null) === (b.part_id ?? null)

/**
 * The row once the owner attached candidate `c` („Anhängen“), with what was read of it:
 * - its Gmail receipt is `c` — the e-mail, the part, its subject and Date header, the file
 *   name —, without its data (the booking route fetches the part), proven by the owner;
 * - what the reader read, as Analyse fills a row: the invoice number, else the bank text's;
 *   the invoice date, else the e-mail's; the euro total;
 * - the notes about the receipt it had and about the search go (lib/receipt-match.ts
 *   isGmailSearchNote): the row says where this one came from — and, when the reader failed,
 *   that its data could not be read (RECEIPT_UNREADABLE_NOTE);
 * - the list without `c` (none left: no list);
 * - gmail_rule_ids: the rules whose sender's search found `c`, and every rule the row is
 *   chosen among of that sender whose „E-Mail enthält“ its subject has (lib/rule-match.ts
 *   receiptRuleIds) — so a pick of another rule drops it, as it drops a receipt Analyse
 *   attached. Found by no rule's sender (the name or processor search): none, the field goes.
 *   Never the replaced receipt's;
 * - its status as the receipt makes it: a rule's row by lib/rule-match.ts ruleRowStatus
 *   („Bereit“), a row to choose for by ruleChoiceStatus („Prüfen“), an AI row no longer „Beleg
 *   fehlt“; a row held as booked keeps its hold, the status behind it.
 * Which rule the invoice address on it names, and whether the row is ticked, the page settles
 * after (lib/rule-match.ts recheckRuleChoice).
 */
export function withGmailCandidate(t: MatchedTransaction, c: GmailCandidate, read: GmailCandidateRead): MatchedTransaction {
  const file = read.name || c.file_name || c.subject
  const rest = (t.gmail_candidates ?? []).filter(x => !sameCandidate(x, c))
  const kept = (t.match_note || '').split(' · ').filter(p => p && !isGmailSearchNote(p))
  const row: MatchedTransaction = {
    ...t,
    gmail_message_id: c.message_id,
    gmail_part_id: c.part_id,
    gmail_subject: c.subject,
    gmail_date: c.date,
    pdf_attachment_name: file,
    pdf_base64: null,
    receipt_check: 'owner',
    extracted_invoice_number: read.extracted.invoice_number || extractInvoiceNumberFromReference(t.transaction),
    extracted_invoice_date: read.extracted.date || emailDateToIso(c.date),
    extracted_amount: read.extracted.amount ?? null,
    match_note: [...kept, ...(read.unreadable ? [RECEIPT_UNREADABLE_NOTE] : []), gmailAttachedNote(file)].join(' · '),
  }
  if (rest.length) row.gmail_candidates = rest
  else delete row.gmail_candidates
  if (c.found_by) {
    row.gmail_rule_ids = receiptRuleIds(
      { email: { subject: c.subject, bodyText: '' }, sender: c.found_by.sender, ruleIds: c.found_by.rule_ids },
      t.rule_choices ?? [],
    )
  } else delete row.gmail_rule_ids

  const held = t.status === 'duplicate'
  const before = held ? t.own_status : t.status
  const status = t.vendor ? ruleRowStatus(row, t.vendor)
    : isOpenRuleChoice(t) ? ruleChoiceStatus(row, t.rule_choices!)
    : before === 'missing_invoice' ? 'needs_review'
    : before
  if (!status) return row
  return held ? { ...row, own_status: status } : { ...row, status }
}

/**
 * The other rows whose Gmail receipt is candidate `c` — the same e-mail and part, not removed
 * (`cleared`), no receipt attached by hand instead (`uploads`) — once row `i` took it by
 * „Anhängen“. The run's claims kept one PDF on one row; they are gone after Analyse, so the
 * page checks here that the owner did not give a PDF to a second row unawares.
 */
export function gmailBelegElsewhere(
  rows: readonly MatchedTransaction[],
  i: number,
  c: Pick<GmailCandidate, 'message_id' | 'part_id'>,
  cleared: ReadonlySet<number>,
  uploads: Readonly<Record<number, unknown>>,
): number[] {
  return rows.flatMap((t, k) =>
    k !== i && !!t?.gmail_message_id && !cleared.has(k) && !uploads[k]
      && sameCandidate({ message_id: t.gmail_message_id, part_id: t.gmail_part_id ?? null }, c) ? [k] : [])
}

/**
 * Such a row: its receipt no longer proven ('unchecked'), the note naming the row `label` that
 * has it too first (once; „der anderen Zeile“ when that label is this row's own), a
 * Buchungsregel's row „Prüfen“ — one held as booked keeps its hold,
 * the status behind it. The page unticks it: which row the PDF belongs to is the owner's to say.
 */
export function withGmailBelegElsewhere(t: MatchedTransaction, label: string): MatchedTransaction {
  const note = gmailSameReceiptNote(label, rowLabel(t.transaction))
  const parts = (t.match_note || '').split(' · ').filter(p => p && p !== note)
  const row: MatchedTransaction = { ...t, receipt_check: 'unchecked', match_note: [note, ...parts].join(' · ') }
  if (!t.vendor) return row
  const status = ruleRowStatus(row, t.vendor)
  return t.status === 'duplicate' ? { ...row, own_status: status } : { ...row, status }
}
