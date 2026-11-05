// Invoices made from a quote: its invoice, an advance invoice for part of it, or the final invoice
// that deducts the advance invoices. Each leaves the quote accepted. Shared by the quote routes and
// the Claude connector; refusals are thrown as ServiceError, database failures as they came.
import type { SupabaseClient } from '@supabase/supabase-js'
import { advanceItems, billedAmount, depositTotals, loadQuoteDeposits, writeDeductions } from '@/lib/deposits'
import { logEvent } from '@/lib/events'
import { asDbError } from '@/lib/status'
import { addDays, roundCents, today } from '@/lib/utils/document'
import { ServiceError } from './errors'

type Converted = { invoice_id: string; existing: boolean; quote_status: string; linked?: number }

export interface QuoteConversion {
  invoiceId: string
  // The quote was converted before: that invoice, unchanged.
  existing: boolean
  // Advance and partial invoices the final invoice deducts.
  linked: number
}

// convert_quote_to_invoice does the whole conversion in one transaction (status check, unnumbered
// draft invoice due after the client's payment days, every line, quote → accepted) and hands back
// the existing invoice when the quote was converted before. With `final` it is the final invoice
// (Schlussrechnung): it links the quote's issued advance and partial invoices, and their deduction
// lines (per invoice and VAT rate) are written here. The refusals keep their code: MI016 (not
// convertible), MI019 (advance invoices exist: make the final invoice) and the deposit guards
// MI020–MI022. Null when there is no such quote.
export async function convertQuote(supabase: SupabaseClient, quoteId: string, opts: { final?: boolean } = {}): Promise<QuoteConversion | null> {
  const { data, error } = await supabase.rpc('convert_quote_to_invoice', opts.final ? { p_quote_id: quoteId, p_final: true } : { p_quote_id: quoteId })
  if (error) throw error
  const result = data as Converted | null
  if (!result) return null
  const conversion = { invoiceId: result.invoice_id, existing: result.existing, linked: result.linked ?? 0 }
  if (result.existing) return conversion

  const { data: quote } = await supabase.from('documents').select('number').eq('id', quoteId).single()
  await logEvent(supabase, result.invoice_id, 'converted', { from_id: quoteId, from_number: quote?.number ?? null, from_type: 'quote' })
  // The invoice is still an unnumbered draft; the quote's history links to it by id.
  await logEvent(supabase, quoteId, 'converted', { to_id: result.invoice_id, to_type: 'invoice' })
  if (result.quote_status === 'sent') await logEvent(supabase, quoteId, 'status_changed', { from: 'sent', to: 'accepted' })

  if (opts.final) {
    // A failure leaves a draft without its deduction lines; the editor writes them when it opens.
    try {
      await writeDeductions(supabase, result.invoice_id)
    } catch (err) {
      console.error(`[quotes/final] deductions of ${result.invoice_id} not written:`, err)
    }
  }
  return conversion
}

export type AdvanceRequest = { mode: 'percent' | 'amount'; value: number }

export function advanceRequestValid({ mode, value }: AdvanceRequest): boolean {
  return Number.isFinite(value) && value > 0 && !(mode === 'percent' && value > 100)
}

