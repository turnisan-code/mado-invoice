// Credit card settlements in the bank CSV (PR „Vorsteuer“, fixed rules; AUDIT.md „Found
// in the July–November import“). „PAYLIFE ABRECHNUNG VOM 18.10.2026 … PayLife“ (−28,30)
// came back „Privatentnahme“ under the old IBAN rule; it was the business credit card's
// Kartenentgelt. What a settlement pays changes every month — only the fee, or card
// purchases too, each a supply of its own with its own receipt — and the statement lies in
// the issuer's portal, not in the mailbox. So a fixed rule, before any Buchungsregel,
// receipt search or AI, proposes the fee booking („Geschäftskonto & Geldverkehr“, „Keine
// Vorsteuer“, 0 %), asks for the statement as Beleg and says how to split purchases: never
// certain, never ticked, never taken by „Alle“.
//
// Pure and client-safe: lib/matcher.ts, the import page and the booking route share it.
// No env variable, no server module.
import type { AiSuggestion, BookamatAccounts, EasybankTransaction, MatchedTransaction } from '@/lib/expenses/types'
import { CARD_ISSUERS, cardIssuerOf } from './card-issuers'
import { CARD_TRANSACTION, PROCESSOR_PURCHASE } from './refunds'
import { findCounterpartyAccount, ownerNameWithExtras, ownTransfer } from './own-transfer'
import { normName } from './rule-accounts'
import { keineVorsteuerOf, purchasePool } from './tax-accounts'
import { csvBankAccountId } from './bank-account'
import { deDate } from './booking-dates'

export type CardSettlement = {
  issuer: string               // 'PayLife' …, 'Mastercard', 'Visa', the debiting bank, or 'Kreditkarte'
  where: string                // where the statement is („im PayLife Serviceportal“)
  statementDate: string | null // ISO, from „VOM 18.10.2026“ / „v. 18.10.2026“: a real date only
  month: string                // 'MM/YYYY' for the title: the statement date's, else „10/2026“ in the text, else the bank date's ('' when none)
}

// A bank row, or a draft's (whose CSV columns may be gone: then its reference is read)
export type SettlementTx = {
  type?: string | null
  date?: string | null
  counterparty?: string | null
  reference?: string | null
  raw?: Record<string, string> | null
}

// A settlement whose text names neither an issuer nor a card network nor the debiting bank
export const GENERIC_ISSUER = 'Kreditkarte'
export const GENERIC_STATEMENT_WHERE = 'im Kundenportal der Bank oder des Kartenherausgebers'

// The bank's own fees and statements: never a card settlement
const BANK_FEE = /kontof(?:ü|ue|u)hr|kontoabschluss|\babschluss\b|kontoentgelt|entgeltabrechnung|spesenabrechnung|zinsabrechnung/i
// A fuel card's settlement: its fuel invoices are mailed, the AI and the car-cost rules
// take it
const FUEL_CARD = /tankkart/i
// A card statement by its wording (decisions L7): „Karten(-)abrechnung“ only as a word of
// its own or after „Kredit“ — never inside another compound („Fahrkartenabrechnung“,
// „Visitenkarten-Abrechnung“) — and „Kreditkarte“ near „Abrechnung“ on one line of the
// bank text. No u flag: the project compiles for a target without it.
const CARD_STATEMENT = /(?:^|[^a-zäöüß])(?:kredit)?karten?\s*-?\s*abrechnung|kreditkart[^|]{0,40}abrechnung|abrechnung[^|]{0,40}kreditkart/i
const NETWORK = /\b(master\s*card|visa)\b/i
// An issuer's or a card network's name right next to „Abrechnung“, a word of its own, on
// one line of the bank text (IMPORT-5): the name before it, at most 20 characters apart and
// followed by a space or by a hyphen right before „Abrechnung“ („DINERS CLUB ABRECHNUNG
// 10/2026“, „PAYLIFE ABRECHNUNG VOM …“, „MASTERCARD GOLD ABRECHNUNG“, „VISA-Abrechnung“),
// or right after it („Abrechnung Diners Club“). A statement's own compound counts as the
// word („PAYLIFE MONATSABRECHNUNG“, „PayLife Kreditkartenabrechnung“, „Kartenabrechnung
// PayLife“) — no other („Fahrkartenabrechnung“). Never a purpose that only mentions the
// card („Abrechnung Zimmer 12 bezahlt mit PayLife“, „Fahrkartenabrechnung bez. PayLife“),
// nor a compound of the name („Visa-Gebühr Abrechnung“: a travel visa's fee). No u flag.
const STATEMENT_WORD = '(?:monats|kreditkarten|karten)?-?abrechnung'
const nameBesideStatement = (name: RegExp): RegExp => new RegExp(
  `(?:${name.source})(?:\\s(?:[^|]{0,18}?[^|a-zäöüß])?|\\s*-\\s*)${STATEMENT_WORD}|(?:^|[^a-zäöüß])${STATEMENT_WORD}\\s+(?:${name.source})`, 'i')
