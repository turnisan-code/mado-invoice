import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  refundReason, refundNote, isOwnCredit, isPrivateDeposit, flagPrivateDepositGuess, flagOwnAccountCredit, ownAccountCreditNote, ownCreditInvoiceNote,
  ownCreditNote, privateDepositKind, OWN_BUSINESS_CREDIT_NOTE, PRIVATE_DEPOSIT_GUESS_NOTE,
  SVS_TERMS, SVS_PATTERN, FINANZAMT_TERMS, FINANZAMT_PATTERN, FINANZAMT_HOLDER, FINANZAMT_CREDIT_NOTE, SVS_CREDIT_NOTE,
  CARD_TRANSACTION, PAYMENT_PROCESSORS, PROCESSOR_PURCHASE, processorPurchaseOf,
  authorityCredit, authorityMention, authorityMentionNote, authorityMentionNoteOf, flagAuthorityMention,
} from '../refunds'
import { OWN_BUSINESS_IBANS, OWNER_NAME, ownTransfer } from '../own-transfer'
import { parseEasybankCsv } from '../csv-parser'
import type { EasybankTransaction, Vendor } from '@/lib/expenses/types'

const credit = (counterparty: string, reference: string, amount = 10) =>
  ({ counterparty, reference, amount, date: '2026-07-14', type: 'income', currency: 'EUR', raw: {} }) as EasybankTransaction

const rule = (name: string, match_strings: string[], extra: Partial<Vendor> = {}) => ({
  id: name, name, match_strings, email_sender: '', cost_account_id: 1, purchasetax_account_id: 2,
  bank_account_id: 3, tax_percent: 20, deductibility_tax_percent: 100, deductibility_amount_percent: 100,
  country: '', vatin: '', title_template: '{vendor} {month}', category: '', active: true,
  amount_min: null, amount_max: null, invoice_address_match: '', email_body_keywords: [],
  notes_template: '', skip_invoice_search: false, ...extra,
}) as Vendor

const RULES = [
  rule('Miete Studio', ['Hausverwaltung Gruber'], { amount_min: 900, amount_max: 900 }),
  rule('Magenta Internet Studio', ['MAGENTA']),
]

describe('refundReason — a credit from an expense vendor', () => {
  test('a Buchungsregel keyword in the counterparty, whatever the amount (partial refund)', () => {
    // The rule only takes 900 € debits; its 120.50 € Betriebskosten credit is still its refund
    const tx = credit('Hausverwaltung Gruber GmbH',
      'Gutschrift|BKAUATWWXXX AT121100000123456789 Hausverwaltung Gruber GmbH|Guthaben BK-Abrechnung 2025', 120.5)
    assert.equal(refundReason(tx, RULES), 'Buchungsregel „Miete Studio“')
  })

  test('a Buchungsregel keyword in the payer’s name, as a whole word', () => {
    const tx = credit('MAGENTA Telekom', 'Gutschrift|BKAUATWWXXX AT121100000123456789 MAGENTA Telekom|Gutschrift 910000000126')
    assert.equal(refundReason(tx, RULES), 'Buchungsregel „Magenta Internet Studio“')
  })

  test('a keyword in the free text of a client’s transfer is no refund (review: MIETE, Magenta)', () => {
    // July's real revenue credit carries „MIETE“ in its text
    const uni = credit('Akad.f.Kunst Wien Rechnungswesen', '0000302755/MIETE 03/26/02.06.2026/MIETE 04/26/|VD/000000585|BKAUATWWXXX AT000000000000000077|Akad.f.Kunst Wien Rechnungswesen', 1234.4)
    assert.equal(refundReason(uni, [rule('Studio 1 Miete', ['Hausmann Peter|Miete', 'Aufnahmeraum'])]), null)
    assert.equal(refundReason(credit('Agentur X GmbH', 'Gutschrift|Honorar Jingle Magenta Kampagne'), RULES), null)
    // „romiete“ (a bank-text keyword) inside a word of the payer's name
    assert.equal(refundReason(credit('Büromiete Service GmbH', 'Gutschrift'), [rule('Büro Miete', ['romiete'])]), null)
    // the landlord himself, named by a keyword's first part
    assert.equal(refundReason(credit('Hausmann Peter', 'Gutschrift|Guthaben Betriebskosten'), [rule('Studio 1 Miete', ['Hausmann Peter|Miete'])]), 'Buchungsregel „Studio 1 Miete“')
  })

  test('a card purchase given back without a processor prefix (MC/… E-COMM)', () => {
    const tx = credit('HERTZ UK\\LONDON\\GB', 'Gutschrift Überweisung MC/000000612|E-COMM 12,40 620 K002 20.07. 00:00|HERTZ UK\\LONDON\\GB|SPESEN: 0,00', 12.4)
    assert.equal(refundReason(tx, []), 'Kartenzahlung bei HERTZ UK zurück')
  })

  test('an inactive rule or a blank keyword matches nothing', () => {
    const tx = credit('Hausverwaltung Gruber GmbH', 'Gutschrift|Guthaben BK-Abrechnung')
    assert.equal(refundReason(tx, [rule('Miete Studio', ['Hausverwaltung Gruber'], { active: false })]), null)
    assert.equal(refundReason(credit('Client GmbH', 'Gutschrift|Projekt Juli'), [rule('Leer', ['', '  '])]), null)
  })

  test('the Sozialversicherung (SVS)', () => {
    assert.equal(refundReason(credit('Sozialversicherungsanstalt der Selbständigen',
      'Gutschrift|BKAUATWWXXX AT431200000000012345 Sozialversicherungsanstalt der Selbständigen|Beitragsgutschrift'), []),
      'Sozialversicherung')
    assert.equal(refundReason(credit('Sozialvers.Anstalt d.Selbst.', 'Gutschrift|Rückzahlung'), []), 'Sozialversicherung')
    assert.equal(refundReason(credit('SVS', 'Gutschrift|SVS-Beitragsgutschrift 2/2026'), []), 'Sozialversicherung')
    // The acronym inside another word is not the SVS
    assert.equal(refundReason(credit('SVSTRADING GMBH', 'Gutschrift|Projekt'), []), null)
    // A client's text naming it is not the SVS paying
    assert.equal(refundReason(credit('Verein Musik in Time', 'Gutschrift|Honorar Juli abzgl. Sozialversicherung'), []), null)
  })

  test('the words the expense prompt shares are the words the check knows', () => {
    for (const t of SVS_TERMS) assert.ok(SVS_PATTERN.test(t), t)
    for (const t of FINANZAMT_TERMS) assert.ok(FINANZAMT_PATTERN.test(t), t)
  })

  test('the Finanzamt (Abgabenkonto)', () => {
    assert.equal(refundReason(credit('FINANZAMT OESTERREICH',
      'Gutschrift|BUNDATWWXXX AT780100000005504133 FINANZAMT OESTERREICH|Rückzahlung Abgabenkonto 03 123/4567'), []),
      'Finanzamt')
    assert.equal(refundReason(credit('Republik Österreich', 'Gutschrift|Guthaben Abgabenkonto 03 123/4567'), []), 'Finanzamt')
  })

  test('a card purchase given back: „PROCESSOR*VENDOR“', () => {
    // July's Klangio refund, proposed as „Einnahmen“ (audit P1-4)
    assert.equal(refundReason(credit('PADDLE.NET* KLANGIO\\LISBOA\\10', 'Gutschrift|PADDLE.NET* KLANGIO\\LISBOA\\10', 0.83), []),
      'Kauf bei KLANGIO über PADDLE.NET')
    assert.equal(refundReason(credit('KLARNA*THOMANN\\BURGEBRACH', 'Gutschrift|KLARNA*THOMANN\\BURGEBRACH'), []),
      'Kauf bei THOMANN über KLARNA')
    assert.equal(refundReason(credit('PAYPAL *STEAM GAMES', 'Gutschrift|PAYPAL *STEAM GAMES\\4029357733'), []),
      'Kauf bei STEAM GAMES über PAYPAL')
    assert.equal(refundReason(credit('Gutschrift', 'Gutschrift|MOL*NUKI HOME SOLUTION\\433162'), []),
      'Kauf bei NUKI HOME SOLUTION über MOL')
  })
})

