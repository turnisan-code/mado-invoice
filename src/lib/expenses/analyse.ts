// Mado's Analyse of a statement line (PR 9a, 9b): what Bookmatic's Analyse (lib/matcher.ts
// enrichExpense, processExpenseTransaction, processIncomeTransaction, findCsvDuplicates) makes
// of a line, without an AI or a Drive invoice (PR 9c). The receipt a debit's Gmail search found
// (PR 9b) is stored on the line and given to its row here (ExpenseLineState.found).
// A debit: the fixed rules (a transfer to the owner's own account, a card issuer's
// settlement), then the Buchungsregeln; any other debit is the owner's to fill in. A credit
// that pays no Mado invoice (the „Einnahmen“ tab decides that): a refund of an expense is
// said and not booked, a Privateinlage follows its fixed rule, any other is the owner's.
// Then every line is checked against the bookings Bookamat already has.
//
// Pure and client-safe: the server and the page run it on the same inputs.
import type {
  BookamatAccounts, DuplicateInfo, EasybankTransaction, GmailCandidate, MatchedIncomeTransaction, MatchedTransaction, Vendor,
} from './types'
import {
  findCounterpartyAccount, ownerNameWithExtras, ownTransfer, ownTransferExpenseSuggestion, withInvoiceQuestion,
  OWN_BUSINESS_IBANS, type OwnTransfer,
} from './own-transfer'
import { cardSettlement, cardSettlementExpenseRow } from './card-settlement'
import {
  generateTitle, matchRules, otherRuleBookedNote, otherRuleBooking, ownRuleOverride, pickRule, receiptRuleIds, ruleChoiceStatus,
  ruleOutcome, ruleRowStatus, tiedRuleBookings,
} from './rule-match'
import { authorityMentionNoteOf, privateDepositKind, refundNote, refundReason, PRIVATE_DEPOSIT_GUESS_NOTE } from './refunds'
import { statementBankAccountId } from './bank-account'
import { assignDuplicates, bankRows, nearBankDate, windowFor, type BookingLite, type DuplicateMatch } from './duplicates'
import { bookingDateOf } from './booking-dates'
import { cleanCounterparty, emailDateToIso, extractInvoiceNumberFromReference } from './invoice-parsing'
import type { ReceiptPick, ReceiptRead, ReceiptVia } from './receipt-match'

const EMPTY_RECEIPT = {
  gmail_message_id: null,
  gmail_subject: null,
  gmail_date: null,
  pdf_attachment_name: null,
  pdf_base64: null,
  extracted_invoice_date: null,
  extracted_invoice_number: null,
  extracted_amount: null,
} as const

const join = (...parts: (string | null | undefined)[]): string | null => parts.filter(Boolean).join(' · ') || null

// ─── Debits ──────────────────────────────────────────────────────────────────

// Moved from Bookmatic lib/matcher.ts
export const OWN_TRANSFER_RULE_NOTE = 'Feste Regel: Überweisung auf dein eigenes Konto'
export const OWN_TRANSFER_ACCOUNTS_MISSING_NOTE = '⚠ Überweisung auf dein eigenes Konto — Konto „Privatentnahmen (allgemein)“ oder „Keine Vorsteuer“ fehlt in bookamat: dort anlegen oder selbst ein Konto wählen'
export const OWN_TRANSFER_LISTS_MISSING_NOTE = '⚠ Überweisung auf dein eigenes Konto — Konten von bookamat nicht ladbar: Steuerkonto „Privatentnahmen (allgemein)“, „Keine Vorsteuer“, 0 % selbst wählen oder neu analysieren'

// Moved from Bookmatic lib/ai-classifier.ts: a debit to an account of the owner's that the
// fixed rule did not take (one of the owner's business accounts; a holder that is the owner's
// name with a title or „e.U.“) is no business expense, and which it is is the owner's call
export const OWN_BUSINESS_DEBIT_NOTE = '⚠ Überweisung auf dein anderes Geschäftskonto — keine Ausgabe und keine Privatentnahme: hier nicht buchen, in bookamat als Übertrag zwischen den Zahlungsmittelkonten erfassen.'
export const ownAccountNote = (holder: string): string =>
  `⚠ Empfänger trägt deinen Namen („${holder}“) — eine Umbuchung zwischen deinen Konten oder eine Privatentnahme, keine Betriebsausgabe? Privatentnahme: Steuerkonto „Privatentnahmen (allgemein)“, „Keine Vorsteuer“, 0 %; Umbuchung: hier nicht buchen.`