const ISSUER_STATEMENTS = CARD_ISSUERS.map(i => ({ issuer: i.issuer, where: i.where, statement: nameBesideStatement(i.pattern) }))
const NETWORK_STATEMENT = nameBesideStatement(NETWORK)
const STATEMENT_DATE = /\b(?:vom|v\.)\s*(\d{2})\.(\d{2})\.(\d{4})\b/i
const TEXT_MONTH = /\b(0[1-9]|1[0-2])\/(20\d{2})\b/
// An easybank card purchase („Bezahlung Karte … MC/…“); CARD_TRANSACTION covers the
// „MC/…|E-COMM“ and „MC/…|POS“ forms
const CARD_PAYMENT = /^\s*bezahlung\s+karte\b/i
// A holder field that is the payment's text, not a bank's name (findCounterpartyAccount
// takes the last line when nothing follows the IBAN)
const NOT_A_BANK_NAME = /kart|abrechnung/i

// dd, mm, yyyy as an ISO date when it is a real calendar date („31.02.2026“ is none)
function realIso(dd: string, mm: string, yyyy: string): string | null {
  const d = Number(dd), m = Number(mm), y = Number(yyyy)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}

function settlementOf(issuer: string, where: string, text: string, bankDate: string | null | undefined): CardSettlement {
  const d = text.match(STATEMENT_DATE)
  const statementDate = d ? realIso(d[1], d[2], d[3]) : null
  const m = text.match(TEXT_MONTH)
  const month = statementDate ? `${statementDate.slice(5, 7)}/${statementDate.slice(0, 4)}`
    : m ? `${m[1]}/${m[2]}`
    : typeof bankDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(bankDate) ? `${bankDate.slice(5, 7)}/${bankDate.slice(0, 4)}`
    : ''
  return { issuer, where, statementDate, month }
}

/**
 * A credit card issuer's settlement debited from the business account, or null. Read from
 * the bank text (column 1, else the reference) and the counterparty, in this order:
 * - only a debit; never a card purchase („Bezahlung Karte“, „MC/…|E-COMM“, „MC/…|POS“ —
 *   an „AMEX TRAVEL“ merchant too), a purchase through a payment processor („PAYPAL *X“,
 *   „KLARNA*X“ …), the bank's own fees (Kontoführung, Abschluss, Entgeltabrechnung …), a
 *   fuel card, or a transfer to one of the owner's own accounts;
 * - an issuer as the counterparty account's holder (CARD_ISSUERS), whatever the wording: a
 *   SEPA debit, or a transfer paying the card's balance;
 * - an issuer named in the text right next to „Abrechnung“, on one line („DINERS CLUB
 *   ABRECHNUNG 10/2026“, „Abrechnung Diners Club“) — not one a merchant's purpose names
 *   („Abrechnung Zimmer 12 bezahlt mit PayLife“);
 * - a card statement by its wording („Kreditkartenabrechnung“, „Abrechnung Kreditkarte“):
 *   the debiting bank as issuer, else 'Kreditkarte';
 * - a card network right next to „Abrechnung“, likewise („MASTERCARD ABRECHNUNG“, „VISA
 *   Abrechnung“; not „Visa-Gebühr Abrechnung“).
 * Anything else („Wien Energie Jahresabrechnung“, „Betriebskostenabrechnung“, PayPal's or
 * Klarna's own SEPA debits) is none: the AI as before. Never throws.
 */
