/**
 * Refunds among the bank's credits (audit P1-4).
 *
 * Every credit becomes an income row (lib/csv-parser.ts decides by the sign alone). A
 * refund from an expense vendor is not revenue: it reduces that expense
 * (Aufwandsminderung). This app offers only revenue accounts for a credit, so it cannot
 * book one correctly; July's „PADDLE.NET* KLANGIO +0,83“ was proposed as „Einnahmen“.
 * Such a credit is shown with its reason, gets no suggestion and is booked in bookamat.
 *
 * Pure (no googleapis, pdf-parse or Anthropic), so it is tested on its own. Used by
 * lib/matcher.ts, by the enrich route when bookamat's account lists are missing, and by a
 * draft's conversion on the import page (lib/import-drafts.ts): no package, no env variable.
 */

import type { EasybankTransaction, MatchedIncomeTransaction, Vendor } from '@/lib/expenses/types'
import { extractIncomeInvoiceNumber, invoiceKey } from './invoice-parsing'
import { counterpartyAccountOf, ownerNameWithExtras, ownTransfer, OWN_BUSINESS_IBANS, type CounterpartyAccount } from './own-transfer'
// From the card issuers' table, never from lib/card-settlement.ts: that module imports
// this one (a cycle)
import { issuerCreditReason } from './card-issuers'

// The CSV's columns (raw) where the caller has them: an own transfer is read from them
type CreditText = Pick<EasybankTransaction, 'counterparty' | 'reference'> & { raw?: EasybankTransaction['raw'] | null }
// What the refund check reads of a Buchungsregel: its keywords
export type RuleKeywords = Pick<Vendor, 'name' | 'match_strings' | 'active'>

/**
 * How bank texts name the Sozialversicherung and the Finanzamt. The expense prompt
 * (lib/ai-classifier.ts, rules 2 and 3) lists these words as text for payments to
 * them; it can build its lists from here (adding the Finanzamt's payment references
 * for debits, „2601/03+“, „0601/“, „USt-Voranmeldung“) instead of keeping a copy.
 */
export const SVS_TERMS = ['Sozialvers.', 'Sozialversicherung', 'SVS', 'WGKK', 'ÖGK'] as const
export const FINANZAMT_TERMS = ['Finanzamt', 'Abgabenkonto'] as const

// The words anywhere („Sozialversicherungsanstalt“, „Sozialvers.Anstalt“, „FINANZAMT
// OESTERREICH“, „Abgabenkonto 03 …“); the acronyms only as words of their own, so a
// code that merely contains „SVS“ doesn't count. No u flag: the project compiles for a
// target without it.
export const SVS_PATTERN = /sozialvers|(?:^|[^a-z0-9äöüß])(?:svs|wgkk|ögk|oegk)(?![a-z0-9äöüß])/i
export const FINANZAMT_PATTERN = /finanzamt|abgabenkonto/i
// The Finanzamt's own account as the bank prints its holder: „Wien 3/6/7/11/15 Schwechat
// Gerasd“ (cut at the field's length), as on the owner's FA debits. Read from the paying
// account's holder only, never from a client's text.
export const FINANZAMT_HOLDER = /schwechat\s*gerasd/i

/**
 * Payment processors whose card purchases read „PROCESSOR*VENDOR“ on the statement
 * („PADDLE.NET* KLANGIO“, „KLARNA*THOMANN“, „MOL*NUKI“, „PAYPAL *STEAM“). A credit in
 * that form gives a card purchase back. A payout from PayPal or Stripe to the owner
 * reads differently („PayPal Europe S.a r.l. et Cie …“) and stays a client payment.
 */
export const PAYMENT_PROCESSORS = ['PADDLE.NET', 'PADDLE', 'STRIPE', 'KLARNA', 'PAYPAL', 'MOL', 'SQ', 'SUMUP'] as const
// „PROCESSOR*VENDOR“ in a bank text: group 1 the processor, group 2 the vendor up to the
// next „\“, „|“ or „*“. Shared by the refund check here and the import's checks on debits.
export const PROCESSOR_PURCHASE = new RegExp(
  `(?:^|[^a-z0-9.])(${PAYMENT_PROCESSORS.map(p => p.replace(/\./g, '\\.')).join('|')})\\s*\\*\\s*([a-z0-9][^\\\\|*]*)`,
  'i',
)

