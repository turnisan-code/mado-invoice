import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { format, parseISO } from 'date-fns'
import { de } from 'date-fns/locale'
import {
  addressesOnReceipt, compareRules, receiptOtherAddressNote, emailFitsRule, generateTitle, isOpenRuleChoice, matchRules, otherRuleBookedNote, otherRuleBooking,
  isRuleWarningNote, ownerSetRuleFields, ownRuleBooking, ownRuleOverride, pickRule, receiptAddressesAsked, receiptFromOtherRuleNote, receiptRuleApplyLabel, receiptRuleChoices,
  receiptRuleIds, receiptRuleOnResume, receiptRulePickedText, receiptRuleTieNote, recheckRuleChoice, removedReceiptBelegMissing, reopenRuleChoice,
  ruleAddressDroppedNote, ruleAddressMissingNote, ruleAddressNote, ruleChoiceAddresses, ruleChoiceDetail, ruleChoiceLine, ruleChoiceReason,
  ruleChoiceStatus, ruleDecisionText, ruleInsteadLabel, ruleOutcome, ruleOutrankedNote, rulePickedNote, ruleReceiptSenders, ruleRowStatus,
  ruleGoneDraftNote, ruleSwitchedNote, ruleTieAddressNote, ruleTieDraftNote, ruleTieDraftNotice, ruleTieNote, ruleTieRefusal,
  ruleEmailPool, sortRules, staleRuleGoneRefusal, staleRuleRefusal, suggestReceiptRules, tiedRuleBookings, AI_RULES_UNREADABLE_TEXT, RECEIPT_RULE_APPLY_HINT, RULES_UNREADABLE_TEXT, RULE_CHOICE_APPLY, RULE_CHOICE_FOOTER,
  RULE_CHOICE_OWN_FIELDS, RULE_CHOICE_PILL, RULE_CHOICE_QUESTION, RULE_CHOICE_TITLE, RULE_TIE_BLOCK, RULE_TIE_NO_AI, type RuleEmail,
} from '../rule-match'
import { assignDuplicates, bankRows, toBookingLite } from '../duplicates'
import { RECEIPT_UNREADABLE_NOTE } from '../invoice-parsing'
import { cardSettlement } from '../card-settlement'
import { OWNER_NAME, ownTransfer } from '../own-transfer'
import type { EasybankTransaction, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// Buchungsregel ties (PR „Job 1 fixes“ § 2.2, P2-7). Synthetic rules and bank rows: example
// IBANs AT00 0000 …, made-up names (Netzcom, Acme, Muster GmbH), invoice numbers 910000000xxx.

const rule = (id: string, name: string, match_strings: string[], extra: Partial<Vendor> = {}): Vendor => ({
  id, name, match_strings, email_sender: '', cost_account_id: 39209, purchasetax_account_id: 7002,
  bank_account_id: 5002, tax_percent: 20, deductibility_tax_percent: 100, deductibility_amount_percent: 100,
  country: '', vatin: '', title_template: '{vendor} {month_short}', category: '', active: true,
  amount_min: null, amount_max: null, invoice_address_match: '', email_body_keywords: [],
  notes_template: '', skip_invoice_search: false, ...extra,
})
const debit = (counterparty: string, reference: string, amount: number, date = '2026-07-16'): EasybankTransaction =>
  ({ date, counterparty, reference, amount, type: 'expense', currency: 'EUR', raw: {} })
const row = (transaction: EasybankTransaction, over: Partial<MatchedTransaction> = {}): MatchedTransaction => ({
  transaction, vendor: null, confidence: 0, gmail_message_id: null, gmail_subject: null, gmail_date: null,
  pdf_attachment_name: null, pdf_base64: null, extracted_invoice_date: null, extracted_invoice_number: null,
  extracted_amount: null, title: transaction.counterparty, status: 'needs_review', ...over,
})
const names = (rules: readonly Vendor[]) => rules.map(r => r.name)
// A receipt's text, as the matcher checks an address in it (lower-case, anywhere)
const inText = (text: string) => (address: string) => text.toLowerCase().includes(address.toLowerCase())

// Two contracts of one provider, told apart by the invoice address (as the Magenta pair)
const HOME = rule('n1', 'Netzcom Home Office', ['NETZCOM'], { invoice_address_match: 'Musterweg 1', email_sender: '@netzcom.example' })
const STUDIO = rule('n2', 'Netzcom Studio', ['NETZCOM'], { invoice_address_match: 'Beispielgasse 2', email_sender: '@netzcom.example' })
// The critic's cases: an address rule beside one with an amount range
const BUERO = rule('n3', 'Netzcom Büro', ['NETZCOM'], { invoice_address_match: 'Musterweg 1', amount_min: 40, amount_max: 41 })
const GENERIC = rule('n4', 'Netzcom', ['NETZCOM'], { amount_min: 40, amount_max: 41 })
const ACME = rule('a1', 'Acme', ['ACME'])
const ACME_SPECIAL = rule('a2', 'Acme Special', ['ACME'], { amount_min: 30, amount_max: 35 })

// The debit of either contract: the bank's display name as counterparty, the provider in the text
const NETZ_TX = debit('NETZ AUSTRIA GMBH', 'Abbuchung SEPA-Lastschrift OG/000000701|BKAUATWWXXX AT000000000000000020 NETZCOM Austria GmbH|Kundennr 910000000101', 40.5)
const ACME_TX = (amount: number) => debit('ACME CLOUD', 'Bezahlung Karte MC/000000702|E-COMM|ACME CLOUD\\DUBLIN', amount)

describe('matchRules — keywords and amounts (P2-7)', () => {
  test('a keyword in the bank text alone: the counterparty is the bank’s display name', () => {
    assert.equal(NETZ_TX.counterparty.toLowerCase().includes('netzcom'), false)
    assert.equal(matchRules(NETZ_TX, [GENERIC]).rule, GENERIC)
  })
  test('a keyword is any part of the text, as before: „germiete“ in „Lagermiete“', () => {
    const lager = rule('l1', 'Lager', ['germiete'])
    assert.equal(matchRules(debit('Muster GmbH', 'Dauerauftrag|LAGERMIETE OKTOBER', 300), [lager]).rule, lager)
  })
  test('an inactive rule never fits', () => {
    assert.equal(matchRules(ACME_TX(9.57), [{ ...ACME, active: false }]).rule, null)
  })
  test('empty and blank keywords fit nothing (an empty one fitted every row); the others are trimmed', () => {
    const blank = rule('e1', 'Leer', ['', ' '])
    assert.deepEqual(matchRules(ACME_TX(9.57), [blank]), { rule: null, tie: [], others: [], addressUnchecked: false, droppedByAddress: [] })
    const padded = rule('e2', 'Acme', ['', '  acme '])
    assert.equal(matchRules(ACME_TX(9.57), [padded]).rule, padded)
  })
  test('an amount range is more specific: Acme Special (30–35) and Acme at 32,40 → Acme Special, Acme among the others; at 50,00 → Acme', () => {
    const at32 = matchRules(ACME_TX(32.4), [ACME, ACME_SPECIAL])
    assert.equal(at32.rule, ACME_SPECIAL)
    assert.deepEqual(names(at32.others), ['Acme'])
    assert.deepEqual([at32.tie, at32.addressUnchecked], [[], false])
    const at50 = matchRules(ACME_TX(50), [ACME, ACME_SPECIAL])
    assert.equal(at50.rule, ACME)
    assert.deepEqual(at50.others, [])
  })
  test('the order the rules come in decides nothing: equal rules tie, by name, then by id', () => {
    assert.deepEqual(matchRules(ACME_TX(32.4), [ACME_SPECIAL, ACME]), matchRules(ACME_TX(32.4), [ACME, ACME_SPECIAL]))
    const b = rule('b', 'Acme', ['ACME']), a = rule('a', 'Acme', ['ACME'])
    for (const rules of [[a, b], [b, a]]) {
      const m = matchRules(ACME_TX(9.57), rules)
      assert.equal(m.rule, null)
      assert.deepEqual(m.tie.map(r => r.id), ['a', 'b'])
    }
    // Before, the first of equal scores won: the table's scan order decided
  })
  test('compareRules: the name lower-cased, as German sorts it, then the id', () => {
    const sorted = sortRules([rule('2', 'Zebra', []), rule('9', 'äpfel', []), rule('1', 'Bank', []), rule('3', 'Apfel', []), rule('0', 'apfel', [])])
    assert.deepEqual(sorted.map(r => `${r.name}#${r.id}`), ['apfel#0', 'Apfel#3', 'äpfel#9', 'Bank#1', 'Zebra#2'])
    assert.equal(compareRules(rule('x', 'Netzcom', []), rule('x', 'NETZCOM', [])), 0)
  })
})

describe('matchRules — the invoice address (P2-7, the critic’s cases)', () => {
  test('two address rules without a receipt’s text: a tie, the addresses unchecked', () => {
    const m = matchRules(NETZ_TX, [STUDIO, HOME])
    assert.deepEqual([m.rule, names(m.tie), m.addressUnchecked], [null, ['Netzcom Home Office', 'Netzcom Studio'], true])
  })
  test('critic case 1: Büro (address, 40–41) and Studio (address) without text — a tie; an amount range never beats an unchecked address', () => {
    const m = matchRules(NETZ_TX, [BUERO, STUDIO])
    assert.deepEqual([m.rule, names(m.tie), m.addressUnchecked], [null, ['Netzcom Büro', 'Netzcom Studio'], true])
  })
  test('critic case 2: a generic rule (40–41, no address) and Studio (address) without text — a tie (before, Studio won unseen)', () => {
    const m = matchRules(NETZ_TX, [GENERIC, STUDIO])
    assert.deepEqual([m.rule, names(m.tie), m.addressUnchecked], [null, ['Netzcom', 'Netzcom Studio'], true])
  })
  test('with the receipt’s text: its address decides; neither address — none, both dropped; both — a tie', () => {
    const studio = matchRules(NETZ_TX, [HOME, STUDIO], inText('Rechnung an: Muster GmbH, Beispielgasse 2, 1010 Wien'))
    assert.deepEqual([studio.rule, names(studio.droppedByAddress), studio.tie, studio.addressUnchecked], [STUDIO, ['Netzcom Home Office'], [], false])
    const neither = matchRules(NETZ_TX, [HOME, STUDIO], inText('Rechnung an: Muster GmbH, Hauptplatz 9'))
    assert.deepEqual([neither.rule, neither.tie, names(neither.droppedByAddress)], [null, [], ['Netzcom Home Office', 'Netzcom Studio']])
    const both = matchRules(NETZ_TX, [HOME, STUDIO], inText('Musterweg 1 und Beispielgasse 2'))
    assert.deepEqual([both.rule, names(both.tie), both.addressUnchecked], [null, ['Netzcom Home Office', 'Netzcom Studio'], false])
  })
  test('once both addresses are checked, the scores decide: critic case 1 with both on the receipt → Büro by its range; the generic one with Studio’s → Studio', () => {
    assert.equal(matchRules(NETZ_TX, [BUERO, STUDIO], inText('Musterweg 1 · Beispielgasse 2')).rule, BUERO)
    const m = matchRules(NETZ_TX, [GENERIC, STUDIO], inText('Beispielgasse 2'))
    assert.deepEqual([m.rule, names(m.others)], [STUDIO, ['Netzcom']])
    assert.deepEqual(names(matchRules(NETZ_TX, [GENERIC, STUDIO], inText('Hauptplatz 9')).droppedByAddress), ['Netzcom Studio'])
  })
  test('a single address rule: without text it applies, unchecked (as before); with a text that lacks its address it drops out', () => {
    const alone = matchRules(NETZ_TX, [STUDIO])
    assert.deepEqual([alone.rule, alone.addressUnchecked], [STUDIO, true])
    const dropped = matchRules(NETZ_TX, [STUDIO], inText('Musterweg 1'))
    assert.deepEqual([dropped.rule, names(dropped.droppedByAddress), dropped.addressUnchecked], [null, ['Netzcom Studio'], false])
  })
  test('a blank address (saved untrimmed) is none: no bonus, nothing unchecked — two such rules tie', () => {
    const spaced = rule('s1', 'Netzcom Leerzeichen', ['NETZCOM'], { invoice_address_match: '   ' })
    const m = matchRules(NETZ_TX, [spaced, rule('s2', 'Netzcom Ohne', ['NETZCOM'])])
    assert.deepEqual([m.rule, m.tie.length, m.addressUnchecked], [null, 2, false])
    // an address is trimmed before it is looked for
    assert.equal(matchRules(NETZ_TX, [{ ...STUDIO, invoice_address_match: '  Beispielgasse 2 ' }, HOME], inText('beispielgasse 2')).rule?.id, STUDIO.id)
  })
})

describe('generateTitle — without date-fns, as date-fns wrote it', () => {
  const r = rule('t1', 'Netzcom Studio', [], { title_template: '{vendor} – {month} ({month_short})' })
  test('all twelve months, the first and the last day', () => {
    for (let mo = 1; mo <= 12; mo++) {
      const mm = String(mo).padStart(2, '0')
      for (const day of ['01', '15', String(new Date(Date.UTC(2026, mo, 0)).getUTCDate())]) {
        const date = `2026-${mm}-${day}`
        const parsed = parseISO(date)
        assert.equal(generateTitle(r, date), `Netzcom Studio – ${format(parsed, 'MMMM yyyy', { locale: de })} (${format(parsed, 'MM/yyyy')})`, date)
      }
    }
    assert.equal(generateTitle(r, '2026-03-02'), 'Netzcom Studio – März 2026 (03/2026)')
  })
  test('a date that is none throws, as date-fns’ format did', () => {
    assert.throws(() => generateTitle(r, 'kein Datum'), RangeError)
    assert.throws(() => generateTitle(r, '2026-13-01'), RangeError)
  })
})

describe('suggestReceiptRules — Belege’s rule for a receipt', () => {
  test('one rule: it; rules that tie: none, the tie named; no vendor read: nothing', () => {
    assert.equal(suggestReceiptRules({ vendor: 'ACME Cloud', amount: 32.4 }, [ACME, ACME_SPECIAL]).rule, ACME_SPECIAL)
    const tie = suggestReceiptRules({ vendor: 'Netzcom Austria GmbH', amount: 40.5 }, [HOME, STUDIO])
    assert.deepEqual([tie.rule, names(tie.tie)], [null, ['Netzcom Home Office', 'Netzcom Studio']])
    assert.equal(suggestReceiptRules({ vendor: null, amount: 1 }, [ACME]).rule, null)
    assert.equal(suggestReceiptRules({ vendor: 'ACME' }, []).rule, null)
  })
})

describe('receiptRuleOnResume — a receipt opened again from Belege’ inbox (GET /api/receipt/[id], D3)', () => {
  const NETZ_READ = { vendor: 'Netzcom Austria GmbH', amount: 40.5, currency: 'EUR' }
  const ACME_READ = { vendor: 'ACME Cloud', amount: 32.4 }
  const none = { id: null, name: null, rule: null, choices: [] }

  test('a rule stored before ties were asked (the first by name), which now ties: none applied, the rules that tie offered', () => {
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'n1', ai_raw_response: NETZ_READ }, [STUDIO, HOME]),
      { id: null, name: null, rule: null, choices: [HOME, STUDIO] })
  })
  test('no rule stored (uploaded on a tie), or the stored one deleted since: the rules that tie offered', () => {
    for (const id of [null, undefined, '', 'deleted']) {
      assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: id, ai_raw_response: NETZ_READ }, [HOME, STUDIO]),
        { id: null, name: null, rule: null, choices: [HOME, STUDIO] }, String(id))
    }
  })
  test('a stored rule not in a tie stays as it is: handed over while active, only named once switched off', () => {
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'a2', ai_raw_response: ACME_READ }, [ACME, ACME_SPECIAL]),
      { id: 'a2', name: 'Acme Special', rule: ACME_SPECIAL, choices: [] })
    const off = { ...ACME_SPECIAL, active: false }
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'a2', ai_raw_response: ACME_READ }, [ACME, off]),
      { id: 'a2', name: 'Acme Special', rule: null, choices: [] })
    // other rules that tie now do not take it away
    const twin = rule('a3', 'Acme Special Zwei', ['ACME'], { amount_min: 30, amount_max: 35 })
    assert.deepEqual(names(suggestReceiptRules(ACME_READ, [ACME, ACME_SPECIAL, twin]).tie), ['Acme Special', 'Acme Special Zwei'])
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'a1', ai_raw_response: ACME_READ }, [ACME, ACME_SPECIAL, twin]),
      { id: 'a1', name: 'Acme', rule: ACME, choices: [] })
    // a reading that names no vendor (not readable): the stored rule as it was
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'a2', ai_raw_response: { vendor: null, unreadable: true } }, [ACME_SPECIAL]),
      { id: 'a2', name: 'Acme Special', rule: ACME_SPECIAL, choices: [] })
  })
  test('no rule stored and none tying: none — a rule that would apply now is not added unseen', () => {
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: null, ai_raw_response: ACME_READ }, [ACME, ACME_SPECIAL]), none)
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: null, ai_raw_response: null }, [HOME, STUDIO]), none)
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: null, ai_raw_response: 'kein JSON-Objekt' }, [HOME, STUDIO]), none)
  })
  test('rules not readable: no rule applied, none offered — not even the stored one (it may tie)', () => {
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'n1', ai_raw_response: NETZ_READ }, null), none)
    assert.deepEqual(receiptRuleOnResume({ suggested_vendor_id: 'a2', ai_raw_response: ACME_READ }, null), none)
  })
  test('the reading’s amount decides a range, as at the upload; one that is no number counts as none', () => {
    const at = (amount: unknown) => receiptRuleOnResume({ suggested_vendor_id: null, ai_raw_response: { vendor: 'ACME', amount } }, [ACME_SPECIAL, { ...ACME_SPECIAL, id: 'a4', name: 'Acme Special B' }])
    assert.deepEqual(names(at(32.4).choices), ['Acme Special', 'Acme Special B'])
    assert.deepEqual(at(50).choices, [])
    assert.deepEqual(at('32,40').choices, [])
  })
})