export function cardSettlement(tx: SettlementTx | null | undefined): CardSettlement | null {
  try {
    if (!tx || tx.type !== 'expense') return null
    const col1 = tx.raw?.col1
    const bankText = typeof col1 === 'string' ? col1 : (typeof tx.reference === 'string' ? tx.reference : '')
    const counterparty = typeof tx.counterparty === 'string' ? tx.counterparty : ''
    const text = `${bankText} ${counterparty}`
    // The same, its lines kept apart: a name and „Abrechnung“ count only on one line
    const lines = `${bankText}|${counterparty}`

    if (CARD_TRANSACTION.test(bankText) || CARD_PAYMENT.test(bankText)) return null
    if (PROCESSOR_PURCHASE.test(counterparty) || PROCESSOR_PURCHASE.test(bankText)) return null
    if (BANK_FEE.test(text) || FUEL_CARD.test(text)) return null
    // The owner's own accounts, whatever the purpose says („Ausgleich Kreditkartenabrechnung“)
    if (ownTransfer({ reference: bankText, raw: tx.raw ?? null })) return null
    const col0 = tx.raw?.col0
    const holder = findCounterpartyAccount(bankText, typeof col0 === 'string' ? col0 : null)?.holder ?? ''
    if (ownerNameWithExtras(holder)) return null

    const issuer = cardIssuerOf(tx)
    if (issuer?.by === 'holder') return settlementOf(issuer.issuer, issuer.where, text, tx.date)
    const named = ISSUER_STATEMENTS.find(i => i.statement.test(lines))
    if (named) return settlementOf(named.issuer, named.where, text, tx.date)
    if (CARD_STATEMENT.test(text)) {
      const bank = holder && !NOT_A_BANK_NAME.test(holder) ? holder : GENERIC_ISSUER
      return settlementOf(bank, GENERIC_STATEMENT_WHERE, text, tx.date)
    }
    const network = lines.match(NETWORK_STATEMENT)?.[0].match(NETWORK)?.[1]
    if (network) return settlementOf(/visa/i.test(network) ? 'Visa' : 'Mastercard', GENERIC_STATEMENT_WHERE, text, tx.date)
    return null
  } catch {
    return null
  }
}

// ─── The fixed rule's proposal ────────────────────────────────────────────────────

// Card fees are VAT-exempt financial services (§ 6 Abs 1 Z 8 UStG): this Steuerkonto,
// „Keine Vorsteuer“, 0 %
export const CARD_FEE_ACCOUNT = 'Geschäftskonto & Geldverkehr'
export const CARD_SETTLEMENT_CATEGORY = 'Kartenabrechnung'
const TITLE_MAX = 50

// „ PayLife“ in the texts; nothing for a settlement without a named issuer
const issuerLabel = (s: Pick<CardSettlement, 'issuer'>): string =>
  s.issuer && s.issuer !== GENERIC_ISSUER ? ` ${s.issuer}` : ''

// „Kreditkartenabrechnung PayLife 10/2026“; without an issuer „Kreditkartenabrechnung
// 10/2026“. At most 50 characters: a long bank name is cut, the month kept.
export function cardSettlementTitle(s: CardSettlement): string {
  const head = 'Kreditkartenabrechnung'
  const month = s.month ? ` ${s.month}` : ''
  const issuer = issuerLabel(s).slice(0, Math.max(0, TITLE_MAX - head.length - month.length)).trimEnd()
  return `${head}${issuer}${month}`.slice(0, TITLE_MAX)
}

