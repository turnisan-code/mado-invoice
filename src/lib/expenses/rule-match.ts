/**
 * Which Buchungsregel a payment books (P2-7, PR „Job 1 fixes“ § 2.2).
 *
 * A rule fits a payment by a keyword in its counterparty or bank text, by its amount range,
 * and — once a receipt was read — by its invoice address on the receipt. When several fit,
 * the more specific one applies: an amount range, an address found on the receipt. Rules
 * that fit equally are never decided by the order they were read in: the row asks „Regel
 * wählen“, and the owner picks one, or the address on a receipt attached decides. An
 * address that could not be checked (no receipt, a scan) decides nothing, and nothing beats
 * it either. Every list this module returns is in one order (compareRules), whatever order
 * the rules came in.
 *
 * Pure and client-safe: no package, no env variable. Used by lib/matcher.ts (Analyse), the
 * booking and re-classification routes, Belege's routes and page (a receipt's rule),
 * /api/import/extract-invoice, and the import page (a row's choice, its receipts, a draft's
 * load through lib/import-drafts.ts).
 */

import type { EasybankTransaction, MatchedTransaction, Vendor } from '@/lib/expenses/types'
import { ownTransfer } from './own-transfer'
import { cardSettlement } from './card-settlement'
import { assignDuplicates, normTitle, type BookingLite, type DuplicateMatch, type PaymentRow } from './duplicates'
import { eur } from './money'
import { rateLabel } from './rule-vat'
import { isGmailReceiptNote, receiptDoubt } from './receipt-match'

// ─── One order ──────────────────────────────────────────────────────────────────────

// By name, lower-cased, as German sorts it; rules of the same name by id
export function compareRules(a: Pick<Vendor, 'name' | 'id'>, b: Pick<Vendor, 'name' | 'id'>): number {
  const byName = String(a.name ?? '').toLowerCase().localeCompare(String(b.name ?? '').toLowerCase(), 'de')
  if (byName) return byName
  const x = String(a.id ?? ''), y = String(b.id ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}
export const sortRules = <T extends Pick<Vendor, 'name' | 'id'>>(rules: readonly T[]): T[] => [...rules].sort(compareRules)
// Each rule once (the first copy of an id), in rule order
function rulesOnce(rules: readonly Vendor[]): Vendor[] {
  const seen = new Set<string>()
  return sortRules(rules.filter(r => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  }))
}

// ─── Matching ───────────────────────────────────────────────────────────────────────

/**
 * What the Buchungsregeln say of a payment:
 * - `rule`: the one that applies, or null;
 * - `tie`: two or more that fit equally (`rule` is null then) — the owner picks;
 * - `others`: rules that fit too, less specific than `rule` (or than the tied ones);
 * - `addressUnchecked`: a fitting rule's invoice address could not be checked (no receipt
 *   text was given);
 * - `droppedByAddress`: rules that fit by keyword and amount, but whose address is not on
 *   the receipt.
 */
export type RuleMatch = {
  rule: Vendor | null
  tie: Vendor[]
  others: Vendor[]
  addressUnchecked: boolean
  droppedByAddress: Vendor[]
}

