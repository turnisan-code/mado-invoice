import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findCounterpartyAccount,
  isIban,
  isOwnerName,
  normIban,
  ownerNameInText,
  ownerNameWithExtras,
  ownTransfer,
  ownTransferExpenseSuggestion,
  OWN_BUSINESS_IBANS,
  OWNER_NAME,
  privateGuessOnBusiness,
  promptCsvFields,
  withInvoiceQuestion,
} from '../own-transfer'
import type { BookamatAccount } from '@/lib/expenses/types'

// Synthetic rows in the bank's real layouts (easybank column 1: „|“ is a line break at 57
// characters). Public example IBANs only — never a real account's.
const OWN = 'AT611904300234573201'            // the CSV's own account (column 0)
const PRIVATE = 'DE89370400440532013000'      // the owner's private account
const OTHER = 'CH9300762011623852957'         // somebody else's

const row = (col1: string) => ({
  reference: col1,
  raw: { col0: OWN, col1, col2: '03.07.2026', col3: '03.07.2026', col4: '-3.500,00', col5: 'EUR' },
})

const SAME_LINE = `Abbuchung Echtzeitüberweisung FE/000000662|NTSBDEB1XXX ${PRIVATE} Konrad Testmann|Private Auszahlung`
const END_OF_TEXT = `Abbuchung SEPA-Zahlung (EU-Raum) VB/000000593|NTSBDEB1XXX ${PRIVATE} Konrad Testmann`
const NEXT_LINE = 'Gutschrift Echtzeitüberweisung FE/000000600|BKAUATWWXXX LT121000011101001000|Beispiel GmbH'
const RENT = `Abbuchung Dauerauftrag BG/000000650|BKAUATWWXXX ${OTHER} Mustermann Max|Büromiete Musterstraße 1Konrad Testmann`
const POLICY = `Nulltarifversicherung Optik, Praemie 07/2026 bis 06/20|27, Vers.-Nr.9100000000, Testmann Konrad|OG/000000660|BKAUATWWXXX ${PRIVATE}|Muster Versicherung Speziale Krankenversich`
const FINANZAMT = 'Abbuchung Echtzeitüberweisung FE/000000640|GB29NWBK60161331926819 Wien 3/6/7/11/15 Schwechat Gerasd|2607/09+88300E'
const CARD = 'Bezahlung Karte MC/000000665|E-COMM 9,57 USD 0,00 01.11. 23:26|ADOBE SYSTEMS SOFTWARE\\SAGGAR'

describe('findCounterpartyAccount — the holder next to the IBAN', () => {
  test('on the same line, a reference line following', () => {
    assert.deepEqual(findCounterpartyAccount(SAME_LINE, OWN), { iban: PRIVATE, holder: 'Konrad Testmann' })
  })
  test('at the end of the text (a SEPA payment without a reference)', () => {
    assert.deepEqual(findCounterpartyAccount(END_OF_TEXT, OWN), { iban: PRIVATE, holder: 'Konrad Testmann' })
  })
  test('on the next line when that is the last one', () => {
    assert.deepEqual(findCounterpartyAccount(NEXT_LINE, OWN), { iban: 'LT121000011101001000', holder: 'Beispiel GmbH' })
    // the next line is not the last: no holder
    assert.deepEqual(findCounterpartyAccount(`X|BKAUATWWXXX ${OTHER}|Konrad Testmann|Private Auszahlung`, OWN), { iban: OTHER, holder: '' })
  })
  test('the Finanzamt’s „IBAN Name|reference“ without a BIC', () => {
    assert.deepEqual(findCounterpartyAccount(FINANZAMT, OWN), { iban: 'GB29NWBK60161331926819', holder: 'Wien 3/6/7/11/15 Schwechat Gerasd' })
  })
  test('the CSV’s own IBAN is skipped', () => {
    assert.deepEqual(findCounterpartyAccount(`Umbuchung ${OWN}|BKAUATWWXXX ${OTHER} Max Mustermann`, OWN), { iban: OTHER, holder: 'Max Mustermann' })
  })
  test('a card row has no account: BIC-shaped words are none', () => {
    assert.equal(findCounterpartyAccount(CARD, OWN), null)
    assert.equal(findCounterpartyAccount('Bezahlung Karte MC/000000640|POS 23,90 0001 K002 19.10. 12:05|BROTHERS COFFEE\\WIEN', OWN), null)
  })
  test('an IBAN with letters (IE) is read whole', () => {
    assert.deepEqual(findCounterpartyAccount('X VB/000000594|AIBKIE2DXXX IE29AIBK93115212345678 Konrad Testmann', OWN),
      { iban: 'IE29AIBK93115212345678', holder: 'Konrad Testmann' })
  })
  test('no prefix of a longer token: a wrong length is no IBAN', () => {
    assert.equal(findCounterpartyAccount('X|NTSBDEB1XXX DE8937040044053201300 Konrad Testmann', OWN), null)  // DE has 22
    assert.equal(findCounterpartyAccount(`X|BKAUATWWXXX ${OWN}9 Konrad Testmann`, null), null)              // AT has 20
    assert.ok(isIban(OWN) && isIban('IE29AIBK93115212345678') && isIban('at61 1904 3002 3457 3201'))
    assert.ok(!isIban('AT61190430023457320') && !isIban('SOFTWARE') && !isIban(''))
  })
})

