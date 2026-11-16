// easybank's headerless CSV, read the way Bookmatic reads it (lib/csv-parser.ts,
// lib/booking-dates.ts). Made-up IBANs, BICs, names and numbers only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeStatement, isEasybank, parseEasybank, parseStatement } from '@/lib/bank/parse'

const IBAN = 'AT001234567890123456'
const line = (text: string, posted: string, valuta: string, amount: string, currency = 'EUR') => [IBAN, text, posted, valuta, amount, currency].join(';')
const noXml = { xmlParser: () => { throw new Error('not XML') } }

const credit = line('Gutschrift Überweisung|TESTATWWXXX AT991234567890123456 Max Muster|RN-209906001', '15.06.2026', '15.06.2026', '840,00')
const debit = line('Bezahlung Karte MC/000000901|POS 4711 D002 12.06. 09:15|SPESEN: 1,50|Musterladen', '15.06.2026', '15.06.2026', '-101,50')

test('an easybank file has no header: its first line is a transaction', () => {
  const text = [credit, debit].join('\n')
  assert.equal(isEasybank(text), true)
  const parsed = parseStatement(text, noXml)
  assert.equal(parsed.format, 'easybank')
  assert.deepEqual(parsed.transactions.map(t => [t.date, t.amount, t.currency]), [['2026-06-15', 840, 'EUR'], ['2026-06-15', -101.5, 'EUR']])
  assert.deepEqual(parsed.warnings, [])
  // Nothing to map by hand.
  assert.equal(parsed.csv, undefined)
})

test('a header line, should one appear, is skipped; other CSVs are not easybank', () => {
  const withHeader = ['IBAN;Buchungstext;Buchungsdatum;Valutadatum;Betrag;Währung', credit].join('\n')
  assert.equal(isEasybank(withHeader), true)
  assert.deepEqual(parseEasybank(withHeader).transactions.map(t => t.amount), [840])
  assert.equal(isEasybank('Datum;Text;Betrag\n15.06.2026;Gutschrift;840,00'), false)
  assert.equal(isEasybank('Buchungsdatum,Betrag,Text\n2026-06-15,840.00,Gutschrift'), false)
})

test('the payer of a credit is the name after its BIC and IBAN', () => {
  const [tx] = parseEasybank(credit).transactions
  assert.equal(tx.counterparty, 'Max Muster')
  assert.equal(tx.text, 'Gutschrift Überweisung TESTATWWXXX AT991234567890123456 Max Muster RN-209906001')
  // Also when a purpose line follows it.
  const foreign = line('Gutschrift Auslandsüberweisung|TESTUS33XXX US12345678901234 Sample Radio Inc|INVOICE PAYMENT', '04.08.2026', '04.08.2026', '258,00')
  assert.equal(parseEasybank(foreign).transactions[0].counterparty, 'Sample Radio Inc')
  // A debit names its last line that names someone.
  assert.equal(parseEasybank(debit).transactions[0].counterparty, 'Musterladen')
})

test('a number broken across easybank\'s lines is whole in the search text', () => {
  const broken = line('Gutschrift Überweisung|TESTATWWXXX AT991234567890123456 Max Muster|Zahlung zu Rechnung RN-2099|06001 vielen Dank', '15.06.2026', '15.06.2026', '840,00')
  const [tx] = parseEasybank(broken).transactions
  assert.match(tx.search ?? '', /RN-209906001/)
  assert.match(tx.text, /RN-2099 06001/)
})

test('SPESEN are read and shown with the line', () => {
  const [tx] = parseEasybank(debit).transactions
  assert.equal(tx.fee, 1.5)
  assert.equal(parseEasybank(credit).transactions[0].fee, undefined)
})

test('a credit paid at the end of a month and posted in the next one keeps its day of payment', () => {
  const newYear = line('Gutschrift Echtzeitüberweisung|TESTATWWXXX AT991234567890123456 Max Muster|RN-209912003', '02.01.2027', '31.12.2026', '500,00')
  assert.equal(parseEasybank(newYear).transactions[0].date, '2026-12-31')
  // Within one month the Buchungsdatum stays: the same UVA period.
  const sameMonth = line('Gutschrift|TESTATWWXXX AT991234567890123456 Max Muster|RN-209906002', '15.06.2026', '13.06.2026', '100,00')
  assert.equal(parseEasybank(sameMonth).transactions[0].date, '2026-06-15')
  // More than seven days back is not the day of payment; a card credit keeps the bank's day.
  const old = line('Gutschrift|TESTATWWXXX AT991234567890123456 Max Muster|RN-209906003', '02.07.2026', '20.06.2026', '100,00')
  assert.equal(parseEasybank(old).transactions[0].date, '2026-07-02')
  const card = line('Gutschrift Karte MC/000000902|Musterladen Rückerstattung', '01.07.2026', '30.06.2026', '20,00')
  assert.equal(parseEasybank(card).transactions[0].date, '2026-07-01')
})

test('every line not read is named with its number and why', () => {
  const text = [
    credit,
    `${IBAN};kaputt;15.06.2026`,
    line('Gutschrift|TESTATWWXXX AT991234567890123456 Max Muster', '31.06.2026', '30.06.2026', '10,00'),
    line('Gutschrift|TESTATWWXXX AT991234567890123456 Max Muster', '15.06.2026', '15.06.2026', '0,00'),
    '',
    debit,
  ].join('\n')
  const parsed = parseEasybank(text)
  assert.deepEqual(parsed.warnings, ['fewCells:2', 'noDate:3', 'noAmount:4'])
  assert.equal(parsed.transactions.length, 2)
})

test('the same line twice is two transactions with their own ids, stable across imports', () => {
  const a = parseEasybank([credit, credit].join('\n')).transactions
  assert.equal(a.length, 2)
  assert.notEqual(a[0].id, a[1].id)
  assert.deepEqual(parseEasybank([credit, credit].join('\r\n')).transactions.map(t => t.id), a.map(t => t.id))
})

test('a windows-1252 export keeps its umlauts', () => {
  const text = line('Gutschrift|TESTATWWXXX AT991234567890123456 Jürgen Müller|RN-209906004', '15.06.2026', '15.06.2026', '1.234,56')
  const bytes = Uint8Array.from(Buffer.from(text, 'latin1'))
  const decoded = decodeStatement(bytes.buffer)
  const [tx] = parseEasybank(decoded).transactions
  assert.equal(tx.counterparty, 'Jürgen Müller')
  assert.equal(tx.amount, 1234.56)
})