// A purchase through a payment processor named in a bank text or counterparty
// („PAYPAL *INTERNETBS“, „PADDLE.NET* KLANGIO\LISBOA“, „MOL*NUKI HOME SOLUTION“): the
// processor as PAYMENT_PROCESSORS writes it, and the vendor behind it (trimmed, at most
// 40 characters). null when the text names none — a payout from PayPal or Stripe
// („PayPal Europe S.a r.l. et Cie …“) is not in that form.
export function processorPurchaseOf(text: string | null | undefined): { processor: string; vendor: string } | null {
  const m = (text || '').match(PROCESSOR_PURCHASE)
  return m ? { processor: m[1].toUpperCase(), vendor: m[2].trim().slice(0, 40) } : null
}

// The paying account, read from the bank text (column 1, else the reference). Odd text
// (a draft's row) is none, as in ownTransfer: this runs before every credit's checks.
const payingAccount = (tx: CreditText): CounterpartyAccount | null => counterpartyAccountOf(tx)
const fromOwnBusinessAccount = (account: CounterpartyAccount | null): boolean =>
  !!account && OWN_BUSINESS_IBANS.includes(account.iban)

/**
 * A private deposit, which lib/matcher.ts books by its fixed rule: explicit wording
 * („Privateinlage“, „private Einzahlung“, „Eigeneinlage“) — 'wording' — or a transfer
 * from one of the owner's own accounts (lib/own-transfer.ts) whose text names no
 * invoice — 'own'; with one it may be a client paying through his private account. An
 * invoice is named when the own-transfer check finds an invoice-like token („RN-…“, „Rg
 * 4711“) or the strict reader one of the owner's invoice numbers (extractIncomeInvoiceNumber:
 * „Re-Nr. …“, „Invoice # …“, a „|“ part „202501901“). Never from one of his business
 * accounts (OWN_BUSINESS_IBANS, checked first, whatever the text says): a client payment
 * received there, or a transfer between his accounts (flagOwnAccountCredit asks). A bare
 * FE/… reference is no marker: easybank puts those on client payments too.
 */
export const PRIVATE_DEPOSIT_PATTERN = /privateinlage|private\s+einzahlung|eigeneinlage/i
export type PrivateDeposit = 'wording' | 'own' | null
export function privateDepositKind(tx: CreditText): PrivateDeposit {
  if (fromOwnBusinessAccount(payingAccount(tx))) return null
  if (PRIVATE_DEPOSIT_PATTERN.test(`${tx.reference || ''} ${tx.counterparty || ''}`)) return 'wording'
  const own = ownTransfer(tx)
  return own && !own.invoiceRef && !extractIncomeInvoiceNumber(tx) ? 'own' : null
}
export const isPrivateDeposit = (tx: CreditText): boolean => privateDepositKind(tx) !== null

/**
 * The AI put a credit on the Privateinlagen account although the fixed rule did not
 * recognise it (no private wording, not from the owner's own account): the owner's to
 * check, never ticked by „Alle“.
 */
export const PRIVATE_DEPOSIT_GUESS_NOTE = '⚠ Als Privateinlage eingestuft, aber nicht als Überweisung von deinem eigenen Konto erkannt — prüfen.'
type Guess = { certainty?: 'hoch' | 'niedrig'; reasoning: string }
const flagGuess = <T extends Guess>(s: T, note: string): T =>
  ({ ...s, certainty: 'niedrig', reasoning: `${note} ${s.reasoning || ''}`.trim() })
export function flagPrivateDepositGuess<T extends Guess>(s: T, revenueAccountName: string | null | undefined): T {
  return /privateinlag/i.test(revenueAccountName || '') ? flagGuess(s, PRIVATE_DEPOSIT_GUESS_NOTE) : s
}