describe('isOwnerName — exactly the owner, in either order', () => {
  test('his name as banks print it', () => {
    for (const n of ['Konrad Testmann', 'TESTMANN KONRAD', 'Testmann, Konrad', ' konrad  testmann ', 'Konrad Téstmann']) assert.ok(isOwnerName(n), n)
  })
  test('anything more is another account holder', () => {
    for (const n of ['Konrad Testmann e.U.', 'Konrad Testmann e.U', 'Mag. Konrad Testmann', 'Konrad und Anna Testmann',
      'Konrad Testmann Tonstudio', 'Konrad Testmann GmbH', 'Testmann', 'Konrad', '', 'Mustermann Max']) {
      assert.ok(!isOwnerName(n), n)
    }
  })
})

describe('ownerNameWithExtras — his name, alone or with only a title or „e.U.“ besides', () => {
  test('a title or „e.U.“ beside his name: still his account', () => {
    for (const n of ['Konrad Testmann', 'Testmann, Konrad', 'Konrad Testmann e.U.', 'Konrad Testmann e.U', 'Konrad Testmann eU',
      'KONRAD TESTMANN E. U.', 'Mag. Konrad Testmann', 'Dr. Konrad Testmann', 'DI Konrad Testmann', 'Dipl.-Ing. Konrad Testmann',
      'Ing. Konrad Testmann', 'Konrad Testmann, MA', 'Konrad Testmann BA', 'Testmann Konrad MSc', 'Konrad Testmann BSc',
      'Prof. Mag. Konrad Testmann', 'Mag. Konrad Testmann e.U.']) {
      assert.ok(ownerNameWithExtras(n), n)
    }
  })
  test('a firm, a second person or any other word: somebody else', () => {
    for (const n of ['Konrad Testmann GmbH', 'Konrad Testmann OG', 'Konrad Testmann KG', 'Konrad Testmann AG',
      'Konrad Testmann sen.', 'Konrad Testmann u. Anna Muster', 'Konrad und Anna Testmann', 'Konrad Testmann Tonstudio',
      'Konrad Konrad Testmann', 'Mag. Testmann', 'Testmann', 'Konrad', 'Max Mustermann e.U.', '', null]) {
      assert.ok(!ownerNameWithExtras(n), String(n))
    }
  })
})

describe('the owner’s name and business accounts are constants', () => {
  test('server and page bundle use the same values: this module reads no env variable', () => {
    assert.equal(OWNER_NAME, 'Konrad Testmann')
    assert.equal(OWN_BUSINESS_IBANS.length, 1)
    assert.ok(OWN_BUSINESS_IBANS.every(iban => isIban(iban) && iban === normIban(iban)))
    // The page bundle never sees a server env variable (only NEXT_PUBLIC_ ones)
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'own-transfer.ts'), 'utf8'), /process\.env/)
  })
})

