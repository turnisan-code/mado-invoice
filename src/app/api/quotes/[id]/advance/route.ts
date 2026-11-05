import { NextResponse } from 'next/server'
import { isUuid, readJsonObject, requireUser } from '@/lib/auth'
import { advanceItems, billedAmount, depositTotals, loadQuoteDeposits } from '@/lib/deposits'
import { logEvent } from '@/lib/events'
import { getT } from '@/lib/i18n/server'
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
  const { t } = await getT()
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: t('lifecycle.errors.notFound') }, { status: 404 })

  const body = await readJsonObject(req)
  const mode = body?.mode === 'percent' || body?.mode === 'amount' ? body.mode : null
  const value = typeof body?.value === 'number' && Number.isFinite(body.value) ? body.value : null
  if (!mode || value == null || value <= 0 || (mode === 'percent' && value > 100)) {
    return NextResponse.json({ error: t('deposits.errors.badAmount') }, { status: 400 })
  }

  const { data: quote, error } = await supabase.from('documents')
    .select('id, number, status, date, client_id, service_date, service_date_end, language, tax_treatment, discount_type, discount_value, buyer_reference, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), clients(payment_days)')
    .eq('id', id).eq('type', 'quote').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!quote) return NextResponse.json({ error: t('lifecycle.errors.notFound') }, { status: 404 })
  if (quote.status !== 'sent' && quote.status !== 'accepted') {
    return NextResponse.json({ error: t('lifecycle.errors.quoteNotConvertible') }, { status: 409 })
  }

  const quoteTotal = depositTotals(quote).total
  const gross = roundCents(mode === 'percent' ? quoteTotal * value / 100 : value)
  if (quoteTotal <= 0 || gross <= 0) return NextResponse.json({ error: t('deposits.errors.emptyQuote') }, { status: 400 })
  const [deposits, { data: conversion, error: convErr }] = await Promise.all([
    loadQuoteDeposits(supabase, id),
    supabase.from('documents').select('id').eq('converted_from_id', id).eq('type', 'invoice')
      .in('invoice_kind', ['standard', 'final']).neq('status', 'cancelled').limit(1).maybeSingle(),
  ])
  if (convErr) return NextResponse.json({ error: convErr.message }, { status: 500 })
  if (conversion) return NextResponse.json({ error: t('deposits.errors.quoteConverted') }, { status: 409 })
  const earlier = deposits
    .filter(d => d.invoice_kind === 'advance' && d.status !== 'cancelled')
    .reduce((s, d) => s + billedAmount(d), 0)
  if (roundCents(earlier + gross) > quoteTotal + 0.005) {
    return NextResponse.json({ error: t('deposits.errors.exceedsQuote', { amount: formatMoney(roundCents(earlier + gross)), total: formatMoney(quoteTotal) }) }, { status: 409 })
  }

  const lang = quote.language === 'en' ? 'en' : 'de'
  const lines = advanceItems(quote, gross, mode === 'percent' ? value : null, lang)
  if (!lines.length) return NextResponse.json({ error: t('deposits.errors.emptyQuote') }, { status: 400 })

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
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  const { error: itemsErr } = await supabase.from('document_items').insert(lines.map(l => ({ ...l, document_id: invoice.id })))
  if (itemsErr) {
    await supabase.from('documents').delete().eq('id', invoice.id)
    return NextResponse.json({ error: itemsErr.message }, { status: 500 })
  }

  await logEvent(supabase, invoice.id, 'converted', { from_id: quote.id, from_number: quote.number, from_type: 'quote' })
  await logEvent(supabase, quote.id, 'deposit_created', { to_id: invoice.id, amount: gross, percent: mode === 'percent' ? value : null })
  if (quote.status === 'sent') {
    const { data: accepted } = await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id).eq('status', 'sent').select('id')
    if (accepted?.length) await logEvent(supabase, quote.id, 'status_changed', { from: 'sent', to: 'accepted' })
  }

  return NextResponse.json({ invoiceId: invoice.id })
}