describe('receiptRuleChoices — the rules that tie, as a receipt’s answer carries them', () => {
  test('each a rule with an id and a name, in the answer’s order; anything else is none', () => {
    assert.deepEqual(receiptRuleChoices([HOME, STUDIO]), [HOME, STUDIO])
    for (const v of [undefined, null, 'Netzcom', {}, 2]) assert.deepEqual(receiptRuleChoices(v), [], String(v))
    assert.deepEqual(receiptRuleChoices([null, 'n1', { id: 1, name: 'Netzcom' }, { id: 'n2' }, HOME]), [HOME])
  })
})

describe('the texts (exact, „…“ quotes)', () => {
  const A = { name: 'A' }, B = { name: 'B' }
  test('row notes, the route’s refusals, the re-classification’s 409, the draft’s', () => {
    assert.equal(ruleTieNote([A, B]), '⚠ Mehrere Buchungsregeln passen: „A“, „B“ — Regel wählen')
    assert.equal(ruleTieAddressNote([A, B]), '⚠ Mehrere Buchungsregeln passen: „A“, „B“ — Rechnungsadresse ohne lesbaren Beleg nicht prüfbar: Beleg anhängen oder Regel wählen')
    assert.equal(ruleAddressMissingNote([A, B]), '⚠ Rechnungsadresse von „A“ / „B“ nicht im Beleg gefunden — Regel wählen oder die Adresse unter Buchungsregeln anpassen')
    assert.equal(ruleAddressDroppedNote(A), '⚠ Regel „A“ passt nach Stichwort, aber ihre Rechnungsadresse steht nicht im Beleg — KI-Vorschlag, bitte prüfen')
    assert.equal(ruleAddressNote(A), 'Zuordnung über Rechnungsadresse („A“)')
    assert.equal(ruleOutrankedNote(A, [B]), 'Regel „A“ — genauer als „B“')
    assert.equal(rulePickedNote(A), 'Regel „A“ gewählt (mehrere passten)')
    assert.equal(receiptFromOtherRuleNote([A]), 'Gefundener Beleg kam von „A“ — entfernt')
    assert.equal(otherRuleBookedNote(A, B), 'Gebucht ist „A“ — diese Zahlung ist laut Rechnung „B“')
    assert.equal(ruleTieRefusal([A, B]), 'Mehrere Buchungsregeln passen („A“, „B“) — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen')
    assert.equal(staleRuleRefusal(A), 'Vor dem Regel-Update analysiert: Regel „A“ ist für diese Zahlung nicht mehr eindeutig — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen')
    assert.equal(RULES_UNREADABLE_TEXT, 'Buchungsregeln nicht lesbar — Zeile aus einer Buchungsregel nicht gebucht, bitte erneut versuchen')
    assert.equal(RULE_TIE_NO_AI, 'Mehrere Buchungsregeln passen — Regel in den Details wählen, keine KI-Neubewertung')
    assert.equal(ruleTieDraftNote(A), '⚠ Älterer Entwurf: Regel „A“ vor dem Update gewählt, es passen aber mehrere — Regel wählen')
    assert.equal(ruleTieDraftNotice(1), 'Eine Zeile aus dem älteren Entwurf passt zu mehreren Buchungsregeln — jetzt „Regel wählen“, nicht mehr angekreuzt. Bitte Regel wählen.')
    assert.equal(ruleTieDraftNotice(2, false), '2 Zeilen aus dem älteren Entwurf passen zu mehreren Buchungsregeln — jetzt „Regel wählen“. Bitte Regel wählen.')
  })
  test('Belege’s (D3): the rules that tie, a button for each, the hint under them, the rule picked', () => {
    assert.equal(receiptRuleTieNote([A, B]), 'Mehrere Buchungsregeln passen: „A“, „B“ — Regel anwenden oder Konten selbst wählen')
    assert.equal(receiptRuleApplyLabel(A), '„A“ anwenden')
    assert.equal(RECEIPT_RULE_APPLY_HINT, 'Anwenden füllt das Formular neu aus dem Beleg und der Regel.')
    assert.equal(receiptRulePickedText('A'), 'Regel gewählt: „A“')
  })
  test('the import page’s: the checkbox, the pill, the banner, the decision, the switch by a receipt', () => {
    assert.equal(RULE_TIE_BLOCK, 'Mehrere Buchungsregeln passen — in den Details eine Regel wählen')
    assert.equal(RULE_CHOICE_PILL, 'Regel wählen')
    assert.equal(RULE_CHOICE_TITLE, 'Mehrere Buchungsregeln passen')
    assert.equal(RULE_CHOICE_QUESTION, 'Welche Regel gilt für diese Zahlung? Sie wird nur auf diese Zeile angewendet.')
    assert.equal(RULE_CHOICE_APPLY, 'Anwenden')
    assert.equal(RULE_CHOICE_FOOTER, 'Damit das nicht jeden Monat fragt: unter Buchungsregeln die Regeln unterscheiden („Betrag von/bis“ oder „Rechnungsadresse enthält“).')
    assert.equal(RULE_CHOICE_OWN_FIELDS, 'Eigene Konten gesetzt — gebucht wird, was gesetzt ist; „Anwenden“ ersetzt sie durch die Regel.')
    assert.equal(ruleInsteadLabel(B), 'Stattdessen „B“ anwenden')
    assert.equal(ruleSwitchedNote(B, A), 'Regel „B“ über die Rechnungsadresse gewählt (statt „A“)')
  })
  test('no straight double quote in any of them', () => {
    const all = [ruleTieNote([A, B]), ruleTieAddressNote([A]), ruleAddressMissingNote([A]), ruleAddressDroppedNote(A), ruleAddressNote(A),
      ruleOutrankedNote(A, [B]), rulePickedNote(A), receiptFromOtherRuleNote([A]), receiptFromOtherRuleNote([]), otherRuleBookedNote(A, B),
      ruleTieRefusal([A]), staleRuleRefusal(A), RULES_UNREADABLE_TEXT, RULE_TIE_NO_AI, ruleTieDraftNote(A), ruleTieDraftNotice(3),
      RULE_TIE_BLOCK, RULE_CHOICE_PILL, RULE_CHOICE_TITLE, RULE_CHOICE_QUESTION, RULE_CHOICE_APPLY, RULE_CHOICE_FOOTER, RULE_CHOICE_OWN_FIELDS,
      ruleInsteadLabel(B), ruleSwitchedNote(B, A)]
    for (const t of all) assert.doesNotMatch(t, /"/, t)
  })
})

describe('the Gmail search for a rule’s row: its senders, „E-Mail enthält“, the e-mails pooled with the rules that found them', () => {
  const ALPHA = rule('al', 'Acme Cloud', ['ACME'], { email_sender: '@alpha.example' })
  const BETA = rule('be', 'Acme Tools', ['ACME'], { email_sender: '@beta.example' })
  const GAMMA = rule('ga', 'Acme Abo', ['ACME'], { email_sender: ' @Alpha.example ' })
  const NONE = rule('no', 'Acme Ohne', ['ACME'], { email_sender: '' })
  const SKIP = rule('sk', 'Acme Lastschrift', ['ACME'], { email_sender: '@skip.example', skip_invoice_search: true })
  const mail = (messageId: string, subject: string, over: Partial<RuleEmail> = {}): RuleEmail =>
    ({ messageId, subject, bodyText: '', ...over })
  const pooled = (out: ReturnType<typeof ruleEmailPool>) => out.map(p => [p.email.messageId, p.sender, p.ruleIds])

  test('each distinct sender once (any case), in rule order, as its first rule writes it, with its rules; a rule without sender or searching none left out', () => {
    const senders = ruleReceiptSenders([BETA, SKIP, ALPHA, NONE, GAMMA])
    assert.deepEqual(senders.map(s => [s.sender, names(s.rules)]), [
      ['@Alpha.example', ['Acme Abo', 'Acme Cloud']],
      ['@beta.example', ['Acme Tools']],
    ])
  })
  test('the e-mails of all senders pooled in that order, each with its sender and the rules that found it — which PDF is the receipt is lib/receipt-match.ts’ to say', () => {
    const searches = [
      { sender: '@alpha.example', rules: [ALPHA], emails: [mail('m1', 'Ihre Rechnung'), mail('m2', 'Rechnung 910000000102')] },
      { sender: '@beta.example', rules: [BETA], emails: [mail('m3', 'Rechnung 910000000103')] },
    ]
    assert.deepEqual(pooled(ruleEmailPool(searches)), [['m1', '@alpha.example', ['al']], ['m2', '@alpha.example', ['al']], ['m3', '@beta.example', ['be']]])
    assert.deepEqual(ruleEmailPool([]), [])
  })
  test('rules of one sender that differ by „E-Mail enthält“: the e-mail goes with the rule whose terms it has; one that fits none of them counts for all', () => {
    const profileA = rule('pa', 'Cloud Profil A', ['CLOUD'], { email_sender: '@cloud.example', email_body_keywords: ['Profil 1001'] })
    const profileB = rule('pb', 'Cloud Profil B', ['CLOUD'], { email_sender: '@cloud.example', email_body_keywords: ['Profil 2002'] })
    const [sender] = ruleReceiptSenders([profileA, profileB])
    assert.deepEqual(pooled(ruleEmailPool([{ ...sender, emails: [mail('x1', 'Rechnung', { bodyText: 'Zahlungsprofil-ID: profil 2002' })] }])), [['x1', '@cloud.example', ['pb']]])
    // narrowed: the e-mail that fits no rule is left out when another fits one
    assert.deepEqual(pooled(ruleEmailPool([{ ...sender, emails: [mail('x0', 'Werbung'), mail('x1', 'Rechnung', { bodyText: 'Profil 1001' })] }])), [['x1', '@cloud.example', ['pa']]])
    assert.deepEqual(pooled(ruleEmailPool([{ ...sender, emails: [mail('x2', 'Rechnung')] }])), [['x2', '@cloud.example', ['pa', 'pb']]])
    assert.equal(emailFitsRule({ subject: 'PROFIL 1001', bodyText: '' }, profileA), true)
    assert.equal(emailFitsRule({ subject: '', bodyText: '' }, ACME), true)
  })
  test('an e-mail two senders’ searches found: once, with the first sender, every one of their rules found it', () => {
    const shared = mail('m5', 'Rechnung')
    const out = ruleEmailPool([
      { sender: '@alpha.example', rules: [ALPHA], emails: [shared] },
      { sender: 'rechnung@alpha.example', rules: [BETA], emails: [shared] },
    ])
    assert.deepEqual(pooled(out), [['m5', '@alpha.example', ['al', 'be']]])
  })
  test('the rules the receipt counts for: those whose search found it, and each other rule the row is chosen among of that sender whose „E-Mail enthält“ it has — one an amount range outranked, not searched for, too', () => {
    // A range decides between two rules of one sender: Analyse searched the winner's sender only
    const SPECIAL = rule('as', 'Acme Cloud Spezial', ['ACME'], { email_sender: ' @Alpha.example', amount_min: 30, amount_max: 35 })
    const fast = matchRules(ACME_TX(32.4), [ALPHA, SPECIAL])
    assert.deepEqual([fast.rule, fast.others], [SPECIAL, [ALPHA]])
    const [sender] = ruleReceiptSenders([fast.rule!])
    const [found] = ruleEmailPool([{ ...sender, emails: [mail('m6', 'Ihre Rechnung', { bodyText: 'Kundennr 910000000106' })] }])
    assert.deepEqual(found.ruleIds, ['as'])
    // Alpha shares the sender: the receipt counts for it too — Beta (another sender) and a rule
    // whose „E-Mail enthält“ the e-mail lacks do not
    const PROFILE = rule('ap', 'Acme Cloud Profil', ['ACME'], { email_sender: '@alpha.example', email_body_keywords: ['Profil 1001'] })
    assert.deepEqual(receiptRuleIds(found, [ALPHA, BETA, PROFILE, SPECIAL]), ['as', 'al'])
    assert.deepEqual(receiptRuleIds(found, []), ['as'])
    // „Stattdessen „Acme Cloud“ anwenden“ keeps the receipt its own sender sent (with the
    // search's finders alone it was dropped as another rule's: „Gefundener Beleg kam von …“)
    const won = row(ACME_TX(32.4), {
      vendor: SPECIAL, confidence: 1, title: 'Acme Cloud Spezial 07/2026', status: 'ready', gmail_message_id: 'm6', gmail_subject: 'Ihre Rechnung',
      receipt_check: 'amount', match_note: 'Gmail: @Alpha.example · Betrag 32,40 € stimmt · Regel „Acme Cloud Spezial“ — genauer als „Acme Cloud“',
      rule_choices: [ALPHA, SPECIAL], rule_tie_checked: true, gmail_rule_ids: receiptRuleIds(found, [ALPHA, SPECIAL]),
    })
    const instead = pickRule(won, 'al', 'owner')
    assert.deepEqual([instead.vendor, instead.gmail_message_id, instead.status], [ALPHA, 'm6', 'ready'])
    assert.equal(instead.match_note, 'Gmail: @Alpha.example · Betrag 32,40 € stimmt · Regel „Acme Cloud“ gewählt (mehrere passten)')
  })
})

describe('ruleOutcome — what Analyse makes of a debit’s rules (lib/matcher.ts enrichExpense)', () => {
  test('one rule: a rule row, nothing to choose among, no note', () => {
    const fast = matchRules(ACME_TX(50), [ACME, ACME_SPECIAL])
    assert.deepEqual(ruleOutcome(fast, fast), { kind: 'rule', rule: ACME, choices: [], pick: null, notes: [] })
  })
  test('a range wins: the rule row with every rule it won over as a choice, and a note on whom it beat', () => {
    const fast = matchRules(ACME_TX(32.4), [ACME_SPECIAL, ACME])
    assert.deepEqual(ruleOutcome(fast, fast), { kind: 'rule', rule: ACME_SPECIAL, choices: [ACME, ACME_SPECIAL], pick: null, notes: ['Regel „Acme Special“ — genauer als „Acme“'] })
  })
  test('the receipt’s address decided a tie: rule_pick „address“, the tied rules as choices, its note', () => {
    const fast = matchRules(NETZ_TX, [HOME, STUDIO])
    const m = matchRules(NETZ_TX, [HOME, STUDIO], inText('Beispielgasse 2'))
    assert.deepEqual(ruleOutcome(fast, m), { kind: 'rule', rule: STUDIO, choices: [HOME, STUDIO], pick: 'address', notes: ['Zuordnung über Rechnungsadresse („Netzcom Studio“)'] })
    // a generic rule beside: both notes
    const fast2 = matchRules(NETZ_TX, [GENERIC, STUDIO])
    const m2 = matchRules(NETZ_TX, [GENERIC, STUDIO], inText('Beispielgasse 2'))
    assert.deepEqual(ruleOutcome(fast2, m2), {
      kind: 'rule', rule: STUDIO, choices: [GENERIC, STUDIO], pick: 'address',
      notes: ['Zuordnung über Rechnungsadresse („Netzcom Studio“)', 'Regel „Netzcom Studio“ — genauer als „Netzcom“'],
    })
  })
  test('a tie: the owner picks — with the address note while a readable receipt could still decide', () => {
    const unchecked = matchRules(NETZ_TX, [HOME, STUDIO])
    assert.deepEqual(ruleOutcome(unchecked, unchecked), { kind: 'choice', choices: [HOME, STUDIO], note: ruleTieAddressNote([HOME, STUDIO]) })
    const same = matchRules(ACME_TX(9.57), [ACME, rule('a3', 'Acme Zwei', ['ACME'])])
    assert.deepEqual(ruleOutcome(same, same), { kind: 'choice', choices: same.tie, note: '⚠ Mehrere Buchungsregeln passen: „Acme“, „Acme Zwei“ — Regel wählen' })
    const both = matchRules(NETZ_TX, [HOME, STUDIO], inText('Musterweg 1, Beispielgasse 2'))
    assert.deepEqual(ruleOutcome(unchecked, both), { kind: 'choice', choices: [HOME, STUDIO], note: ruleTieNote([HOME, STUDIO]) })
  })
  test('two or more rules lost by their address alone: asked, never the AI; one rule lost so: the AI, unsure, with its note', () => {
    const fast = matchRules(NETZ_TX, [HOME, STUDIO])
    const neither = matchRules(NETZ_TX, [HOME, STUDIO], inText('Hauptplatz 9'))
    assert.deepEqual(ruleOutcome(fast, neither), { kind: 'choice', choices: [HOME, STUDIO], note: '⚠ Rechnungsadresse von „Netzcom Home Office“ / „Netzcom Studio“ nicht im Beleg gefunden — Regel wählen oder die Adresse unter Buchungsregeln anpassen' })
    const one = matchRules(NETZ_TX, [STUDIO], inText('Hauptplatz 9'))
    assert.deepEqual(ruleOutcome(matchRules(NETZ_TX, [STUDIO]), one), { kind: 'ai', note: ruleAddressDroppedNote(STUDIO) })
    const nothing = matchRules(ACME_TX(1), [GENERIC])
    assert.deepEqual(ruleOutcome(nothing, nothing), { kind: 'ai', note: null })
  })
  test('the status of a row to choose for: „Kein Beleg“ while no receipt is there and a choice needs one', () => {
    assert.equal(ruleChoiceStatus({ gmail_message_id: null }, [HOME, STUDIO]), 'no_invoice')
    assert.equal(ruleChoiceStatus({ gmail_message_id: 'gm-1' }, [HOME, STUDIO]), 'needs_review')
    assert.equal(ruleChoiceStatus({ gmail_message_id: null }, [{ ...HOME, skip_invoice_search: true }]), 'needs_review')
    assert.equal(ruleRowStatus({ gmail_message_id: null }, HOME), 'no_invoice')
    assert.equal(ruleRowStatus({ gmail_message_id: 'gm-1', receipt_check: 'amount' }, HOME), 'ready')
    assert.equal(ruleRowStatus({ gmail_message_id: null }, { skip_invoice_search: true }), 'ready')
  })
  test('a rule’s row whose Gmail receipt is not proven: „Prüfen“, never ready (P2-11) — a row to choose for is „Prüfen“ with any receipt', () => {
    // its invoice number only, the nearest of several, D2's unchecked one, attached before P2-11
    for (const receipt_check of ['number', 'ambiguous', 'unchecked', undefined] as const) {
      assert.equal(ruleRowStatus({ gmail_message_id: 'gm-1', receipt_check }, HOME), 'needs_review', String(receipt_check))
      assert.equal(ruleRowStatus({ gmail_message_id: 'gm-1', receipt_check }, { skip_invoice_search: true }), 'needs_review', String(receipt_check))
    }
    // a row to choose for is „Prüfen“ with any receipt (its rule is to be picked first)
    assert.equal(ruleChoiceStatus({ gmail_message_id: 'gm-1' }, [HOME, STUDIO]), 'needs_review')
    // proven by its amount, or attached by the owner from the list
    assert.equal(ruleRowStatus({ gmail_message_id: 'gm-1', receipt_check: 'owner' }, HOME), 'ready')
    // no receipt: what a check says of none does not count
    assert.equal(ruleRowStatus({ gmail_message_id: null, receipt_check: 'number' }, HOME), 'no_invoice')
  })
})

// The pair's titles (template '{vendor} {month_short}')
const HOME_TITLE = 'Netzcom Home Office 07/2026'
const STUDIO_TITLE = 'Netzcom Studio 07/2026'

describe('the duplicate check of rows whose rules tie (lib/duplicates.ts titles)', () => {
  const exp = (id: number, title: string, date = '2026-07-16') => toBookingLite({ id, title, date, amounts: [{ group: '2', amount: '40.50' }] })
  const tieRow = () => bankRows(NETZ_TX, { kind: 'expense', bookedDate: NETZ_TX.date, title: null, titles: [HOME_TITLE, STUDIO_TITLE] }).row
  test('two such rows of a day and a booking of each rule: both „Bereits gebucht“, one booking each', () => {
    const out = assignDuplicates([tieRow(), tieRow()], [exp(91, STUDIO_TITLE), exp(92, HOME_TITLE)])
    assert.deepEqual(out.map(d => [d?.id, d?.certain]), [[91, true], [92, true]])
  })
  test('only a third title of the day: „möglicherweise“, never „bereits gebucht“', () => {
    assert.equal(assignDuplicates([tieRow()], [exp(93, 'Acme 07/2026')])[0]?.certain, false)
    // a row without any title (an AI row) is certain on the same day and total, as before
    assert.equal(assignDuplicates([bankRows(NETZ_TX, { kind: 'expense', bookedDate: NETZ_TX.date }).row], [exp(93, 'Acme 07/2026')])[0]?.certain, true)
  })
  test('the row carries the titles only when rules tie', () => {
    assert.deepEqual(tieRow().titles, [HOME_TITLE, STUDIO_TITLE])
    assert.equal('titles' in bankRows(NETZ_TX, { kind: 'expense', bookedDate: NETZ_TX.date, title: STUDIO_TITLE, titles: [] }).row, false)
  })
  test('otherRuleBooking: once the address decided, a booking of another tied rule is only possibly this payment', () => {
    const decided = { transaction: NETZ_TX, vendor: HOME, rule_choices: [HOME, STUDIO], rule_pick: 'address' as const }
    assert.equal(otherRuleBooking(decided, { title: STUDIO_TITLE }), STUDIO)
    assert.equal(otherRuleBooking(decided, { title: `  ${HOME_TITLE.toUpperCase()} ` }), null)
    assert.equal(otherRuleBooking(decided, { title: 'Acme 07/2026' }), null)
    assert.equal(otherRuleBooking({ ...decided, rule_pick: 'owner' }, { title: STUDIO_TITLE }), null)
    assert.equal(otherRuleBooking({ ...decided, rule_pick: undefined }, { title: STUDIO_TITLE }), null)
    // rules whose titles are the same: the booking may be this rule's
    const twin = { ...STUDIO, title_template: 'Netzcom Home Office {month_short}' }
    assert.equal(otherRuleBooking({ ...decided, rule_choices: [HOME, twin] }, { title: HOME_TITLE }), null)
    assert.equal(otherRuleBookedNote(STUDIO, HOME), 'Gebucht ist „Netzcom Studio“ — diese Zahlung ist laut Rechnung „Netzcom Home Office“')
  })
  test('two debits of the pair, their receipts crossed, only Home Office booked: the check gives the booking to the first row; the twin whose receipt is Home Office’s gets it as certain, the other stays „möglicherweise“ (review RULES-4)', () => {
    const second = debit(NETZ_TX.counterparty, NETZ_TX.reference.replace('910000000101', '910000000102'), 40.5)
    const rows = [NETZ_TX, second].map(tx => bankRows(tx, { kind: 'expense', bookedDate: tx.date, title: null, titles: [HOME_TITLE, STUDIO_TITLE] }).row)
    const bookings = [exp(777, HOME_TITLE)]
    const gates = assignDuplicates(rows, bookings)
    assert.deepEqual(gates.map(g => g && [g.id, g.certain]), [[777, true], null])
    // each row's tied rules' bookings, as the booking route checks a row by the title it books
    const tied = rows.map(r => tiedRuleBookings(r, [HOME_TITLE, STUDIO_TITLE], bookings))
    assert.deepEqual(tied.map(t => t.map(b => [b.id, b.certain])), [[[777, true]], [[777, true]]])
    // the first row's receipt names the Studio's address, the second's Home Office's
    const studioRow = { transaction: NETZ_TX, vendor: STUDIO, rule_choices: [HOME, STUDIO], rule_pick: 'address' as const }
    const homeRow = { transaction: second, vendor: HOME, rule_choices: [HOME, STUDIO], rule_pick: 'address' as const }
    assert.equal(ownRuleBooking(studioRow, tied[0]), null)
    assert.equal(otherRuleBooking(studioRow, gates[0]!), HOME)
    assert.equal(ownRuleBooking(homeRow, tied[1])?.id, 777)
    // only once the address decided: the owner's pick, a rule chosen among none, no rule
    for (const rule_pick of ['owner', undefined] as const) assert.equal(ownRuleBooking({ ...homeRow, rule_pick }, tied[1]), null)
    assert.equal(ownRuleBooking({ ...homeRow, vendor: null }, tied[1]), null)
    // both booked: each row its own rule's
    const both = [exp(777, HOME_TITLE), exp(778, STUDIO_TITLE)]
    assert.deepEqual([ownRuleBooking(studioRow, tiedRuleBookings(rows[0], [HOME_TITLE, STUDIO_TITLE], both))?.id, ownRuleBooking(homeRow, tiedRuleBookings(rows[1], [HOME_TITLE, STUDIO_TITLE], both))?.id], [778, 777])
    // a booking of another day, or of another total: not this payment's
    assert.deepEqual(tiedRuleBookings(rows[1], [HOME_TITLE, STUDIO_TITLE], [exp(779, HOME_TITLE, '2026-07-01'), toBookingLite({ id: 780, title: HOME_TITLE, date: '2026-07-16', amounts: [{ group: '2', amount: '41.50' }] })]), [])
    // a row whose rules do not tie has none
    assert.deepEqual(tiedRuleBookings(rows[1], [], bookings), [])
    // what processExpenseTransaction holds each row as: the Home Office row the booking the
    // check gave the other row, the Studio row the check's own (said possible by otherRuleBooking)
    assert.equal(ownRuleOverride(homeRow, { match: gates[1], tied: tied[1] })?.id, 777)
    assert.equal(ownRuleOverride(studioRow, { match: gates[0], tied: tied[0] }), null)
    // the check gave the row that very booking: nothing to replace
    assert.equal(ownRuleOverride(homeRow, { match: gates[0], tied: tied[1] }), null)
    assert.equal(ownRuleOverride(homeRow, undefined), null)
  })
  test('both debits of the pair decided to the same rule by their receipts, two bookings of its title that day: each row keeps the booking the check gave it, never both the same (review check RULES-4)', () => {
    const second = debit(NETZ_TX.counterparty, NETZ_TX.reference.replace('910000000101', '910000000102'), 40.5)
    const rows = [NETZ_TX, second].map(tx => bankRows(tx, { kind: 'expense', bookedDate: tx.date, title: null, titles: [HOME_TITLE, STUDIO_TITLE] }).row)
    const bookings = [exp(101, HOME_TITLE), exp(102, HOME_TITLE)]
    const gates = assignDuplicates(rows, bookings)
    assert.deepEqual(gates.map(g => g && [g.id, g.certain]), [[101, true], [102, true]])
    const tied = rows.map(r => tiedRuleBookings(r, [HOME_TITLE, STUDIO_TITLE], bookings))
    // checked one row at a time, each finds the first booking of its title
    assert.deepEqual(tied.map(t => t.map(b => b.id)), [[101], [101]])
    const homeRows = [NETZ_TX, second].map(transaction => ({ transaction, vendor: HOME, rule_choices: [HOME, STUDIO], rule_pick: 'address' as const }))
    const held = homeRows.map((r, k) => ownRuleOverride(r, { match: gates[k], tied: tied[k] }) ?? gates[k])
    assert.deepEqual(held.map(m => m?.id), [101, 102])
    // the check held a booking of the other rule's title as this row's (said possible): its own rule's booking replaces it
    assert.equal(ownRuleOverride(homeRows[1], { match: { ...gates[1]!, id: 778, title: STUDIO_TITLE }, tied: tied[1] })?.id, 101)
  })
})

describe('pickRule — a rule applied to a row whose rules tie', () => {
  const ALPHA = rule('al', 'Acme Cloud', ['ACME'], { email_sender: '@alpha.example' })
  const BETA = rule('be', 'Acme Tools', ['ACME'], { email_sender: '@beta.example' })
  // As Analyse sends it: Beta's sender found the receipt, its amount and the bank's number on it
  const open = row(ACME_TX(19.9), {
    gmail_message_id: 'gm-7', gmail_part_id: '2', gmail_subject: 'Ihre Rechnung', gmail_date: 'Thu, 16 Jul 2026 08:00:00 +0000',
    pdf_attachment_name: 'rechnung.pdf', pdf_base64: 'JVBERi0=', extracted_invoice_number: '910000000107',
    extracted_invoice_date: '2026-07-16', extracted_amount: 19.9, status: 'needs_review', receipt_check: 'amount',
    match_note: `${ruleTieNote([ALPHA, BETA])} · Gmail: @beta.example · Betrag 19,90 € stimmt · Rechnungsnr. 910000000107`,
    rule_choices: [ALPHA, BETA], rule_tie_checked: true, gmail_rule_ids: ['be'],
  })

  test('the rule whose sender found the receipt: its row — ready, its title, the choices kept, the tie note replaced', () => {
    const out = pickRule(open, 'be', 'owner')
    assert.deepEqual(
      [out.vendor, out.confidence, out.title, out.status, out.rule_pick, out.rule_choices, out.rule_tie_checked, out.gmail_message_id, out.gmail_part_id],
      [BETA, 1, 'Acme Tools 07/2026', 'ready', 'owner', [ALPHA, BETA], true, 'gm-7', '2'])
    assert.equal(out.match_note, 'Regel „Acme Tools“ gewählt (mehrere passten) · Gmail: @beta.example · Betrag 19,90 € stimmt · Rechnungsnr. 910000000107')
    assert.equal(isOpenRuleChoice(out), false)
    assert.equal(isOpenRuleChoice(open), true)
  })
  test('the other rule: the receipt from Beta’s sender goes — its part id too —, with what was read of it, and the row says so — „Kein Beleg“', () => {
    const out = pickRule(open, 'al', 'owner')
    assert.deepEqual(
      [out.vendor, out.status, out.gmail_message_id, out.gmail_part_id, out.gmail_subject, out.gmail_date, out.pdf_attachment_name, out.pdf_base64],
      [ALPHA, 'no_invoice', null, null, null, null, null, null])
    assert.deepEqual([out.extracted_invoice_number, out.extracted_invoice_date, out.extracted_amount, out.gmail_rule_ids], [null, null, null, []])
    // how it was proven goes with it, and every note about it
    assert.equal('receipt_check' in out, false)
    assert.equal(out.match_note, 'Regel „Acme Cloud“ gewählt (mehrere passten) · Gefundener Beleg kam von „Acme Tools“ — entfernt')
  })
  test('a receipt not proven (its number only): the rule’s row „Prüfen“, not ready — held, the status behind the hold; dropped with its warning when another rule’s sender sent it', () => {
    const doubtful = {
      ...open, receipt_check: 'number' as const,
      match_note: `${ruleTieNote([ALPHA, BETA])} · ${RECEIPT_UNREADABLE_NOTE} · Gmail: @beta.example · Rechnungsnr. 910000000107`,
    }
    const out = pickRule(doubtful, 'be', 'owner')
    assert.deepEqual([out.vendor, out.status, out.receipt_check], [BETA, 'needs_review', 'number'])
    const duplicate_of = { id: 191011, title: 'Acme Tools 07/2026', date: '2026-07-16', total: 19.9, certain: true }
    assert.deepEqual([pickRule({ ...doubtful, status: 'duplicate', duplicate_of }, 'be', 'owner').own_status], ['needs_review'])
    // attached before P2-11 (no receipt_check): not proven either
    assert.equal(pickRule({ ...open, receipt_check: undefined }, 'be', 'owner').status, 'needs_review')
    const other = pickRule({ ...doubtful, match_note: `${ruleTieNote([ALPHA, BETA])} · ⚠ Beleg über Rechnungsnr. 910000000107 gefunden, aber Betrag 21,00 € statt 19,90 € — Beleg prüfen · Gmail: @beta.example · Rechnungsnr. 910000000107` }, 'al', 'owner')
    assert.deepEqual([other.status, other.gmail_message_id, 'receipt_check' in other], ['no_invoice', null, false])
    assert.equal(other.match_note, 'Regel „Acme Cloud“ gewählt (mehrere passten) · Gefundener Beleg kam von „Acme Tools“ — entfernt')
  })
  test('the address decided: its note; a receipt whose finders are not known stays', () => {
    const out = pickRule({ ...open, gmail_rule_ids: undefined }, 'al', 'address')
    assert.deepEqual([out.vendor, out.rule_pick, out.gmail_message_id, out.status], [ALPHA, 'address', 'gm-7', 'ready'])
    assert.match(out.match_note ?? '', /^Zuordnung über Rechnungsadresse \(„Acme Cloud“\) · Gmail: @beta\.example/)
  })
  test('held as booked: still held, the rule’s status behind it; an id not among the choices changes nothing', () => {
    const duplicate_of = { id: 191010, title: 'Acme Tools 07/2026', date: '2026-07-16', total: 19.9, certain: true }
    const held = pickRule({ ...open, status: 'duplicate', own_status: 'needs_review', duplicate_of }, 'be', 'owner')
    assert.deepEqual([held.status, held.own_status, held.duplicate_of], ['duplicate', 'ready', duplicate_of])
    assert.equal(pickRule(open, 'zz', 'owner'), open)
    assert.equal(pickRule(row(ACME_TX(1)), 'al', 'owner').vendor, null)
  })
  test('applied again („Stattdessen“): one note, the new rule’s; a rule that searches none is ready without a receipt', () => {
    const first = pickRule({ ...open, gmail_rule_ids: ['al', 'be'] }, 'be', 'owner')
    const again = pickRule(first, 'al', 'owner')
    assert.equal(again.vendor, ALPHA)
    assert.equal(again.match_note, 'Regel „Acme Cloud“ gewählt (mehrere passten) · Gmail: @beta.example · Betrag 19,90 € stimmt · Rechnungsnr. 910000000107')
    const noSearch = { ...BETA, skip_invoice_search: true }
    const bare = row(ACME_TX(19.9), { rule_choices: [ALPHA, noSearch], rule_tie_checked: true, status: 'no_invoice', match_note: ruleTieNote([ALPHA, noSearch]) })
    assert.deepEqual([pickRule(bare, 'be', 'owner').status, pickRule(bare, 'al', 'owner').status], ['ready', 'no_invoice'])
  })
})

// The AI's suggestion an Analyse from before the update made for a debit of the pair when the
// receipt's text held neither address (the old matcher dropped both rules): no marker
const AI_NETZ = {
  cost_account_id: 39209, purchasetax_account_id: 7002, bank_account_id: 5002, tax_percent: 20, deductibility_amount_percent: 100,
  country: '', vatin: '', title: 'Netzcom Internet', category: 'Telefon/Internet', reasoning: 'Rechnung gelesen.', requires_invoice: true,
  certainty: 'hoch', source: 'ai', vorsteuer_checked: true,
} as NonNullable<MatchedTransaction['ai_suggested']>
const oldAiRow = (over: Partial<MatchedTransaction> = {}) => row(NETZ_TX, { title: 'Netzcom Internet', ai_suggested: AI_NETZ, ...over })

describe('ruleChoiceReason — what the booking route refuses for a row’s Buchungsregel', () => {
  const open = row(NETZ_TX, { rule_choices: [HOME, STUDIO], rule_tie_checked: true, match_note: ruleTieAddressNote([HOME, STUDIO]) })
  const four = { cost_account_id: '39209', purchasetax_account_id: '7002', tax_percent: '20', deductibility_amount_percent: '60' }
  // A rule's row as a page from before the update sends it: no marker
  const oldRule = (vendor: Vendor, over: Partial<MatchedTransaction> = {}) =>
    row(NETZ_TX, { vendor, confidence: 1, title: generateTitle(vendor, NETZ_TX.date), status: 'ready', ...over })
  const RULES = [HOME, STUDIO, ACME]

  test('rules that tie, none picked: refused — unless the owner set Steuerkonto, Vorsteuerkonto, USt and BA Betrag himself', () => {
    assert.equal(ruleChoiceReason(open, {}, RULES), 'Mehrere Buchungsregeln passen („Netzcom Home Office“, „Netzcom Studio“) — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen')
    assert.equal(ruleChoiceReason(open, four, RULES), null)
    assert.equal(ruleChoiceReason(open, { cost_account_id: '39209' }, RULES), ruleTieRefusal([HOME, STUDIO]))
    // a value each: a cleared one is none
    assert.equal(ruleChoiceReason(open, { ...four, tax_percent: '' }, RULES), ruleTieRefusal([HOME, STUDIO]))
    // an AI suggestion an old page got for the row settles nothing
    assert.equal(ruleChoiceReason({ ...open, ai_suggested: { cost_account_id: 1 } as MatchedTransaction['ai_suggested'] } as MatchedTransaction, {}, RULES), ruleTieRefusal([HOME, STUDIO]))
    // the rules are not needed for it
    assert.equal(ruleChoiceReason(open, four, null), null)
    assert.deepEqual([ownerSetRuleFields(four), ownerSetRuleFields(null), ownerSetRuleFields({ ...four, deductibility_amount_percent: undefined })], [true, false, false])
  })
  test('an old rule row whose rules tie now: stale; one that is today’s unique rule: booked', () => {
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, RULES), 'Vor dem Regel-Update analysiert: Regel „Netzcom Studio“ ist für diese Zahlung nicht mehr eindeutig — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen')
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, [STUDIO, ACME]), null)
    // the critic's: the old unchecked address bonus beat a range — no longer the one that applies
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, [GENERIC, STUDIO]), staleRuleRefusal(STUDIO))
    // its own rule switched off since, another fitting alone: nothing to choose among — its
    // rule no longer fits (review RULES-2)
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, [HOME]), 'Vor dem Regel-Update analysiert: Buchungsregel „Netzcom Studio“ passt nicht mehr zu dieser Zahlung (geändert oder abgeschaltet) — Regel wieder anpassen oder CSV neu analysieren, dann buchen')
  })
  test('an old rule row whose rule no longer fits while fewer than two do — switched off, keyword or range changed, deleted: „passt nicht mehr“, the owner’s own fields alike; two or more fitting: „nicht mehr eindeutig“ (review RULES-2)', () => {
    for (const rules of [[{ ...STUDIO, active: false }, ACME], [{ ...STUDIO, match_strings: ['NETZWERK'] }], [{ ...STUDIO, amount_max: 30 }, HOME], [ACME], []]) {
      const label = rules.map(r => `${r.name}${r.active ? '' : ' (aus)'}`).join()
      assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, rules), staleRuleGoneRefusal(STUDIO), label)
      assert.equal(ruleChoiceReason(oldRule(STUDIO), four, rules), staleRuleGoneRefusal(STUDIO), label)
    }
    // its rule gone, two others fit now: a draft's load offers them
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, [HOME, rule('n5', 'Netzcom Mobil', ['NETZCOM'])]), staleRuleRefusal(STUDIO))
    // its rule fits still, outranked by a range: two fit
    assert.equal(ruleChoiceReason(oldRule(ACME, { transaction: ACME_TX(32.4) }), {}, [ACME, ACME_SPECIAL]), staleRuleRefusal(ACME))
  })
  test('an old row whose receipt’s address decided its rule (its old note) and whose Gmail receipt is sent: booked; without the receipt: stale', () => {
    const note = 'Gmail: @netzcom.example · Zuordnung über Rechnungsadresse („Netzcom Studio")'
    assert.equal(ruleChoiceReason(oldRule(STUDIO, { match_note: note, gmail_message_id: 'gm-1' }), {}, RULES), null)
    assert.equal(ruleChoiceReason(oldRule(STUDIO, { match_note: note }), {}, RULES), staleRuleRefusal(STUDIO))
    // the note of another rule says nothing of this one
    assert.equal(ruleChoiceReason(oldRule(HOME, { match_note: note, gmail_message_id: 'gm-1' }), {}, RULES), staleRuleRefusal(HOME))
  })
  test('the rules not readable: an old rule row is not booked; a marked one and a row of no rule and no AI suggestion are', () => {
    assert.equal(ruleChoiceReason(oldRule(STUDIO), {}, null), RULES_UNREADABLE_TEXT)
    assert.equal(ruleChoiceReason(oldRule(STUDIO, { rule_tie_checked: true }), {}, null), null)
    assert.equal(ruleChoiceReason(row(NETZ_TX), {}, null), null)
    assert.equal(ruleChoiceReason(null, {}, RULES), null)
  })
  test('an AI row from before the update whose rules tie now: refused — unless the owner set the four fields; one that no tie fits, or marked since: booked; the rules not readable: not booked (review RULES-1)', () => {
    const ai = oldAiRow()
    assert.equal(ruleChoiceReason(ai, {}, RULES), 'Mehrere Buchungsregeln passen („Netzcom Home Office“, „Netzcom Studio“) — Entwurf speichern, Seite neu laden, Regel wählen, dann buchen')
    assert.equal(ruleChoiceReason(ai, four, RULES), null)
    assert.equal(ruleChoiceReason(ai, { cost_account_id: '39209' }, RULES), ruleTieRefusal([HOME, STUDIO]))
    // one rule fits it now, or none: the AI's row, as before
    assert.equal(ruleChoiceReason(ai, {}, [STUDIO, ACME]), null)
    assert.equal(ruleChoiceReason(ai, {}, [ACME]), null)
    // marked: Analyse or a draft's load checked it since
    assert.equal(ruleChoiceReason({ ...ai, rule_tie_checked: true }, {}, RULES), null)
    // the rules not readable: not booked, unless the owner set the four fields
    assert.equal(ruleChoiceReason(ai, {}, null), 'Buchungsregeln nicht lesbar — KI-Vorschlag von vor dem Regel-Update nicht gebucht, bitte erneut versuchen')
    assert.equal(AI_RULES_UNREADABLE_TEXT, ruleChoiceReason(ai, { cost_account_id: '39209' }, null))
    assert.equal(ruleChoiceReason(ai, four, null), null)
    // a fixed rule's suggestion, a card settlement's and an own transfer's: not the AI's guess
    assert.equal(ruleChoiceReason(oldAiRow({ ai_suggested: { ...AI_NETZ, source: 'rule' } }), {}, RULES), null)
    const settlement = debit('Muster Bank AG', 'Abbuchung SEPA-Lastschrift|KREDITKARTENABRECHNUNG VOM 18.10.2026 NETZCOM', 120)
    const own = debit('Private Auszahlung', 'NETZCOM Auslage', 300)
    own.raw = { col0: 'AT000000000000000001', col1: `Abbuchung Echtzeitüberweisung FE/000000662|NTSBDEB1XXX AT000000000000000099 ${OWNER_NAME}|NETZCOM Auslage` }
    assert.ok(cardSettlement(settlement) && ownTransfer(own), 'the fixed rules’ payments')
    for (const transaction of [settlement, own]) {
      assert.equal(matchRules(transaction, RULES).tie.length, 2, transaction.counterparty)
      assert.equal(ruleChoiceReason(oldAiRow({ transaction }), {}, RULES), null, transaction.counterparty)
    }
  })
  test('a row Analyse checked since (marked): booked, whatever the rules say now', () => {
    assert.equal(ruleChoiceReason(oldRule(STUDIO, { rule_tie_checked: true }), {}, RULES), null)
    assert.equal(ruleChoiceReason(pickRule(open, 'n2', 'owner'), {}, RULES), null)
  })
})