describe('privateGuessOnBusiness — a private guess booked on a business Steuerkonto needs its Beleg', () => {
  const guess = { title: 'Privatentnahme', category: 'Privatentnahme', requires_invoice: false }
  const row = (over: Record<string, unknown> = {}) => ({ vendor: null, ai_suggested: guess, ...over })
  test('booked on a business account without a receipt: yes, a split’s business line too', () => {
    assert.equal(privateGuessOnBusiness(row(), ['Büromaterial'], false), true)
    assert.equal(privateGuessOnBusiness(row(), ['Privatentnahmen (allgemein)', 'Büromaterial'], false), true)
    // private by its category alone
    assert.equal(privateGuessOnBusiness(row({ ai_suggested: { ...guess, title: 'Amazon', category: 'Privat-Entnahme' } }), ['Büromaterial'], false), true)
  })
  test('the old rule’s ESt/USt „Privatentnahme“ moved to its tax account, or SVS: no Beleg needed', () => {
    for (const account of ['Einkommensteuer', 'Umsatzsteuer laufendes Jahr', 'Sozialversicherung']) {
      assert.equal(privateGuessOnBusiness(row(), [account], false), false, account)
    }
  })
  test('a receipt lifts it; booked privately, or on no known account, it needs none', () => {
    assert.equal(privateGuessOnBusiness(row(), ['Büromaterial'], true), false)
    assert.equal(privateGuessOnBusiness(row(), ['Privatentnahmen (allgemein)'], false), false)
    assert.equal(privateGuessOnBusiness(row(), [undefined], false), false)
    assert.equal(privateGuessOnBusiness(row(), [], false), false)
  })
  test('only a guess that says private and needs no Beleg; never a Buchungsregel’s row', () => {
    assert.equal(privateGuessOnBusiness(row({ ai_suggested: { ...guess, requires_invoice: true } }), ['Büromaterial'], false), false)
    assert.equal(privateGuessOnBusiness(row({ ai_suggested: { ...guess, title: 'SVS Beitrag', category: 'SVS' } }), ['Sozialversicherung'], false), false)
    assert.equal(privateGuessOnBusiness(row({ vendor: { id: 'v' } }), ['Büromaterial'], false), false)
    assert.equal(privateGuessOnBusiness(row({ ai_suggested: undefined }), ['Büromaterial'], false), false)
  })
})

