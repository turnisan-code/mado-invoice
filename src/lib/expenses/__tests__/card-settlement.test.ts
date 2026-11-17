import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEasybankCsv } from '../csv-parser'
import { CARD_ISSUERS, cardIssuerOf, issuerCreditReason } from '../card-issuers'
import {
  cardSettlement, cardSettlementBoxText, cardSettlementDraftNotice, cardSettlementDraftRows, cardSettlementExpenseRow,
  cardSettlementReasoning, cardSettlementSuggestion, cardSettlementTitle, isStaleCardSettlementRow,
  CARD_FEE_ACCOUNT, CARD_SETTLEMENT_NO_AI, GENERIC_ISSUER, GENERIC_STATEMENT_WHERE, STALE_CARD_SETTLEMENT_TEXT,
  type CardSettlement,
} from '../card-settlement'
import { refundNote } from '../refunds'
import { OWNER_NAME } from '../own-transfer'
import type { AiSuggestion, BookamatAccount, BookamatAccounts, EasybankTransaction, MatchedTransaction, Vendor } from '@/lib/expenses/types'

// Synthetic rows in easybank's layout (column 1: „|“ is a line break at 57 characters),
// read by the real parser. Public example IBANs and made-up names only.
const OWN = 'AT611904300234573201'          // the CSV's own account (column 0)
const ISSUER_IBAN = 'AT121100000123456789'  // the issuer's account
const BANK_IBAN = 'AT000000000000000003'    // some bank's account
const SHOP_IBAN = 'AT000000000000000004'    // a client's or a shop's account
const PRIVATE = 'DE89370400440532013000'    // the owner's private account

function bankRow(col1: string, amount = '-28,30', date = '20.10.2026'): EasybankTransaction {
  const { transactions, errors } = parseEasybankCsv(`${OWN};${col1};${date};${date};${amount};EUR`)
  assert.deepEqual(errors, [])
  assert.equal(transactions.length, 1)
  return transactions[0]
}

const PAYLIFE = `PAYLIFE ABRECHNUNG VOM 18.10.2026            OG/000000660|BAWAATWWXXX ${ISSUER_IBAN} PayLife`
const CARD_PURCHASE = 'Bezahlung Karte                              MC/000000583|E-COMM        39,27 826 K002 02.06. 08:08|PAYPAL *INTERNETBS'
const AMEX_MERCHANT = 'Bezahlung Karte                              MC/000000640|POS          120,00 0001 K002 19.10. 12:05|AMEX TRAVEL\\WIEN'

const PAYLIFE_SETTLEMENT: CardSettlement = { issuer: 'PayLife', where: 'im PayLife Serviceportal', statementDate: '2026-10-18', month: '10/2026' }

