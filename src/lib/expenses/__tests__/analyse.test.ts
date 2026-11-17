import './owner'
// Mado's Analyse of a statement line without Gmail, AI or Drive (PR 9a): the fixed rules, the
// Buchungsregeln, refunds, Privateinlagen, and the bookings Bookamat already has. Made-up
// accounts, names, IBANs and amounts only; the owner is the test owner (Konrad Testmann).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseCredit, analyseExpense, annotateDuplicates, duplicateWindow, OWN_BUSINESS_DEBIT_NOTE, OWN_TRANSFER_RULE_NOTE, PRIVATE_DEPOSIT_RULE_NOTE } from '../analyse'
import { transactionOfCells } from '../csv-parser'
import type { BookamatAccounts, EasybankTransaction, Vendor } from '../types'
import type { BookingLite } from '../duplicates'

const OWN = 'AT611904300234573201'
const LISTS: BookamatAccounts = {
  year: 2026,
  cost_accounts: [
    { id: 11, name: 'Lizenzgebühren', purchasetaxaccounts: [{ id: 21, name: 'Vorsteuer Inland' }, { id: 22, name: 'IG Erwerb von Leistungen' }] },
    { id: 12, name: 'Miete und Pacht', purchasetaxaccounts: [{ id: 21, name: 'Vorsteuer Inland' }] },
    { id: 13, name: 'Privatentnahmen (allgemein)', purchasetaxaccounts: [{ id: 23, name: 'Keine Vorsteuer' }], deductibility_tax_percent: '0.00', deductibility_amount_percent: '0.00' },
  ],
  revenue_accounts: [{ id: 31, name: 'Privateinlagen (allgemein)', deductibility_tax_percent: '0.00', deductibility_amount_percent: '0.00' }, { id: 32, name: 'Erlöse 20 %' }],
  purchasetax_accounts: [
    { id: 21, name: 'Vorsteuer Inland', group: '2', tax_values: ['20.00', '10.00'] }, { id: 22, name: 'IG Erwerb von Leistungen', group: '2' },
    { id: 23, name: 'Keine Vorsteuer', group: '2' }, { id: 24, name: 'Keine Umsatzsteuer', group: '1' }, { id: 25, name: 'Umsatzsteuer Inland', group: '1' },
  ],
  bank_accounts: [{ id: 40, name: 'Geschäftskonto - Musterbank' }, { id: 41, name: 'Geschäftskonto - Easybank', iban: OWN }],
}

const line = (text: string, amount: string, date = '15.06.2026'): EasybankTransaction =>
  transactionOfCells([OWN, text, date, date, amount, 'EUR'])!

const rule = (o: Partial<Vendor> & Pick<Vendor, 'id' | 'name' | 'match_strings'>): Vendor => ({
  email_sender: '', cost_account_id: 11, purchasetax_account_id: 21, bank_account_id: 0, tax_percent: 20,
  deductibility_tax_percent: 100, deductibility_amount_percent: 100, country: '', vatin: '', title_template: `${o.name} {month_short}`,
  category: '', active: true, amount_min: null, amount_max: null, invoice_address_match: '', email_body_keywords: [], notes_template: '',
  skip_invoice_search: false, ...o,
})
const RENT = rule({ id: 'r-rent', name: 'Studio Miete', match_strings: ['HAUSMANN PETER'], cost_account_id: 12, skip_invoice_search: true })
const SOFTWARE = rule({ id: 'r-soft', name: 'Software Abo', match_strings: ['MUSTER SOFTWARE'] })
const TEL_A = rule({ id: 'r-tel-a', name: 'Telefon Büro', match_strings: ['MUSTER TELEKOM'] })
const TEL_B = rule({ id: 'r-tel-b', name: 'Telefon Studio', match_strings: ['MUSTER TELEKOM'] })
const RULES = [RENT, SOFTWARE, TEL_A, TEL_B]

const rentDebit = line('Abbuchung Dauerauftrag BG/000000651|BKAUATWWXXX AT000000000000000002 Hausmann Peter|Miete Juni', '-700,00')

test('a transfer to the owner\'s own account: Privatentnahme by the fixed rule, on the statement\'s own bank account', () => {
  const row = analyseExpense(line('Abbuchung Dauerauftrag BG/000000650|BKAUATWWXXX AT000000000000000001 Konrad Testmann|Privat', '-500,00'), RULES, LISTS)
  assert.deepEqual([row.title, row.status, row.match_note], ['Privatentnahme', 'needs_review', OWN_TRANSFER_RULE_NOTE])
  assert.deepEqual([row.ai_suggested?.cost_account_id, row.ai_suggested?.purchasetax_account_id, row.ai_suggested?.bank_account_id], [13, 23, 41])
  // Without the year's accounts it is the owner's to set
  assert.equal(analyseExpense(line('Abbuchung Dauerauftrag BG/000000650|BKAUATWWXXX AT000000000000000001 Konrad Testmann|Privat', '-500,00'), RULES, null).status, 'unknown_vendor')
})

test('a Buchungsregel\'s debit: ready when the rule needs no Beleg, else „Beleg fehlt“ until one is uploaded', () => {
  const rent = analyseExpense(rentDebit, RULES, LISTS)
  assert.deepEqual([rent.vendor?.id, rent.status], ['r-rent', 'ready'])
  assert.match(rent.title, /^Studio Miete /)
  const soft = line('Bezahlung Karte MC/000000901|MUSTER SOFTWARE DUBLIN', '-29,99')
  assert.deepEqual([analyseExpense(soft, RULES, LISTS).status, analyseExpense(soft, RULES, LISTS, { receipt: true }).status], ['no_invoice', 'ready'])
})

