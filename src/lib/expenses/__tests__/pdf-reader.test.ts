import './owner'
// The PDF reader of PR 9b (Claude Opus 5.5, decision D3a) without an API call: the prompt as sent,
// the request (structured outputs, low effort, the server-side refusal fallback), and what the
// search gets back — the fields as Bookmatic's pdfInvoiceFields read them, or „nicht lesbar“.
// Ported from Bookmatic's lib/__tests__/ai-extractor.test.ts (475072f, the PDF reader's part).
// Synthetic answers only.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import {
  DOCUMENT_TYPES, FALLBACK_BETA, PDF_READER_MAX_TOKENS, PDF_READER_MODEL, ReceiptUnreadableError, pdfInvoiceFields, pdfInvoicePrompt,
  pdfReaderConfigured, readPdfInvoice, readerRequest, type PdfReaderMessages, type ReaderAnswer,
} from '../pdf-reader'
import { TEST_OWNER } from './owner'

describe('pdfInvoicePrompt — what the reader asks of a PDF found in Gmail', () => {
  const p = pdfInvoicePrompt()
  test('the seller’s UID: exactly as printed, its Austrian one when it prints several, never the buyer’s, null if none', () => {
    assert.ok(p.includes(`"vatin": the SELLER's VAT ID exactly as printed (e.g. ATU12345678, DE123456789); if the seller prints several, its Austrian one (ATU…); never the buyer's; null if none`))
  })
  test('names the owner’s own UID (from Einstellungen) and says it is never the seller’s; without one it names none', () => {
    assert.ok(p.includes(`The buyer's own VAT ID ${TEST_OWNER.vatin} is printed on many invoices (next to "Rechnung an", "Kunde", "Leistungsempfänger", "Ihre UID"): it is never the seller's "vatin".`))
    assert.ok(pdfInvoicePrompt('ATU00000000').includes('The buyer\'s own VAT ID ATU00000000'))
    assert.doesNotMatch(pdfInvoicePrompt(''), /buyer's own VAT ID/)
  })
  test('every field the schema holds, with what it means', () => {
    for (const field of ['"date": the invoice date as YYYY-MM-DD, or null', '"invoice_number": the invoice number, digits only, no RN-/RE-/KV- prefix, or null',
      '"amount": the total gross amount as a number, or null', '"currency": the ISO 4217 code of that total, e.g. EUR, USD, GBP, or null if not shown',
      '"amount_due": the amount charged or still to pay as printed (Zahlbetrag, Amount paid, Amount due) as a number when it differs from the gross total, else null']) {
      assert.ok(p.includes(field), field)
    }
  })
  test('what the document itself is: every type, with the words that name it; an invoice that mentions a credit stays one', () => {
    const line = p.split('\n').find(l => l.trimStart().startsWith('"document_type":')) ?? ''
    for (const type of DOCUMENT_TYPES) assert.ok(line.includes(`"${type}"`), type)
    for (const word of ['Rechnung', 'Quittung', 'Gutschrift', 'Storno', 'credit note', 'refund', 'Bestellbestätigung', 'Mahnung', 'Lieferschein', 'Angebot']) {
      assert.ok(line.includes(word), word)
    }
    assert.ok(p.includes('An invoice that only mentions a credit, a refund or a cancellation is still an "invoice".'))
  })
})

describe('pdfInvoiceFields — what the search takes from the reader’s answer', () => {
  const read = (over: Record<string, unknown> = {}) => pdfInvoiceFields({
    date: '2026-07-15', invoice_number: '910000000123', amount: 23.45, currency: 'EUR', vatin: 'ATU12345675', ...over,
  })
  test('a euro total: the amount as read, no foreign total', () => {
    assert.deepEqual(read({ document_type: 'invoice' }), {
      date: '2026-07-15', invoice_number: '910000000123', amount: 23.45, currency: 'EUR', vatin: 'ATU12345675',
      amount_due: null, foreign_total: null, document_type: 'invoice',
    })
  })
  test('a total in another currency: no amount — the printed total kept as the foreign total, with its currency', () => {
    const r = read({ amount: 25, currency: 'USD' })
    assert.deepEqual([r.amount, r.foreign_total, r.currency], [null, 25, 'USD'])
  })
  test('the amount due as read, in euros only', () => {
    assert.equal(read({ amount: 25.2, amount_due: 21 }).amount_due, 21)
    assert.equal(read({ amount: 25.2, amount_due: '21,00 €' }).amount_due, 21)
    assert.equal(read({ amount: 25, amount_due: 21, currency: 'USD' }).amount_due, null)
    assert.equal(read({ currency: null, amount_due: 21 }).amount_due, 21)
    for (const amount_due of [null, undefined, 'n/a', '']) assert.equal(read({ amount_due }).amount_due, null, String(amount_due))
  })
  test('the document type as asked, in any case; anything else is not known (null)', () => {
    for (const type of DOCUMENT_TYPES) assert.equal(read({ document_type: type }).document_type, type)
    assert.equal(read({ document_type: ' Order_Confirmation ' }).document_type, 'order_confirmation')
    for (const document_type of ['Rechnung', 'Gutschrift', 'credit note', '', 'null', true, 1, null, undefined]) {
      assert.equal(read({ document_type }).document_type, null, String(document_type))
    }
  })
  test('a date that is no ISO day is not known', () => {
    assert.equal(read({ date: '15.07.2026' }).date, null)
    assert.equal(read({ date: '2026-02-30' }).date, null)
  })
})

// A stand-in for the SDK's beta messages API: each call's body and request options kept; it
// answers the answers given, one per call (an Error: that call fails). No network.
function standIn(...answers: (ReaderAnswer | Error)[]) {
  const calls: { body: ReturnType<typeof readerRequest>; options?: Anthropic.RequestOptions }[] = []
  const messages: PdfReaderMessages = {
    parse: async (body, options) => {
      calls.push({ body, options })
      const answer = answers[Math.min(calls.length, answers.length) - 1]
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { messages, calls }
}
const PDF = 'JVBERi0xLjQK'
const PARSED = { date: '2026-07-15', invoice_number: '910000000123', amount: 25.2, currency: 'EUR', amount_due: 21, vatin: null, document_type: 'invoice' }
const ok = (parsed: unknown = PARSED): ReaderAnswer => ({ stop_reason: 'end_turn', parsed_output: parsed })

describe('readPdfInvoice — one read by Claude Opus 5.5 (D3a)', () => {
  test('the request: Opus 5.5 at low effort, the answer held to the schema, the refusal fallback opted in; the PDF as a document, then the prompt with the owner’s UID', async () => {
    const { messages, calls } = standIn(ok())
    await readPdfInvoice(PDF, { ownVatin: 'ATU00000000' }, messages)
    const [{ body }] = calls
    assert.equal(body.model, 'claude-opus-5-5')
    assert.equal(PDF_READER_MODEL, 'claude-opus-5-5')
    assert.equal(body.max_tokens, PDF_READER_MAX_TOKENS)
    assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01'])
    assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01')
    assert.equal(body.fallbacks, 'default')
    assert.equal(body.output_config.effort, 'low')
    assert.equal(body.output_config.format.type, 'json_schema')
    assert.deepEqual(body.messages, [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
        { type: 'text', text: pdfInvoicePrompt('ATU00000000') },
      ],
    }])
    // No prefill, no sampling parameters (Opus 5.5 refuses them)
    assert.ok(!('temperature' in body) && !('top_p' in body) && !('thinking' in body))
  })
  test('the schema: every field required, each a value or null, nothing else', () => {
    const schema = readerRequest(PDF).output_config.format.schema as { required: string[]; additionalProperties: boolean; properties: Record<string, { anyOf: { type: string }[] }> }
    assert.deepEqual([...schema.required].sort(), ['amount', 'amount_due', 'currency', 'date', 'document_type', 'invoice_number', 'vatin'])
    assert.equal(schema.additionalProperties, false)
    for (const [field, p] of Object.entries(schema.properties)) assert.ok(p.anyOf.some(t => t.type === 'null'), field)
    assert.deepEqual(['amount', 'amount_due'].map(f => schema.properties[f].anyOf[0].type), ['number', 'number'])
  })
  test('without the owner’s UID given: the one from Einstellungen', async () => {
    const { messages, calls } = standIn(ok())
    await readPdfInvoice(PDF, {}, messages)
    assert.equal(calls[0].body.messages[0].content[1].text, pdfInvoicePrompt(TEST_OWNER.vatin))
  })
  test('the caller’s timeout, retries and signal go to the SDK as its request options; without them none', async () => {
    const signal = new AbortController().signal
    const timed = standIn(ok())
    await readPdfInvoice(PDF, { timeoutMs: 20_000, maxRetries: 1, signal }, timed.messages)
    assert.deepEqual(timed.calls.map(c => c.options), [{ timeout: 20_000, maxRetries: 1, signal }])
    const plain = standIn(ok())
    await readPdfInvoice(PDF, {}, plain.messages)
    assert.deepEqual(plain.calls.map(c => c.options), [undefined])
  })
  test('answers what pdfInvoiceFields reads', async () => {
    assert.deepEqual(await readPdfInvoice(PDF, {}, standIn(ok()).messages), {
      date: '2026-07-15', invoice_number: '910000000123', amount: 25.2, currency: 'EUR', vatin: null,
      amount_due: 21, foreign_total: null, document_type: 'invoice',
    })
  })
  test('„nicht lesbar“: declined by Claude and its fallback, cut off, ended otherwise, or no answer of the schema', async () => {
    const cases: [ReaderAnswer, RegExp][] = [
      [{ stop_reason: 'refusal', parsed_output: null }, /abgelehnt/],
      [{ stop_reason: 'max_tokens', parsed_output: null }, /abgeschnitten/],
      [{ stop_reason: 'pause_turn', parsed_output: null }, /unvollständig \(pause_turn\)/],
      [{ stop_reason: null }, /unvollständig \(ohne Grund\)/],
      [ok(null), /keine gültige Antwort/],
      [ok([1, 2]), /keine gültige Antwort/],
    ]
    for (const [answer, why] of cases) {
      await assert.rejects(readPdfInvoice(PDF, {}, standIn(answer).messages), (e: unknown) => {
        assert.ok(e instanceof ReceiptUnreadableError)
        assert.match((e as Error).message, /^Beleg-Daten nicht lesbar — /)
        assert.match((e as Error).message, why)
        return true
      }, String(answer.stop_reason))
    }
  })
  test('a timeout or an API error is thrown as it comes: the search says it on the line', async () => {
    const timedOut = new Anthropic.APIConnectionTimeoutError()
    await assert.rejects(readPdfInvoice(PDF, { timeoutMs: 20_000, maxRetries: 0 }, standIn(timedOut).messages), e => e === timedOut)
  })
})

describe('pdfReaderConfigured — the search reads PDFs only with ANTHROPIC_API_KEY', () => {
  test('a key: configured; none or blank: not', () => {
    const saved = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
      assert.equal(pdfReaderConfigured(), true)
      process.env.ANTHROPIC_API_KEY = '  '
      assert.equal(pdfReaderConfigured(), false)
      delete process.env.ANTHROPIC_API_KEY
      assert.equal(pdfReaderConfigured(), false)
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })
})