describe('cardSettlement — a card issuer’s settlement in the bank CSV', () => {
  test('PayLife’s SEPA debit: holder „PayLife“, statement date from „VOM 18.10.2026“', () => {
    const tx = bankRow(PAYLIFE)
    // what the parser makes of it: the first segment is the counterparty
    assert.match(tx.counterparty, /^PAYLIFE ABRECHNUNG VOM 18\.10\.2026/)
    assert.deepEqual(cardSettlement(tx), PAYLIFE_SETTLEMENT)
  })

  test('an issuer as the debit’s holder, whatever the wording', () => {
    assert.deepEqual(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000664|BKAUATWWXXX ${BANK_IBAN} card complete Service Bank AG|Monatsrechnung 10/2026`)),
      { issuer: 'card complete', where: 'im Kundenportal von card complete', statementDate: null, month: '10/2026' })
    assert.deepEqual(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000665|GIBAATWWXXX ${BANK_IBAN} DC Bank AG|Kartenkonto 4711`)),
      { issuer: 'Diners Club', where: 'im Kundenportal von Diners Club', statementDate: null, month: '10/2026' })
    assert.deepEqual(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000666|BKAUATWWXXX ${BANK_IBAN} American Express Europe S.A.|Lastschrift`)),
      { issuer: 'American Express', where: 'im Kundenportal von American Express', statementDate: null, month: '10/2026' })
  })

  test('an issuer named in the text with „Abrechnung“', () => {
    // the holder is the card's bank, not an issuer of the table
    assert.deepEqual(cardSettlement(bankRow(`DINERS CLUB ABRECHNUNG 10/2026               OG/000000667|GIBAATWWXXX ${BANK_IBAN} Beispielbank AG`, '-41,10', '05.11.2026')),
      { issuer: 'Diners Club', where: 'im Kundenportal von Diners Club', statementDate: null, month: '10/2026' })
    // „Abrechnung“ right before the issuer; PayLife's wording without its account (IMPORT-5)
    assert.deepEqual(cardSettlement(bankRow('Abrechnung Diners Club 10/2026 VD/000000703', '-41,10', '05.11.2026')),
      { issuer: 'Diners Club', where: 'im Kundenportal von Diners Club', statementDate: null, month: '10/2026' })
    assert.deepEqual(cardSettlement(bankRow('PAYLIFE ABRECHNUNG VOM 18.10.2026 VD/000000704')), PAYLIFE_SETTLEMENT)
  })

  test('the generic wordings: the debiting bank, the card network or „Kreditkarte“ as issuer', () => {
    const generic = (col1: string) => cardSettlement(bankRow(col1))
    assert.deepEqual(generic(`Abbuchung SEPA-Lastschrift                   OG/000000668|BKAUATWWXXX ${BANK_IBAN} Beispielbank AG|Kreditkartenabrechnung 10/2026`),
      { issuer: 'Beispielbank AG', where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' })
    assert.deepEqual(generic('KREDITKARTENABRECHNUNG 09/2026 VD/000000669'),
      { issuer: GENERIC_ISSUER, where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '09/2026' })
    for (const col1 of ['Kartenabrechnung VD/000000670', 'Kreditkarten-Abrechnung VD/000000671', 'Karten-Abrechnung VD/000000672',
      'Abrechnung Kreditkarte VD/000000673', 'Kreditkarte Abrechnung VD/000000674']) {
      assert.deepEqual(generic(col1), { issuer: GENERIC_ISSUER, where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' }, col1)
    }
    assert.equal(generic('MASTERCARD ABRECHNUNG 10/2026 VD/000000675')?.issuer, 'Mastercard')
    assert.equal(generic('Master Card Abrechnung VD/000000676')?.issuer, 'Mastercard')
    assert.deepEqual(generic('VISA Abrechnung VD/000000677'), { issuer: 'Visa', where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' })
    // the network right next to „Abrechnung“: a word or two apart, hyphenated, or after it
    assert.equal(generic('MASTERCARD GOLD ABRECHNUNG 10/2026 VD/000000705')?.issuer, 'Mastercard')
    assert.equal(generic('VISA-Abrechnung 10/2026 VD/000000706')?.issuer, 'Visa')
    assert.equal(generic('Abrechnung VISA Card 10/2026 VD/000000707')?.issuer, 'Visa')
    // „v. 18.10.2026“ is a statement date too
    assert.equal(generic('Kreditkartenabrechnung v. 18.10.2026 VD/000000678')?.statementDate, '2026-10-18')
  })

  test('a holder field that is the payment’s text is no bank name', () => {
    // nothing after the IBAN, and the purpose is the last line: findCounterpartyAccount
    // takes it as the holder
    assert.equal(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000679|BKAUATWWXXX ${BANK_IBAN}|Kreditkartenabrechnung 10/2026`))?.issuer, GENERIC_ISSUER)
  })

  test('a transfer paying the card’s balance to the issuer is one too', () => {
    assert.deepEqual(cardSettlement(bankRow(`Abbuchung Echtzeitüberweisung                FE/000000680|BAWAATWWXXX ${ISSUER_IBAN} PayLife|Ausgleich Kartenkonto`, '-512,40', '02.11.2026')),
      { issuer: 'PayLife', where: 'im PayLife Serviceportal', statementDate: null, month: '11/2026' })
  })

  test('never a card purchase or a card credit: there an issuer is a merchant', () => {
    assert.equal(cardSettlement(bankRow(CARD_PURCHASE, '-39,27', '03.06.2026')), null)
    assert.equal(cardSettlement(bankRow(AMEX_MERCHANT, '-120,00')), null)
    // the reason for that order: the merchant names an issuer
    assert.deepEqual(cardIssuerOf(bankRow(AMEX_MERCHANT, '-120,00')), { issuer: 'American Express', where: 'im Kundenportal von American Express', by: 'text' })
    assert.equal(cardSettlement(bankRow('Bezahlung Karte MC/000000641 Kreditkartenabrechnung', '-10,00')), null)
  })

  test('never a payment processor', () => {
    assert.equal(cardSettlement(bankRow('Bezahlung Karte                              MC/000000611|E-COMM        12,00 276 K002 01.10. 10:00|KLARNA*THOMANN', '-12,00')), null)
    assert.equal(cardSettlement(bankRow('PAYPAL *CARDSHOP Kreditkartenabrechnung      OG/000000681', '-12,00')), null)
    // PayPal's and Klarna's own SEPA debits
    assert.equal(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000682|DEUTDEFFXXX ${SHOP_IBAN} PayPal Europe S.a r.l. et Cie S.C.A|1040123456789 PP.1234.PP . INTERNETBS, Ihr Einkauf bei INTERNETBS`, '-39,27')), null)
    assert.equal(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000683|ESSESESSXXX ${SHOP_IBAN} Klarna Bank AB (publ)|Ihr Einkauf bei Thomann`, '-89,00')), null)
  })

  test('never the bank’s own fees', () => {
    for (const col1 of ['Kontoführung 10/2026 VD/000000684', 'Abschluss per 30.09.2026 VD/000000685', 'Entgeltabrechnung 3. Quartal 2026 VD/000000686',
      'Kartenentgelt Debitkarte 2026 VD/000000687', 'Kontoabschluss Kreditkarte Abrechnung VD/000000688']) {
      assert.equal(cardSettlement(bankRow(col1, '-6,90')), null, col1)
    }
  })

  test('never another „Abrechnung“, nor a card inside another compound (decisions L7)', () => {
    for (const col1 of [
      `Abbuchung SEPA-Lastschrift                   OG/000000689|BKAUATWWXXX ${SHOP_IBAN} Wien Energie GmbH|Jahresabrechnung 2026`,
      `Abbuchung SEPA-Lastschrift                   OG/000000690|BKAUATWWXXX ${SHOP_IBAN} Hausverwaltung Muster|Betriebskostenabrechnung 2025`,
      `Magenta Festnetz Rechnung 920191840126 vom 05.10.2026 - D|etails OG/000000691|BKAUATWWXXX ${SHOP_IBAN} Magenta Telekom`,
      'Tankkartenabrechnung 10/2026 VD/000000692',
      'Fahrkartenabrechnung 10/2026 VD/000000693',
      `Abbuchung SEPA-Lastschrift                   OG/000000694|BKAUATWWXXX ${SHOP_IBAN} Druckerei Muster|Visitenkarten-Abrechnung 10/2026`,
      'Visitenkarten Abrechnung VD/000000695',
      'Eintrittskartenabrechnung Konzert VD/000000696',
    ]) {
      assert.equal(cardSettlement(bankRow(col1, '-55,00')), null, col1)
    }
  })

  test('a statement’s compound beside the name counts as „Abrechnung“, read by the parser with a bank as holder: „PAYLIFE MONATSABRECHNUNG“, „PayLife Kreditkartenabrechnung“, „Kartenabrechnung PayLife“, „Mastercard Monatsabrechnung“', () => {
    const paylife = { issuer: 'PayLife', where: 'im PayLife Serviceportal', statementDate: null, month: '10/2026' }
    for (const text of ['PAYLIFE MONATSABRECHNUNG 10/2026            ', 'PayLife Kreditkartenabrechnung 10/2026      ', 'Kartenabrechnung PayLife 10/2026            ', 'PayLife Karten-Abrechnung 10/2026           ']) {
      assert.deepEqual(cardSettlement(bankRow(`${text} OG/000000801|GIBAATWWXXX ${BANK_IBAN} Beispielbank AG`, '-41,10')), paylife, text)
    }
    assert.deepEqual(cardSettlement(bankRow(`Mastercard Monatsabrechnung 10/2026          OG/000000811|GIBAATWWXXX ${BANK_IBAN} Beispielbank AG`, '-41,10')),
      { issuer: 'Mastercard', where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' })
    assert.equal(cardSettlement(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000812|GIBAATWWXXX ${BANK_IBAN} Beispielbank AG|DINERS CLUB MONATSABRECHNUNG 10/2026`, '-41,10'))?.issuer, 'Diners Club')
  })

  test('never a merchant’s debit whose purpose names a card issuer or network beside another „Abrechnung“ (IMPORT-5)', () => {
    for (const col1 of [
      `Hotel Muster Abrechnung Zimmer 12 bez. PayLife OG/000000708|BKAUATWWXXX ${SHOP_IBAN} Hotel Muster GmbH`,
      `Abbuchung SEPA-Lastschrift                   OG/000000709|BKAUATWWXXX ${SHOP_IBAN} Hotel Muster GmbH|Abrechnung Zimmer 12 bezahlt mit PayLife`,
      `Abbuchung SEPA-Lastschrift                   OG/000000710|BKAUATWWXXX ${SHOP_IBAN} OEBB Personenverkehr|Fahrkartenabrechnung bez. PayLife`,
      `Abbuchung SEPA-Lastschrift                   OG/000000711|BKAUATWWXXX ${SHOP_IBAN} Visumservice GmbH|Visa-Gebuehr Abrechnung 4711`,
      // another compound right beside the name is none either
      `Abbuchung SEPA-Lastschrift                   OG/000000712|BKAUATWWXXX ${SHOP_IBAN} OEBB Personenverkehr|Fahrkartenabrechnung PayLife 10/2026`,
      `Abbuchung SEPA-Lastschrift                   OG/000000713|BKAUATWWXXX ${SHOP_IBAN} Muster Hausverwaltung|VISA Betriebskostenabrechnung 2026`,
    ]) {
      const tx = bankRow(col1, '-180,00')
      assert.equal(tx.type, 'expense', col1)
      assert.equal(cardSettlement(tx), null, col1)
    }
  })

  test('never an own transfer or an account in the owner’s name, whatever the purpose says', () => {
    assert.equal(cardSettlement(bankRow(`Abbuchung Echtzeitüberweisung                FE/000000697|NTSBDEB1XXX ${PRIVATE} ${OWNER_NAME}|Ausgleich Kreditkartenabrechnung`, '-300,00')), null)
    assert.equal(cardSettlement(bankRow(`Abbuchung Echtzeitüberweisung                FE/000000698|NTSBDEB1XXX ${PRIVATE} ${OWNER_NAME} e.U.|Kreditkartenabrechnung 10/2026`, '-300,00')), null)
    assert.equal(cardSettlement(bankRow(`Abbuchung Echtzeitüberweisung                FE/000000699|NTSBDEB1XXX ${PRIVATE} ${OWNER_NAME}|PayLife Ausgleich`, '-300,00')), null)
  })

  test('only debits', () => {
    assert.equal(cardSettlement(bankRow(PAYLIFE, '28,30')), null)
  })

  test('a draft’s row without CSV columns is read from the reference; garbage never throws', () => {
    assert.deepEqual(cardSettlement({ type: 'expense', date: '2026-10-20', counterparty: '', reference: PAYLIFE }), PAYLIFE_SETTLEMENT)
    for (const g of [null, undefined, {}, { type: 'expense' }, { type: 'expense', raw: { col1: 42 } }, { type: 'expense', raw: null, reference: null },
      { type: 'expense', reference: '|||' }, { type: 'expense', counterparty: 7, reference: 'Kreditkartenabrechnung', date: 5 },
      { type: 'expense', reference: 'AT'.repeat(5000) + '|' + '|'.repeat(500) + 'Kreditkartenabrechnung' }]) {
      assert.doesNotThrow(() => cardSettlement(g as never))
    }
    assert.equal(cardSettlement(null), null)
    assert.equal(cardSettlement({ type: 'expense', reference: '|||' }), null)
    // no bank date either: no month
    assert.equal(cardSettlement({ type: 'expense', reference: 'Kreditkartenabrechnung' })?.month, '')
  })

  test('an impossible date („VOM 31.02.2026“) is no Rechnungsdatum; the month falls back to the bank date', () => {
    assert.deepEqual(cardSettlement(bankRow(`PAYLIFE ABRECHNUNG VOM 31.02.2026            OG/000000660|BAWAATWWXXX ${ISSUER_IBAN} PayLife`, '-28,30', '03.03.2026')),
      { issuer: 'PayLife', where: 'im PayLife Serviceportal', statementDate: null, month: '03/2026' })
  })
})

describe('cardIssuerOf and issuerCreditReason — the issuers, shared with the refunds of credits', () => {
  test('by holder before text', () => {
    assert.deepEqual(cardIssuerOf(bankRow(`Abbuchung SEPA-Lastschrift                   OG/000000700|BAWAATWWXXX ${ISSUER_IBAN} PayLife|Amex Umstellung`)),
      { issuer: 'PayLife', where: 'im PayLife Serviceportal', by: 'holder' })
    assert.equal(cardIssuerOf(null), null)
    assert.equal(cardIssuerOf({ reference: 'Büromaterial Muster' }), null)
    // no pattern keeps state between calls
    assert.ok(CARD_ISSUERS.every(i => !i.pattern.global && !i.pattern.sticky))
  })
  test('the issuer as the payer of a credit: a refund of the settlement, and refundNote says to book it in bookamat', () => {
    const reason = issuerCreditReason(bankRow(`Gutschrift Echtzeitüberweisung               FE/000000701|BAWAATWWXXX ${ISSUER_IBAN} PayLife|Guthaben Kartenkonto`, '12,90'))
    assert.equal(reason, 'Guthaben aus der Kreditkartenabrechnung PayLife')
    assert.equal(refundNote(reason!), '⚠ Erstattung — in bookamat als Aufwandsminderung buchen (Guthaben aus der Kreditkartenabrechnung PayLife)')
  })
  test('an issuer only named in a client’s text is no refund', () => {
    const tx = bankRow(`Gutschrift Echtzeitüberweisung               FE/000000702|BKAUATWWXXX ${SHOP_IBAN} Muster GmbH|Workshop bezahlt per Amex`, '450,00')
    assert.equal(cardIssuerOf(tx)?.by, 'text')
    assert.equal(issuerCreditReason(tx), null)
    assert.equal(issuerCreditReason(null), null)
  })
})

// The year's lists, with ids that are not 2026's: found by name
const VST_INLAND = { id: 7002, name: 'Vorsteuer Inland', group: '2' }
const IG_LEISTUNGEN = { id: 7003, name: 'IG Erwerb von Leistungen', group: '2' }
const KEINE_VST = { id: 7001, name: 'Keine Vorsteuer', group: '2' }
const KEINE_UST = { id: 7101, name: 'Keine Umsatzsteuer', group: '1' }
const UST_INLAND = { id: 7102, name: 'Umsatzsteuer Inland', group: '1' }
const FEE_ACCOUNT: BookamatAccount = { id: 39194, name: 'Geschäftskonto & Geldverkehr', purchasetaxaccounts: [VST_INLAND, IG_LEISTUNGEN, KEINE_VST] }
const BANKS = [{ id: 5001, name: 'Geschäftskonto - Musterbank' }, { id: 5002, name: 'Geschäftskonto - Easybank' }]
const lists = (cost: BookamatAccount[] = [{ id: 39209, name: 'Internet', purchasetaxaccounts: [VST_INLAND] }, FEE_ACCOUNT],
  pt: BookamatAccount[] = [VST_INLAND, IG_LEISTUNGEN, KEINE_VST, UST_INLAND, KEINE_UST]): BookamatAccounts =>
  ({ cost_accounts: cost, purchasetax_accounts: pt, bank_accounts: BANKS })

const R1_PAYLIFE = 'Kreditkartenabrechnung PayLife vom 18.10.2026. Die Abrechnung liegt im PayLife Serviceportal, nicht im Postfach: dort herunterladen und hier als Beleg anhängen. Nur das Kartenentgelt: so buchen — „Geschäftskonto & Geldverkehr“, „Keine Vorsteuer“, 0 % (Kartenentgelte sind umsatzsteuerfrei). Mit Käufen: in den Details „+ Zeile hinzufügen“ und je Kauf eine Zeile mit Betrag, Steuerkonto, Vorsteuerkonto und USt laut Händlerrechnung; das Entgelt bleibt in der ersten Zeile, die Händlerrechnungen danach in bookamat zur Buchung hochladen. Das Buchungsdatum bleibt der Tag dieser Abbuchung, auch für die Käufe — nicht das Kaufdatum. Ein Kauf, der schon über Belege gebucht ist, nicht noch einmal: dann die Abrechnung ohne ihn von Hand in bookamat buchen und hier nicht ankreuzen.'

describe('cardSettlementSuggestion — the fixed rule’s proposal', () => {
  test('„Geschäftskonto & Geldverkehr“ by name, „Keine Vorsteuer“ linked, 0 %, BA 100 %, the CSV’s bank, unsure, Beleg required, source „rule“', () => {
    const expected: AiSuggestion = {
      cost_account_id: 39194,
      purchasetax_account_id: 7001,
      bank_account_id: 5002,
      tax_percent: 0,
      deductibility_amount_percent: 100,
      deductible_share: 1,
      country: '',
      supplier_region: 'AT',
      vatin: '',
      title: 'Kreditkartenabrechnung PayLife 10/2026',
      category: 'Kartenabrechnung',
      reasoning: R1_PAYLIFE,
      requires_invoice: true,
      certainty: 'niedrig',
      source: 'rule',
    }
    assert.deepEqual(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists(), 5002), expected)
    assert.equal(CARD_FEE_ACCOUNT, 'Geschäftskonto & Geldverkehr')
    // the name as the owner reads it: any case, any spaces
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([{ ...FEE_ACCOUNT, id: 1, name: ' geschäftskonto  &  GELDVERKEHR ' }]), 5002)?.cost_account_id, 1)
  })

  test('title „Kreditkartenabrechnung PayLife 10/2026“, at most 50 characters; generic „Kreditkartenabrechnung 10/2026“', () => {
    assert.equal(cardSettlementTitle(PAYLIFE_SETTLEMENT), 'Kreditkartenabrechnung PayLife 10/2026')
    assert.equal(cardSettlementTitle({ issuer: GENERIC_ISSUER, where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' }), 'Kreditkartenabrechnung 10/2026')
    assert.equal(cardSettlementTitle({ issuer: 'Mastercard', where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' }), 'Kreditkartenabrechnung Mastercard 10/2026')
    // a long bank name is cut, the month kept
    const long = cardSettlementTitle({ issuer: 'Erste Bank der oesterreichischen Sparkassen AG', where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' })
    assert.ok(long.length <= 50, long)
    assert.match(long, /^Kreditkartenabrechnung Erste Bank .* 10\/2026$/)
    assert.equal(cardSettlementTitle({ ...PAYLIFE_SETTLEMENT, month: '' }), 'Kreditkartenabrechnung PayLife')
  })

  test('the reasoning says where the statement is, what to do with only the fee, how to split purchases, and their date', () => {
    assert.equal(cardSettlementReasoning(PAYLIFE_SETTLEMENT), R1_PAYLIFE)
    const generic = cardSettlementReasoning({ issuer: GENERIC_ISSUER, where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' })
    assert.match(generic, /^Kreditkartenabrechnung\. Die Abrechnung liegt im Kundenportal der Bank oder des Kartenherausgebers, nicht im Postfach/)
    assert.match(generic, /„\+ Zeile hinzufügen“/)
    assert.match(generic, /Das Buchungsdatum bleibt der Tag dieser Abbuchung, auch für die Käufe/)
  })

  test('„Keine Vorsteuer“ from the purchase side of the list when the account links none; never a sales-side one', () => {
    const unlinked = { id: 39194, name: 'Geschäftskonto & Geldverkehr' }
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([unlinked]), 5002)?.purchasetax_account_id, 7001)
    // bookamat's group decides the side: a „Keine Vorsteuer“ on the sales side is none
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([unlinked], [VST_INLAND, { ...KEINE_VST, group: '1' }]), 5002), null)
    // linked accounts without „Keine Vorsteuer“: none that bookamat would take with it
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([{ ...FEE_ACCOUNT, purchasetaxaccounts: [VST_INLAND] }]), 5002), null)
  })

  test('a missing account: no suggestion; without the exact name, only a single „…Geldverkehr…“ account counts', () => {
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([{ id: 39209, name: 'Internet' }]), 5002), null)
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([{ id: 39194, name: 'Geschäftskonto & Geldverkehr' }], [VST_INLAND, UST_INLAND]), 5002), null)
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, null, 5002), null)
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([{ id: 41, name: 'Bank- und Geldverkehrsspesen', purchasetaxaccounts: [KEINE_VST] }]), 5002)?.cost_account_id, 41)
    assert.equal(cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists([
      { id: 41, name: 'Bank- und Geldverkehrsspesen', purchasetaxaccounts: [KEINE_VST] },
      { id: 42, name: 'Geldverkehr sonstiges', purchasetaxaccounts: [KEINE_VST] },
    ]), 5002), null)
  })
})

describe('cardSettlementExpenseRow — the row Analyse sends', () => {
  const tx = bankRow(PAYLIFE)
  const N1 = '⚠ Kreditkartenabrechnung — Abrechnung im PayLife Serviceportal herunterladen und als Beleg anhängen; Käufe darauf je Kauf als eigene Zeile buchen'

  test('with the lists: „Beleg fehlt“, the fixed rule’s suggestion, N1 first then N2, no receipt fields, Rechnungsdatum from the text', () => {
    const row = cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists())
    const expected: MatchedTransaction = {
      transaction: tx,
      vendor: null,
      confidence: 0,
      gmail_message_id: null,
      gmail_subject: null,
      gmail_date: null,
      pdf_attachment_name: null,
      pdf_base64: null,
      extracted_invoice_date: '2026-10-18',
      extracted_invoice_number: null,
      extracted_amount: null,
      title: 'Kreditkartenabrechnung PayLife 10/2026',
      status: 'missing_invoice',
      match_note: `${N1} · Feste Regel: Kreditkartenabrechnung PayLife`,
      ai_suggested: cardSettlementSuggestion(PAYLIFE_SETTLEMENT, lists(), 5002)!,
    }
    assert.deepEqual(row, expected)
    // on the CSV's own bank, Easybank, not the first of the list
    assert.equal(row.ai_suggested?.bank_account_id, 5002)
  })

  test('a matching Buchungsregel is named (N5) and not applied', () => {
    const row = cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists(), 'PayLife Gebühr')
    assert.equal(row.vendor, null)
    assert.equal(row.match_note,
      `${N1} · Feste Regel: Kreditkartenabrechnung PayLife · Buchungsregel „PayLife Gebühr“ gilt nicht für Kreditkartenabrechnungen — was gebucht wird, steht auf der Abrechnung`)
    assert.equal(cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists(), '  ').match_note, `${N1} · Feste Regel: Kreditkartenabrechnung PayLife`)
  })

  test('without the lists (N3) or without the accounts (N4): no suggestion, still „Beleg fehlt“', () => {
    const noLists = cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, undefined)
    assert.equal(noLists.ai_suggested, undefined)
    assert.equal(noLists.status, 'missing_invoice')
    assert.equal(noLists.title, 'Kreditkartenabrechnung PayLife 10/2026')
    assert.equal(noLists.extracted_invoice_date, '2026-10-18')
    assert.equal(noLists.match_note,
      '⚠ Kreditkartenabrechnung PayLife — Konten von bookamat nicht ladbar: „Geschäftskonto & Geldverkehr“, „Keine Vorsteuer“, 0 % selbst wählen oder neu analysieren; Abrechnung im PayLife Serviceportal herunterladen und als Beleg anhängen')
    const noAccounts = cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists([{ id: 39209, name: 'Internet' }]), 'PayLife Gebühr')
    assert.equal(noAccounts.ai_suggested, undefined)
    assert.equal(noAccounts.status, 'missing_invoice')
    assert.equal(noAccounts.match_note,
      '⚠ Kreditkartenabrechnung PayLife — „Geschäftskonto & Geldverkehr“ oder „Keine Vorsteuer“ fehlt in bookamat: Konten selbst wählen; Abrechnung im PayLife Serviceportal herunterladen und als Beleg anhängen · Buchungsregel „PayLife Gebühr“ gilt nicht für Kreditkartenabrechnungen — was gebucht wird, steht auf der Abrechnung')
  })

  test('a settlement without a named issuer says none', () => {
    const generic: CardSettlement = { issuer: GENERIC_ISSUER, where: GENERIC_STATEMENT_WHERE, statementDate: null, month: '10/2026' }
    assert.equal(cardSettlementExpenseRow(tx, generic, lists()).match_note,
      '⚠ Kreditkartenabrechnung — Abrechnung im Kundenportal der Bank oder des Kartenherausgebers herunterladen und als Beleg anhängen; Käufe darauf je Kauf als eigene Zeile buchen · Feste Regel: Kreditkartenabrechnung')
    assert.equal(cardSettlementExpenseRow(tx, generic, undefined).match_note,
      '⚠ Kreditkartenabrechnung — Konten von bookamat nicht ladbar: „Geschäftskonto & Geldverkehr“, „Keine Vorsteuer“, 0 % selbst wählen oder neu analysieren; Abrechnung im Kundenportal der Bank oder des Kartenherausgebers herunterladen und als Beleg anhängen')
  })

  test('the page’s box for a row without suggestion, and the re-classification’s refusal', () => {
    assert.equal(cardSettlementBoxText(PAYLIFE_SETTLEMENT),
      'Kreditkartenabrechnung PayLife — Konten oben selbst wählen („Geschäftskonto & Geldverkehr“, „Keine Vorsteuer“, 0 %); Käufe auf der Abrechnung je Kauf als eigene Zeile buchen, mit dem Buchungsdatum dieser Abbuchung. Eine Buchungsregel gilt hier nicht.')
    assert.equal(CARD_SETTLEMENT_NO_AI, 'Kreditkartenabrechnung — feste Regel, keine KI-Neubewertung')
  })
})

// A row as an older page saved it: an AI suggestion, a Buchungsregel's, or none
const aiGuess = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  cost_account_id: 39233, purchasetax_account_id: 7001, bank_account_id: 5002, tax_percent: 0,
  deductibility_amount_percent: 100, country: '', vatin: '', title: 'Privatentnahme', category: 'Privatentnahme',
  reasoning: 'IBAN im Text — Privatentnahme', requires_invoice: false, certainty: 'hoch', ...over,
})
const RULE_VENDOR = { id: 'v1', name: 'PayLife Gebühr' } as Vendor
const oldRow = (transaction: EasybankTransaction, over: Partial<MatchedTransaction> = {}): MatchedTransaction => ({
  transaction, vendor: null, confidence: 0,
  gmail_message_id: 'gm-1', gmail_subject: 'PayLife Preisblatt', gmail_date: '2026-10-15', pdf_attachment_name: 'preisblatt.pdf', pdf_base64: null,
  extracted_invoice_date: null, extracted_invoice_number: null, extracted_amount: null,
  title: 'Privatentnahme', status: 'needs_review', match_note: 'Gmail: PAYLIFE ABRECHNUNG', ai_suggested: aiGuess(), ...over,
})

describe('isStaleCardSettlementRow — what the booking route refuses from a tab open since before the update', () => {
  const tx = bankRow(PAYLIFE)
  test('an AI suggestion (source „ai“ or none) or a Buchungsregel’s row on a settlement: refused', () => {
    assert.equal(isStaleCardSettlementRow(oldRow(tx)), true)
    assert.equal(isStaleCardSettlementRow(oldRow(tx, { ai_suggested: aiGuess({ source: 'ai' }) })), true)
    assert.equal(isStaleCardSettlementRow(oldRow(tx, { vendor: RULE_VENDOR, ai_suggested: undefined })), true)
    assert.equal(STALE_CARD_SETTLEMENT_TEXT, 'Kreditkartenabrechnung vor dem Update analysiert — Entwurf speichern, Seite neu laden, Abrechnung als Beleg anhängen, Zeile prüfen, dann buchen')
  })
  test('the fixed rule’s row, a row without suggestion, any row that is no settlement: not', () => {
    assert.equal(isStaleCardSettlementRow(cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists())), false)
    assert.equal(isStaleCardSettlementRow(cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, undefined)), false)
    assert.equal(isStaleCardSettlementRow(oldRow(bankRow(CARD_PURCHASE, '-39,27'))), false)
    assert.equal(isStaleCardSettlementRow(null), false)
  })
})

describe('cardSettlementDraftRows — a draft from before this update', () => {
  const tx = bankRow(PAYLIFE)
  const other = oldRow(bankRow(CARD_PURCHASE, '-39,27', '03.06.2026'), { title: 'Internet.bs Domain' })

  test('an AI settlement row becomes the fixed rule’s row and is in changed; its keyword-search Gmail receipt is dropped', () => {
    const { rows, changed } = cardSettlementDraftRows([other, oldRow(tx)], lists())
    assert.deepEqual(changed, [1])
    assert.equal(rows[0], other)
    assert.deepEqual(rows[1], cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists()))
    assert.equal(rows[1].gmail_message_id, null)
    assert.equal(rows[1].pdf_attachment_name, null)
  })

  test('a Buchungsregel’s row is converted too, naming the rule', () => {
    const { rows, changed } = cardSettlementDraftRows([oldRow(tx, { vendor: RULE_VENDOR, ai_suggested: undefined, status: 'ready', confidence: 0.9 })], lists())
    assert.deepEqual(changed, [0])
    assert.equal(rows[0].vendor, null)
    assert.equal(rows[0].confidence, 0)
    assert.equal(rows[0].ai_suggested?.source, 'rule')
    assert.match(rows[0].match_note ?? '', /Buchungsregel „PayLife Gebühr“ gilt nicht für Kreditkartenabrechnungen/)
  })

  test('a row held as booked keeps status „duplicate“, its title and its match; own_status is the rule’s; not in changed', () => {
    const duplicate_of = { id: 191001, title: 'PayLife Kartenentgelt', date: '2026-10-20', total: 28.3, certain: true }
    const held = oldRow(tx, { status: 'duplicate', own_status: 'needs_review', duplicate_of, title: 'PayLife Kartenentgelt' })
    const { rows, changed } = cardSettlementDraftRows([held], lists())
    assert.deepEqual(changed, [])
    assert.equal(rows[0].status, 'duplicate')
    assert.equal(rows[0].own_status, 'missing_invoice')
    assert.equal(rows[0].title, 'PayLife Kartenentgelt')
    assert.deepEqual(rows[0].duplicate_of, duplicate_of)
    assert.equal(rows[0].ai_suggested?.source, 'rule')
  })

  test('the duplicate check’s answer stays on a converted row', () => {
    const possible = { id: 191002, title: 'Kartenentgelt', date: '2026-10-21', total: 28.3, certain: false }
    const { rows, changed } = cardSettlementDraftRows([oldRow(tx, { duplicate_of: possible }), oldRow(tx, { duplicate_check_failed: 'bookamat nicht erreichbar' })], lists())
    assert.deepEqual(changed, [0, 1])
    assert.deepEqual(rows[0].duplicate_of, possible)
    assert.equal(rows[0].status, 'missing_invoice')
    assert.equal(rows[1].duplicate_check_failed, 'bookamat nicht erreichbar')
  })

  test('a fixed rule’s row and every other row stay as they are; converting twice changes nothing', () => {
    const fixed = cardSettlementExpenseRow(tx, PAYLIFE_SETTLEMENT, lists())
    const once = cardSettlementDraftRows([fixed, other, oldRow(tx)], lists())
    assert.equal(once.rows[0], fixed)
    assert.equal(once.rows[1], other)
    assert.deepEqual(once.changed, [2])
    const twice = cardSettlementDraftRows(once.rows, lists())
    assert.deepEqual(twice.rows, once.rows)
    assert.deepEqual(twice.changed, [])
  })

  test('without the lists: an old AI row loses its suggestion (N3) and is in changed; a row without suggestion stays; with the lists it gains the rule’s', () => {
    const { rows, changed } = cardSettlementDraftRows([oldRow(tx)], null)
    assert.deepEqual(changed, [0])
    assert.equal(rows[0].ai_suggested, undefined)
    assert.match(rows[0].match_note ?? '', /^⚠ Kreditkartenabrechnung PayLife — Konten von bookamat nicht ladbar/)
    const again = cardSettlementDraftRows(rows, null)
    assert.equal(again.rows[0], rows[0])
    assert.deepEqual(again.changed, [])
    const withLists = cardSettlementDraftRows(rows, lists())
    assert.deepEqual(withLists.changed, [0])
    assert.equal(withLists.rows[0].ai_suggested?.cost_account_id, 39194)
    // the lists without the accounts give none: as it is
    const bare = cardSettlementDraftRows(rows, lists([{ id: 39209, name: 'Internet' }]))
    assert.equal(bare.rows[0], rows[0])
    assert.deepEqual(bare.changed, [])
  })

  test('the notice: one or several, and whether they were unticked (IMPORT-2)', () => {
    assert.equal(cardSettlementDraftNotice(1, true), 'Eine Kreditkartenabrechnung aus dem älteren Entwurf folgt jetzt der festen Regel und ist nicht mehr angekreuzt — die Abrechnung als Beleg anhängen und prüfen.')
    assert.equal(cardSettlementDraftNotice(1, false), 'Eine Kreditkartenabrechnung aus dem älteren Entwurf folgt jetzt der festen Regel — die Abrechnung als Beleg anhängen und prüfen.')
    assert.equal(cardSettlementDraftNotice(2, true), '2 Kreditkartenabrechnungen aus dem älteren Entwurf folgen jetzt der festen Regel und sind nicht mehr angekreuzt — die Abrechnungen als Beleg anhängen und prüfen.')
    assert.equal(cardSettlementDraftNotice(2, false), '2 Kreditkartenabrechnungen aus dem älteren Entwurf folgen jetzt der festen Regel — die Abrechnungen als Beleg anhängen und prüfen.')
  })
})

describe('client-safe', () => {
  const importsOf = (file: string) => {
    const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    return { src, imports: Array.from(src.matchAll(/(?:\bfrom|\bimport|\brequire\()\s*['"]([^'"]+)['"]/g)).map(m => m[1]) }
  }
  test('lib/card-issuers.ts imports only lib/own-transfer.ts and reads no env variable', () => {
    const { src, imports } = importsOf('card-issuers.ts')
    assert.deepEqual(imports, ['./own-transfer'])
    assert.doesNotMatch(src, /process\.env/)
  })
  test('lib/card-settlement.ts imports only pure modules and reads no env variable', () => {
    const { src, imports } = importsOf('card-settlement.ts')
    assert.deepEqual(imports, ['@/lib/expenses/types', './card-issuers', './refunds', './own-transfer', './rule-accounts', './tax-accounts', './bank-account', './booking-dates'])
    assert.doesNotMatch(src, /process\.env/)
  })
})