export function ownAccountNoteOf(tx: EasybankTransaction): string | null {
  if (ownTransfer(tx)) return null
  const account = findCounterpartyAccount(tx.raw?.col1 ?? tx.reference, tx.raw?.col0)
  if (!account) return null
  if (OWN_BUSINESS_IBANS.includes(account.iban)) return OWN_BUSINESS_DEBIT_NOTE
  return ownerNameWithExtras(account.holder) ? ownAccountNote(account.holder) : null
}

// The statement's own Zahlungsmittelkonto (its IBAN is the line's column 0)
export const lineBankAccountId = (tx: EasybankTransaction, lists: Pick<BookamatAccounts, 'bank_accounts'> | null | undefined): number =>
  statementBankAccountId(lists?.bank_accounts, tx.raw?.col0)

export function ownTransferExpenseRow(tx: EasybankTransaction, own: OwnTransfer, lists?: BookamatAccounts | null): MatchedTransaction {
  const suggestion = lists ? ownTransferExpenseSuggestion(own, lists, lineBankAccountId(tx, lists)) : null
  const missing = withInvoiceQuestion(lists ? OWN_TRANSFER_ACCOUNTS_MISSING_NOTE : OWN_TRANSFER_LISTS_MISSING_NOTE, own)
  return {
    transaction: tx,
    vendor: null,
    confidence: 0,
    ...EMPTY_RECEIPT,
    title: 'Privatentnahme',
    status: suggestion ? 'needs_review' : 'unknown_vendor',
    match_note: suggestion ? OWN_TRANSFER_RULE_NOTE : missing,
    ai_suggested: suggestion ?? undefined,
  }
}

// The Gmail search's outcome a line keeps (bank_lines.receipt_search, PR 9b), as Bookmatic's
// GmailFind gave it to the row (lib/expenses/gmail-receipt.ts): the receipt attached — its e-mail
// and part, the e-mail's text for the rules' „E-Mail enthält“ —, how it was proven, what Claude
// read and its text layer; what was found and not attached; the notes and the failed searches
export type StoredGmailFind = {
  chosen: {
    messageId: string; partId: string | null; fileName: string; subject: string; date: string | null
    via: ReceiptVia; bodyText?: string
  } | null
  check: ReceiptPick['check']
  read: ReceiptRead | null
  text: string | null
  note: string | null
  plainNote: string | null
  candidates: GmailCandidate[]
  failed: string[]
}

export type ExpenseLineState = {
  // The rule the owner picked among those that fit equally („Regel wählen“)
  ruleId?: string | null
  // A Beleg uploaded by hand: a Buchungsregel's row needs nothing more
  receipt?: boolean
  // What the line's Gmail search found (PR 9b)
  found?: StoredGmailFind | null
}

/**
 * A debit's row (Bookmatic lib/matcher.ts enrichExpense, without the AI: PR 9c). An own transfer
 * and a card issuer's settlement first, by their fixed rules, before any Buchungsregel or receipt.
 * Then the Buchungsregeln, first without the receipt's text; with the receipt the line's Gmail
 * search attached, a rule whose invoice address is not on it drops out. The receipt's fields as
 * Bookmatic's Analyse filled them: its e-mail and part, the invoice number read (else the bank
 * text's), the invoice date read (else the e-mail's), the euro total, how it was proven, what was
 * found and not attached unless the receipt is proven, the rules whose sender sent it.
 */