describe('refundReason — a card issuer’s credit (PR „Vorsteuer“, fixed rules § 1.10)', () => {
  // Synthetic credits in easybank's layout (column 1: „|“ is a line break), read by the
  // real parser. Public example IBANs, made-up names.
  const OWN = 'AT611904300234573201'          // the CSV's own account (column 0)
  const ISSUER_IBAN = 'AT121100000123456789'  // the issuer's account
  const BANK_IBAN = 'AT000000000000000003'    // some bank's account
  const CLIENT_IBAN = 'AT000000000000000004'  // a client's account
  const bankCredit = (col1: string, amount: string): EasybankTransaction => {
    const { transactions, errors } = parseEasybankCsv(`${OWN};${col1};20.10.2026;20.10.2026;${amount};EUR`)
    assert.deepEqual(errors, [])
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].type, 'income')
    return transactions[0]
  }
  const PAYLIFE_CREDIT = `Gutschrift Echtzeitüberweisung               FE/000000701|BAWAATWWXXX ${ISSUER_IBAN} PayLife|Guthaben Kartenkonto`

  test('the issuer as the paying account’s holder: „Guthaben aus der Kreditkartenabrechnung PayLife“, and refundNote says to book it in bookamat', () => {
    const tx = bankCredit(PAYLIFE_CREDIT, '12,90')
    // the parser's counterparty is the purpose line; the issuer is the account's holder
    assert.equal(tx.counterparty, 'Guthaben Kartenkonto')
    const reason = refundReason(tx, RULES)
    assert.equal(reason, 'Guthaben aus der Kreditkartenabrechnung PayLife')
    assert.equal(refundNote(reason!), '⚠ Erstattung — in bookamat als Aufwandsminderung buchen (Guthaben aus der Kreditkartenabrechnung PayLife)')
  })

  test('every issuer of the table by its account’s holder; a draft’s row without the CSV’s columns by its reference', () => {
    assert.equal(refundReason(bankCredit(`Gutschrift Überweisung                       FE/000000703|BKAUATWWXXX ${BANK_IBAN} card complete Service Bank AG|Gutschrift Bonus`, '5,00'), []),
      'Guthaben aus der Kreditkartenabrechnung card complete')
    assert.equal(refundReason(bankCredit(`Gutschrift Überweisung                       FE/000000704|BKAUATWWXXX ${BANK_IBAN} American Express Europe S.A.|Rückerstattung`, '19,99'), []),
      'Guthaben aus der Kreditkartenabrechnung American Express')
    assert.equal(refundReason(bankCredit(`Gutschrift Überweisung                       FE/000000705|GIBAATWWXXX ${BANK_IBAN} DC Bank AG|Kartenkonto 4711`, '7,50'), []),
      'Guthaben aus der Kreditkartenabrechnung Diners Club')
    // as the booking route gets a row from a draft: no raw columns, the bank text in the reference
    assert.equal(refundReason(credit('Guthaben Kartenkonto', PAYLIFE_CREDIT, 12.9), []), 'Guthaben aus der Kreditkartenabrechnung PayLife')
  })

  test('by the account’s holder before the text: a PayLife credit naming Amex is PayLife’s', () => {
    assert.equal(refundReason(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000706|BAWAATWWXXX ${ISSUER_IBAN} PayLife|Amex Umstellung`, '3,00'), []),
      'Guthaben aus der Kreditkartenabrechnung PayLife')
  })

  test('an issuer only named in a client’s text is no refund: the client’s payment stays income', () => {
    assert.equal(refundReason(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000702|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Workshop bezahlt per Amex`, '450,00'), RULES), null)
    assert.equal(refundReason(credit('Muster GmbH', 'Gutschrift|Honorar, Zahlung per PayLife-Karte'), RULES), null)
  })

  test('a card purchase given back at an issuer’s merchant („AMEX TRAVEL“) stays the card payment’s refund', () => {
    assert.equal(refundReason(bankCredit('Gutschrift Überweisung MC/000000612|E-COMM 12,40 620 K002 20.07. 00:00|AMEX TRAVEL\\WIEN|SPESEN: 0,00', '12,40'), []),
      'Kartenzahlung bei AMEX TRAVEL zurück')
  })

  test('never from the owner’s own account, whatever its purpose names: a Privateinlage', () => {
    const tx = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000707|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}|PayLife Rückzahlung`, '50,00')
    assert.equal(isPrivateDeposit(tx), true)
    assert.equal(refundReason(tx, []), null)
  })

  test('a credit naming one of the owner’s invoices pays it, even from an issuer', () => {
    assert.equal(refundReason(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000708|BAWAATWWXXX ${ISSUER_IBAN} PayLife|RN-202604003`, '120,00'), []), null)
  })
})