// N1: the row's first note, also on the collapsed row
export const cardSettlementNote = (s: Pick<CardSettlement, 'where'>): string =>
  `⚠ Kreditkartenabrechnung — Abrechnung ${s.where} herunterladen und als Beleg anhängen; Käufe darauf je Kauf als eigene Zeile buchen`
// N2: the fixed rule's label (as „Feste Regel: Überweisung auf dein eigenes Konto“)
export const cardSettlementRuleNote = (s: Pick<CardSettlement, 'issuer'>): string =>
  `Feste Regel: Kreditkartenabrechnung${issuerLabel(s)}`
// N3: bookamat's lists could not be loaded
export const cardSettlementListsMissingNote = (s: Pick<CardSettlement, 'issuer' | 'where'>): string =>
  `⚠ Kreditkartenabrechnung${issuerLabel(s)} — Konten von bookamat nicht ladbar: „${CARD_FEE_ACCOUNT}“, „Keine Vorsteuer“, 0 % selbst wählen oder neu analysieren; Abrechnung ${s.where} herunterladen und als Beleg anhängen`
// N4: the year's books lack the fee account or its „Keine Vorsteuer“
export const cardSettlementAccountsMissingNote = (s: Pick<CardSettlement, 'issuer' | 'where'>): string =>
  `⚠ Kreditkartenabrechnung${issuerLabel(s)} — „${CARD_FEE_ACCOUNT}“ oder „Keine Vorsteuer“ fehlt in bookamat: Konten selbst wählen; Abrechnung ${s.where} herunterladen und als Beleg anhängen`
// N5: a Buchungsregel's keyword matched the settlement; it is not applied
export const ruleNotForSettlementNote = (ruleName: string): string =>
  `Buchungsregel „${ruleName}“ gilt nicht für Kreditkartenabrechnungen — was gebucht wird, steht auf der Abrechnung`

// R1: the suggestion's reasoning (the „Feste Regel“ banner). Every line of a settlement is
// spent on its debit date (EStR Rz 4624, VwGH Ro 2021/13/0003): one booking, one
// Buchungsdatum — the purchases are not moved to their card dates.
export function cardSettlementReasoning(s: CardSettlement): string {
  const date = s.statementDate ? ` vom ${deDate(s.statementDate)}` : ''
  return [
    `Kreditkartenabrechnung${issuerLabel(s)}${date}.`,
    `Die Abrechnung liegt ${s.where}, nicht im Postfach: dort herunterladen und hier als Beleg anhängen.`,
    `Nur das Kartenentgelt: so buchen — „${CARD_FEE_ACCOUNT}“, „Keine Vorsteuer“, 0 % (Kartenentgelte sind umsatzsteuerfrei).`,
    'Mit Käufen: in den Details „+ Zeile hinzufügen“ und je Kauf eine Zeile mit Betrag, Steuerkonto, Vorsteuerkonto und USt laut Händlerrechnung; das Entgelt bleibt in der ersten Zeile, die Händlerrechnungen danach in bookamat zur Buchung hochladen.',
    'Das Buchungsdatum bleibt der Tag dieser Abbuchung, auch für die Käufe — nicht das Kaufdatum.',
    'Ein Kauf, der schon über Belege gebucht ist, nicht noch einmal: dann die Abrechnung ohne ihn von Hand in bookamat buchen und hier nicht ankreuzen.',
  ].join(' ')
}

// B1: the page's box on a settlement row without a suggestion (in place of „Lieferant nicht
// erkannt …“, and without „+ Buchungsregel“)
export const cardSettlementBoxText = (s: Pick<CardSettlement, 'issuer'>): string =>
  `Kreditkartenabrechnung${issuerLabel(s)} — Konten oben selbst wählen („${CARD_FEE_ACCOUNT}“, „Keine Vorsteuer“, 0 %); Käufe auf der Abrechnung je Kauf als eigene Zeile buchen, mit dem Buchungsdatum dieser Abbuchung. Eine Buchungsregel gilt hier nicht.`