export function analyseExpense(
  tx: EasybankTransaction, vendors: readonly Vendor[], lists: BookamatAccounts | null | undefined, state: ExpenseLineState = {},
): MatchedTransaction {
  const own = ownTransfer(tx)
  if (own) return ownTransferExpenseRow(tx, own, lists)
  const settlement = cardSettlement(tx)
  if (settlement) {
    const named = matchRules(tx, [...vendors])
    return cardSettlementExpenseRow(tx, settlement, lists, (named.rule ?? named.tie[0])?.name)
  }

  const fast = matchRules(tx, [...vendors])
  const found = state.found ?? null
  const chosen = found?.chosen ?? null
  // With the receipt's text, when an invoice address could not be checked without it (a scan
  // has no text: its address stays unchecked)
  const receiptText = found?.text?.trim() ? found.text.toLowerCase() : ''
  const m = receiptText && fast.addressUnchecked
    ? matchRules(tx, [...vendors], address => receiptText.includes(address.toLowerCase()))
    : fast
  const outcome = ruleOutcome(fast, m)
  // The rules whose sender's search found the receipt attached: a pick of another drops it
  const sent = chosen?.via
  let gmailRuleIds = sent?.kind === 'sender' ? sent.ruleIds : undefined
  if (sent?.kind === 'sender' && outcome.kind !== 'ai' && chosen) {
    gmailRuleIds = receiptRuleIds({ email: { subject: chosen.subject, bodyText: chosen.bodyText ?? '' }, sender: sent.sender, ruleIds: sent.ruleIds }, outcome.choices)
  }
  // What the row says of its receipt: how it was proven or why it is doubtful, the searches
  // that failed
  const receiptNote = (): string | null => [found?.note, ...(found?.failed ?? [])].filter(Boolean).join(' · ') || null
  const receiptFields = () => {
    const read = chosen ? found?.read ?? null : null
    return {
      gmail_message_id: chosen?.messageId ?? null,
      gmail_part_id: chosen?.partId ?? null,
      gmail_subject: chosen?.subject ?? null,
      gmail_date: chosen?.date ?? null,
      pdf_attachment_name: chosen?.fileName ?? null,
      pdf_base64: null,
      extracted_invoice_number: read?.invoice_number || extractInvoiceNumberFromReference(tx),
      extracted_invoice_date: read?.date || emailDateToIso(chosen?.date),
      extracted_amount: read?.amount || null,
      ...(chosen && found?.check ? { receipt_check: found.check } : {}),
      ...(found && found.check !== 'amount' && found.candidates.length ? { gmail_candidates: found.candidates } : {}),
      ...(gmailRuleIds ? { gmail_rule_ids: gmailRuleIds } : {}),
    }
  }
  // Rules that fit equally, or that lost only by their address on the receipt: the owner picks
  // one („Regel wählen“)
  if (outcome.kind === 'choice') {
    const open: MatchedTransaction = {
      transaction: tx,
      vendor: null,
      confidence: 0,
      ...receiptFields(),
      title: tx.counterparty,
      status: ruleChoiceStatus({ gmail_message_id: chosen?.messageId ?? null }, outcome.choices),
      match_note: join(outcome.note, receiptNote()),
      rule_choices: outcome.choices,
      rule_tie_checked: true,
    }
    return applyRulePick(open, state.ruleId, !!state.receipt)
  }

  const fields = receiptFields()
  if (outcome.kind === 'rule') {
    const row: MatchedTransaction = {
      transaction: tx,
      vendor: outcome.rule,
      confidence: 1,
      ...fields,
      title: generateTitle(outcome.rule, tx.date),
      // „Kein Beleg“ until its receipt is there, „Prüfen“ while it is not proven
      status: ruleRowStatus(fields, outcome.rule),
      match_note: join(receiptNote(), ...outcome.notes),
      ...(outcome.choices.length ? { rule_choices: outcome.choices } : {}),
      ...(outcome.pick ? { rule_pick: outcome.pick } : {}),
      rule_tie_checked: true,
    }
    return applyRulePick(row, state.ruleId, !!state.receipt)
  }
  // No rule: the owner fills it in (PR 9c asks Claude). The one rule that fit by its keyword and
  // lost by its invoice address says why; a debit to an account of the owner's says so first.
  return {
    transaction: tx,
    vendor: null,
    confidence: 0,
    ...fields,
    title: tx.counterparty,
    status: 'unknown_vendor',
    match_note: join(ownAccountNoteOf(tx), outcome.note, receiptNote()),
    rule_tie_checked: true,
  }
}