describe('the import page’s row whose rules tie: its line, the banner, the receipts attached', () => {
  // As Analyse sends a row of the pair whose receipt could not be read
  const open = row(NETZ_TX, { status: 'no_invoice', rule_choices: [HOME, STUDIO], rule_tie_checked: true, match_note: ruleTieAddressNote([HOME, STUDIO]) })
  // As Analyse sends a row of the pair whose Gmail receipt's address decided
  const decided = row(NETZ_TX, {
    vendor: STUDIO, confidence: 1, title: STUDIO_TITLE, status: 'ready', gmail_message_id: 'gm-1', gmail_subject: 'Ihre Rechnung', receipt_check: 'amount',
    rule_choices: [HOME, STUDIO], rule_pick: 'address', rule_tie_checked: true, gmail_rule_ids: ['n1', 'n2'],
    match_note: 'Gmail: @netzcom.example · Zuordnung über Rechnungsadresse („Netzcom Studio“)',
  })
  // A rule won by its amount range over another (no address involved)
  const won = row(ACME_TX(32.4), { vendor: ACME_SPECIAL, confidence: 1, status: 'ready', rule_choices: [ACME, ACME_SPECIAL], rule_tie_checked: true })

  test('the line of its own: the note that asks — wherever it stands —, else the rules that fit; none once a rule applies', () => {
    assert.equal(ruleChoiceLine(open), ruleTieAddressNote([HOME, STUDIO]))
    assert.equal(ruleChoiceLine({ ...open, match_note: `Gmail: @netzcom.example · ${ruleAddressMissingNote([HOME, STUDIO])}` }), ruleAddressMissingNote([HOME, STUDIO]))
    assert.equal(ruleChoiceLine({ ...open, match_note: `${ruleTieDraftNote(STUDIO)} · Gmail: @netzcom.example` }), ruleTieDraftNote(STUDIO))
    // a note that lost it, or none: from the rules
    assert.equal(ruleChoiceLine({ ...open, match_note: 'Gmail: @netzcom.example' }), '⚠ Mehrere Buchungsregeln passen: „Netzcom Home Office“, „Netzcom Studio“ — Regel wählen')
    assert.equal(ruleChoiceLine({ ...open, match_note: null }), ruleTieNote([HOME, STUDIO]))
    for (const t of [pickRule(open, 'n2', 'owner'), decided, won, row(NETZ_TX)]) assert.equal(ruleChoiceLine(t), null)
  })

  test('the banner: each rule with its accounts, rate, both BA values, its range and its address; once a rule applies, how', () => {
    const accountName = (id: number, kind: 'cost' | 'tax') => `${kind === 'cost' ? 'Steuerkonto' : 'Vorsteuerkonto'} ${id}`
    assert.equal(ruleChoiceDetail(HOME, accountName), '„Netzcom Home Office“ — Steuerkonto 39209 · Vorsteuerkonto 7002 · 20 % · BA 100 % / USt 100 % · Adresse „Musterweg 1“')
    assert.equal(
      ruleChoiceDetail({ ...BUERO, tax_percent: 4.9, deductibility_amount_percent: 60, deductibility_tax_percent: 60, invoice_address_match: ' Musterweg 1 ' }, accountName),
      '„Netzcom Büro“ — Steuerkonto 39209 · Vorsteuerkonto 7002 · 4,9 % · BA 60 % / USt 60 % · Betrag 40,00–41,00 € · Adresse „Musterweg 1“')
    assert.equal(ruleChoiceDetail({ ...GENERIC, amount_max: null }, accountName), '„Netzcom“ — Steuerkonto 39209 · Vorsteuerkonto 7002 · 20 % · BA 100 % / USt 100 % · Betrag ab 40,00 €')
    assert.equal(ruleChoiceDetail({ ...GENERIC, amount_min: null, purchasetax_account_id: 0 }, accountName), '„Netzcom“ — Steuerkonto 39209 · — · 20 % · BA 100 % / USt 100 % · Betrag bis 41,00 €')
    assert.equal(ruleDecisionText(pickRule(open, 'n2', 'owner')), 'Regel „Netzcom Studio“ gewählt')
    assert.equal(ruleDecisionText(decided), 'Regel „Netzcom Studio“ über die Rechnungsadresse gewählt')
    assert.equal(ruleDecisionText(won), 'Regel „Acme Special“ — genauer als „Acme“')
    // still to choose for, or a rule chosen among none: nothing to say
    for (const t of [open, row(ACME_TX(50), { vendor: ACME }), row(ACME_TX(50), { vendor: ACME, rule_choices: [ACME] })]) assert.equal(ruleDecisionText(t), null)
  })

  test('what a receipt attached is checked for: the addresses of the rules it was chosen among, trimmed and once — the owner’s pick’s too (review answers (2))', () => {
    assert.deepEqual(ruleChoiceAddresses(open), ['Musterweg 1', 'Beispielgasse 2'])
    assert.deepEqual(ruleChoiceAddresses(decided), ['Musterweg 1', 'Beispielgasse 2'])
    assert.deepEqual(ruleChoiceAddresses({ rule_choices: [{ ...HOME, invoice_address_match: ' Musterweg 1 ' }, HOME, GENERIC] }), ['Musterweg 1'])
    assert.deepEqual(ruleChoiceAddresses(won), [])
    assert.deepEqual(ruleChoiceAddresses(pickRule(open, 'n1', 'owner')), ['Musterweg 1', 'Beispielgasse 2'])
    assert.deepEqual(ruleChoiceAddresses({ rule_choices: [HOME] }), [])
    assert.deepEqual(ruleChoiceAddresses({}), [])
  })

  test('a row to choose for, its receipt names one rule’s address: that rule applies (rule_pick „address“, its note) — to be ticked as a rule’s row', () => {
    const out = recheckRuleChoice(open, ['Beispielgasse 2'])
    assert.equal(out.tick, true)
    assert.deepEqual([out.row.vendor, out.row.rule_pick, out.row.title, out.row.status, out.row.rule_choices], [STUDIO, 'address', STUDIO_TITLE, 'no_invoice', [HOME, STUDIO]])
    assert.equal(out.row.match_note, 'Zuordnung über Rechnungsadresse („Netzcom Studio“)')
    // a generic rule beside an address rule: the address missing from the receipt leaves the generic one
    const pair = row(NETZ_TX, { status: 'no_invoice', rule_choices: [GENERIC, STUDIO], rule_tie_checked: true, match_note: ruleTieAddressNote([GENERIC, STUDIO]) })
    assert.deepEqual([recheckRuleChoice(pair, []).row.vendor, recheckRuleChoice(pair, ['Beispielgasse 2']).row.vendor], [GENERIC, STUDIO])
  })

  test('a rule Analyse decided, checked again by the receipt attached: the same rule is kept as it is; another alone is applied instead, said, and not ticked', () => {
    const kept = recheckRuleChoice(decided, ['Beispielgasse 2'])
    assert.equal(kept.row, decided)
    assert.equal(kept.tick, true)
    const switched = recheckRuleChoice(decided, ['Musterweg 1'])
    assert.equal(switched.tick, false)
    assert.deepEqual([switched.row.vendor, switched.row.rule_pick, switched.row.title, switched.row.gmail_message_id], [HOME, 'address', HOME_TITLE, 'gm-1'])
    assert.equal(switched.row.match_note, 'Gmail: @netzcom.example · Regel „Netzcom Home Office“ über die Rechnungsadresse gewählt (statt „Netzcom Studio“)')
    assert.equal(ruleDecisionText(switched.row), 'Regel „Netzcom Home Office“ über die Rechnungsadresse gewählt')
  })

  test('both addresses on the receipt, or neither: to be chosen for again — the note says which; not ticked', () => {
    const both = recheckRuleChoice(decided, ['Musterweg 1', 'Beispielgasse 2'])
    assert.equal(both.tick, false)
    assert.deepEqual([both.row.vendor, both.row.confidence, both.row.title, 'rule_pick' in both.row, both.row.rule_choices], [null, 0, 'NETZ AUSTRIA GMBH', false, [HOME, STUDIO]])
    assert.equal(both.row.match_note, `${ruleTieNote([HOME, STUDIO])} · Gmail: @netzcom.example`)
    assert.equal(isOpenRuleChoice(both.row), true)
    const neither = recheckRuleChoice(open, [])
    assert.deepEqual([neither.tick, neither.row.vendor, neither.row.status], [false, null, 'no_invoice'])
    assert.equal(neither.row.match_note, '⚠ Rechnungsadresse von „Netzcom Home Office“ / „Netzcom Studio“ nicht im Beleg gefunden — Regel wählen oder die Adresse unter Buchungsregeln anpassen')
  })

  test('a rule the owner picked is never switched: a receipt naming only another rule’s address keeps the pick, unticked, the note first; its own address, both, none or no text: as it is, ticked (review answers (2))', () => {
    const owner = pickRule({ ...open, match_note: `${ruleTieAddressNote([HOME, STUDIO])} · Gmail: @netzcom.example` }, 'n1', 'owner')
    const doubted = recheckRuleChoice(owner, ['Beispielgasse 2'])
    assert.deepEqual([doubted.tick, doubted.pickDoubted, doubted.row.vendor, doubted.row.rule_pick, doubted.row.title], [false, true, HOME, 'owner', HOME_TITLE])
    assert.equal(doubted.row.match_note, '⚠ Beleg nennt die Rechnungsadresse von „Netzcom Studio“ — gewählt ist „Netzcom Home Office“: Regel oder Beleg prüfen · Regel „Netzcom Home Office“ gewählt (mehrere passten) · Gmail: @netzcom.example')
    assert.equal(doubted.row.match_note?.split(' · ')[0], receiptOtherAddressNote([STUDIO], HOME))
    for (const found of [['Musterweg 1'], ['Musterweg 1', 'Beispielgasse 2'], [], null]) {
      assert.deepEqual(recheckRuleChoice(owner, found), { row: owner, tick: true }, JSON.stringify(found))
    }
    // another receipt: the note goes with the doubt, or is said once
    assert.deepEqual(recheckRuleChoice(doubted.row, ['Musterweg 1']), { row: owner, tick: true })
    assert.equal(recheckRuleChoice(doubted.row, ['Beispielgasse 2']).row.match_note, doubted.row.match_note)
    // another receipt without text (a scan): it decides nothing, and the note goes with the receipt it was about (review check)
    for (const found of [null, undefined]) assert.deepEqual(recheckRuleChoice(doubted.row, found), { row: owner, tick: true }, String(found))
    // a rule without an address picked, the receipt naming the other's: doubted too
    const generic = pickRule(row(NETZ_TX, { rule_choices: [GENERIC, STUDIO], rule_tie_checked: true, status: 'no_invoice' }), 'n4', 'owner')
    assert.deepEqual([recheckRuleChoice(generic, ['Beispielgasse 2']).tick, recheckRuleChoice(generic, ['Beispielgasse 2']).row.vendor], [false, GENERIC])
    // two other rules' addresses
    const HAFEN = rule('n6', 'Netzcom Lager', ['NETZCOM'], { invoice_address_match: 'Hafenstraße 3' })
    const three = pickRule(row(NETZ_TX, { rule_choices: [HOME, HAFEN, STUDIO], rule_tie_checked: true, status: 'no_invoice' }), 'n1', 'owner')
    assert.equal(recheckRuleChoice(three, ['Hafenstraße 3', 'Beispielgasse 2']).row.match_note?.split(' · ')[0],
      '⚠ Beleg nennt die Rechnungsadresse von „Netzcom Lager“ / „Netzcom Studio“ — gewählt ist „Netzcom Home Office“: Regel oder Beleg prüfen')
    // „Stattdessen“ replaces the note; „Beleg entfernen“ takes it with the receipt, the pick stays
    assert.equal(pickRule(doubted.row, 'n2', 'owner').match_note, 'Regel „Netzcom Studio“ gewählt (mehrere passten) · Gmail: @netzcom.example')
    assert.deepEqual(reopenRuleChoice(doubted.row), owner)
    assert.equal(reopenRuleChoice(owner), owner)
    // the note stays shown on a row whose Gmail receipt was removed: it is about the receipt
    // attached instead (review check) — so is an older draft's rule that no longer fits
    for (const note of [receiptOtherAddressNote([STUDIO], HOME), ruleGoneDraftNote(STUDIO)]) assert.ok(isRuleWarningNote(note), note)
    for (const note of [ruleTieDraftNote(STUDIO), ruleTieNote([HOME, STUDIO]), ruleSwitchedNote(STUDIO, HOME), 'Gmail: @netzcom.example', 'Regel „Netzcom Home Office“ gewählt (mehrere passten)']) {
      assert.equal(isRuleWarningNote(note), false, note)
    }
  })

  test('nothing decides: a receipt without text (an image, a scan), a row chosen among none — as it is, a rule’s row ticked as before', () => {
    assert.deepEqual(recheckRuleChoice(open, null), { row: open, tick: false })
    assert.deepEqual(recheckRuleChoice(decided, undefined), { row: decided, tick: true })
    const plain = row(ACME_TX(50), { vendor: ACME, confidence: 1, status: 'no_invoice' })
    assert.deepEqual(recheckRuleChoice(plain, ['Beispielgasse 2']), { row: plain, tick: true })
    const ai = row(ACME_TX(50))
    assert.deepEqual(recheckRuleChoice(ai, ['Beispielgasse 2']), { row: ai, tick: false })
    // rules of which none has an address (they differ by „E-Mail enthält“, say): a receipt
    // checked for another row's addresses (a bulk drop) leaves the row as it is
    const ACME_ZWEI = rule('a3', 'Acme Zwei', ['ACME'])
    const twins = row(ACME_TX(9.57), { status: 'no_invoice', rule_choices: [ACME, ACME_ZWEI], rule_tie_checked: true, match_note: ruleTieNote([ACME, ACME_ZWEI]) })
    const same = recheckRuleChoice(twins, ['Beispielgasse 2'])
    assert.equal(same.row, twins, 'the same row, not a copy: nothing to re-render, nothing to untick')
    assert.equal(same.tick, false)
    assert.equal(recheckRuleChoice(won, []).row, won)
  })

  test('a receipt attached by hand decides the rule of a row whose Gmail receipt is not proven: the rule’s row „Prüfen“ by that Gmail receipt — the tick is the caller’s, by the receipt attached (P2-11)', () => {
    const doubtful = { ...open, gmail_message_id: 'gm-2', gmail_subject: 'Ihre Rechnung', receipt_check: 'number' as const }
    const out = recheckRuleChoice(doubtful, ['Beispielgasse 2'])
    assert.deepEqual([out.tick, out.row.vendor, out.row.rule_pick, out.row.status, out.row.gmail_message_id], [true, STUDIO, 'address', 'needs_review', 'gm-2'])
    const proven = recheckRuleChoice({ ...doubtful, receipt_check: 'amount' }, ['Beispielgasse 2'])
    assert.equal(proven.row.status, 'ready')
  })

  test('held as booked: still held, its title kept, the status behind the hold follows', () => {
    const duplicate_of = { id: 191012, title: STUDIO_TITLE, date: '2026-07-16', total: 40.5, certain: true }
    const held: MatchedTransaction = { ...decided, status: 'duplicate', own_status: 'ready', duplicate_of }
    const again = recheckRuleChoice(held, ['Musterweg 1', 'Beispielgasse 2']).row
    assert.deepEqual([again.vendor, again.status, again.own_status, again.title, again.duplicate_of], [null, 'duplicate', 'needs_review', STUDIO_TITLE, duplicate_of])
    const switched = recheckRuleChoice(held, ['Musterweg 1']).row
    assert.deepEqual([switched.vendor, switched.status, switched.own_status], [HOME, 'duplicate', 'ready'])
  })

  test('„Beleg entfernen“ on a row whose rule the receipt’s address decided: to be chosen for again, the address unchecked now; any other row as it is', () => {
    const out = reopenRuleChoice(decided)
    // the receipt's id stays on the row (the page removes it: it sends none)
    assert.deepEqual([out.vendor, out.confidence, out.title, out.status, 'rule_pick' in out, out.rule_choices, out.gmail_message_id],
      [null, 0, 'NETZ AUSTRIA GMBH', 'needs_review', false, [HOME, STUDIO], 'gm-1'])
    assert.equal(out.match_note, `${ruleTieAddressNote([HOME, STUDIO])} · Gmail: @netzcom.example`)
    assert.equal(ruleChoiceLine(out), ruleTieAddressNote([HOME, STUDIO]))
    // decided by a receipt attached by hand: „Kein Beleg“ once it is gone
    assert.equal(reopenRuleChoice(recheckRuleChoice(open, ['Beispielgasse 2']).row).status, 'no_invoice')
    for (const t of [pickRule(open, 'n2', 'owner'), won, open, row(ACME_TX(50), { vendor: ACME })]) assert.equal(reopenRuleChoice(t), t)
  })

  test('/api/import/extract-invoice and /api/import/gmail-receipt: the addresses asked — trimmed, once, texts only, bounded; none asked: null', () => {
    assert.deepEqual(receiptAddressesAsked(JSON.stringify([' Musterweg 1 ', 'Musterweg 1', '', '  ', 7, null, 'Beispielgasse 2'])), ['Musterweg 1', 'Beispielgasse 2'])
    for (const v of [null, undefined, '', '[]', '[" "]', '{"a":1}', 'kein JSON', 42]) assert.equal(receiptAddressesAsked(v), null, String(v))
    assert.equal(receiptAddressesAsked(JSON.stringify(['x'.repeat(201)])), null)
    assert.equal(receiptAddressesAsked(JSON.stringify(Array.from({ length: 60 }, (_, k) => `Musterweg ${k}`)))?.length, 50)
    // /api/import/gmail-receipt: the array its JSON body carries, read the same way
    assert.deepEqual(receiptAddressesAsked([' Musterweg 1 ', 'Musterweg 1', '', 7, null, 'Beispielgasse 2']), ['Musterweg 1', 'Beispielgasse 2'])
    for (const v of [[], [' '], { a: 1 }]) assert.equal(receiptAddressesAsked(v), null, JSON.stringify(v))
    assert.equal(receiptAddressesAsked(Array.from({ length: 60 }, (_, k) => `Musterweg ${k}`))?.length, 50)
  })

  test('the addresses on a receipt: in its whole text, any case, as Analyse looks for them — also far past the 6000 characters raw_text keeps; no text: null', () => {
    const long = `Rechnung 910000000101\n${'Position Datenvolumen 4,99\n'.repeat(400)}Rechnungsadresse: MUSTER GMBH, BEISPIELGASSE 2, 1010 Wien\n${'Position Gebühr 1,00\n'.repeat(400)}Summe 40,50`
    assert.ok(long.length > 12000 && long.indexOf('BEISPIELGASSE') > 6000)
    assert.deepEqual(addressesOnReceipt(long, ['Musterweg 1', 'Beispielgasse 2']), ['Beispielgasse 2'])
    // Analyse's verdict (lib/matcher.ts: the lower-cased text includes the lower-cased address)
    for (const a of ['Musterweg 1', 'Beispielgasse 2', 'beispielgasse 2', '1010 Wien']) {
      assert.equal(addressesOnReceipt(long, [a])?.length === 1, long.toLowerCase().includes(a.toLowerCase()), a)
    }
    assert.equal(addressesOnReceipt(null, ['Musterweg 1']), null)
    assert.equal(addressesOnReceipt('  \n ', ['Musterweg 1']), null)
    assert.deepEqual(addressesOnReceipt('Rechnung', []), [])
  })
})