describe('refundReason — the Finanzamt by its account’s holder (PR „Vorsteuer“, fixed rules § 2.4)', () => {
  // Synthetic credits in easybank's layout, read by the real parser. The Finanzamt's
  // account prints its holder as on the owner's FA debits (own-transfer.test.ts FINANZAMT):
  // „IBAN Wien 3/6/7/11/15 Schwechat Gerasd“, with or without a BIC. Example IBANs.
  const OWN = 'AT611904300234573201'          // the CSV's own account (column 0)
  const FA_IBAN = 'AT000000000000000005'      // the Finanzamt's account
  const CLIENT_IBAN = 'AT000000000000000004'  // a client's account
  const FA_HOLDER = 'Wien 3/6/7/11/15 Schwechat Gerasd'
  const bankCredit = (col1: string, amount: string): EasybankTransaction => {
    const { transactions, errors } = parseEasybankCsv(`${OWN};${col1};20.10.2026;20.10.2026;${amount};EUR`)
    assert.deepEqual(errors, [])
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].type, 'income')
    return transactions[0]
  }
  const FA_CREDIT = `Gutschrift Überweisung                       FE/000000709|${FA_IBAN} ${FA_HOLDER}|Rückzahlung Guthaben`

  test('„Wien 3/6/7/11/15 Schwechat Gerasd“ paying, a purpose that names neither the Finanzamt nor the Abgabenkonto: „Finanzamt“, and refundNote says how to book it in bookamat', () => {
    const tx = bankCredit(FA_CREDIT, '1.250,00')
    // the parser's counterparty is the purpose line: by name the Finanzamt was not seen
    assert.equal(tx.counterparty, 'Rückzahlung Guthaben')
    assert.ok(!FINANZAMT_PATTERN.test(tx.counterparty) && !/abgabenkonto/i.test(tx.reference))
    const reason = refundReason(tx, RULES)
    assert.equal(reason, 'Finanzamt')
    assert.equal(refundNote(reason!), FINANZAMT_CREDIT_NOTE)
    assert.equal(FINANZAMT_CREDIT_NOTE, '⚠ Gutschrift vom Finanzamt — in bookamat buchen: USt-Erstattung auf „Vom Finanzamt erstattete USt“, Einkommensteuer-Erstattung als Privateinlage')
  })

  test('with a BIC, without a purpose line (the holder is then the counterparty), and a draft’s row without the CSV’s columns', () => {
    const withBic = bankCredit(`Gutschrift Überweisung                       FE/000000710|BUNDATWWXXX ${FA_IBAN} ${FA_HOLDER}|UVA 09/2026`, '86,40')
    assert.equal(refundReason(withBic, []), 'Finanzamt')
    const noPurpose = bankCredit(`Gutschrift Überweisung                       FE/000000711|BUNDATWWXXX ${FA_IBAN} ${FA_HOLDER}`, '86,40')
    assert.equal(noPurpose.counterparty, FA_HOLDER)
    assert.equal(refundReason(noPurpose, []), 'Finanzamt')
    // as the booking route gets a row from a draft: no raw columns, the bank text in the reference
    assert.equal(refundReason(credit('Rückzahlung Guthaben', FA_CREDIT, 1250), []), 'Finanzamt')
  })

  test('the office’s name as the holder counts too („FINANZAMT OESTERREICH“), whatever the purpose says', () => {
    const tx = bankCredit(`Gutschrift Überweisung                       FE/000000712|BUNDATWWXXX ${FA_IBAN} FINANZAMT OESTERREICH|Rückzahlung ESt 2025`, '412,00')
    assert.equal(tx.counterparty, 'Rückzahlung ESt 2025')
    assert.equal(refundReason(tx, []), 'Finanzamt')
  })

  test('only as the paying account’s holder: a client’s purpose naming the place stays a client’s payment', () => {
    const tx = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000713|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Workshop Schwechat Gerasdorf`, '450,00')
    assert.equal(refundReason(tx, RULES), null)
    assert.ok(FINANZAMT_HOLDER.test(FA_HOLDER))
    assert.ok(!FINANZAMT_HOLDER.test('Schwechat') && !FINANZAMT_HOLDER.test('Tischlerei Schwechat GmbH'))
    assert.equal(FINANZAMT_HOLDER.global, false)
  })

  test('never from the owner’s own account, whatever its purpose names: a Privateinlage', () => {
    const tx = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000714|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}|Rückzahlung Finanzamt`, '412,00')
    assert.equal(isPrivateDeposit(tx), true)
    assert.equal(refundReason(tx, []), null)
  })
})