/**
 * A credit from one of the owner's own accounts that the fixed rule did not take, checked
 * against where it came from. From one of his business accounts (OWN_BUSINESS_IBANS): a
 * client payment received there, or a transfer between his accounts — never a
 * Privateinlage, and only he knows which. From his own private account with an invoice
 * number in the text (as privateDepositKind reads it): a client paying through it, or a
 * Privateinlage. From an account in his name with a title or „e.U.“ besides
 * (ownerNameWithExtras): a transfer between his accounts, a Privateinlage or a client
 * payment. Its note, or null for anyone else. No question asks about a Drive invoice of
 * its amount any more: Analyse finds a Drive invoice only by the bank text's number (P1-10).
 */
export const OWN_BUSINESS_CREDIT_NOTE = '⚠ Von deinem anderen Geschäftskonto — eine Kundenzahlung, die dort einging? Dann als Einnahme mit ihrem Eingangsdatum buchen; sonst ein Übertrag zwischen deinen Konten: hier nicht buchen.'
export const ownCreditInvoiceNote = (ref: string): string =>
  `⚠ Von deinem eigenen Konto, aber mit Rechnungsnummer „${ref}“ im Text — Kundenzahlung über dein Privatkonto (dann Einnahme zu dieser Rechnung) oder Privateinlage? Bitte prüfen.`
export const ownAccountCreditNote = (holder: string): string =>
  `⚠ Von einem Konto auf deinen Namen („${holder}“) — Übertrag zwischen deinen Konten (dann hier nicht buchen), Privateinlage oder Kundenzahlung? Bitte prüfen.`
export function ownCreditNote(tx: CreditText): string | null {
  const account = payingAccount(tx)
  if (!account) return null
  if (fromOwnBusinessAccount(account)) return OWN_BUSINESS_CREDIT_NOTE
  const own = ownTransfer(tx)
  // The number that kept the fixed rule off (privateDepositKind): the own-transfer check's
  // token, else the strict reader's
  const ref = own ? (own.invoiceRef ?? extractIncomeInvoiceNumber(tx)) : null
  if (ref) return ownCreditInvoiceNote(ref)
  return ownerNameWithExtras(account.holder) ? ownAccountCreditNote(account.holder) : null
}

// A credit the owner's own rule or questions take: a Privateinlage (the fixed rule) or one
// from one of his own accounts (ownCreditNote asks). Neither a client's question about an
// authority (authorityMention) nor the Mado question (lib/drive-invoices.ts) is its.
export const isOwnCredit = (tx: CreditText): boolean => isPrivateDeposit(tx) || ownCreditNote(tx) !== null

/**
 * The AI's answer on a credit: from one of the owner's own accounts (ownCreditNote)
 * unsure, whatever account the AI chose; otherwise only a Privateinlage guess is
 * (flagPrivateDepositGuess).
 */
export function flagOwnAccountCredit<T extends Guess>(s: T, tx: CreditText, revenueAccountName: string | null | undefined): T {
  const note = ownCreditNote(tx)
  return note ? flagGuess(s, note) : flagPrivateDepositGuess(s, revenueAccountName)
}