type SettlementLists = Pick<BookamatAccounts, 'cost_accounts' | 'purchasetax_accounts'>

/**
 * The fixed rule's proposal: „Geschäftskonto & Geldverkehr“ by name (that name exactly,
 * else the only Steuerkonto whose name contains „Geldverkehr“), „Keine Vorsteuer“ among
 * the Vorsteuerkonten it links (the whole purchase side when it links none; never a
 * sales-side account), 0 %, BA 100 %, the CSV's own bank account. Unsure, Beleg required.
 * null when the year's books lack either account. Every id differs per year: always by
 * name in the year's lists.
 */
export function cardSettlementSuggestion(
  s: CardSettlement,
  lists: SettlementLists | null | undefined,
  csvBankId: number,
): AiSuggestion | null {
  const costAccounts = lists?.cost_accounts ?? []
  const named = costAccounts.filter(a => /geldverkehr/i.test(a.name))
  const cost = costAccounts.find(a => normName(a.name) === normName(CARD_FEE_ACCOUNT)) ?? (named.length === 1 ? named[0] : undefined)
  if (!cost) return null
  const tax = keineVorsteuerOf(purchasePool(lists?.purchasetax_accounts, cost.purchasetaxaccounts))
  if (!tax) return null
  return {
    cost_account_id: cost.id,
    purchasetax_account_id: tax.id,
    bank_account_id: csvBankId,
    tax_percent: 0,
    // As any suggestion: BA USt follows (resolveExpenseDefaults); an account's lock wins
    deductibility_amount_percent: 100,
    deductible_share: 1,
    country: '',
    supplier_region: 'AT',
    vatin: '',
    title: cardSettlementTitle(s),
    category: CARD_SETTLEMENT_CATEGORY,
    reasoning: cardSettlementReasoning(s),
    requires_invoice: true,
    certainty: 'niedrig',
    source: 'rule',
  }
}

/**
 * The row Analyse sends for a settlement (lib/matcher.ts enrichExpense, right after the
 * own transfer): no Buchungsregel, no receipt search, no AI. Always „Beleg fehlt“ — the
 * statement is needed whatever the accounts. The Rechnungsdatum is the statement's date
 * read from the bank text (an attached statement's date replaces it). Notes: N1 (or N3
 * without lists, N4 without the accounts), N2 with a suggestion, N5 when a Buchungsregel
 * matched (`ruleName`; it is not applied).
 */
export function cardSettlementExpenseRow(
  tx: EasybankTransaction,
  s: CardSettlement,
  lists?: Pick<BookamatAccounts, 'cost_accounts' | 'purchasetax_accounts' | 'bank_accounts'> | null,
  ruleName?: string | null,
): MatchedTransaction {
  const suggestion = lists ? cardSettlementSuggestion(s, lists, csvBankAccountId(lists.bank_accounts)) : null
  const first = suggestion ? cardSettlementNote(s) : lists ? cardSettlementAccountsMissingNote(s) : cardSettlementListsMissingNote(s)
  const rule = ruleName?.trim()
  return {
    transaction: tx,
    vendor: null,
    confidence: 0,
    gmail_message_id: null,
    gmail_subject: null,
    gmail_date: null,
    pdf_attachment_name: null,
    pdf_base64: null,
    extracted_invoice_date: s.statementDate,
    extracted_invoice_number: null,
    extracted_amount: null,
    title: suggestion?.title ?? cardSettlementTitle(s),
    status: 'missing_invoice',
    match_note: [first, suggestion ? cardSettlementRuleNote(s) : null, rule ? ruleNotForSettlementNote(rule) : null]
      .filter(Boolean).join(' · '),
    ai_suggested: suggestion ?? undefined,
  }
}

// /api/import/reclassify refuses a settlement (409): the classifier returns one account
// and cannot split a statement
export const CARD_SETTLEMENT_NO_AI = 'Kreditkartenabrechnung — feste Regel, keine KI-Neubewertung'