describe('who pays decides: the Sozialversicherung and the Finanzamt by the paying account’s holder; a client’s text naming them is asked (follow-up from PR „Vorsteuer“)', () => {
  // Synthetic credits in easybank's layout, read by the real parser. Column 1's „|“ is a
  // line break at 57 characters: after BIC and IBAN a holder keeps 24 of them. Example
  // IBANs, made-up names.
  const OWN = 'AT611904300234573201'          // the CSV's own account (column 0)
  const SVS_IBAN = 'AT000000000000000010'     // the SVS's account
  const CLIENT_IBAN = 'AT000000000000000004'  // a client's account
  const CLUB_IBAN = 'AT000000000000000011'    // a club's account
  const STATE_IBAN = 'AT000000000000000012'   // an account of the Republic the app does not know
  const bankCredit = (col1: string, amount: string): EasybankTransaction => {
    const { transactions, errors } = parseEasybankCsv(`${OWN};${col1};20.10.2026;20.10.2026;${amount};EUR`)
    assert.deepEqual(errors, [])
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].type, 'income')
    return transactions[0]
  }
  const SVS_WITH_BIC = `Gutschrift Überweisung                       FE/000000801|BKAUATWWXXX ${SVS_IBAN} Sozialversicherungsansta|Beitragsgutschrift 2/2026`
  const SVS_NO_BIC = `Gutschrift Überweisung                       FE/000000802|${SVS_IBAN} Sozialvers.Anstalt d. Selbstaendige|Beitragsgutschrift 2/2026`
  const CLIENT_FA = `Gutschrift Echtzeitüberweisung               FE/000000803|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Workshop Finanzamt Wien`
  const CLUB_SVS = `Gutschrift Echtzeitüberweisung               FE/000000804|BKAUATWWXXX ${CLUB_IBAN} Verein Muster|Honorar Juli abzgl. Sozialversicherung`
  const FA_NOTE = '⚠ Der Text nennt das Finanzamt, gezahlt hat aber „Muster GmbH“ — Kundenzahlung (dann Einnahme) oder Erstattung vom Finanzamt (dann nicht hier, sondern in bookamat buchen)? Bitte prüfen.'
  const SVS_NOTE = '⚠ Der Text nennt die Sozialversicherung, gezahlt hat aber „Verein Muster“ — Kundenzahlung (dann Einnahme) oder Gutschrift der Sozialversicherung (dann nicht hier, sondern in bookamat buchen)? Bitte prüfen.'

  test('the SVS paying back contributions, with a purpose line: „Sozialversicherung“ by its account’s holder — with a BIC (the holder cut by the bank), without one, and a draft’s row without the CSV’s columns', () => {
    const withBic = bankCredit(SVS_WITH_BIC, '412,00')
    // the parser's counterparty is the purpose line, which names no authority
    assert.equal(withBic.counterparty, 'Beitragsgutschrift 2/2026')
    assert.ok(!SVS_PATTERN.test(withBic.counterparty))
    assert.equal(authorityCredit(withBic), 'Sozialversicherung')
    const reason = refundReason(withBic, RULES)
    assert.equal(reason, 'Sozialversicherung')
    assert.equal(refundNote(reason!), SVS_CREDIT_NOTE)
    const noBic = bankCredit(SVS_NO_BIC, '412,00')
    assert.equal(noBic.counterparty, 'Beitragsgutschrift 2/2026')
    assert.equal(refundReason(noBic, RULES), 'Sozialversicherung')
    // as the booking route gets a row from a draft: no raw columns, the bank text in the reference
    assert.equal(refundReason(credit('Beitragsgutschrift 2/2026', SVS_WITH_BIC, 412), []), 'Sozialversicherung')
    // its own credit: nothing to ask
    for (const tx of [withBic, noBic]) assert.equal(authorityMention(tx), null)
  })

  test('a holder named by the SVS’s acronym is the SVS — a client called „SVS Consulting GmbH“ too, as without a purpose line', () => {
    assert.equal(refundReason(bankCredit(`Gutschrift Überweisung                       FE/000000805|BKAUATWWXXX ${SVS_IBAN} SVS|Gutschrift Q1`, '50,00'), []), 'Sozialversicherung')
    const consulting = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000806|BKAUATWWXXX ${CLIENT_IBAN} SVS Consulting GmbH|Projekt Juli`, '900,00')
    assert.equal(consulting.counterparty, 'Projekt Juli')
    assert.equal(refundReason(consulting, []), 'Sozialversicherung')
    const noPurpose = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000807|BKAUATWWXXX ${CLIENT_IBAN} SVS Consulting GmbH`, '900,00')
    assert.equal(noPurpose.counterparty, 'SVS Consulting GmbH')
    assert.equal(refundReason(noPurpose, []), 'Sozialversicherung')
  })

  test('a client’s text naming the Finanzamt or the Sozialversicherung is no refund: asked, naming who paid (authorityMention, its note)', () => {
    const fa = bankCredit(CLIENT_FA, '450,00')
    assert.equal(fa.counterparty, 'Workshop Finanzamt Wien')
    assert.equal(authorityCredit(fa), null)
    assert.equal(refundReason(fa, RULES), null)
    assert.deepEqual(authorityMention(fa), { authority: 'Finanzamt', holder: 'Muster GmbH' })
    assert.equal(authorityMentionNote({ authority: 'Finanzamt', holder: 'Muster GmbH' }), FA_NOTE)
    assert.equal(authorityMentionNoteOf(fa), FA_NOTE)
    const club = bankCredit(CLUB_SVS, '1.000,00')
    assert.equal(club.counterparty, 'Honorar Juli abzgl. Sozialversicherung')
    assert.equal(refundReason(club, RULES), null)
    assert.deepEqual(authorityMention(club), { authority: 'Sozialversicherung', holder: 'Verein Muster' })
    assert.equal(authorityMentionNote({ authority: 'Sozialversicherung', holder: 'Verein Muster' }), SVS_NOTE)
    assert.equal(authorityMentionNoteOf(club), SVS_NOTE)
    // a purpose over two lines: the parser keeps the last as the counterparty, the mention reads them all
    const twoLines = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000808|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Workshop Finanzamt Wien|Juli 2026 Teil 2`, '450,00')
    assert.equal(twoLines.counterparty, 'Juli 2026 Teil 2')
    assert.equal(refundReason(twoLines, RULES), null)
    assert.equal(authorityMentionNoteOf(twoLines), FA_NOTE)
    // nothing to ask: a text naming neither, or the Finanzamt's place only in a client's purpose
    assert.equal(authorityMention(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000809|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Honorar Juli`, '450,00')), null)
    assert.equal(authorityMention(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000810|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Workshop Schwechat Gerasdorf`, '450,00')), null)
  })

  test('the Finanzamt’s own word: „Abgabenkonto“ makes a credit the Finanzamt’s, whoever pays; from an account the app does not know without it, asked', () => {
    const withWord = bankCredit(`Gutschrift Überweisung                       FE/000000811|BUNDATWWXXX ${STATE_IBAN} Republik Oesterreich|Rückzahlung Abgabenkonto 03 123/4567`, '412,00')
    assert.equal(authorityCredit(withWord), 'Finanzamt')
    assert.equal(refundReason(withWord, []), 'Finanzamt')
    assert.equal(authorityMention(withWord), null)
    const without = bankCredit(`Gutschrift Überweisung                       FE/000000812|BUNDATWWXXX ${STATE_IBAN} Republik Oesterreich|Rückzahlung Finanzamt 2025`, '412,00')
    assert.equal(without.counterparty, 'Rückzahlung Finanzamt 2025')
    assert.equal(authorityCredit(without), null)
    assert.equal(refundReason(without, []), null)
    assert.deepEqual(authorityMention(without), { authority: 'Finanzamt', holder: 'Republik Oesterreich' })
    // „Abgabenkonto“ in a client's purpose still counts as the Finanzamt's (kept on purpose)
    const client = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000813|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Beratung Abgabenkonto`, '300,00')
    assert.equal(refundReason(client, []), 'Finanzamt')
    assert.equal(authorityMention(client), null)
  })

  test('the holder decides when the bank prints one; without one the counterparty, as before (a holder on a line of its own before the purpose, no IBAN in the text)', () => {
    // a client's purpose naming the SVS: the holder is no authority
    assert.equal(authorityCredit(bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000814|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Rückzahlung Sozialversicherung`, '80,00')), null)
    // the holder on a line of its own, then the purpose: none is read, the purpose line decides
    const ownLine = (purpose: string) => bankCredit(`Gutschrift Überweisung                       FE/000000815|BKAUATWWXXX ${SVS_IBAN}|Sozialversicherungsanstalt|${purpose}`, '80,00')
    assert.equal(authorityCredit(ownLine('Rückzahlung Sozialversicherung')), 'Sozialversicherung')
    assert.equal(refundReason(ownLine('Beitragsgutschrift 2/2026'), []), null)
    assert.equal(authorityMention(ownLine('Beitragsgutschrift 2/2026')), null)
    // no IBAN in the text (a draft's row as the route gets it)
    assert.equal(authorityCredit(credit('Sozialvers.Anstalt d.Selbst.', 'Gutschrift|Rückzahlung')), 'Sozialversicherung')
    assert.equal(authorityCredit(credit('FINANZAMT OESTERREICH', 'Gutschrift|Rückzahlung')), 'Finanzamt')
    assert.equal(authorityCredit(credit('Muster GmbH', 'Gutschrift|Rückzahlung')), null)
  })

  test('the owner’s own accounts naming the Finanzamt: their own rules — a Privateinlage from his private account, the business account’s question — no refund, nothing asked', () => {
    const own = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000816|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}|Rückzahlung Finanzamt`, '412,00')
    assert.equal(isPrivateDeposit(own), true)
    assert.equal(refundReason(own, []), null)
    assert.equal(authorityMention(own), null)
    const business = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000817|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} ${OWNER_NAME}|Rückzahlung Finanzamt`, '412,00')
    assert.equal(isPrivateDeposit(business), false)
    assert.equal(refundReason(business, []), null)
    assert.equal(ownCreditNote(business), OWN_BUSINESS_CREDIT_NOTE)
    assert.equal(authorityMention(business), null)
    // with an invoice number from his private account: the own-account question, not this one
    const withInvoice = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000818|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}|RN-202501901 Finanzamt`, '412,00')
    assert.equal(ownCreditNote(withInvoice), ownCreditInvoiceNote('RN-202501901'))
    assert.equal(authorityMention(withInvoice), null)
    // a Privateinlage by its wording, whoever's account: the fixed rule's, nothing asked
    const wording = bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000820|BKAUATWWXXX ${CLUB_IBAN} Erika Musterfrau|Privateinlage Rückzahlung Finanzamt`, '412,00')
    assert.equal(privateDepositKind(wording), 'wording')
    assert.equal(ownCreditNote(wording), null)
    assert.equal(authorityMention(wording), null)
  })

  test('flagAuthorityMention: the AI’s answer on such a credit is unsure, the note first; on any other credit unchanged', () => {
    const guess = { revenue_account_id: 1, reasoning: 'Kundenzahlung.', certainty: 'hoch' as const }
    const flagged = flagAuthorityMention(guess, bankCredit(CLIENT_FA, '450,00'))
    assert.equal(flagged.certainty, 'niedrig')
    assert.equal(flagged.reasoning, `${FA_NOTE} Kundenzahlung.`)
    assert.equal(flagged.revenue_account_id, 1)
    assert.equal(flagAuthorityMention(guess, bankCredit(CLUB_SVS, '1.000,00')).reasoning, `${SVS_NOTE} Kundenzahlung.`)
    // the SVS's own credit, a client's text naming neither: the same object back
    assert.equal(flagAuthorityMention(guess, bankCredit(SVS_WITH_BIC, '412,00')), guess)
    assert.equal(flagAuthorityMention(guess, bankCredit(`Gutschrift Echtzeitüberweisung               FE/000000819|BKAUATWWXXX ${CLIENT_IBAN} Muster GmbH|Honorar Juli`, '450,00')), guess)
  })
})

describe('refundReason — a client payment stays income', () => {
  test('„Gutschrift“ alone is no marker: every credit starts with it', () => {
    const tx = credit('Client GmbH', 'Gutschrift Echtzeitüberweisung|BKAUATWWXXX AT123456789012345678 Client GmbH|Projekt Juli FE/000000572')
    assert.equal(refundReason(tx, RULES), null)
    assert.equal(refundReason(credit('Gutschrift', 'Gutschrift'), RULES), null)
  })

  test('a PayPal or Stripe payout to the owner is not the PROCESSOR*VENDOR form', () => {
    assert.equal(refundReason(credit('PayPal Europe S.a.r.l. et Cie S.C.A',
      'Gutschrift|DEUTDEFFXXX DE88500700100175526303 PayPal Europe S.a.r.l. et Cie S.C.A|1040012345678 PP.1234.PP ABBUCHUNG VOM PAYPAL-KONTO'), []),
      null)
    assert.equal(refundReason(credit('STRIPE PAYMENTS EUROPE LTD', 'Gutschrift|STRIPE PAYOUT ST-A1B2C3'), []), null)
  })

  test('a private deposit is booked by its own rule, never as a refund', () => {
    const tx = credit('Konrad Testmann', 'Gutschrift|NTSBDEB1XXX DE36100110012345678901 Konrad Testmann|Privateinlage')
    assert.equal(isPrivateDeposit(tx), true)
    assert.equal(refundReason(tx, [rule('Privat', ['Testmann'])]), null)
  })

  test('a credit naming one of the owner\'s invoices pays it, even from a supplier with a rule', () => {
    const tx = credit('Studio X GmbH', 'Gutschrift|BKAUATWWXXX AT123456789012345678 Studio X GmbH|RN-202604003')
    assert.equal(refundReason(tx, [rule('Studio X', ['Studio X'])]), null)
  })
})

describe('isPrivateDeposit — a transfer from the owner’s own account (P1-12)', () => {
  // A credit as the CSV gives it (public example IBANs): column 0 is this account's own
  const fromOwnAccount = (purpose: string, iban = 'DE89370400440532013000') => {
    const col1 = `Gutschrift Echtzeitüberweisung FE/000000580|NTSBDEB1XXX ${iban} Konrad Testmann${purpose ? `|${purpose}` : ''}`
    return { ...credit('Konrad Testmann', col1, 3500), raw: { col0: 'AT611904300234573201', col1, col2: '26.06.2026', col3: '26.06.2026', col4: '3.500,00', col5: 'EUR' } }
  }
  test('the owner as the paying account’s holder, without any wording', () => {
    assert.equal(isPrivateDeposit(fromOwnAccount('')), true)
    assert.equal(isPrivateDeposit(fromOwnAccount('Umbuchung')), true)
    // never a refund, whatever a rule's keyword
    assert.equal(refundReason(fromOwnAccount(''), [rule('Privat', ['Testmann'])]), null)
  })
  test('with an invoice number: maybe a client paying through his account — not by the rule', () => {
    assert.equal(isPrivateDeposit(fromOwnAccount('RN-202604003')), false)
    assert.equal(isPrivateDeposit(fromOwnAccount('Rg 4711')), false)
  })
  test('from his business account (Musterbank): no Privateinlage — its wording neither, the account comes first', () => {
    assert.equal(isPrivateDeposit(fromOwnAccount('', OWN_BUSINESS_IBANS[0])), false)
    assert.equal(isPrivateDeposit(fromOwnAccount('Eigeneinlage', OWN_BUSINESS_IBANS[0])), false)
    assert.equal(isPrivateDeposit(fromOwnAccount('Privateinlage Juli', OWN_BUSINESS_IBANS[0])), false)
    // without the CSV's columns, from the reference alike
    assert.equal(isPrivateDeposit(credit('Konrad Testmann', `Gutschrift|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} Konrad Testmann|Eigeneinlage`)), false)
  })
  test('a client’s credit stays no private deposit; without columns as before', () => {
    assert.equal(isPrivateDeposit(credit('Client GmbH', 'Gutschrift Echtzeitüberweisung|BKAUATWWXXX DE89370400440532013000 Client GmbH|Projekt Juli')), false)
    assert.equal(isPrivateDeposit({ counterparty: 'Konrad Testmann', reference: 'Gutschrift|Privateinlage' }), true)
  })
  test('privateDepositKind: by its wording, or from his own account — never from a business account', () => {
    assert.equal(privateDepositKind(fromOwnAccount('Privateinlage')), 'wording')
    assert.equal(privateDepositKind(credit('Konrad Testmann', 'Gutschrift|Eigeneinlage')), 'wording')
    assert.equal(privateDepositKind(fromOwnAccount('')), 'own')
    assert.equal(privateDepositKind(fromOwnAccount('Umbuchung')), 'own')
    assert.equal(privateDepositKind(fromOwnAccount('RN-202604003')), null)
    assert.equal(privateDepositKind(fromOwnAccount('Eigeneinlage', OWN_BUSINESS_IBANS[0])), null)
    assert.equal(privateDepositKind(credit('Client GmbH', 'Gutschrift|BKAUATWWXXX DE89370400440532013000 Client GmbH|Projekt Juli')), null)
  })
  test('privateDepositKind: an invoice number only the strict reader finds („Re-Nr. …“, „Invoice # …“, a bare part) — not \'own\', asked naming it (P1-10)', () => {
    for (const purpose of ['Re-Nr. 202501901', 'Invoice # 202501901', 'Invoice No. 202501901', '202501901']) {
      const tx = fromOwnAccount(purpose)
      // the own-transfer check's token misses these
      assert.equal(ownTransfer(tx)?.invoiceRef ?? null, null, purpose)
      assert.equal(privateDepositKind(tx), null, purpose)
      assert.equal(isPrivateDeposit(tx), false, purpose)
      assert.equal(ownCreditNote(tx), ownCreditInvoiceNote('202501901'), purpose)
      const asked = flagOwnAccountCredit({ revenue_account_id: 1, reasoning: 'Kundenzahlung.', certainty: 'hoch' as const }, tx, 'Einnahmen')
      assert.equal(asked.certainty, 'niedrig', purpose)
      assert.equal(asked.reasoning, `${ownCreditInvoiceNote('202501901')} Kundenzahlung.`, purpose)
    }
    // no number, a word, a year: still his own transfer, the fixed rule's
    for (const purpose of ['Rechnung Oktober', 'Umbuchung 2025', 'Projekt 11/2026']) {
      assert.equal(privateDepositKind(fromOwnAccount(purpose)), 'own', purpose)
    }
  })
})

describe('isOwnCredit — a credit the owner’s own rule or questions take (P1-10: no Mado question on it)', () => {
  test('a Privateinlage by its wording or from his own account, one from his business account, one with a number from his own, one from an account in his name with a title', () => {
    for (const tx of [
      credit('Muster GmbH', 'Gutschrift|BKAUATWWXXX AT000000000000000006 Muster GmbH|Privateinlage'),
      credit(OWNER_NAME, `Gutschrift|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}`),
      credit(OWNER_NAME, `Gutschrift|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} ${OWNER_NAME}|Umbuchung`),
      credit(OWNER_NAME, `Gutschrift|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}|Re-Nr. 202501901`),
      credit(`Mag. ${OWNER_NAME}`, `Gutschrift|NTSBDEB1XXX DE89370400440532013000 Mag. ${OWNER_NAME}`),
    ]) assert.equal(isOwnCredit(tx), true, tx.reference)
  })
  test('a client, a firm in his name: no', () => {
    assert.equal(isOwnCredit(credit('Muster GmbH', 'Gutschrift|BKAUATWWXXX AT000000000000000006 Muster GmbH|Projekt Juli')), false)
    assert.equal(isOwnCredit(credit(`${OWNER_NAME} GmbH`, `Gutschrift|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME} GmbH|Projekt Juli`)), false)
  })
})

describe('flagPrivateDepositGuess — the AI’s Privateinlage is unsure', () => {
  const guess = { revenue_account_id: 28235, reasoning: 'Eigene Einzahlung.', certainty: 'hoch' as const }
  test('on the Privateinlagen account: niedrig, with the note first', () => {
    const r = flagPrivateDepositGuess(guess, 'Privateinlagen (allgemein)')
    assert.equal(r.certainty, 'niedrig')
    assert.equal(r.reasoning, `${PRIVATE_DEPOSIT_GUESS_NOTE} Eigene Einzahlung.`)
    assert.equal(r.revenue_account_id, 28235)
  })
  test('any other account, or none known: unchanged', () => {
    assert.equal(flagPrivateDepositGuess(guess, 'Einnahmen'), guess)
    assert.equal(flagPrivateDepositGuess(guess, undefined), guess)
  })
})

describe('flagOwnAccountCredit — the AI’s answer on a credit from the owner’s own accounts', () => {
  const guess = { revenue_account_id: 28235, reasoning: 'Eigene Einzahlung.', certainty: 'hoch' as const }
  const income = { ...guess, revenue_account_id: 1 }
  test('from his private account with an invoice number: unsure, whatever the AI chose — client payment or Privateinlage?', () => {
    const tx = credit('Konrad Testmann', 'Gutschrift Echtzeitüberweisung FE/000000674|NTSBDEB1XXX DE89370400440532013000 Konrad Testmann|RN-202603005')
    for (const [s, name] of [[guess, 'Privateinlagen (allgemein)'], [income, 'Einnahmen']] as const) {
      const r = flagOwnAccountCredit(s, tx, name)
      assert.equal(r.certainty, 'niedrig')
      assert.equal(r.reasoning, `${ownCreditInvoiceNote('RN-202603005')} Eigene Einzahlung.`)
    }
  })
  test('from his business account: unsure, never a Privateinlage', () => {
    const tx = credit('Konrad Testmann', `Gutschrift Echtzeitüberweisung FE/000000675|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} Konrad Testmann|Umbuchung`)
    for (const [s, name] of [[guess, 'Privateinlagen (allgemein)'], [income, 'Einnahmen']] as const) {
      const r = flagOwnAccountCredit(s, tx, name)
      assert.equal(r.certainty, 'niedrig')
      assert.ok(r.reasoning.startsWith(OWN_BUSINESS_CREDIT_NOTE))
    }
  })
  test('anyone else: only a Privateinlage guess is flagged, as before', () => {
    const tx = credit('Client GmbH', 'Gutschrift Echtzeitüberweisung|BKAUATWWXXX DE89370400440532013000 Client GmbH|RN-202605010')
    assert.equal(flagOwnAccountCredit(income, tx, 'Einnahmen'), income)
    assert.ok(flagOwnAccountCredit(guess, tx, 'Privateinlagen (allgemein)').reasoning.startsWith(PRIVATE_DEPOSIT_GUESS_NOTE))
  })
  test('from an account in his name with a title or „e.U.“: unsure, whatever the AI chose — Übertrag, Privateinlage or client payment?', () => {
    for (const holder of ['Konrad Testmann e.U.', 'Mag. Konrad Testmann']) {
      const tx = credit(holder, `Gutschrift Echtzeitüberweisung FE/000000691|NTSBDEB1XXX DE89370400440532013000 ${holder}|Umbuchung`)
      assert.equal(isPrivateDeposit(tx), false)
      for (const [s, name] of [[guess, 'Privateinlagen (allgemein)'], [income, 'Einnahmen']] as const) {
        const r = flagOwnAccountCredit(s, tx, name)
        assert.equal(r.certainty, 'niedrig', `${holder} ${name}`)
        assert.equal(r.reasoning, `${ownAccountCreditNote(holder)} Eigene Einzahlung.`)
      }
    }
    assert.equal(ownAccountCreditNote('Konrad Testmann e.U.'),
      '⚠ Von einem Konto auf deinen Namen („Konrad Testmann e.U.“) — Übertrag zwischen deinen Konten (dann hier nicht buchen), Privateinlage oder Kundenzahlung? Bitte prüfen.')
  })
  test('a firm in his name is a client like any other', () => {
    const tx = credit('Konrad Testmann GmbH', 'Gutschrift Echtzeitüberweisung FE/000000692|NTSBDEB1XXX DE89370400440532013000 Konrad Testmann GmbH|RN-202605011')
    assert.equal(flagOwnAccountCredit(income, tx, 'Einnahmen'), income)
    assert.equal(ownCreditNote(tx), null)
  })
  test('from his own account without a number: the fixed rule’s — no question about a Drive invoice of its amount any more (P1-10)', () => {
    const col1 = `Gutschrift Echtzeitüberweisung FE/000000680|NTSBDEB1XXX DE89370400440532013000 ${OWNER_NAME}`
    const tx = { ...credit(OWNER_NAME, col1, 1200), raw: { col0: 'AT611904300234573201', col1 } }
    // Analyse books it by the fixed rule (privateDepositKind 'own'); asked without it, it names no invoice
    assert.equal(privateDepositKind(tx), 'own')
    assert.equal(ownCreditNote(tx), ownAccountCreditNote(OWNER_NAME))
    // neither takes a Drive invoice any more: Analyse finds one only by the bank text's number
    assert.equal(ownCreditNote.length, 1)
    assert.equal(flagOwnAccountCredit.length, 3)
  })
  test('ownCreditNote — the note a row without the AI’s answer gets: business account, invoice number, name with a title', () => {
    assert.equal(ownCreditNote(credit('Konrad Testmann', `Gutschrift|BAWAATWWXXX ${OWN_BUSINESS_IBANS[0]} Konrad Testmann|Umbuchung`)), OWN_BUSINESS_CREDIT_NOTE)
    assert.equal(ownCreditNote(credit('Konrad Testmann', 'Gutschrift|NTSBDEB1XXX DE89370400440532013000 Konrad Testmann|RN-202603005')), ownCreditInvoiceNote('RN-202603005'))
    assert.equal(ownCreditNote(credit('Mag. Konrad Testmann', 'Gutschrift|NTSBDEB1XXX DE89370400440532013000 Mag. Konrad Testmann')), ownAccountCreditNote('Mag. Konrad Testmann'))
    assert.equal(ownCreditNote(credit('Client GmbH', 'Gutschrift|BKAUATWWXXX DE89370400440532013000 Client GmbH|Projekt Juli')), null)
    assert.equal(ownCreditNote(credit('Client GmbH', 'Gutschrift Echtzeitüberweisung FE/000000600|Projekt Juli')), null)
  })
})

describe('refundNote', () => {
  test('says what to do and why', () => {
    assert.equal(refundNote('Kauf bei KLANGIO über PADDLE.NET'), '⚠ Erstattung — in bookamat als Aufwandsminderung buchen (Kauf bei KLANGIO über PADDLE.NET)')
  })
  test('a Finanzamt credit is no Aufwandsminderung: USt-Erstattung or private', () => {
    assert.match(refundNote('Finanzamt'), /^⚠ Gutschrift vom Finanzamt — .*„Vom Finanzamt erstattete USt“.*Privateinlage$/)
  })
  test('an SVS credit: contributions back, or a private benefit', () => {
    assert.match(refundNote('Sozialversicherung'), /^⚠ Gutschrift der Sozialversicherung — .*Aufwandsminderung.*Privateinlage$/)
  })
})

describe('processorPurchaseOf — a purchase through a payment processor (shared with the import’s debit checks)', () => {
  test('card debits in easybank’s shape: the processor and the vendor behind it', () => {
    // Synthetic, in the bank's layout (column 1: „|“ is a line break)
    assert.deepEqual(processorPurchaseOf('Bezahlung Karte                              MC/000000583|E-COMM        39,27 826 K002 02.06. 08:08|PAYPAL *INTERNETBS'),
      { processor: 'PAYPAL', vendor: 'INTERNETBS' })
    assert.deepEqual(processorPurchaseOf('PADDLE.NET* KLANGIO\\LISBOA\\10'), { processor: 'PADDLE.NET', vendor: 'KLANGIO' })
    assert.deepEqual(processorPurchaseOf('MOL*NUKI HOME SOLUTION\\433162'), { processor: 'MOL', vendor: 'NUKI HOME SOLUTION' })
    assert.deepEqual(processorPurchaseOf('KLARNA*THOMANN\\BURGEBRACH'), { processor: 'KLARNA', vendor: 'THOMANN' })
    assert.deepEqual(processorPurchaseOf('SQ *CAFE MUSTER\\WIEN'), { processor: 'SQ', vendor: 'CAFE MUSTER' })
    assert.deepEqual(processorPurchaseOf('SUMUP *MARKTSTAND X|K002'), { processor: 'SUMUP', vendor: 'MARKTSTAND X' })
  })
  test('every processor the list names, written as the list writes it; the vendor as written', () => {
    for (const p of PAYMENT_PROCESSORS) {
      assert.deepEqual(processorPurchaseOf(`${p.toLowerCase()} *Muster Shop\\Wien`), { processor: p, vendor: 'Muster Shop' }, p)
    }
  })
  test('the vendor is cut at 40 characters', () => {
    const long = 'A'.repeat(60)
    assert.equal(processorPurchaseOf(`PAYPAL *${long}`)?.vendor, 'A'.repeat(40))
  })
  test('a payout to the owner, a processor inside a word, nothing: none', () => {
    assert.equal(processorPurchaseOf('PayPal Europe S.a.r.l. et Cie S.C.A'), null)
    assert.equal(processorPurchaseOf('DEUTDEFFXXX DE88500700100175526303 PayPal Europe S.a.r.l. et Cie S.C.A|1040012345678 PP.1234.PP ABBUCHUNG VOM PAYPAL-KONTO'), null)
    assert.equal(processorPurchaseOf('STRIPE PAYOUT ST-A1B2C3'), null)
    assert.equal(processorPurchaseOf('XPAYPAL *Y'), null)
    assert.equal(processorPurchaseOf(''), null)
    assert.equal(processorPurchaseOf(null), null)
    assert.equal(processorPurchaseOf(undefined), null)
  })
  test('PROCESSOR_PURCHASE is shared without state: not global', () => {
    assert.ok(PROCESSOR_PURCHASE instanceof RegExp)
    assert.equal(PROCESSOR_PURCHASE.global, false)
    assert.equal(PROCESSOR_PURCHASE.sticky, false)
  })
  test('refundReason says the same as before through it (counterparty first, then the text)', () => {
    assert.equal(refundReason(credit('PAYPAL *STEAM GAMES', 'Gutschrift|KLARNA*THOMANN'), []), 'Kauf bei STEAM GAMES über PAYPAL')
    assert.equal(refundReason(credit('Gutschrift', 'Gutschrift|KLARNA*THOMANN\\BURGEBRACH'), []), 'Kauf bei THOMANN über KLARNA')
  })
})

describe('CARD_TRANSACTION — easybank’s card rows (MC/…|E-COMM, MC/…|POS)', () => {
  test('a card debit or credit, online or at a till', () => {
    assert.ok(CARD_TRANSACTION.test('Bezahlung Karte                              MC/000000583|E-COMM        39,27 826 K002 02.06. 08:08|PAYPAL *INTERNETBS'))
    assert.ok(CARD_TRANSACTION.test('Bezahlung Karte MC/000000612|POS          252,00 GBP K002 05.07. 10:51|HERTZ UK\\LONDON'))
    assert.ok(CARD_TRANSACTION.test('Gutschrift Überweisung MC/000000612|E-COMM 12,40 620 K002 20.07. 00:00|HERTZ UK\\LONDON\\GB|SPESEN: 0,00'))
  })
  test('a transfer or a SEPA debit (a card issuer’s settlement too) is none', () => {
    assert.ok(!CARD_TRANSACTION.test('Gutschrift Echtzeitüberweisung|BKAUATWWXXX AT123456789012345678 Client GmbH|Projekt Juli FE/000000572'))
    assert.ok(!CARD_TRANSACTION.test('PAYLIFE ABRECHNUNG VOM 18.10.2026            OG/000000660|BAWAATWWXXX AT611904300234573201 PayLife'))
    assert.ok(!CARD_TRANSACTION.test(''))
  })
  test('refundReason gives a card purchase back through it, as before', () => {
    const tx = credit('HERTZ UK\\LONDON\\GB', 'Gutschrift Überweisung MC/000000612|E-COMM 12,40 620 K002 20.07. 00:00|HERTZ UK\\LONDON\\GB|SPESEN: 0,00', 12.4)
    assert.equal(refundReason(tx, []), 'Kartenzahlung bei HERTZ UK zurück')
  })
})