test('rules that fit equally: „Regel wählen“, until the owner picks one of them', () => {
  const tel = line('Abbuchung Lastschrift|MUSTER TELEKOM Rechnung 0626', '-49,90')
  const open = analyseExpense(tel, RULES, LISTS)
  assert.deepEqual([open.vendor, open.rule_choices?.map(r => r.id), open.status], [null, ['r-tel-a', 'r-tel-b'], 'no_invoice'])
  const picked = analyseExpense(tel, RULES, LISTS, { ruleId: 'r-tel-b' })
  assert.deepEqual([picked.vendor?.id, picked.rule_pick, picked.status], ['r-tel-b', 'owner', 'no_invoice'])
  assert.equal(analyseExpense(tel, RULES, LISTS, { ruleId: 'r-tel-b', receipt: true }).status, 'ready')
  // An id that is none of the rules that fit changes nothing
  assert.equal(analyseExpense(tel, RULES, LISTS, { ruleId: 'r-soft' }).vendor, null)
})

test('any other debit is the owner\'s to fill in; to his other business account it says so', () => {
  const other = analyseExpense(line('Bezahlung Karte MC/000000902|Musterladen Wien', '-12,40'), RULES, LISTS)
  assert.deepEqual([other.vendor, other.status, other.ai_suggested], [null, 'unknown_vendor', undefined])
  const toBusiness = analyseExpense(line('Abbuchung Überweisung|BAWAATWWXXX AT990000000000000777 Konrad Testmann e.U.|Übertrag', '-1.000,00'), RULES, LISTS)
  assert.equal(toBusiness.status, 'unknown_vendor')
  assert.match(toBusiness.match_note ?? '', new RegExp(OWN_BUSINESS_DEBIT_NOTE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('a credit that pays no invoice: a refund of an expense is said and not booked; a Privateinlage by its fixed rule; any other is the owner\'s', () => {
  const refund = analyseCredit(line('Gutschrift Überweisung|MUSTER SOFTWARE Rückerstattung', '29,99'), RULES, LISTS)
  assert.ok(refund.refund, 'a refund')
  assert.equal(refund.status, 'unknown')
  const deposit = analyseCredit(line('Gutschrift Überweisung|BKAUATWWXXX AT000000000000000001 Konrad Testmann|Einlage', '2.000,00'), RULES, LISTS)
  assert.deepEqual([deposit.status, deposit.match_note, deposit.ai_suggested?.revenue_account_id, deposit.ai_suggested?.vat_account_id, deposit.ai_suggested?.bank_account_id, deposit.ai_suggested?.vat_percent],
    ['needs_review', PRIVATE_DEPOSIT_RULE_NOTE, 31, 24, 41, 0])
  assert.match(deposit.title, /^Privateinlage 06\/2026$/)
  const other = analyseCredit(line('Gutschrift Überweisung|BKAUATWWXXX AT000000000000000003 Agentur Beispiel GmbH|Honorar', '840,00'), RULES, LISTS)
  assert.deepEqual([other.status, other.refund ?? null, other.ai_suggested], ['unknown', null, undefined])
})

test('a booking Bookamat has of the payment: certain on its day with the rule\'s title, held until the owner books anyway', () => {
  const rent = analyseExpense(rentDebit, RULES, LISTS)
  const booked: BookingLite = { id: 7001, title: rent.title, date: '2026-06-15', total: 700, income: false, zeroTax: 0 }
  assert.deepEqual(duplicateWindow([{ kind: 'expense', row: rent }]), { from: '2026-06-10', until: '2026-06-15' })
  const [held] = annotateDuplicates([{ kind: 'expense', row: rent }], [booked])
  assert.deepEqual([held.status, held.own_status, held.duplicate_of?.id, held.duplicate_of?.certain], ['duplicate', 'ready', 7001, true])
  // Said not to be this payment („trotzdem buchen“): not its duplicate any more
  const [acked] = annotateDuplicates([{ kind: 'expense', row: rent, ack: [7001] }], [booked])
  assert.deepEqual([acked.status, acked.duplicate_of ?? null], ['ready', null])
  // The check could not run: said on every line
  const [failed] = annotateDuplicates([{ kind: 'expense', row: rent }], null, 'Bookamat antwortet nicht')
  assert.equal(failed.duplicate_check_failed, 'Bookamat antwortet nicht')
})

test('a Buchungsdatum the owner moved near the bank date is checked there too; rules that tie are checked by their titles', () => {
  const rent = analyseExpense(rentDebit, RULES, LISTS)
  const moved: BookingLite = { id: 7101, title: rent.title, date: '2026-06-12', total: 700, income: false, zeroTax: 0 }
  const [onMoved] = annotateDuplicates([{ kind: 'expense', row: rent, override: { date: '2026-06-12' } }], [moved])
  assert.equal(onMoved.duplicate_of?.id, 7101)
  // Not moved: a booking three days before the payment is no certain one of it
  const [plain] = annotateDuplicates([{ kind: 'expense', row: rent }], [moved])
  assert.notEqual(plain.duplicate_of?.certain, true)
  // A debit whose rules tie: a booking under either rule's title on its day is its booking
  const tel = analyseExpense(line('Abbuchung Lastschrift|MUSTER TELEKOM Rechnung 0626', '-49,90'), RULES, LISTS)
  const byTitle: BookingLite = { id: 7102, title: 'Telefon Studio 06/2026', date: '2026-06-15', total: 49.9, income: false, zeroTax: 0 }
  const [tied] = annotateDuplicates([{ kind: 'expense', row: tel }], [byTitle])
  assert.deepEqual([tied.duplicate_of?.id, tied.duplicate_of?.certain], [7102, true])
})