describe('removedReceiptBelegMissing — a row whose Gmail receipt the owner removed („Beleg entfernen“) and that needs a Beleg (review GAP-2, RULES-B4)', () => {
  // The rule's row as Analyse sends it with a proven Gmail receipt: „Bereit“, and it stays
  // so once the receipt is removed
  const ruleRow = row(NETZ_TX, { vendor: HOME, confidence: 1, status: 'ready', gmail_message_id: 'gm-1', gmail_subject: 'Ihre Rechnung', receipt_check: 'amount' })
  const removed = { removed: true, handUpload: false, bookedPrivate: false }

  test('a Buchungsregel’s row: missing its Beleg once the receipt is removed, until one is attached by hand — kept: not', () => {
    assert.equal(removedReceiptBelegMissing(ruleRow, removed), true)
    assert.equal(removedReceiptBelegMissing(ruleRow, { ...removed, removed: false }), false)
    assert.equal(removedReceiptBelegMissing(ruleRow, { ...removed, handUpload: true }), false)
  })
  test('a rule that searches no receipt (skip_invoice_search), or booked on a private Steuerkonto: no Beleg needed', () => {
    assert.equal(removedReceiptBelegMissing({ ...ruleRow, vendor: { ...HOME, skip_invoice_search: true } }, removed), false)
    assert.equal(removedReceiptBelegMissing(ruleRow, { ...removed, bookedPrivate: true }), false)
  })
  test('an AI row: as its suggestion asks — requires_invoice', () => {
    const ai = row(NETZ_TX, { status: 'needs_review', gmail_message_id: 'gm-1', ai_suggested: AI_NETZ })
    assert.equal(removedReceiptBelegMissing(ai, removed), true)
    assert.equal(removedReceiptBelegMissing({ ...ai, ai_suggested: { ...AI_NETZ, requires_invoice: false } }, removed), false)
    // neither a rule nor a suggestion: nothing to book, nothing asked
    assert.equal(removedReceiptBelegMissing(row(NETZ_TX, { status: 'unknown_vendor', gmail_message_id: 'gm-1' }), removed), false)
  })
  test('a row whose rules tie (reopened by the removal, or picked since): when any of its rules searches one', () => {
    const open = row(NETZ_TX, { status: 'needs_review', gmail_message_id: 'gm-1', rule_choices: [HOME, STUDIO], rule_tie_checked: true })
    assert.equal(removedReceiptBelegMissing(open, removed), true)
    assert.equal(removedReceiptBelegMissing({ ...open, rule_choices: [HOME, { ...STUDIO, skip_invoice_search: true }] }, removed), true)
    assert.equal(removedReceiptBelegMissing({ ...open, rule_choices: [{ ...HOME, skip_invoice_search: true }, { ...STUDIO, skip_invoice_search: true }] }, removed), false)
    // its AI suggestion (an older draft's) does not decide it
    assert.equal(removedReceiptBelegMissing({ ...open, ai_suggested: { ...AI_NETZ, requires_invoice: false } }, removed), true)
    // the hand-decided tie: the picked rule's own
    assert.equal(removedReceiptBelegMissing(pickRule(open, 'n2', 'owner'), removed), true)
    assert.equal(removedReceiptBelegMissing(pickRule({ ...open, rule_choices: [HOME, { ...STUDIO, skip_invoice_search: true }] }, 'n2', 'owner'), removed), false)
  })
})

// ─── Wiring: read from the sources (they load googleapis, pdf-parse, Next) ─────────────