/**
 * The owner's pick among the rules („Regel wählen“, or a rule other than the one that fit), applied
 * after the row's receipt as Bookmatic's page applied it: a receipt the picked rule's sender did not
 * send drops out (lib/expenses/rule-match.ts pickRule). A Beleg uploaded by hand makes a rule's
 * row ready. A choice not made yet stays a choice.
 */
export function applyRulePick(row: MatchedTransaction, ruleId: string | null | undefined, handReceipt: boolean): MatchedTransaction {
  const withReceipt = (r: MatchedTransaction): MatchedTransaction =>
    handReceipt && r.vendor && r.status === 'no_invoice' ? { ...r, status: 'ready' } : r
  const choice = !row.vendor && !!row.rule_choices?.length
  if (ruleId && (choice || (row.vendor && row.vendor.id !== ruleId))) return withReceipt(pickRule(row, ruleId, 'owner'))
  return choice ? row : withReceipt(row)
}

// ─── Credits that pay no Mado invoice ────────────────────────────────────────

export const PRIVATE_DEPOSIT_RULE_NOTE = 'Regel: Privateinlagen (allgemein) · Keine Umsatzsteuer · 0%'

const monthYear = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`

export function analyseCredit(
  tx: EasybankTransaction, vendors: readonly Vendor[], lists: BookamatAccounts | null | undefined,
): MatchedIncomeTransaction {
  const base = {
    transaction: tx,
    drive_file_id: null,
    drive_file_name: null,
    pdf_base64: null,
    extracted_invoice_number: null,
    extracted_invoice_date: null,
    extracted_amount: null,
    drive_match: 'none' as const,
  }
  const refund = refundReason(tx, [...vendors])
  if (refund) {
    return { ...base, title: `Erstattung ${cleanCounterparty(tx.counterparty)}`.slice(0, 50), status: 'unknown', refund, match_note: refundNote(refund) }
  }
  const deposit = privateDepositKind(tx)
  if (deposit) {
    // The fixed rule (Bookmatic lib/matcher.ts enrichIncome): Privateinlagen (allgemein),
    // Keine Umsatzsteuer, 0 %. Without the Privateinlagen account: the owner's to book.
    const privateAccount = (lists?.revenue_accounts ?? []).find(a => /privateinlag/i.test(a.name))
    const noVat = (lists?.purchasetax_accounts ?? []).find(a => /keine\s+umsatzsteuer/i.test(a.name))
    const title = `Privateinlage ${monthYear(tx.date)}`
    return {
      ...base,
      title,
      status: privateAccount ? 'needs_review' : 'unknown',
      match_note: join(privateAccount ? PRIVATE_DEPOSIT_RULE_NOTE : null, deposit === 'wording' && !ownTransfer(tx) ? PRIVATE_DEPOSIT_GUESS_NOTE : null),
      ai_suggested: privateAccount ? {
        revenue_account_id: privateAccount.id,
        vat_account_id: noVat?.id ?? 0,
        bank_account_id: lineBankAccountId(tx, lists),
        vat_percent: 0,
        country: '',
        vatin: '',
        title,
        category: 'Sonstiges',
        reasoning: 'Private Einzahlung — fixe Buchungsregel: Privateinlagen (allgemein), Keine Umsatzsteuer, 0% USt.',
        certainty: 'hoch',
        source: 'rule',
      } : undefined,
    }
  }
  return { ...base, title: tx.counterparty.slice(0, 50), status: 'unknown', match_note: authorityMentionNoteOf(tx) }
}

// ─── Bookings Bookamat already has ───────────────────────────────────────────

export type AnalysedLine =
  | { kind: 'expense'; row: MatchedTransaction; override?: Record<string, string> | null; ack?: readonly number[] }
  | { kind: 'income'; row: MatchedIncomeTransaction; override?: Record<string, string> | null; ack?: readonly number[] }

// The window of bookings to read for these lines (lib/expenses/duplicates.ts): around each
// line's bank date and day of payment, and its Buchungsdatum as the owner set it
export function duplicateWindow(lines: readonly AnalysedLine[]): { from: string; until: string } | null {
  return windowFor(lines.flatMap(l => paymentRows(l).windowRows))
}

function paymentRows(l: AnalysedLine) {
  const tx = l.row.transaction
  const bookedDate = bookingDateOf(tx, l.override ?? undefined, l.kind)
  if (l.kind === 'income') return { ...bankRows(tx, { kind: 'income', bookedDate }), titles: [] as string[], bookedDate }
  const row = l.row
  const title = l.override?.title || (row.vendor || row.title === 'Privatentnahme' ? row.title : null)
  const titles = row.vendor ? [] : (row.rule_choices ?? []).map(r => generateTitle(r, tx.date))
  return { ...bankRows(tx, { kind: 'expense', bookedDate, title, titles }), titles, bookedDate }
}

const asInfo = (m: DuplicateMatch): DuplicateInfo => ({ id: m.id, title: m.title, date: m.date, total: m.total, certain: m.certain, ...(m.bank ? { bank: m.bank } : {}), ...(m.viaTip ? { viaTip: m.viaTip } : {}) })

function annotate<T extends MatchedTransaction | MatchedIncomeTransaction>(row: T, match: DuplicateMatch | null): T {
  if (!match) return row
  return match.certain
    ? { ...row, duplicate_of: asInfo(match), status: 'duplicate', own_status: row.status }
    : { ...row, duplicate_of: asInfo(match) }
}

// Each line with the booking it most likely repeats (Bookmatic lib/matcher.ts
// processExpenseTransaction): certain → „Bereits gebucht“, else „möglicherweise bereits
// gebucht“; either is held until the owner books it anyway. A booking is given to one line
// only; the bookings the owner said are not a line's payment (`ack`) are never its.
// `bookings` null: the check could not run — every line says so and none is booked.
export function annotateDuplicates(
  lines: readonly AnalysedLine[], bookings: BookingLite[] | null, failed?: string | null,
): (MatchedTransaction | MatchedIncomeTransaction)[] {
  if (!bookings) return lines.map(l => ({ ...l.row, duplicate_check_failed: failed || 'Bookamat nicht lesbar' }))
  const built = lines.map(paymentRows)
  const assigned = assignDuplicates(built.map(b => b.row), bookings)
  const taken = new Set(assigned.filter((m): m is DuplicateMatch => !!m).map(m => m.id))
  // A Buchungsdatum the owner moved to another day near the bank date is checked there too (as
  // Bookmatic's booking route did), with the bookings no other line took
  built.forEach((b, k) => {
    if (assigned[k] || b.bookedDate === b.row.date || b.bookedDate === b.row.payDate || !nearBankDate(b.row.date, b.bookedDate)) return
    const m = assignDuplicates([{ ...b.row, date: b.bookedDate, payDate: null, invoiceKey: null }], bookings, new Set([...taken, ...(lines[k].ack ?? [])]))[0]
    if (m) { assigned[k] = m; taken.add(m.id) }
  })
  return lines.map((l, k) => {
    const acked = new Set(l.ack ?? [])
    let match = assigned[k]
    if (match && acked.has(match.id)) {
      // Asked again without the bookings said not to be its, nor those other lines took
      const exclude = new Set([...acked, ...[...taken].filter(id => id !== match!.id)])
      match = assignDuplicates([built[k].row], bookings, exclude)[0] ?? null
    }
    if (l.kind === 'income') return annotate(l.row, match)
    const tied = tiedRuleBookings(built[k].row, built[k].titles, bookings).filter(b => !acked.has(b.id))
    const own = ownRuleOverride(l.row, { match, tied })
    if (own) return annotate(l.row, own)
    const other = match?.certain ? otherRuleBooking(l.row, match) : null
    if (other && match && l.row.vendor) {
      return annotate({ ...l.row, match_note: join(otherRuleBookedNote(other, l.row.vendor), l.row.match_note) }, { ...match, certain: false })
    }
    return annotate(l.row, match)
  })
}
