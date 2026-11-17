import './owner'
// A PDF's text as a line's search reads it (PR 9b, lib/expenses/gmail-receipt.ts pdfTextOf): unpdf
// instead of Bookmatic's pdf-parse. PDF.js gives a no-break space between thousands as a plain
// one; the amounts must read as pdf-parse's text read them („1 234,56“ is one amount), or a
// second receipt of the debit's amount is never read (review finding, PR 9b). Made-up PDFs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { keepThousands, pdfTextOf } from '../gmail-receipt'
import { amountsInText } from '../money'
import { debitInText, numberOnDocument } from '../receipt-match'
import type { EasybankTransaction } from '@/lib/expenses/types'

async function pdfWith(...lines: string[]): Promise<string> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 220])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  lines.forEach((text, k) => page.drawText(text, { x: 20, y: 180 - 24 * k, size: 12, font }))
  return Buffer.from(await doc.save()).toString('base64')
}
const debit = (amount: number): EasybankTransaction =>
  ({ date: '2026-07-16', counterparty: 'MUSTER GMBH', reference: 'Muster GmbH', amount, type: 'expense', currency: 'EUR', raw: {} })

describe('pdfTextOf — a PDF’s text and pages', () => {
  test('a total with a no-break space between thousands reads as one amount, as pdf-parse’s text did', async () => {
    const t = await pdfTextOf(await pdfWith('Gesamtbetrag 1 234,56 EUR', 'Menge 2 Stueck'))
    assert.equal(t.pages, 1)
    assert.ok(amountsInText(t.text).includes(1234.56), t.text)
    assert.equal(debitInText(t.text, debit(1234.56)), true)
  })
  test('keepThousands: in an amount with cents the spaces between its groups are no-break spaces again; other digits stay as read', () => {
    assert.deepEqual(amountsInText(keepThousands('1 234 567,89')), [1234567.89])
    assert.equal(keepThousands('Total 1 234.56 USD'), 'Total 1\u00a0234.56 USD')
    assert.equal(keepThousands('Menge 2 Stueck, 12 Monate'), 'Menge 2 Stueck, 12 Monate')
    assert.equal(keepThousands('Rechnung 2026 0001234'), 'Rechnung 2026 0001234')
  })
  test('a quantity before a price („Menge 2 450,00“): the debit is in the text read either way, so no read Bookmatic would make is skipped', () => {
    const text = keepThousands('Menge 2 450,00 EUR')
    assert.equal(debitInText(text, debit(450)), true)
    assert.equal(debitInText(text, debit(2450)), true)
    assert.equal(debitInText(text, debit(45)), false)
  })
  test('keepThousands: an invoice number printed in groups of three stays one the bank’s number is found in (verifier finding, PR 9b)', () => {
    const text = keepThousands('Rechnungsnr. 2026 001 234 · Gesamt 1 234,56 €')
    assert.equal(text, 'Rechnungsnr. 2026 001 234 · Gesamt 1\u00a0234,56 €')
    assert.equal(numberOnDocument('2026001234', text), true)
    assert.deepEqual(amountsInText(text), [1234.56])
  })
})