describe('withInvoiceQuestion — an own transfer naming an invoice asks „Auslagenersatz?“ where no suggestion does', () => {
  const missing = '⚠ Überweisung auf dein eigenes Konto — Konten von bookamat nicht ladbar: Steuerkonto „Privatentnahmen (allgemein)“, „Keine Vorsteuer“, 0 % selbst wählen oder neu analysieren'
  test('appended with its number', () => {
    const own = ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000671|NTSBDEB1XXX ${PRIVATE} Konrad Testmann|Auslage Thomann RE-12345`))
    assert.equal(withInvoiceQuestion(missing, own!),
      `${missing} · ⚠ Rechnungsnummer „RE-12345“ im Text — Auslagenersatz? Dann die Ausgabe selbst gesondert buchen.`)
  })
  test('without an invoice number the note stays as it is', () => {
    assert.equal(withInvoiceQuestion(missing, ownTransfer(row(SAME_LINE))!), missing)
  })
})

describe('ownTransfer — a transfer between this account and one of the owner’s own', () => {
  test('the owner as holder: same line with a reference line, and at the end of the text', () => {
    assert.deepEqual(ownTransfer(row(SAME_LINE)), { iban: PRIVATE, holder: 'Konrad Testmann', invoiceRef: null })
    assert.deepEqual(ownTransfer(row(END_OF_TEXT)), { iban: PRIVATE, holder: 'Konrad Testmann', invoiceRef: null })
  })
  test('the name on the next (last) line, and in reversed order', () => {
    assert.equal(ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000601|RLNWATWWXXX ${OTHER}|Testmann, Konrad`))?.iban, OTHER)
    assert.equal(ownTransfer(row(`Gutschrift Echtzeitüberweisung FE/000000602|RLNWATWW ${OTHER} TESTMANN KONRAD|Private Einzahlung`))?.holder, 'TESTMANN KONRAD')
  })
  test('the owner’s name only in the reference (office rent) is none', () => {
    assert.equal(ownTransfer(row(RENT)), null)
  })
  test('a private insurance debit naming him is none (Muster Versicherung)', () => {
    assert.equal(ownTransfer(row(POLICY)), null)
  })
  test('the Finanzamt is none', () => {
    assert.equal(ownTransfer(row(FINANZAMT)), null)
  })
  test('a company form or a title is another holder', () => {
    assert.equal(ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000672|NTSBDEB1XXX ${PRIVATE} Konrad Testmann e.U.|Umbuchung`)), null)
    assert.equal(ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000673|NTSBDEB1XXX ${PRIVATE} Mag. Konrad Testmann`)), null)
  })
  test('his business account (Musterbank) comes first: no Privatentnahme, holder or not', () => {
    assert.equal(ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000670|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} Konrad Testmann|Umbuchung`)), null)
  })
  test('an invoice number in the text is kept (Auslagenersatz?)', () => {
    const ref = (purpose: string) => ownTransfer(row(`Abbuchung Echtzeitüberweisung FE/000000671|NTSBDEB1XXX ${PRIVATE} Konrad Testmann|${purpose}`))?.invoiceRef
    assert.equal(ref('Auslage Thomann RE-12345'), 'RE-12345')
    assert.equal(ref('RN-202605010'), 'RN-202605010')
    assert.equal(ref('Rg 4711 Studio'), 'Rg 4711')
    assert.equal(ref('Rechnung 921707510426'), 'Rechnung 921707510426')
    assert.equal(ref('Rechnungsnr. 123'), 'Rechnungsnr. 123')
    assert.equal(ref('INV-260820-24'), 'INV-260820-24')
    assert.equal(ref('Private Auszahlung'), null)
    assert.equal(ref('Ware 2026 Kern 12'), null)
  })
  test('a card row with BIC-shaped words is none', () => {
    assert.equal(ownTransfer(row(CARD)), null)
  })
  test('without the CSV columns the reference is read', () => {
    assert.equal(ownTransfer({ reference: SAME_LINE })?.iban, PRIVATE)
  })
  test('garbage never throws', () => {
    for (const g of [null, undefined, {}, { reference: '|||' }, { reference: 'Konrad Testmann' }, { raw: null, reference: OWN },
      { raw: { col1: 42 } }, { raw: { col0: 7, col1: SAME_LINE } }, { reference: 'AT'.repeat(5000) + '|' + '|'.repeat(500) }]) {
      assert.doesNotThrow(() => ownTransfer(g as never))
    }
    assert.equal(ownTransfer(null), null)
    assert.equal(ownTransfer({ reference: '|||' }), null)
  })
})

describe('ownerNameInText — the owner’s name outside the holder field', () => {
  test('in a policy’s reference (Muster Versicherung): yes, across the line break too', () => {
    assert.equal(ownerNameInText(POLICY), true)
    assert.equal(ownerNameInText('Praemie 2026, Vers.-Nr.1, Testm|ann Konrad|OG/000000660|BKAUATWWXXX DE89370400440532013000|Beispiel Versicherung'), true)
    assert.equal(ownerNameInText(RENT), true)
  })
  test('as the holder only: no', () => {
    assert.equal(ownerNameInText(SAME_LINE), false)
    assert.equal(ownerNameInText(END_OF_TEXT, 'Konrad Testmann'), false)
  })
  test('the surname alone never counts', () => {
    assert.equal(ownerNameInText('GOOGLE WORKSPACE_TESTM|OG/000000610|CITIIE2XXXX IE29AIBK93115212345678|Google Cloud EMEA Limited'), false)
    assert.equal(ownerNameInText('Testmann Studio|Rechnung 12'), false)
    assert.equal(ownerNameInText(null), false)
  })
})

describe('promptCsvFields — the prompt’s CSV fields without the own IBAN', () => {
  test('column 0 is dropped, the rest kept', () => {
    const out = promptCsvFields(row(SAME_LINE).raw)
    assert.doesNotMatch(out, new RegExp(OWN))
    assert.doesNotMatch(out, /col0:/)
    assert.match(out, /^ {2}col1: Abbuchung Echtzeitüberweisung/)
    assert.match(out, /col4: -3\.500,00/)
    assert.match(out, /col5: EUR/)
  })
  test('any field holding the own IBAN (spaced, lower-case) goes too; empty fields as before', () => {
    assert.equal(promptCsvFields({ col0: OWN, col1: 'x', col2: '', col3: 'at61 1904 3002 3457 3201' }), '  col1: x')
  })
  test('no IBAN in column 0 (a header-based CSV): everything stays', () => {
    assert.equal(promptCsvFields({ Buchungstext: 'x', Betrag: '-1,00' }), '  Buchungstext: x\n  Betrag: -1,00')
    assert.equal(promptCsvFields(undefined), '')
  })
})

describe('ownTransferExpenseSuggestion — the fixed Privatentnahme', () => {
  const KEINE_VST = { id: 6601, name: 'Keine Vorsteuer', group: '2' }
  const lists = (cost: BookamatAccount[], pt: BookamatAccount[] = [{ id: 6589, name: 'Vorsteuer Inland', group: '2' }, KEINE_VST]) =>
    ({ cost_accounts: cost, purchasetax_accounts: pt })
  const own = { iban: PRIVATE, holder: 'Konrad Testmann', invoiceRef: null }

  test('„Privatentnahmen (allgemein)“ exactly wins over another private account', () => {
    const s = ownTransferExpenseSuggestion(own, lists([
      { id: 28233, name: 'Privatentnahme Kfz-Nutzung', purchasetaxaccounts: [KEINE_VST] },
      { id: 28234, name: ' privatentnahmen  (Allgemein) ', purchasetaxaccounts: [KEINE_VST] },
    ]), 3224)
    assert.equal(s?.cost_account_id, 28234)
    assert.equal(s?.purchasetax_account_id, 6601)
    assert.equal(s?.bank_account_id, 3224)
    assert.equal(s?.tax_percent, 0)
    assert.equal(s?.title, 'Privatentnahme')
    assert.equal(s?.category, 'Privatentnahme')
    assert.equal(s?.requires_invoice, false)
    assert.equal(s?.certainty, 'hoch')
    assert.equal(s?.source, 'rule')
    assert.equal(s?.reasoning, 'Überweisung auf dein eigenes Konto (Inhaber Konrad Testmann, IBAN …3000) — Privatentnahme (feste Regel).')
    // As any suggestion: the account's lock books 0 / 0; moved to a business account, 100 %
    assert.equal(s?.deductibility_amount_percent, 100)
    assert.equal(s?.deductible_share, 1)
  })
  test('else the only one starting with „Privatentnahme“; two are no answer', () => {
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 28234, name: 'Privatentnahmen' }]), 3224)?.cost_account_id, 28234)
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 1, name: 'Privatentnahme Kfz' }, { id: 2, name: 'Privatentnahme Telefon' }]), 3224), null)
  })
  test('„Keine Vorsteuer“ linked to the Steuerkonto, else by name in the list', () => {
    const linked = { id: 7001, name: 'Keine Vorsteuer' }
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 28234, name: 'Privatentnahmen (allgemein)', purchasetaxaccounts: [linked] }]), 3224)?.purchasetax_account_id, 7001)
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 28234, name: 'Privatentnahmen (allgemein)' }]), 3224)?.purchasetax_account_id, 6601)
  })
  test('an account missing in bookamat: no suggestion', () => {
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 28209, name: 'Internet' }]), 3224), null)
    assert.equal(ownTransferExpenseSuggestion(own, lists([{ id: 28234, name: 'Privatentnahmen (allgemein)' }], [{ id: 6589, name: 'Vorsteuer Inland' }]), 3224), null)
    assert.equal(ownTransferExpenseSuggestion(own, null, 3224), null)
  })
  test('an invoice number in the text: unsure, and it says why', () => {
    const s = ownTransferExpenseSuggestion({ ...own, invoiceRef: 'RE-12345' }, lists([{ id: 28234, name: 'Privatentnahmen (allgemein)' }]), 3224)
    assert.equal(s?.certainty, 'niedrig')
    assert.equal(s?.source, 'rule')
    assert.match(s?.reasoning ?? '', /^⚠ Überweisung auf dein eigenes Konto, aber mit Rechnungsnummer „RE-12345“ im Text — Auslagenersatz\?/)
  })
})