// A rule's keywords, trimmed and lower-cased; an empty one is none (it would fit every row)
const keywordsOf = (rule: Pick<Vendor, 'match_strings'>): string[] =>
  (Array.isArray(rule.match_strings) ? rule.match_strings : [])
    .map(s => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
    .filter(Boolean)
// A rule's „Rechnungsadresse enthält“, trimmed; a blank one is none
export const addressOf = (rule: Pick<Vendor, 'invoice_address_match'>): string =>
  typeof rule.invoice_address_match === 'string' ? rule.invoice_address_match.trim() : ''
const hasRange = (rule: Pick<Vendor, 'amount_min' | 'amount_max'>) => rule.amount_min != null || rule.amount_max != null

/**
 * The Buchungsregeln for a payment. Active rules only. A rule fits when one of its keywords
 * is part of the counterparty or the bank text (any case, no word boundaries) and the gross
 * amount is within its range. Its invoice address: with `addressFound` (the receipt's text
 * was read), a rule whose address is not found drops out; without it, the rule stays, its
 * address unchecked.
 * - One fitting rule: it applies (its address unchecked or not).
 * - Two or more, and any address unchecked: a tie — no amount range wins over an address
 *   that may decide the other way.
 * - Otherwise the most specific applies: 1, + 0.1 for a range, + 0.2 for an address found.
 *   Equally specific ones tie. No keyword wins by being longer.
 */
export function matchRules(
  tx: Pick<EasybankTransaction, 'counterparty' | 'reference' | 'amount'>,
  rules: readonly Vendor[],
  addressFound?: (address: string) => boolean,
): RuleMatch {
  const counterparty = (tx.counterparty || '').toLowerCase()
  const bankText = (tx.reference || '').toLowerCase()
  // Scores in tenths: 10, + 1 for a range, + 2 for an address found
  const fitting: { rule: Vendor; score: number; unchecked: boolean }[] = []
  const dropped: Vendor[] = []
  for (const rule of rules) {
    if (!rule?.active) continue
    if (!keywordsOf(rule).some(k => counterparty.includes(k) || bankText.includes(k))) continue
    if (rule.amount_min != null && tx.amount < rule.amount_min) continue
    if (rule.amount_max != null && tx.amount > rule.amount_max) continue
    const address = addressOf(rule)
    let score = hasRange(rule) ? 11 : 10
    if (address && addressFound) {
      if (!addressFound(address)) {
        dropped.push(rule)
        continue
      }
      score += 2
    }
    fitting.push({ rule, score, unchecked: !!address && !addressFound })
  }
  const droppedByAddress = sortRules(dropped)
  const addressUnchecked = fitting.some(f => f.unchecked)
  if (fitting.length > 1 && addressUnchecked) {
    return { rule: null, tie: sortRules(fitting.map(f => f.rule)), others: [], addressUnchecked, droppedByAddress }
  }
  const best = Math.max(...fitting.map(f => f.score))
  const top = sortRules(fitting.filter(f => f.score === best).map(f => f.rule))
  const others = sortRules(fitting.filter(f => f.score < best).map(f => f.rule))
  return top.length === 1
    ? { rule: top[0], tie: [], others, addressUnchecked, droppedByAddress }
    : { rule: null, tie: top, others, addressUnchecked, droppedByAddress }
}

// The Buchungsregel for a captured receipt (Belege): its vendor as the counterparty, no
// bank text, its total as the amount. Rules that tie apply none: the form offers each of
// them (below, „Belege“).
export function suggestReceiptRules(
  ext: { vendor?: string | null; amount?: number | null },
  rules: readonly Vendor[],
): RuleMatch {
  if (!ext.vendor || !rules.length) return { rule: null, tie: [], others: [], addressUnchecked: false, droppedByAddress: [] }
  return matchRules({ counterparty: ext.vendor, reference: '', amount: ext.amount ?? 0 }, rules)
}

// ─── A rule's title ─────────────────────────────────────────────────────────────────

// The months as date-fns' German locale writes them („MMMM“): this module takes no package
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

// The booking title of a rule's row: its template with {vendor}, {month} („Juli 2026“) and
// {month_short} („07/2026“) of the payment's date (YYYY-MM-DD). A date that is none throws,
// as date-fns did.
export function generateTitle(rule: Pick<Vendor, 'name' | 'title_template'>, date: string): string {
  const d = /^(\d{4})-(\d{2})/.exec(date ?? '')
  const month = d ? Number(d[2]) : 0
  if (!d || month < 1 || month > 12) throw new RangeError('Invalid time value')
  return rule.title_template
    .replace('{vendor}', rule.name)
    .replace('{month}', `${MONTHS[month - 1]} ${d[1]}`)
    .replace('{month_short}', `${d[2]}/${d[1]}`)
}

// ─── Texts ──────────────────────────────────────────────────────────────────────────

const quoted = (rules: readonly Pick<Vendor, 'name'>[], sep = ', ') => rules.map(r => `„${r.name}“`).join(sep)

// The row of rules that tie: the owner picks one. When a readable receipt could decide (an
// invoice address unchecked), the row says so.
export const ruleTieNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `⚠ Mehrere Buchungsregeln passen: ${quoted(rules)} — Regel wählen`
export const ruleTieAddressNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `⚠ Mehrere Buchungsregeln passen: ${quoted(rules)} — Rechnungsadresse ohne lesbaren Beleg nicht prüfbar: Beleg anhängen oder Regel wählen`
// Two or more rules whose addresses are all missing from the receipt
export const ruleAddressMissingNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `⚠ Rechnungsadresse von ${quoted(rules, ' / ')} nicht im Beleg gefunden — Regel wählen oder die Adresse unter Buchungsregeln anpassen`
// The one rule that fit by its keyword lost by its address: the AI's suggestion, unsure
export const ruleAddressDroppedNote = (rule: Pick<Vendor, 'name'>): string =>
  `⚠ Regel „${rule.name}“ passt nach Stichwort, aber ihre Rechnungsadresse steht nicht im Beleg — KI-Vorschlag, bitte prüfen`
// How the rule was chosen among several (provenance, no warning)
export const ruleAddressNote = (rule: Pick<Vendor, 'name'>): string => `Zuordnung über Rechnungsadresse („${rule.name}“)`
export const ruleOutrankedNote = (rule: Pick<Vendor, 'name'>, others: readonly Pick<Vendor, 'name'>[]): string =>
  `Regel „${rule.name}“ — genauer als ${quoted(others)}`
export const rulePickedNote = (rule: Pick<Vendor, 'name'>): string => `Regel „${rule.name}“ gewählt (mehrere passten)`
// A receipt attached later whose invoice address names another of the row's rules: applied
// instead, and the row is not ticked
export const ruleSwitchedNote = (rule: Pick<Vendor, 'name'>, before: Pick<Vendor, 'name'>): string =>
  `Regel „${rule.name}“ über die Rechnungsadresse gewählt (statt „${before.name}“)`
// The receipt another rule's sender sent, dropped by a pick
export const receiptFromOtherRuleNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `Gefundener Beleg kam von ${rules.length ? quoted(rules, ' / ') : 'einer anderen Buchungsregel'} — entfernt`
// A receipt attached to a row whose rule the owner picked names only the invoice address of
// another rule it was chosen among: the pick stays, the row is not ticked
export const receiptOtherAddressNote = (others: readonly Pick<Vendor, 'name'>[], picked: Pick<Vendor, 'name'>): string =>
  `⚠ Beleg nennt die Rechnungsadresse von ${quoted(others, ' / ')} — gewählt ist „${picked.name}“: Regel oder Beleg prüfen`
// A booking of another tied rule, held as this payment's until the address decided
export const otherRuleBookedNote = (booked: Pick<Vendor, 'name'>, rule: Pick<Vendor, 'name'>): string =>
  `Gebucht ist „${booked.name}“ — diese Zahlung ist laut Rechnung „${rule.name}“`

// The address note Analyse wrote before PR „Job 1 fixes“ (as old drafts and tabs keep it,
// closing quote and all): the receipt's address decided the row's rule
const oldAddressNote = (name: string) => `Zuordnung über Rechnungsadresse („${name}")`

// The notes that ask the owner to pick a rule (Analyse's, a draft's — of a rule's row or of
// an AI row —, the page's)
const CHOICE_NOTE_STARTS = [
  '⚠ Mehrere Buchungsregeln passen: ', '⚠ Rechnungsadresse von „', '⚠ Älterer Entwurf: Regel „',
  '⚠ Älterer Entwurf: KI-Vorschlag von vor dem Update, es passen aber mehrere Buchungsregeln (',
]
// The note that a receipt names another rule's address than the owner's pick
const OTHER_ADDRESS_NOTE_START = '⚠ Beleg nennt die Rechnungsadresse von „'
// The notes about the rule choice, which a pick replaces
const RULE_NOTE_STARTS = [...CHOICE_NOTE_STARTS, OTHER_ADDRESS_NOTE_START, 'Zuordnung über Rechnungsadresse („', 'Regel „']
const isRuleNote = (part: string) => RULE_NOTE_STARTS.some(s => part.startsWith(s))
// The notes about a Gmail receipt found by a rule's sender (its provenance, split at „ · “,
// how it was proven, why it is doubtful — lib/receipt-match.ts), which go with it
const isReceiptNote = isGmailReceiptNote
const noteParts = (note: string | null | undefined) => (note || '').split(' · ').filter(Boolean)

// ─── A row's state ──────────────────────────────────────────────────────────────────

// A row whose rules tie, not yet decided: no rule applied, the rules to pick from
export const isOpenRuleChoice = (t: Pick<MatchedTransaction, 'vendor' | 'rule_choices'> | null | undefined): boolean =>
  !!t && !t.vendor && (t.rule_choices?.length ?? 0) >= 1

// A Buchungsregel's row: „Kein Beleg“ until its receipt is there — unless the rule searches
// none (skip_invoice_search) —; „Prüfen“ while its Gmail receipt is not proven (only its
// invoice number, the nearest of several, an unchecked one, or attached before P2-11:
// lib/receipt-match.ts receiptDoubt), never ticked by Analyse; else ready
export const ruleRowStatus = (
  row: Pick<MatchedTransaction, 'gmail_message_id' | 'receipt_check'>, rule: Pick<Vendor, 'skip_invoice_search'>,
): 'no_invoice' | 'needs_review' | 'ready' =>
  !row.gmail_message_id && !rule.skip_invoice_search ? 'no_invoice' : receiptDoubt(row) ? 'needs_review' : 'ready'

// A row whose rules tie: its Beleg is needed as a rule's row needs it — whichever is picked.
// It is „Prüfen“ with a receipt, proven or not: the owner picks its rule first.
export const ruleChoiceStatus = (
  row: Pick<MatchedTransaction, 'gmail_message_id'>, choices: readonly Pick<Vendor, 'skip_invoice_search'>[],
): 'no_invoice' | 'needs_review' => (!row.gmail_message_id && choices.some(r => !r.skip_invoice_search) ? 'no_invoice' : 'needs_review')

// A row whose Gmail receipt the owner removed („Beleg entfernen“), none attached by hand
// since, not booked on a private Steuerkonto, that needs a Beleg: a Buchungsregel's row whose
// rule searches one (not skip_invoice_search), a row whose rules tie when one of them does, an
// AI row whose suggestion requires one. Its status stays what the receipt made it; the import
// page counts it as „Beleg fehlt“ and leaves it out of „Alle“ — ticked by hand, it is booked.
export const removedReceiptBelegMissing = (
  t: Pick<MatchedTransaction, 'vendor' | 'rule_choices' | 'ai_suggested'>,
  row: { removed: boolean; handUpload: boolean; bookedPrivate: boolean },
): boolean =>
  row.removed && !row.handUpload && !row.bookedPrivate && (
    t.vendor ? !t.vendor.skip_invoice_search
      : isOpenRuleChoice(t) ? t.rule_choices!.some(r => !r.skip_invoice_search)
        : !!t.ai_suggested?.requires_invoice)

/**
 * The row once a rule among its choices is applied: by the owner („Anwenden“), or by the
 * invoice address on a receipt attached (`how`). Its title, accounts and status are the
 * rule's — a row held as booked keeps its hold, the rule's status behind it. The note about
 * the choice is replaced. A Gmail receipt that another rule's sender sent (gmail_rule_ids
 * lacks this rule) is dropped with what was read from it, and the row says so; one whose
 * finders are not known stays. The choices stay, so another can be applied instead. An id
 * that is not among the choices changes nothing.
 */
export function pickRule(t: MatchedTransaction, ruleId: string, how: 'owner' | 'address'): MatchedTransaction {
  const rule = (t.rule_choices ?? []).find(r => r.id === ruleId)
  return rule ? withRule(t, rule, how, how === 'owner' ? rulePickedNote(rule) : ruleAddressNote(rule)) : t
}

// The row with `rule` (one of its choices) applied, `picked` in place of the notes about
// the choice
function withRule(t: MatchedTransaction, rule: Vendor, how: 'owner' | 'address', picked: string): MatchedTransaction {
  const choices = t.rule_choices ?? []
  const finders = t.gmail_rule_ids
  const fromOther = !!t.gmail_message_id && Array.isArray(finders) && !finders.includes(rule.id)
  const parts: string[] = []
  let placed = false
  for (const p of noteParts(t.match_note)) {
    if (isRuleNote(p)) {
      if (!placed) parts.push(picked)
      placed = true
    } else if (!(fromOther && isReceiptNote(p))) parts.push(p)
  }
  if (!placed) parts.unshift(picked)
  if (fromOther) parts.splice(parts.indexOf(picked) + 1, 0, receiptFromOtherRuleNote(choices.filter(r => finders!.includes(r.id))))
  const base: MatchedTransaction = fromOther ? withoutReceiptCheck({
    ...t,
    gmail_message_id: null, gmail_part_id: null, gmail_subject: null, gmail_date: null, pdf_attachment_name: null, pdf_base64: null,
    extracted_invoice_number: null, extracted_invoice_date: null, extracted_amount: null, gmail_rule_ids: [],
  }) : t
  const status = ruleRowStatus(base, rule)
  const held = t.status === 'duplicate'
  return {
    ...base,
    vendor: rule,
    confidence: 1,
    title: generateTitle(rule, t.transaction.date),
    status: held ? 'duplicate' : status,
    ...(held ? { own_status: status } : {}),
    rule_pick: how,
    rule_tie_checked: true,
    match_note: parts.join(' · '),
  }
}

// The row once its rules are to be chosen among again: no rule applied, its Beleg needed as
// a rule's row needs it, the counterparty as its title — a row held as booked keeps its hold
// and its title, the choice's status behind it —, `note` in place of the notes about the
// choice. Its choices stay.
function asChoice(t: MatchedTransaction, note: string): MatchedTransaction {
  const status = ruleChoiceStatus(t, t.rule_choices ?? [])
  const held = t.status === 'duplicate'
  const out: MatchedTransaction = {
    ...t,
    vendor: null,
    confidence: 0,
    ...(held ? { own_status: status } : { status, title: t.transaction.counterparty }),
    match_note: [note, ...noteParts(t.match_note).filter(p => !isRuleNote(p))].join(' · '),
  }
  delete out.rule_pick
  return withoutAi(out)
}

// A row to choose for asks no AI (lib/matcher.ts returns it before the classifier): an AI
// suggestion an older page put on a rule's row goes with the rule — that page re-classified
// rule rows on an upload, and with no rule applied the suggestion's accounts, UID and country
// would show as the row's and be booked beside the owner's own four fields
function withoutAi(t: MatchedTransaction): MatchedTransaction {
  if (!('ai_suggested' in t) && !('ai_error' in t)) return t
  const out = { ...t }
  delete out.ai_suggested
  delete out.ai_error
  return out
}

// A Gmail receipt dropped: how it was proven goes with it
function withoutReceiptCheck(t: MatchedTransaction): MatchedTransaction {
  const out = { ...t }
  delete out.receipt_check
  return out
}

// ─── The import page: a row whose rules tie, the receipts attached to it ─────────────

// What the page says (exact, „…“ quotes): the row's checkbox, its status pill, the details
// banner of a row to choose for, and the banner once a rule applies
export const RULE_TIE_BLOCK = 'Mehrere Buchungsregeln passen — in den Details eine Regel wählen'
export const RULE_CHOICE_PILL = 'Regel wählen'
export const RULE_CHOICE_TITLE = 'Mehrere Buchungsregeln passen'
export const RULE_CHOICE_QUESTION = 'Welche Regel gilt für diese Zahlung? Sie wird nur auf diese Zeile angewendet.'
export const RULE_CHOICE_APPLY = 'Anwenden'
export const RULE_CHOICE_FOOTER = 'Damit das nicht jeden Monat fragt: unter Buchungsregeln die Regeln unterscheiden („Betrag von/bis“ oder „Rechnungsadresse enthält“).'
// The owner set Steuerkonto, Vorsteuerkonto, USt and BA Betrag himself (ownerSetRuleFields)
export const RULE_CHOICE_OWN_FIELDS = 'Eigene Konten gesetzt — gebucht wird, was gesetzt ist; „Anwenden“ ersetzt sie durch die Regel.'
export const ruleInsteadLabel = (rule: Pick<Vendor, 'name'>): string => `Stattdessen „${rule.name}“ anwenden`

// An amount of a rule's range without its „€“: „40,00“
const rangeAmount = (n: number) => eur(n).replace(/ €$/, '')

/**
 * One rule as the banner offers it: „A“ — Steuerkonto · Vorsteuerkonto · USt % · BA Betrag %
 * / USt %, and its amount range and invoice address when it has them. `accountName`: an
 * account's name in the year's lists (the page's; „#id“ when they are not loaded).
 */
export function ruleChoiceDetail(rule: Vendor, accountName: (id: number, kind: 'cost' | 'tax') => string): string {
  const name = (id: number, kind: 'cost' | 'tax') => (id ? accountName(id, kind) : '—')
  const range = rule.amount_min != null && rule.amount_max != null ? `Betrag ${rangeAmount(rule.amount_min)}–${rangeAmount(rule.amount_max)} €`
    : rule.amount_min != null ? `Betrag ab ${eur(rule.amount_min)}`
    : rule.amount_max != null ? `Betrag bis ${eur(rule.amount_max)}`
    : null
  const address = addressOf(rule)
  return [
    `„${rule.name}“ — ${name(rule.cost_account_id, 'cost')}`,
    name(rule.purchasetax_account_id, 'tax'),
    `${rateLabel(rule.tax_percent)} %`,
    `BA ${rateLabel(rule.deductibility_amount_percent)} % / USt ${rateLabel(rule.deductibility_tax_percent)} %`,
    ...(range ? [range] : []),
    ...(address ? [`Adresse „${address}“`] : []),
  ].join(' · ')
}

// The line of a row to choose for, on the row itself whatever else its note says and the
// page hides of it (a removed receipt's): the note that asks — Analyse's, a draft's, the
// re-check's —, else the rules that fit. null for any other row.
export function ruleChoiceLine(t: Pick<MatchedTransaction, 'vendor' | 'rule_choices' | 'match_note'>): string | null {
  if (!isOpenRuleChoice(t)) return null
  return noteParts(t.match_note).find(p => CHOICE_NOTE_STARTS.some(s => p.startsWith(s))) ?? ruleTieNote(t.rule_choices!)
}

// How the rule of a row chosen among several applies: by the owner, by the invoice address
// on its receipt, or as the most specific (an amount range). null when it was chosen among
// none, or applies no rule.
export function ruleDecisionText(t: Pick<MatchedTransaction, 'vendor' | 'rule_choices' | 'rule_pick'>): string | null {
  const rule = t.vendor
  const others = (t.rule_choices ?? []).filter(r => r.id !== rule?.id)
  if (!rule || !others.length) return null
  if (t.rule_pick === 'owner') return `Regel „${rule.name}“ gewählt`
  if (t.rule_pick === 'address') return `Regel „${rule.name}“ über die Rechnungsadresse gewählt`
  return ruleOutrankedNote(rule, others)
}

// The invoice addresses a receipt attached to the row is checked for: those of the rules
// it was chosen among — the owner's pick's too (a receipt may name another) —, none when it
// was chosen among none
export function ruleChoiceAddresses(t: Pick<MatchedTransaction, 'rule_choices'>): string[] {
  const choices = t.rule_choices ?? []
  if (choices.length < 2) return []
  return Array.from(new Set(choices.map(addressOf).filter(Boolean)))
}

// The row of the owner's pick with `note` (receiptOtherAddressNote) first in place of one a
// receipt before it gave, or none; the same row when nothing changes
function withOtherAddressNote(t: MatchedTransaction, note: string | null): MatchedTransaction {
  const parts = noteParts(t.match_note)
  const rest = parts.filter(p => !p.startsWith(OTHER_ADDRESS_NOTE_START))
  if (!note && rest.length === parts.length) return t
  return { ...t, match_note: [...(note ? [note] : []), ...rest].join(' · ') || null }
}

/**
 * A receipt attached to a row (uploaded, dropped with others) checks the invoice addresses
 * of the rules the row was chosen among again, as Analyse checks them: also a rule Analyse
 * decided — a wrong receipt found may have decided it. `found`: the addresses on the receipt
 * (/api/import/extract-invoice's addresses_found); null when its text could not be read (an
 * image, a scan): nothing is decided by it. Not among rules of which none has an address
 * (nothing on a receipt tells them apart).
 * - a rule the owner picked: kept — when the receipt names another rule's address and not
 *   its own, the row says so first (receiptOtherAddressNote) and is not ticked, its tick
 *   taken back (`pickDoubted`); a receipt without text decides nothing, and the note an
 *   earlier receipt gave goes with that receipt;
 * - the row's rule: kept;
 * - another single rule: applied instead, the row says so — not ticked (`tick` false);
 * - a row to choose for: the rule applies (rule_pick 'address');
 * - none, or several: to choose for again.
 * `tick`: the row is a rule's row the receipt may tick, as a receipt ticks a rule's row (the
 * caller checks the receipt itself).
 */
export function recheckRuleChoice(
  t: MatchedTransaction, found: readonly string[] | null | undefined,
): { row: MatchedTransaction; tick: boolean; pickDoubted?: true } {
  const choices = t.rule_choices ?? []
  if (!ruleChoiceAddresses(t).length) return { row: t, tick: !!t.vendor }
  if (t.rule_pick === 'owner' && t.vendor) {
    // This receipt replaces the one the note was about (review check RULES answers (2))
    if (!found) return { row: withOtherAddressNote(t, null), tick: true }
    const picked = t.vendor
    const own = addressOf(picked)
    const named = choices.filter(r => r.id !== picked.id && !!addressOf(r) && found.includes(addressOf(r)))
    const doubted = named.length > 0 && !(own && found.includes(own))
    const row = withOtherAddressNote(t, doubted ? receiptOtherAddressNote(named, picked) : null)
    return doubted ? { row, tick: false, pickDoubted: true } : { row, tick: true }
  }
  if (!found) return { row: t, tick: !!t.vendor }
  const m = matchRules(t.transaction, choices, address => found.includes(address))
  if (m.rule) {
    if (!t.vendor) return { row: pickRule(t, m.rule.id, 'address'), tick: true }
    if (t.vendor.id === m.rule.id) return { row: t, tick: true }
    return { row: withRule(t, m.rule, 'address', ruleSwitchedNote(m.rule, t.vendor)), tick: false }
  }
  const note = m.tie.length ? ruleTieNote(m.tie)
    : m.droppedByAddress.length ? ruleAddressMissingNote(m.droppedByAddress)
    : ruleTieNote(choices)
  return { row: asChoice(t, note), tick: false }
}

/**
 * „Beleg entfernen“ on a row whose rule the receipt's invoice address decided (rule_pick
 * 'address'): without that receipt nothing decides — the owner picks, or attaches the
 * receipt whose address decides. On a rule the owner picked, the note that the receipt
 * named another rule's address goes with it. Any other row stays as it is.
 */
export function reopenRuleChoice(t: MatchedTransaction): MatchedTransaction {
  const choices = t.rule_choices ?? []
  if (t.rule_pick === 'owner') return withOtherAddressNote(t, null)
  if (t.rule_pick !== 'address' || choices.length < 2) return t
  const m = matchRules(t.transaction, choices)
  const tied = m.tie.length ? m.tie : choices
  return asChoice(t, m.addressUnchecked ? ruleTieAddressNote(tied) : ruleTieNote(tied))
}

// The invoice addresses a receipt read is asked for: /api/import/extract-invoice's form field
// „addresses“ (a JSON array of texts), or the array /api/import/gmail-receipt's JSON body
// carries — each trimmed and once, blank ones dropped, at most 50, of at most 200 characters
// each; null when none is asked
export function receiptAddressesAsked(v: unknown): string[] | null {
  let list: unknown = v
  if (typeof v === 'string') {
    if (!v) return null
    try {
      list = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!Array.isArray(list)) return null
  const asked = Array.from(new Set(list.flatMap(a => {
    const s = typeof a === 'string' ? a.trim() : ''
    return s && s.length <= 200 ? [s] : []
  }))).slice(0, 50)
  return asked.length ? asked : null
}

// The addresses on a receipt, looked for in its whole text as Analyse looks for them (any
// case, anywhere — lib/matcher.ts); null when it has no text (a scan, an image), so nothing
// can be checked
export function addressesOnReceipt(text: string | null | undefined, addresses: readonly string[]): string[] | null {
  if (!text?.trim()) return null
  const lower = text.toLowerCase()
  return addresses.filter(a => lower.includes(a.toLowerCase()))
}

// ─── Belege: a receipt whose rules tie ──────────────────────────────────────────────

// What the receipt form says (exact, „…“ quotes): the rules that fit equally — none is
// applied —, a button for each, the hint under them, and the line once one is applied
export const receiptRuleTieNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `Mehrere Buchungsregeln passen: ${quoted(rules)} — Regel anwenden oder Konten selbst wählen`
export const receiptRuleApplyLabel = (rule: Pick<Vendor, 'name'>): string => `„${rule.name}“ anwenden`
export const RECEIPT_RULE_APPLY_HINT = 'Anwenden füllt das Formular neu aus dem Beleg und der Regel.'
export const receiptRulePickedText = (name: string): string => `Regel gewählt: „${name}“`

// The rules a receipt's answer offers (its rule_choices), each a rule with an id and a
// name; none when it has no such list (a receipt that could not be read)
export function receiptRuleChoices(v: unknown): Vendor[] {
  if (!Array.isArray(v)) return []
  return v.filter((r): r is Vendor => !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string')
}

/**
 * A receipt opened again from Belege' inbox (GET /api/receipt/[id]): its reading matched
 * again with the rules as they are now — all of them, in one order; null when they could
 * not be read. The rule stored at its upload stays (named even when switched off since,
 * handed over only while active), unless it now ties with others: a receipt uploaded
 * before rule ties were asked kept the first by name. Then, as when none was stored or it
 * is gone, no rule applies and the rules that tie are offered. Rules not read: no rule,
 * none offered — as the upload applies none without them.
 */
export function receiptRuleOnResume(
  stored: { suggested_vendor_id?: string | null; ai_raw_response?: unknown },
  rules: readonly Vendor[] | null,
): { id: string | null; name: string | null; rule: Vendor | null; choices: Vendor[] } {
  if (!rules) return { id: null, name: null, rule: null, choices: [] }
  const read = stored.ai_raw_response && typeof stored.ai_raw_response === 'object' ? stored.ai_raw_response as Record<string, unknown> : {}
  const m = suggestReceiptRules({
    vendor: typeof read.vendor === 'string' ? read.vendor : null,
    amount: typeof read.amount === 'number' ? read.amount : null,
  }, rules)
  const id = stored.suggested_vendor_id || null
  const kept = id ? rules.find(r => r.id === id) ?? null : null
  if (m.tie.length > 1 && (!kept || m.tie.some(r => r.id === kept.id))) return { id: null, name: null, rule: null, choices: m.tie }
  return { id, name: kept?.name || null, rule: kept && kept.active !== false ? kept : null, choices: [] }
}

// ─── Analyse (lib/matcher.ts enrichExpense) ─────────────────────────────────────────

// One sender's Gmail search for the planned rules: the rules that use it (in rule order)
export type RuleSender = { sender: string; rules: Vendor[] }
// An e-mail as lib/gmail.ts searchInvoices returns it, as far as the rules read it
export type RuleEmail = { messageId: string; subject: string; bodyText: string }

// The senders to search for a payment's receipt: each distinct „E-Mail Absender“ of the
// planned rules (the one that applies, or every tied one), in rule order; a rule that
// searches none (skip_invoice_search) is left out
export function ruleReceiptSenders(plan: readonly Vendor[]): RuleSender[] {
  const out: RuleSender[] = []
  for (const rule of sortRules(plan)) {
    const sender = typeof rule.email_sender === 'string' ? rule.email_sender.trim() : ''
    if (rule.skip_invoice_search || !sender) continue
    const same = out.find(s => s.sender.toLowerCase() === sender.toLowerCase())
    if (same) same.rules.push(rule)
    else out.push({ sender, rules: [rule] })
  }
  return out
}

// Whether an e-mail fits a rule's „E-Mail enthält“: every term in its text or subject; a
// rule without terms takes every e-mail
export function emailFitsRule(email: Pick<RuleEmail, 'subject' | 'bodyText'>, rule: Pick<Vendor, 'email_body_keywords'>): boolean {
  const terms = Array.isArray(rule.email_body_keywords) ? rule.email_body_keywords : []
  if (!terms.length) return true
  const text = `${email.bodyText} ${email.subject}`.toLowerCase()
  return terms.every(kw => text.includes(String(kw).toLowerCase()))
}

/**
 * The e-mails a rule's row's sender searches found (in ruleReceiptSenders' order, each with
 * the e-mails Gmail found), pooled: per sender, those that fit one of its rules' „E-Mail
 * enthält“ — all of them when none fits —, in that order, each e-mail once. Each with the
 * sender whose search found it first, and `ruleIds`: the rules whose sender's search found
 * it (an e-mail that fit none of them counts for all of its sender's; one two senders found,
 * for the rules of both), in rule order. Which of their PDFs is the receipt is
 * lib/receipt-match.ts pickGmailReceipt's to say.
 */
export function ruleEmailPool<E extends RuleEmail>(
  searches: readonly (RuleSender & { emails: readonly E[] })[],
): { email: E; sender: string; ruleIds: string[] }[] {
  const pool: { email: E; sender: string; rules: Vendor[] }[] = []
  for (const s of searches) {
    const fits = s.emails.map(e => s.rules.filter(r => emailFitsRule(e, r)))
    const narrowed = fits.some(f => f.length > 0)
    s.emails.forEach((email, k) => {
      if (narrowed && !fits[k].length) return
      pool.push({ email, sender: s.sender, rules: narrowed ? fits[k] : s.rules })
    })
  }
  const out: { email: E; sender: string; ruleIds: string[] }[] = []
  for (const p of pool) {
    if (out.some(o => o.email.messageId === p.email.messageId)) continue
    const finders = rulesOnce(pool.filter(q => q.email.messageId === p.email.messageId).flatMap(q => q.rules))
    out.push({ email: p.email, sender: p.sender, ruleIds: finders.map(r => r.id) })
  }
  return out
}

// A rule's „E-Mail Absender“ as senders are compared: trimmed, any case
const senderOf = (rule: Pick<Vendor, 'email_sender'>) => (typeof rule.email_sender === 'string' ? rule.email_sender.trim().toLowerCase() : '')

/**
 * The rules the receipt attached from ruleEmailPool's e-mails counts for (a row's gmail_rule_ids): those
 * whose sender's search found it, and every other rule the row is chosen among (`choices`)
 * that has the same sender and whose „E-Mail enthält“ the e-mail has. Analyse searched only
 * the senders of the rule that applies or of the rules that tie: a rule an amount range
 * outranked was not searched for, yet its sender sent the receipt — „Stattdessen“ on it keeps
 * the receipt (pickRule).
 */
export function receiptRuleIds(
  found: { email: Pick<RuleEmail, 'subject' | 'bodyText'>; sender: string; ruleIds: readonly string[] },
  choices: readonly Vendor[],
): string[] {
  const sender = found.sender.trim().toLowerCase()
  const same = sortRules(choices).filter(r => !found.ruleIds.includes(r.id) && senderOf(r) === sender && emailFitsRule(found.email, r))
  return [...found.ruleIds, ...same.map(r => r.id)]
}

/**
 * What a debit's row becomes, from its rules matched without the receipt's text (`fast`)
 * and then with it (`m`; the same when there was no text to check an address against):
 * - 'rule': `m.rule` applies. `choices`: every rule it was chosen among, when more than one
 *   ([rule, …others, …fast's tie]); `pick` 'address' when the receipt's address decided a
 *   tie; the notes say how it won.
 * - 'choice': the owner picks — rules that tie, or two or more that lost only by their
 *   address on the receipt; the note leads the row's.
 * - 'ai': no rule applies; when the one rule that fit lost by its address, the AI's answer
 *   is unsure and the note says why.
 */
export type RuleOutcome =
  | { kind: 'rule'; rule: Vendor; choices: Vendor[]; pick: 'address' | null; notes: string[] }
  | { kind: 'choice'; choices: Vendor[]; note: string }
  | { kind: 'ai'; note: string | null }
export function ruleOutcome(fast: RuleMatch, m: RuleMatch): RuleOutcome {
  const fastTied = fast.tie.length > 0
  if (m.rule) {
    const choices = rulesOnce([m.rule, ...m.others, ...fast.tie])
    return {
      kind: 'rule',
      rule: m.rule,
      choices: choices.length > 1 ? choices : [],
      pick: fastTied ? 'address' : null,
      notes: [
        ...(fastTied ? [ruleAddressNote(m.rule)] : []),
        ...(m.others.length ? [ruleOutrankedNote(m.rule, m.others)] : []),
      ],
    }
  }
  if (m.tie.length) return { kind: 'choice', choices: m.tie, note: m.addressUnchecked ? ruleTieAddressNote(m.tie) : ruleTieNote(m.tie) }
  if (m.droppedByAddress.length > 1) return { kind: 'choice', choices: m.droppedByAddress, note: ruleAddressMissingNote(m.droppedByAddress) }
  return { kind: 'ai', note: m.droppedByAddress.length === 1 ? ruleAddressDroppedNote(m.droppedByAddress[0]) : null }
}

/**
 * After the invoice address decided a tie (rule_pick 'address'): the other tied rule whose
 * title a booking carries, or null. The duplicate check took that booking for this payment
 * by the tied rules' titles; it books the other rule's, so it is only possibly this one.
 */
export function otherRuleBooking(
  row: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'rule_choices' | 'rule_pick'>,
  booked: { title: string },
): Vendor | null {
  const rule = row.vendor
  if (row.rule_pick !== 'address' || !rule) return null
  const title = normTitle(booked.title)
  if (normTitle(generateTitle(rule, row.transaction.date)) === title) return null
  return (row.rule_choices ?? []).find(r => r.id !== rule.id && normTitle(generateTitle(r, row.transaction.date)) === title) ?? null
}

/**
 * The day's bookings of the rules that tie for a payment (`titles`: their titles for its
 * date): for each title, its booking of this payment as the booking route checks a row by
 * the title it books (`row` as lib/duplicates.ts bankRows builds it) — certain ones only.
 * The check of a whole CSV gives each booking to one row: of two debits of a pair, the one
 * whose receipt names the booked rule may be left without it (ownRuleBooking).
 */
export function tiedRuleBookings(row: PaymentRow, titles: readonly string[], bookings: BookingLite[]): DuplicateMatch[] {
  return titles.flatMap(title => {
    const m = assignDuplicates([{ ...row, title, titles: null }], bookings)[0]
    return m?.certain ? [m] : []
  })
}

// After the invoice address decided a tie (rule_pick 'address'): the booking among the tied
// rules' (tiedRuleBookings) that carries the row's own rule's title — this payment's, booked
// already —, or null
export function ownRuleBooking<B extends { title: string }>(
  row: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'rule_pick'>,
  tied: readonly B[],
): B | null {
  const rule = row.vendor
  if (row.rule_pick !== 'address' || !rule) return null
  const title = normTitle(generateTitle(rule, row.transaction.date))
  return tied.find(b => normTitle(b.title) === title) ?? null
}

// The booking a row is held as instead of the one the check gave it (`gate.match`), or null:
// its own rule's booking of the day (ownRuleBooking) — also when the check gave that booking
// to the other debit of the pair (their receipts crossed). Not when the check holds a certain
// booking of that title as this payment already: two debits of one rule, two bookings of its
// title — each row keeps the one the check gave it (review check RULES-4)
export function ownRuleOverride<B extends { id: number; title: string; certain: boolean }>(
  row: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'rule_pick'>,
  gate: { match?: B | null; tied?: readonly B[] } | null | undefined,
): B | null {
  const own = gate?.tied ? ownRuleBooking(row, gate.tied) : null
  if (!own || own.id === gate?.match?.id) return null
  if (gate?.match?.certain && normTitle(gate.match.title) === normTitle(own.title)) return null
  return own
}

// ─── The booking route: a page open since before the update ─────────────────────────

// The fields a rule sets that only the owner's own values replace: Steuerkonto,
// Vorsteuerkonto, USt and BA Betrag
const RULE_FIELDS = ['cost_account_id', 'purchasetax_account_id', 'tax_percent', 'deductibility_amount_percent'] as const

// The owner set all four himself (a value each: a cleared one is none) — what a row whose
// rules tie may be booked with instead of a pick
export function ownerSetRuleFields(ov: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return RULE_FIELDS.every(f => ov?.[f] != null && ov[f] !== '')
}

// What the booking route answers for such rows, the Testlauf too: the text says to save the
// draft first — a Testlauf saves none, and the reload converts it (ruleTieDraftRows)
export const ruleTieRefusal = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `Mehrere Buchungsregeln passen (${quoted(rules)}) — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen`
export const staleRuleRefusal = (rule: Pick<Vendor, 'name'>): string =>
  `Vor dem Regel-Update analysiert: Regel „${rule.name}“ ist für diese Zahlung nicht mehr eindeutig — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen`
// Its rule no longer fits, and fewer than two rules do: nothing to choose among — the rule is
// to be set back, or the CSV analysed again
export const staleRuleGoneRefusal = (rule: Pick<Vendor, 'name'>): string =>
  `Vor dem Regel-Update analysiert: Buchungsregel „${rule.name}“ passt nicht mehr zu dieser Zahlung (geändert oder abgeschaltet) — Regel wieder anpassen oder CSV neu analysieren, dann buchen`
export const RULES_UNREADABLE_TEXT = 'Buchungsregeln nicht lesbar — Zeile aus einer Buchungsregel nicht gebucht, bitte erneut versuchen'
export const AI_RULES_UNREADABLE_TEXT = 'Buchungsregeln nicht lesbar — KI-Vorschlag von vor dem Regel-Update nicht gebucht, bitte erneut versuchen'
// The re-classification's 409 for a payment whose rules tie
export const RULE_TIE_NO_AI = 'Mehrere Buchungsregeln passen — Regel in den Details wählen, keine KI-Neubewertung'

// Every rule that fits a payment by the match: the one that applies, those that tie, those
// it outranks
const fittingRules = (m: RuleMatch): Vendor[] => sortRules([...(m.rule ? [m.rule] : []), ...m.tie, ...m.others])

// The receipt's address decided the row's rule in an Analyse from before the update
const addressDecidedBefore = (t: Pick<MatchedTransaction, 'vendor' | 'match_note'>): boolean =>
  !!t.vendor && (t.match_note || '').includes(oldAddressNote(t.vendor.name))

// An AI row analysed before the update (no rule_tie_checked): the old matcher sent a payment
// to the AI when the receipt's text had neither of its rules' addresses — rules that tie now
// were never asked. Not a fixed rule's suggestion, an own transfer's or a card settlement's,
// nor a row to choose for.
const oldAiRow = (t: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'rule_choices' | 'rule_tie_checked' | 'ai_suggested'>): boolean =>
  !t.vendor && !t.rule_tie_checked && !isOpenRuleChoice(t) && !!t.ai_suggested && t.ai_suggested.source !== 'rule'
  && !ownTransfer(t.transaction) && !cardSettlement(t.transaction)

/**
 * Why the booking route refuses an expense row for its Buchungsregel, or null:
 * - rules that tie, not decided: unless the owner set Steuerkonto, Vorsteuerkonto, USt and
 *   BA Betrag himself (ownerSetRuleFields) — an AI suggestion an old page got does not count;
 * - an AI row analysed before the update (no rule_tie_checked) whose rules tie now — unless
 *   the owner set those four himself; such a row when the rules could not be read;
 * - a rule's row analysed before the update (no rule_tie_checked), whose rule is not the one
 *   the current rules give without a receipt — unless its note says the receipt's address
 *   decided it then and that Gmail receipt is sent with it: with two or more rules fitting
 *   it now, a draft's load offers them (staleRuleRefusal); with fewer, its rule no longer
 *   fits and nothing is to choose (staleRuleGoneRefusal) — the owner's own fields alike;
 * - such a row when the rules could not be read (`rules` null).
 * A row Analyse checked since, an AI row no tie fits and a fixed rule's: null.
 */
export function ruleChoiceReason(
  t: Pick<MatchedTransaction, 'transaction' | 'vendor' | 'rule_choices' | 'rule_tie_checked' | 'match_note' | 'gmail_message_id' | 'ai_suggested'> | null | undefined,
  ov: Readonly<Record<string, unknown>> | null | undefined,
  rules: readonly Vendor[] | null | undefined,
): string | null {
  if (!t) return null
  if (isOpenRuleChoice(t)) return ownerSetRuleFields(ov) ? null : ruleTieRefusal(t.rule_choices!)
  if (t.rule_tie_checked) return null
  if (!t.vendor) {
    if (!oldAiRow(t) || ownerSetRuleFields(ov)) return null
    if (!rules) return AI_RULES_UNREADABLE_TEXT
    const tie = matchRules(t.transaction, rules).tie
    return tie.length >= 2 ? ruleTieRefusal(tie) : null
  }
  if (!rules) return RULES_UNREADABLE_TEXT
  const m = matchRules(t.transaction, rules)
  if (m.rule?.id === t.vendor.id) return null
  if (t.gmail_message_id && addressDecidedBefore(t)) return null
  return fittingRules(m).length >= 2 ? staleRuleRefusal(t.vendor) : staleRuleGoneRefusal(t.vendor)
}

// ─── A draft analysed before the update (lib/import-drafts.ts convertDraftRows, step 4) ──

export const ruleTieDraftNote = (rule: Pick<Vendor, 'name'>): string =>
  `⚠ Älterer Entwurf: Regel „${rule.name}“ vor dem Update gewählt, es passen aber mehrere — Regel wählen`
// A rule's row of the older draft whose rule no longer fits, while fewer than two rules do
export const ruleGoneDraftNote = (rule: Pick<Vendor, 'name'>): string =>
  `⚠ Älterer Entwurf: Buchungsregel „${rule.name}“ passt nicht mehr zu dieser Zahlung (geändert oder abgeschaltet) — Regel wieder anpassen oder CSV neu analysieren`
// The rule's warnings a removed Gmail receipt does not take with it (the page hides that
// receipt's notes on its row): that the receipt attached instead names another rule's address
// (receiptOtherAddressNote), and that an older draft's rule no longer fits (ruleGoneDraftNote)
export const isRuleWarningNote = (part: string): boolean =>
  part.startsWith(OTHER_ADDRESS_NOTE_START) || part.startsWith('⚠ Älterer Entwurf: Buchungsregel „')
// The page's notice after `n` such rows; `unticked`: some of them were ticked
export const ruleGoneDraftNotice = (n: number, unticked = true): string =>
  `${n === 1 ? 'Eine Zeile' : `${n} Zeilen`} aus dem älteren Entwurf ${n === 1 ? 'gehört' : 'gehören'} zu einer Buchungsregel, die nicht mehr passt${unticked ? ', nicht mehr angekreuzt' : ''}. Bitte Regel wieder anpassen oder CSV neu analysieren.`
// An AI row of the older draft whose rules tie now
export const aiTieDraftNote = (rules: readonly Pick<Vendor, 'name'>[]): string =>
  `⚠ Älterer Entwurf: KI-Vorschlag von vor dem Update, es passen aber mehrere Buchungsregeln (${quoted(rules)}) — Regel wählen`
// The page's notice after `n` rows of an older draft became a choice; `unticked`: some of
// them were ticked (the page unticks them)
export const ruleTieDraftNotice = (n: number, unticked = true): string =>
  `${n === 1 ? 'Eine Zeile' : `${n} Zeilen`} aus dem älteren Entwurf ${n === 1 ? 'passt' : 'passen'} zu mehreren Buchungsregeln — jetzt „Regel wählen“${unticked ? ', nicht mehr angekreuzt' : ''}. Bitte Regel wählen.`

// The rules among `choices` whose sender is the old row's rule's: that rule's sender found
// its Gmail receipt (Analyse searched no other before the update)
const oldReceiptFinders = (t: MatchedTransaction, choices: readonly Vendor[]) =>
  t.gmail_message_id && !t.gmail_rule_ids && t.vendor
    ? { gmail_rule_ids: choices.filter(r => !!senderOf(r) && senderOf(r) === senderOf(t.vendor!)).map(r => r.id) }
    : {}

/**
 * A draft analysed before this update: each Buchungsregel's row without rule_tie_checked is
 * matched again with the current rules (`review.rules`), without a receipt's text, as the
 * booking route checks it (ruleChoiceReason):
 * - its rule is the one that applies: marked;
 * - the receipt's address decided it then (its note) and that Gmail receipt is still
 *   attached (not in `review.cleared_gmail`): marked, rule_pick 'address', with the rules it
 *   was chosen among;
 * - two or more rules fit now: the owner picks — no rule applied, the rules that fit as its
 *   choices, the row's own counterparty as its title, its Beleg needed as a rule row's, the
 *   draft's note first, no AI suggestion (one an older page put on the rule's row goes). A
 *   row held as booked keeps its hold and its title (own_status follows) and is counted only
 *   when the owner booked it anyway („Trotzdem buchen“: `review.acked`).
 * - its rule no longer fits, and fewer than two rules do: nothing to choose among — it stays
 *   unmarked (the route refuses it: staleRuleGoneRefusal), ruleGoneDraftNote first in its
 *   note (once; gone again once its rule fits again), listed in `gone` unless held as
 *   booked and not booked anyway by the owner („Trotzdem buchen“: `review.acked`) — the
 *   page unticks it.
 * An AI row analysed before the update (oldAiRow) whose rules tie now becomes „Regel wählen“
 * as well — the tied rules as its choices, the AI's suggestion gone, aiTieDraftNote first;
 * one no tie fits is only marked. Left as they are: a row of no rule and no AI suggestion, a
 * row Analyse checked since, a transfer to an own account or a card settlement (their fixed
 * rules'), and every row when the rules could not be read (`rules` null — the route checks
 * them).
 * `changed`: the rows that became a choice, not held as booked or booked anyway by the owner
 * — the page unticks them; with the owner's four fields the route would book such a row
 * without its rule.
 * Converting twice changes nothing.
 */
export function ruleTieDraftRows(
  rows: MatchedTransaction[],
  review: { rules?: readonly Vendor[] | null; cleared_gmail?: readonly number[] | null; acked?: readonly number[] | null },
): { rows: MatchedTransaction[]; changed: number[]; gone: number[] } {
  const changed: number[] = []
  const gone: number[] = []
  const rules = review.rules
  if (!rules) return { rows, changed, gone }
  const cleared = new Set((review.cleared_gmail ?? []).map(Number))
  const acked = new Set((review.acked ?? []).map(Number))
  const out = rows.map((t, i): MatchedTransaction => {
    if (t?.transaction && oldAiRow(t)) {
      const tie = matchRules(t.transaction, rules).tie
      if (tie.length < 2) return { ...t, rule_tie_checked: true }
      const status = ruleChoiceStatus(t, tie)
      const held = t.status === 'duplicate'
      // Held, but booked anyway by the owner: sent as any other row (repair check)
      if (!held || acked.has(i)) changed.push(i)
      return withoutAi({
        ...t,
        vendor: null,
        confidence: 0,
        ...(held ? { own_status: status } : { status, title: t.transaction.counterparty }),
        rule_choices: tie,
        rule_tie_checked: true,
        match_note: [aiTieDraftNote(tie), ...noteParts(t.match_note)].join(' · '),
      })
    }
    const old = t?.vendor
    if (!t?.transaction || !old || t.rule_tie_checked) return t
    if (ownTransfer(t.transaction) || cardSettlement(t.transaction)) return t
    // A former load's note that its rule no longer fitted: gone once it fits again
    const goneNote = ruleGoneDraftNote(old)
    const parts = noteParts(t.match_note)
    const m = matchRules(t.transaction, rules)
    if (m.rule?.id === old.id) {
      return { ...t, ...(parts.includes(goneNote) ? { match_note: parts.filter(p => p !== goneNote).join(' · ') || null } : {}), rule_tie_checked: true }
    }
    const fitting = fittingRules(m)
    if (t.gmail_message_id && !cleared.has(i) && addressDecidedBefore(t)) {
      const choices = rulesOnce([...fitting, old])
      return {
        ...t,
        rule_tie_checked: true,
        rule_pick: 'address',
        ...(choices.length > 1 ? { rule_choices: choices, ...oldReceiptFinders(t, choices) } : {}),
      }
    }
    const held = t.status === 'duplicate'
    if (fitting.length < 2) {
      if (parts.includes(goneNote)) return t
      // Held, but booked anyway by the owner: sent as any other row (review check)
      if (!held || acked.has(i)) gone.push(i)
      return { ...t, match_note: [goneNote, ...parts].join(' · ') }
    }
    const status = ruleChoiceStatus(t, fitting)
    // Held, but booked anyway by the owner: sent as any other row (repair check)
    if (!held || acked.has(i)) changed.push(i)
    return withoutAi({
      ...t,
      vendor: null,
      confidence: 0,
      ...(held ? { own_status: status } : { status, title: t.transaction.counterparty }),
      rule_choices: fitting,
      rule_tie_checked: true,
      ...oldReceiptFinders(t, fitting),
      match_note: [ruleTieDraftNote(old), ...parts.filter(p => p !== oldAddressNote(old.name) && p !== goneNote)].join(' · '),
    })
  })
  return { rows: out, changed, gone }
}
