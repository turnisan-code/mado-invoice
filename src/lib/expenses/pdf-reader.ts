// The PDF reader of PR 9b („Belege aus Gmail“, decision D3a): Claude Opus 5.5 reads a PDF found
// in Gmail for what proves it is a debit's receipt — its total, the amount due, the currency (and
// the total when it is another currency), the invoice number and date, the seller's UID and what
// the document is. Ported from Bookmatic's lib/ai-extractor.ts (475072f: pdfInvoicePrompt,
// pdfInvoiceFields, extractPdfInvoiceData); the receipt-photo reader there is Job 2's (item 10).
//
// What changed on the way: the free-text JSON of Haiku 4.5 is now a structured output (the
// answer's shape is the schema below), Opus 5.5 thinks at low effort (its thinking cannot be
// turned off), and a refusal is retried on Anthropic's fallback model server-side
// (`fallbacks: 'default'`). A refusal of the whole chain, a cut-off answer or one without the
// fields is „nicht lesbar“ (ReceiptUnreadableError); an API error, a timeout or an abort is thrown
// as it comes. The answer is parsed here, after its stop reason is checked (the SDK's parse()
// would throw its own error on a refusal or a cut-off before that). The answer goes through pdfInvoiceFields as before, so a total in another currency
// is never taken for euros. Server only: the key is ANTHROPIC_API_KEY.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import * as z from 'zod/v4'
import { aiRequestOptions, untilAborted, type AiCallOptions } from './ai-call'
import { isForeignCurrency } from './vat-origin'
import { OWN_VATIN } from './vatin'

export const PDF_READER_MODEL = 'claude-opus-5-5'
// The server-side refusal fallback (decision D3a)
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
// Structured outputs on the beta messages API, as the SDK's own parse() asks for them
export const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15'
// Thinking at low effort and the small answer; what is not used is not billed
export const PDF_READER_MAX_TOKENS = 4096

// What kind of document the PDF reader says a PDF is. Asked so that a credit note, an order
// confirmation, a reminder, a delivery note or a quote of the debit's amount is never taken for
// its invoice.
export const DOCUMENT_TYPES = [
  'invoice', 'receipt', 'credit_note', 'order_confirmation', 'reminder', 'delivery_note', 'quote', 'other',
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export interface PdfInvoiceData {
  date: string | null
  invoice_number: string | null
  amount: number | null          // the gross total in euros; null when it is in another currency
  currency: string | null        // ISO 4217 code of the printed total, as read
  vatin: string | null
  amount_due: number | null      // the amount charged or still to pay when it differs from the total; euros only
  foreign_total: number | null   // the printed total when it is in another currency (`amount` is null then)
  document_type: DocumentType | null  // null: the reader named none of DOCUMENT_TYPES
}

// The answer's shape, as the API holds Claude to it
export const PDF_READER_ANSWER = z.object({
  date: z.string().nullable(),
  invoice_number: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  amount_due: z.number().nullable(),
  vatin: z.string().nullable(),
  document_type: z.enum(DOCUMENT_TYPES).nullable(),
})

// What the reader asks. Its UID is the seller's, its Austrian one when it prints several, never
// the buyer's — whose own UID is named (the owner's, from Einstellungen). The amount due proves an
// invoice as much as its total (a debit of the Zahlbetrag after a credit); an invoice that only
// mentions a credit or a refund stays one.
export function pdfInvoicePrompt(ownVatin: string = OWN_VATIN): string {
  return `Extract key invoice fields from this PDF:
  "date": the invoice date as YYYY-MM-DD, or null
  "invoice_number": the invoice number, digits only, no RN-/RE-/KV- prefix, or null
  "amount": the total gross amount as a number, or null
  "currency": the ISO 4217 code of that total, e.g. EUR, USD, GBP, or null if not shown
  "amount_due": the amount charged or still to pay as printed (Zahlbetrag, Amount paid, Amount due) as a number when it differs from the gross total, else null
  "vatin": the SELLER's VAT ID exactly as printed (e.g. ATU12345678, DE123456789); if the seller prints several, its Austrian one (ATU…); never the buyer's; null if none
  "document_type": what the document itself is: "invoice" (Rechnung), "receipt" (Quittung, Kassenbon, payment receipt), "credit_note" (Gutschrift, Storno, credit note, refund), "order_confirmation" (Bestellbestätigung), "reminder" (Mahnung, Zahlungserinnerung), "delivery_note" (Lieferschein), "quote" (Angebot, Kostenvoranschlag) or "other"
${ownVatin ? `The buyer's own VAT ID ${ownVatin} is printed on many invoices (next to "Rechnung an", "Kunde", "Leistungsempfänger", "Ihre UID"): it is never the seller's "vatin".\n` : ''}An invoice that only mentions a credit, a refund or a cancellation is still an "invoice".`
}

/**
 * The reader's answer could not be used: Claude declined it (and the fallback model too), it was
 * cut off (max_tokens) or ended any other way than end_turn, or it held no answer of the schema.
 * Callers say „Beleg-Daten nicht lesbar“ and keep the file.
 */
export class ReceiptUnreadableError extends Error {
  constructor(detail: string) {
    super(`Beleg-Daten nicht lesbar — ${detail}`)
    this.name = 'ReceiptUnreadableError'
    Object.setPrototypeOf(this, ReceiptUnreadableError.prototype)
  }
}

// The schema holds numbers and strings; anything that isn't one plainly is left out rather than
// guessed, as the free-text answers were read before
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[\s%€]/g, '').replace(',', '.')
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null
}
const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() && !/^null$/i.test(v.trim()) ? v.trim() : null
}
const isoDate = (v: unknown): string | null => {
  const s = str(v)
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null
}
// One of DOCUMENT_TYPES as asked (any case, spaces around); anything else is not known
const documentTypeOf = (v: unknown): DocumentType | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return DOCUMENT_TYPES.find(t => t === s) ?? null
}