// A keyword as a whole word of the text („MAGENTA“ in „Magenta Telekom“, not „romiete“
// inside „Büromiete“). Shorter than three characters it says nothing.
function hasWord(text: string, word: string): boolean {
  const w = word.trim().toLowerCase()
  if (w.length < 3) return false
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9äöüß])${escaped}(?![a-z0-9äöüß])`, 'i').test(text)
}

// The Buchungsregel whose keyword is the payer: the keyword step of matchRules
// (lib/rule-match.ts) on the counterparty alone, without its amount range, which a partial
// refund would fail. Not the free text of the transfer: a client's „Miete Aufnahmeraum“
// or „Jingle Magenta Kampagne“ says nothing about who pays, and July's Akad. f. Kunst
// credit carries „MIETE“ in its text. A keyword written for the bank text („Hausmann
// Peter|Miete“) counts by its parts.
function ruleOf(tx: CreditText, vendors: readonly RuleKeywords[]): RuleKeywords | null {
  const payer = (tx.counterparty || '').toLowerCase()
  if (!payer.trim()) return null
  for (const v of vendors) {
    if (!v.active) continue
    for (const s of v.match_strings || []) {
      if (s && s.split('|').some(part => hasWord(payer, part))) return v
    }
  }
  return null
}

// A card transaction: easybank writes them as „MC/…|E-COMM …“ or „MC/…|POS …“, debit or
// credit. Clients pay by transfer, so a credit in that form gives a purchase back (July's
// „MC/000000610|E-COMM 0,83 … PADDLE.NET* KLANGIO“).
export const CARD_TRANSACTION = /(?:^|[\s|])MC\/\d+[^|]*\|\s*(?:E-COMM|POS)\b/i

// ─── The Sozialversicherung and the Finanzamt: who pays decides ───────────────────────

export type Authority = 'Sozialversicherung' | 'Finanzamt'

// The authority a text names: the SVS by its words, the Finanzamt by its name or the
// Abgabenkonto
const authorityNamedIn = (text: string): Authority | null =>
  SVS_PATTERN.test(text) ? 'Sozialversicherung' : FINANZAMT_PATTERN.test(text) ? 'Finanzamt' : null
// The authority an account's holder is: as its name says (cut by the bank at the line's
// end, „Sozialversicherungsansta“, it still does), or the Finanzamt's own account
const authorityOfHolder = (holder: string): Authority | null =>
  authorityNamedIn(holder) ?? (FINANZAMT_HOLDER.test(holder) ? 'Finanzamt' : null)
// The paying account's holder as the bank prints it, or '' (no account in the text, or a
// holder on a line of its own before the purpose line)
const payingHolder = (tx: CreditText): string => (payingAccount(tx)?.holder ?? '').trim()

/**
 * The Sozialversicherung or the Finanzamt paying this credit, or null. Who pays decides,
 * not what a client wrote („Workshop Finanzamt Wien“, „Honorar … abzgl.
 * Sozialversicherung“): a credit's counterparty is its purpose line whenever it has one
 * (lib/csv-parser.ts), so the payer is the paying account's holder.
 * - „Abgabenkonto“ in the bank text: the Finanzamt, whoever the holder (its own word);
 * - else, with a holder: that holder alone — the SVS by its words, the Finanzamt by its
 *   name or its account („Wien 3/6/7/11/15 Schwechat Gerasd“); anyone else is none (a
 *   client whose name has „SVS“ as a word of its own is taken for the SVS);
 * - else (no IBAN in the text, a draft's row without it, a holder on a line of its own):
 *   the counterparty, as before.
 */
export function authorityCredit(tx: CreditText): Authority | null {
  if (/abgabenkonto/i.test(tx.reference || '')) return 'Finanzamt'
  const holder = payingHolder(tx)
  return holder ? authorityOfHolder(holder) : authorityNamedIn(tx.counterparty || '')
}
// Who paid a credit that is not the Sozialversicherung's or the Finanzamt's: its printed
// holder; '' when it is theirs, or no holder is printed
const otherPayer = (tx: CreditText): string => (authorityCredit(tx) ? '' : payingHolder(tx))

/**
 * Why a credit is a refund from an expense vendor, or null when it isn't one:
 * - its counterparty or bank text has a Buchungsregel's keyword → „Buchungsregel „X““;
 * - the Sozialversicherung pays it → „Sozialversicherung“, or the Finanzamt → „Finanzamt“
 *   (authorityCredit: by the paying account's holder, or the Abgabenkonto);
 * - it is a card purchase given back („PROCESSOR*VENDOR“) → „Kauf bei VENDOR über X“;
 * - a card issuer pays it, as its account's holder (a credit balance after a returned
 *   purchase, a bonus: money of a settlement back) → „Guthaben aus der
 *   Kreditkartenabrechnung PayLife“ (lib/card-issuers.ts). An issuer only named in a
 *   client's text („Workshop bezahlt per Amex“) is none.
 * „Gutschrift“ alone says nothing: every credit's bank text starts with it. A private
 * deposit and a credit naming one of the owner's invoices (RN-…) are never refunds.
 */
export function refundReason(tx: CreditText, vendors: readonly RuleKeywords[]): string | null {
  if (isPrivateDeposit(tx)) return null
  const counterparty = tx.counterparty || ''
  const reference = tx.reference || ''
  if (invoiceKey(`${reference} ${counterparty}`)) return null

  const rule = ruleOf(tx, vendors)
  if (rule) return `Buchungsregel „${rule.name}“`

  // Who pays, not what a client wrote: a client's text naming either is asked instead
  // (authorityMention)
  const authority = authorityCredit(tx)
  if (authority) return authority

  const purchase = processorPurchaseOf(counterparty) ?? processorPurchaseOf(reference)
  if (purchase) return `Kauf bei ${purchase.vendor} über ${purchase.processor}`
  if (CARD_TRANSACTION.test(reference)) {
    const merchant = counterparty.split('\\')[0].trim().slice(0, 40)
    return merchant ? `Kartenzahlung bei ${merchant} zurück` : 'Kartenzahlung zurück'
  }
  // A card issuer as the paying account's holder; a card row above has no such account,
  // and an issuer named there („AMEX TRAVEL“) is a merchant
  const issuerCredit = issuerCreditReason(tx)
  if (issuerCredit) return issuerCredit
  return null
}

/** What a refund row says instead of a suggestion. */
export const REFUND_NOTE = '⚠ Erstattung — in bookamat als Aufwandsminderung buchen'
/**
 * The Finanzamt's credit is no reduction of an expense: it pays back Umsatzsteuer
 * (bookamat's Ertragskonto „Vom Finanzamt erstattete USt“) or Einkommensteuer (private,
 * a Privateinlage), and the bank text doesn't say which.
 */
export const FINANZAMT_CREDIT_NOTE =
  '⚠ Gutschrift vom Finanzamt — in bookamat buchen: USt-Erstattung auf „Vom Finanzamt erstattete USt“, Einkommensteuer-Erstattung als Privateinlage'
/**
 * The Sozialversicherung pays back contributions (a reduction of the Sozialversicherung
 * expense) but also pays benefits to the insured (Wahlarzt-Kostenerstattung, Krankengeld,
 * Wochengeld): those are private.
 */
export const SVS_CREDIT_NOTE =
  '⚠ Gutschrift der Sozialversicherung — in bookamat buchen: Beitragsgutschrift als Aufwandsminderung auf „Sozialversicherung“, Leistungen (Arztkosten, Krankengeld …) als Privateinlage'
export const refundNote = (reason: string): string =>
  reason === 'Finanzamt' ? FINANZAMT_CREDIT_NOTE
    : reason === 'Sozialversicherung' ? SVS_CREDIT_NOTE
    : `${REFUND_NOTE} (${reason})`

/**
 * A credit whose text names the Finanzamt or the Sozialversicherung, paid by someone else:
 * a holder is printed, and the credit is not theirs (authorityCredit). Mostly a client's
 * payment („Workshop Finanzamt Wien“, „Honorar Juli abzgl. Sozialversicherung“) — but it
 * may be the authority's from an account the app does not know, so it is asked, never
 * booked in bulk. Read in the counterparty and the whole bank text (a purpose over two
 * lines). None for the owner's own accounts: their own rules and questions speak
 * (isPrivateDeposit, ownCreditNote).
 */
export type AuthorityMention = { authority: Authority; holder: string }
export function authorityMention(tx: CreditText): AuthorityMention | null {
  const holder = otherPayer(tx)
  if (!holder) return null
  if (isOwnCredit(tx)) return null
  const authority = authorityNamedIn(`${tx.counterparty || ''} ${tx.reference || ''}`)
  return authority ? { authority, holder } : null
}
export const authorityMentionNote = (m: AuthorityMention): string => m.authority === 'Finanzamt'
  ? `⚠ Der Text nennt das Finanzamt, gezahlt hat aber „${m.holder}“ — Kundenzahlung (dann Einnahme) oder Erstattung vom Finanzamt (dann nicht hier, sondern in bookamat buchen)? Bitte prüfen.`
  : `⚠ Der Text nennt die Sozialversicherung, gezahlt hat aber „${m.holder}“ — Kundenzahlung (dann Einnahme) oder Gutschrift der Sozialversicherung (dann nicht hier, sondern in bookamat buchen)? Bitte prüfen.`
// The note for a credit, or null when its text names neither or the authority pays it
export const authorityMentionNoteOf = (tx: CreditText): string | null => {
  const m = authorityMention(tx)
  return m ? authorityMentionNote(m) : null
}
// The AI's answer on such a credit: unsure, the note first, so „Alle“ never ticks it
export function flagAuthorityMention<T extends Guess>(s: T, tx: CreditText): T {
  const note = authorityMentionNoteOf(tx)
  return note ? flagGuess(s, note) : s
}

// ─── Drafts saved before refunds were decided by who pays ─────────────────────────────

// An old refund row of the Finanzamt or the Sozialversicherung that someone else paid
export const staleAuthorityRefundNote = (holder: string): string =>
  `⚠ Älterer Entwurf: als Erstattung eingestuft, gezahlt hat aber „${holder}“ — eine Kundenzahlung? Dann CSV neu analysieren.`

/**
 * A draft analysed before this update, loaded (lib/import-drafts.ts convertDraftRows,
 * before the income account guard): an income row the refund check now calls a refund
 * (an SVS credit with a purpose line; a Buchungsregel's by `rules`, the current ones —
 * none: only the refunds that need none) becomes a refund row, as the booking route
 * already treats it: `refund`, its note in front of match_note, its suggestion kept but
 * never booked. Only a row with no refund yet, no Mado invoice and no fixed rule's
 * suggestion. A row held as booked (status 'duplicate') converts too and keeps its hold,
 * as a new Analyse holds a refund row (PR „Job 1 fixes“ § 3.1): its booking is then shown
 * beside the refund, not beside a revenue suggestion. `changed`: the converted rows not
 * held as booked — the page unticks them; a held row is never counted or unticked.
 * An old refund row of the Finanzamt or the Sozialversicherung that someone else paid (a
 * client whose text named it) keeps `refund`: there is no AI answer to fall back on, and
 * the booking route keeps skipping it until a new Analyse. Its note says so, in front.
 * Converting twice changes nothing.
 */
export function refundDraftRows(
  rows: MatchedIncomeTransaction[],
  rules: readonly RuleKeywords[],
): { rows: MatchedIncomeTransaction[]; changed: number[] } {
  const changed: number[] = []
  const out = rows.map((t, i) => {
    if (!t?.transaction) return t
    if (t.refund) {
      if (t.refund !== 'Finanzamt' && t.refund !== 'Sozialversicherung') return t
      const holder = otherPayer(t.transaction)
      if (!holder) return t
      const note = staleAuthorityRefundNote(holder)
      if ((t.match_note || '').split(' · ').includes(note)) return t
      return { ...t, match_note: [note, t.match_note].filter(Boolean).join(' · ') }
    }
    if (t.mado_invoice || t.ai_suggested?.source === 'rule') return t
    const reason = refundReason(t.transaction, rules)
    if (!reason) return t
    if (t.status !== 'duplicate') changed.push(i)
    return { ...t, refund: reason, match_note: [refundNote(reason), t.match_note].filter(Boolean).join(' · ') }
  })
  return { rows: out, changed }
}

// The page's notice after `n` rows of an older draft became refund rows (joined to its
// others); `unticked`: some of them were ticked (the page unticks them)
export const refundDraftNotice = (n: number, unticked = true): string =>
  `Älterer Entwurf: ${n === 1 ? 'eine Gutschrift ist' : `${n} Gutschriften sind`} jetzt als Erstattung erkannt — nicht hier als Einnahme buchen, sondern in bookamat${unticked ? '; nicht mehr angekreuzt' : ''}.`