// An advance invoice (Anzahlungsrechnung) for part of a sent or accepted quote: { mode: 'percent',
// value: 30 } or { mode: 'amount', value: 1500 } (gross). The draft carries one line per VAT rate
// of the quote, the quote's service date as the expected one and the client's payment terms. A
// sent quote becomes accepted, as on conversion. Advance invoices never add up to more than the
// quote (exceeds_quote names both amounts, unformatted), and none follows the quote's own invoice.
export async function createAdvanceInvoice(supabase: SupabaseClient, quoteId: string, request: AdvanceRequest): Promise<{ invoiceId: string; gross: number }> {
  const { mode, value } = request
  if (!advanceRequestValid(request)) throw new ServiceError(400, 'deposit_bad_amount', 'Expected a percentage up to 100 or an amount above zero')

  const { data: quote, error } = await supabase.from('documents')
    .select('id, number, status, date, client_id, service_date, service_date_end, language, tax_treatment, discount_type, discount_value, buyer_reference, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), clients(payment_days)')
    .eq('id', quoteId).eq('type', 'quote').maybeSingle()
  if (error) throw error
  if (!quote) throw new ServiceError(404, 'not_found', 'Quote not found')
  if (quote.status !== 'sent' && quote.status !== 'accepted') {
    throw new ServiceError(409, 'MI016', 'Only a sent or accepted quote can be invoiced')
  }

  const quoteTotal = depositTotals(quote).total
  const gross = roundCents(mode === 'percent' ? quoteTotal * value / 100 : value)
  if (quoteTotal <= 0 || gross <= 0) throw new ServiceError(400, 'empty_quote', 'The quote has no amount to ask an advance payment for')
  const [deposits, { data: conversion, error: convErr }] = await Promise.all([
    loadQuoteDeposits(supabase, quoteId).then(list => ({ list, error: null }), (err: unknown) => ({ list: [], error: asDbError(err) })),
    supabase.from('documents').select('id').eq('converted_from_id', quoteId).eq('type', 'invoice')
      .in('invoice_kind', ['standard', 'final']).neq('status', 'cancelled').limit(1).maybeSingle(),
  ])
  if (deposits.error) throw deposits.error
  if (convErr) throw convErr
  if (conversion) throw new ServiceError(409, 'quote_converted', 'The quote already has its invoice')
  const earlier = deposits.list
    .filter(d => d.invoice_kind === 'advance' && d.status !== 'cancelled')
    .reduce((s, d) => s + billedAmount(d), 0)
  if (roundCents(earlier + gross) > quoteTotal + 0.005) {
    throw new ServiceError(409, 'exceeds_quote', 'Advance invoices would exceed the quote total', { amount: roundCents(earlier + gross), total: quoteTotal })
  }

  const lang = quote.language === 'en' ? 'en' : 'de'
  const lines = advanceItems(quote, gross, mode === 'percent' ? value : null, lang)
  if (!lines.length) throw new ServiceError(400, 'empty_quote', 'The quote has no amount to ask an advance payment for')

  const { data: settings } = await supabase.from('settings').select('default_payment_days').maybeSingle()
  // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
  const client = quote.clients as unknown as { payment_days: number | null } | null
  const date = today()
  const { data: invoice, error: insErr } = await supabase.from('documents').insert({
    type: 'invoice',
    invoice_kind: 'advance',
    number: null,
    status: 'draft',
    client_id: quote.client_id,
    date,
    due_date: addDays(date, client?.payment_days ?? settings?.default_payment_days ?? 14),
    service_date: quote.service_date,
    service_date_end: quote.service_date_end,
    language: lang,
    currency: 'EUR',
    exchange_rate: 1,
    tax_treatment: quote.tax_treatment,
    converted_from_id: quote.id,
    buyer_reference: quote.buyer_reference,
  }).select('id').single()
  if (insErr) throw insErr

  const { error: itemsErr } = await supabase.from('document_items').insert(lines.map(l => ({ ...l, document_id: invoice.id })))
  if (itemsErr) {
    await supabase.from('documents').delete().eq('id', invoice.id)
    throw itemsErr
  }

  await logEvent(supabase, invoice.id, 'converted', { from_id: quote.id, from_number: quote.number, from_type: 'quote' })
  await logEvent(supabase, quote.id, 'deposit_created', { to_id: invoice.id, amount: gross, percent: mode === 'percent' ? value : null })
  if (quote.status === 'sent') {
    const { data: accepted } = await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id).eq('status', 'sent').select('id')
    if (accepted?.length) await logEvent(supabase, quote.id, 'status_changed', { from: 'sent', to: 'accepted' })
  }
  return { invoiceId: invoice.id as string, gross }
}
