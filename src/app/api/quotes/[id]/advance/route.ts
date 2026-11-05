import { NextResponse } from 'next/server'
import { apiError, databaseError, invalidJson, isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { advanceItems, billedAmount, depositTotals, loadQuoteDeposits } from '@/lib/deposits'
import { logEvent } from '@/lib/events'
import { getUiLang } from '@/lib/i18n/server'
import { asDbError } from '@/lib/status'
import { addDays, formatMoney, roundCents, today } from '@/lib/utils/document'

// An advance invoice (Anzahlungsrechnung) for part of a sent or accepted quote: { mode: 'percent',
// value: 30 } or { mode: 'amount', value: 1500 } (gross). The draft carries one line per VAT rate
// of the quote, the quote's service date as the expected one and the client's payment terms; it
// is issued from the editor. A sent quote becomes accepted, as on conversion. Advance invoices
// never add up to more than the quote, and none follows the quote's own invoice.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return apiError(404, 'not_found', 'Quote not found')

  const body = await readJsonObject(req)
  if (!body) return invalidJson()
  const mode = body.mode === 'percent' || body.mode === 'amount' ? body.mode : null
  const value = typeof body.value === 'number' && Number.isFinite(body.value) ? body.value : null
  if (!mode || value == null || value <= 0 || (mode === 'percent' && value > 100)) {
    return apiError(400, 'deposit_bad_amount', 'Expected a percentage up to 100 or an amount above zero')
  }

  const { data: quote, error } = await supabase.from('documents')
    .select('id, number, status, date, client_id, service_date, service_date_end, language, tax_treatment, discount_type, discount_value, buyer_reference, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), clients(payment_days)')
    .eq('id', id).eq('type', 'quote').maybeSingle()
  if (error) return databaseError(error)
  if (!quote) return apiError(404, 'not_found', 'Quote not found')
  if (quote.status !== 'sent' && quote.status !== 'accepted') {
    return apiError(409, 'MI016', 'Only a sent or accepted quote can be invoiced')
  }

  const quoteTotal = depositTotals(quote).total
  const gross = roundCents(mode === 'percent' ? quoteTotal * value / 100 : value)
  if (quoteTotal <= 0 || gross <= 0) return apiError(400, 'empty_quote', 'The quote has no amount to ask an advance payment for')
  const [deposits, { data: conversion, error: convErr }] = await Promise.all([
    loadQuoteDeposits(supabase, id).then(list => ({ list, error: null }), (err: unknown) => ({ list: [], error: asDbError(err) })),
    supabase.from('documents').select('id').eq('converted_from_id', id).eq('type', 'invoice')
      .in('invoice_kind', ['standard', 'final']).neq('status', 'cancelled').limit(1).maybeSingle(),
  ])
  if (deposits.error) return databaseError(deposits.error)
  if (convErr) return databaseError(convErr)
  if (conversion) return apiError(409, 'quote_converted', 'The quote already has its invoice')
  const earlier = deposits.list
    .filter(d => d.invoice_kind === 'advance' && d.status !== 'cancelled')
    .reduce((s, d) => s + billedAmount(d), 0)
  if (roundCents(earlier + gross) > quoteTotal + 0.005) {
    const uiLang = await getUiLang()
    return apiError(409, 'exceeds_quote', 'Advance invoices would exceed the quote total', {
      details: { amount: formatMoney(roundCents(earlier + gross), 'EUR', uiLang), total: formatMoney(quoteTotal, 'EUR', uiLang) },
    })
  }

  const lang = quote.language === 'en' ? 'en' : 'de'
  const lines = advanceItems(quote, gross, mode === 'percent' ? value : null, lang)
  if (!lines.length) return apiError(400, 'empty_quote', 'The quote has no amount to ask an advance payment for')

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
  if (insErr) return databaseError(insErr)

  const { error: itemsErr } = await supabase.from('document_items').insert(lines.map(l => ({ ...l, document_id: invoice.id })))
  if (itemsErr) {
    await supabase.from('documents').delete().eq('id', invoice.id)
    return databaseError(itemsErr)
  }

  await logEvent(supabase, invoice.id, 'converted', { from_id: quote.id, from_number: quote.number, from_type: 'quote' })
  await logEvent(supabase, quote.id, 'deposit_created', { to_id: invoice.id, amount: gross, percent: mode === 'percent' ? value : null })
  if (quote.status === 'sent') {
    const { data: accepted } = await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id).eq('status', 'sent').select('id')
    if (accepted?.length) await logEvent(supabase, quote.id, 'status_changed', { from: 'sent', to: 'accepted' })
  }

  return NextResponse.json({ invoiceId: invoice.id })
}