// The reader's answer as the search uses it: the total only in euros („Beleg prüfen“ would print
// $20.00 as „20,00 €“), the amount due in euros too, the printed total in another currency kept
// as the foreign total (the card stamp's own amount can prove it), the document type.
export function pdfInvoiceFields(json: Record<string, unknown>): PdfInvoiceData {
  const currency = str(json.currency)
  const total = num(json.amount)
  const foreign = isForeignCurrency(currency)
  return {
    date: isoDate(json.date),
    invoice_number: str(json.invoice_number),
    amount: foreign ? null : total,
    currency,
    vatin: str(json.vatin),
    amount_due: foreign ? null : num(json.amount_due),
    foreign_total: foreign ? total : null,
    document_type: documentTypeOf(json.document_type),
  }
}

// A total in another currency is no euro amount
export function euroAmountOnly<T extends { amount?: number | null; currency?: string | null }>(x: T): T {
  return isForeignCurrency(x.currency) ? { ...x, amount: null } : x
}
export { isForeignCurrency }

// The request one read sends: the PDF as a document, then the prompt
export function readerRequest(pdfBase64: string, ownVatin: string = OWN_VATIN) {
  return {
    model: PDF_READER_MODEL,
    max_tokens: PDF_READER_MAX_TOKENS,
    betas: [FALLBACK_BETA, STRUCTURED_OUTPUTS_BETA],
    fallbacks: 'default' as const,
    output_config: { effort: 'low' as const, format: betaZodOutputFormat(PDF_READER_ANSWER) },
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: pdfBase64 } },
        { type: 'text' as const, text: pdfInvoicePrompt(ownVatin) },
      ],
    }],
  }
}

export type ReaderRequest = ReturnType<typeof readerRequest>
// What a read gets back: how it ended and its content
export type ReaderAnswer = { stop_reason: string | null; content?: readonly { type: string; text?: string }[] | null }
// The SDK's beta messages API as the reader calls it; tests pass a stand-in, so nothing reaches
// the network
export type PdfReaderMessages = {
  create(body: ReaderRequest, options?: Anthropic.RequestOptions): PromiseLike<ReaderAnswer>
}

export { pdfReaderConfigured } from './reader-config'

let client: Anthropic | null = null
const sdkMessages = (): PdfReaderMessages => ({
  create: (body, options) => {
    client ??= new Anthropic()
    return client.beta.messages.create(body, options) as PromiseLike<ReaderAnswer>
  },
})

// The answer as the schema holds it, or why it can't be used: how it ended first, then its text
export function readerAnswer(msg: ReaderAnswer): Record<string, unknown> {
  if (msg.stop_reason === 'refusal') throw new ReceiptUnreadableError('Claude hat das Lesen abgelehnt')
  if (msg.stop_reason !== 'end_turn') {
    throw new ReceiptUnreadableError(msg.stop_reason === 'max_tokens'
      ? 'Antwort der KI abgeschnitten'
      : `Antwort der KI unvollständig (${msg.stop_reason ?? 'ohne Grund'})`)
  }
  const text = (msg.content ?? []).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ReceiptUnreadableError('keine gültige Antwort der KI')
  }
  const out = PDF_READER_ANSWER.safeParse(json)
  if (!out.success) throw new ReceiptUnreadableError('keine gültige Antwort der KI')
  return out.data as Record<string, unknown>
}

/**
 * One read of a PDF (standard base64). `opts`: the time this read may take, its retries and the
 * signal that aborts it (the line's search budget, lib/expenses/analyse-run.ts), and the owner's
 * UID for the prompt. Throws when the answer can't be used or the API fails.
 */
export async function readPdfInvoice(
  pdfBase64: string,
  opts: AiCallOptions & { ownVatin?: string } = {},
  messages: PdfReaderMessages = sdkMessages(),
): Promise<PdfInvoiceData> {
  const { ownVatin, ...call } = opts
  const msg = await untilAborted(messages.create(readerRequest(pdfBase64, ownVatin ?? OWN_VATIN), aiRequestOptions(call)), call.signal)
  return pdfInvoiceFields(readerAnswer(msg))
}