// ─── Tabs open and drafts saved since before the update ─────────────────────────────

/**
 * A settlement row from a page open since before the update: an AI suggestion (source
 * 'ai' or none) or a Buchungsregel's row. A new Analyse makes neither, and loading a draft
 * converts both (cardSettlementDraftRows), so the booking route refuses it, Testlauf too.
 * Passes: the fixed rule's row, a row without suggestion (the owner chose its accounts),
 * any row that is no settlement. The text says to save the draft first: a booking run saves
 * it, the Testlauf does not, and the reload drops what is not saved.
 */
export const STALE_CARD_SETTLEMENT_TEXT =
  'Kreditkartenabrechnung vor dem Update analysiert — Entwurf speichern, Seite neu laden, Abrechnung als Beleg anhängen, Zeile prüfen, dann buchen'
export function isStaleCardSettlementRow(
  t: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'ai_suggested'> | null | undefined,
): boolean {
  if (!t || !cardSettlement(t.transaction)) return false
  return !!t.vendor || (!!t.ai_suggested && t.ai_suggested.source !== 'rule')
}

/**
 * A draft analysed before this update: its settlement rows become the fixed rule's rows,
 * as a new Analyse makes them (`lists`: the year's, read beside the draft; none → no
 * suggestion, N3). Converted: a settlement row with an AI suggestion or a Buchungsregel,
 * and one without suggestion when the lists now give one. A row the fixed rule made stays.
 * A row held as booked (status 'duplicate') keeps its hold (own_status = the rule row's
 * status) and its title; the duplicate check's answer is kept on every row. The Gmail
 * receipt an old keyword search found is dropped (no search for settlements); a receipt
 * attached by hand is the page's state and stays. `changed`: the converted rows not held
 * as booked — the page unticks them. Converting twice changes nothing.
 */
export function cardSettlementDraftRows(
  rows: MatchedTransaction[],
  lists?: Pick<BookamatAccounts, 'cost_accounts' | 'purchasetax_accounts' | 'bank_accounts'> | null,
): { rows: MatchedTransaction[]; changed: number[] } {
  const changed: number[] = []
  const out = rows.map((t, i) => {
    const s = t ? cardSettlement(t.transaction) : null
    if (!s) return t
    const stale = isStaleCardSettlementRow(t)
    // The fixed rule's row already
    if (!stale && t.ai_suggested) return t
    const fresh = cardSettlementExpenseRow(t.transaction, s, lists, t.vendor?.name)
    // No suggestion before, and the lists give none now: as it is
    if (!stale && !fresh.ai_suggested) return t
    const held = t.status === 'duplicate'
    if (!held) changed.push(i)
    return {
      ...fresh,
      ...(t.duplicate_of !== undefined ? { duplicate_of: t.duplicate_of } : {}),
      ...(t.duplicate_check_failed !== undefined ? { duplicate_check_failed: t.duplicate_check_failed } : {}),
      ...(t.ack_duplicate_ids !== undefined ? { ack_duplicate_ids: t.ack_duplicate_ids } : {}),
      ...(held ? { status: 'duplicate' as const, own_status: fresh.status, title: t.title } : {}),
    }
  })
  return { rows: out, changed }
}

// The page's notice after converting `n` rows of an older draft (joined to its others);
// `unticked`: some of them were ticked (the page unticks them)
export const cardSettlementDraftNotice = (n: number, unticked = true): string => n === 1
  ? `Eine Kreditkartenabrechnung aus dem älteren Entwurf folgt jetzt der festen Regel${unticked ? ' und ist nicht mehr angekreuzt' : ''} — die Abrechnung als Beleg anhängen und prüfen.`
  : `${n} Kreditkartenabrechnungen aus dem älteren Entwurf folgen jetzt der festen Regel${unticked ? ' und sind nicht mehr angekreuzt' : ''} — die Abrechnungen als Beleg anhängen und prüfen.`
