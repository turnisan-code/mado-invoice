// Mado's Analyse of a statement line (PR 9a): what Bookmatic's Analyse (lib/matcher.ts
// enrichExpense, processExpenseTransaction, processIncomeTransaction, findCsvDuplicates) makes
// of a line, without a Gmail search, an AI or a Drive invoice — those come with PR 9b and 9c.
// A debit: the fixed rules (a transfer to the owner's own account, a card issuer's
// settlement), then the Buchungsregeln; any other debit is the owner's to fill in. A credit
// that pays no Mado invoice (the „Einnahmen“ tab decides that): a refund of an expense is
// said and not booked, a Privateinlage follows its fixed rule, any other is the owner's.
// Then every line is checked against the bookings Bookamat already has.
//
// Pure and client-safe: the server and the page run it on the same inputs.
import type {
  BookamatAccounts, DuplicateInfo, EasybankTransaction, MatchedIncomeTransaction, MatchedTransaction, Vendor,
} from './types'
import {
  findCounterpartyAccount, ownerNameWithExtras, ownTransfer, ownTransferExpenseSuggestion, withInvoiceQuestion,
  OWN_BUSINESS_IBANS, type OwnTransfer,
} from './own-transfer'
import { cardSettlement, cardSettlementExpenseRow } from './card-settlement'
import {
  generateTitle, matchRules, otherRuleBookedNote, otherRuleBooking, ownRuleOverride, pickRule, ruleChoiceStatus,
  ruleOutcome, ruleRowStatus, tiedRuleBookings,
} from './rule-match'
import { authorityMentionNoteOf, privateDepositKind, refundNote, refundReason, PRIVATE_DEPOSIT_GUESS_NOTE } from './refunds'
import { statementBankAccountId } from './bank-account'
import { assignDuplicates, bankRows, nearBankDate, windowFor, type BookingLite, type DuplicateMatch } from './duplicates'
import { bookingDateOf } from './booking-dates'
import { cleanCounterparty } from './invoice-parsing'

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

export type ExpenseLineState = {
  // The rule the owner picked among those that fit equally („Regel wählen“)
  ruleId?: string | null
  // A Beleg uploaded by hand: a Buchungsregel's row needs nothing more
  receipt?: boolean
}

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

  const m = matchRules(tx, [...vendors])
  const outcome = ruleOutcome(m, m)
  const withReceipt = (row: MatchedTransaction): MatchedTransaction =>
    state.receipt && row.vendor && row.status === 'no_invoice' ? { ...row, status: 'ready' } : row

  if (outcome.kind === 'choice') {
    const open: MatchedTransaction = {
      transaction: tx,
      vendor: null,
      confidence: 0,
      ...EMPTY_RECEIPT,
      title: tx.counterparty,
      status: ruleChoiceStatus({ gmail_message_id: null }, outcome.choices),
      match_note: outcome.note,
      rule_choices: outcome.choices,
      rule_tie_checked: true,
    }
    return state.ruleId ? withReceipt(pickRule(open, state.ruleId, 'owner')) : open
  }
  if (outcome.kind === 'rule') {
    const row: MatchedTransaction = {
      transaction: tx,
      vendor: outcome.rule,
      confidence: 1,
      ...EMPTY_RECEIPT,
      title: generateTitle(outcome.rule, tx.date),
      status: ruleRowStatus({ gmail_message_id: null }, outcome.rule),
      match_note: join(...outcome.notes),
      ...(outcome.choices.length ? { rule_choices: outcome.choices } : {}),
      ...(outcome.pick ? { rule_pick: outcome.pick } : {}),
      rule_tie_checked: true,
    }
    const picked = state.ruleId && state.ruleId !== outcome.rule.id ? pickRule(row, state.ruleId, 'owner') : row
    return withReceipt(picked)
  }
  return {
    transaction: tx,
    vendor: null,
    confidence: 0,
    ...EMPTY_RECEIPT,
    title: tx.counterparty,
    status: 'unknown_vendor',
    match_note: join(outcome.note, ownAccountNoteOf(tx)),
    rule_tie_checked: true,
  }
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
