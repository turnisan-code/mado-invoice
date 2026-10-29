import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { calcTotals, roundCents, settlesBalance } from '@/lib/utils/document'
import { logEvent } from '@/lib/events'

const MAX_ROWS = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

interface ImportRow {
  transaction_id: string
  document_id: string
  date: string
  amount: number
  note: string | null
  reference?: string | null
  skonto_amount?: number
  // What the part beyond the open balance is: dunning fees and interest (a paid Mahnung), or an
  // overpayment recorded as payment like before.
  excess?: 'fee' | 'payment'
}

interface ImportError {
  transaction_id: string
  /** Known failure the UI can translate; absent for raw database errors. */
  code?: 'not_found' | 'not_issued' | 'cancelled'
  message: string
}

interface DocRow {
  id: string
  type: string
  number: string | null
  status: string
  tax_treatment: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  document_items: { line_type: string | null; sort_order: number | null; quantity: number | null; unit_price: number | null; vat_rate: number | null; discount_type: string | null; discount_value: number | null }[] | null
  payments: { amount: number; kind: string }[] | null
}

function isImportRow(r: unknown): r is ImportRow {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return typeof o.transaction_id === 'string' && o.transaction_id.length > 0 && o.transaction_id.length <= 200
    && typeof o.document_id === 'string' && UUID.test(o.document_id)
    && typeof o.date === 'string' && ISO_DATE.test(o.date) && !Number.isNaN(Date.parse(o.date))
    && typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0
    && (o.note == null || typeof o.note === 'string')
    && (o.reference == null || typeof o.reference === 'string')
    && (o.skonto_amount === undefined || (typeof o.skonto_amount === 'number' && Number.isFinite(o.skonto_amount) && o.skonto_amount >= 0))
    && (o.excess === undefined || o.excess === 'fee' || o.excess === 'payment')
}

export async function POST(req: Request) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await req.json().catch(() => null)
  const rows: unknown[] = Array.isArray(body?.rows) ? body.rows : []
  if (!rows.length) return NextResponse.json({ error: 'rows required' }, { status: 400 })
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `At most ${MAX_ROWS} rows per import` }, { status: 400 })
  if (!rows.every(isImportRow)) return NextResponse.json({ error: 'Invalid row' }, { status: 400 })

  const { data: docs, error: lookupErr } = await supabase
    .from('documents')
    .select(`id, type, number, status, tax_treatment, discount_type, discount_value, ${ITEM_COLS}, payments(amount, kind)`)
    .in('id', [...new Set(rows.map(r => r.document_id))])
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  const byId = new Map(((docs ?? []) as DocRow[]).map(d => [d.id, { ...d, payments: d.payments ?? [] }]))
  const totalOf = (d: DocRow) => calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type, value: d.discount_value } : null,
    d.tax_treatment,
  ).total
  const openOf = (d: DocRow & { payments: { amount: number; kind: string }[] }) =>
    roundCents(totalOf(d) - d.payments.filter(settlesBalance).reduce((s, p) => s + p.amount, 0))

  let imported = 0
  let duplicates = 0
  let fees = 0
  const errors: ImportError[] = []
  const touched = new Set<string>()

  async function insertPayment(row: ImportRow, docId: string, kind: 'payment' | 'skonto' | 'fee', amount: number, importRef: string) {
    const { error } = await supabase.from('payments').insert({
      document_id: docId,
      date: row.date,
      amount,
      note: kind === 'skonto' ? 'Skonto' : row.note?.trim().slice(0, 200) || null,
      reference: row.reference?.trim().slice(0, 140) || null,
      kind,
      import_ref: importRef,
    })
    if (!error) await logEvent(supabase, docId, 'payment_added', { amount, date: row.date, kind, method: 'bank', imported: true })
    return error
  }

  // Transactions an earlier (half-finished) run recorded: their split is kept as it was.
  const earlier = new Map<string, number>()
  const txIds = rows.map(r => r.transaction_id)
  for (let i = 0; i < txIds.length; i += 100) {
    const { data, error } = await supabase.from('payments').select('import_ref, amount').in('import_ref', txIds.slice(i, i + 100))
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const r of data ?? []) earlier.set(r.import_ref as string, roundCents(Number(r.amount)))
  }

  for (const row of rows) {
    const doc = byId.get(row.document_id)
    if (!doc || doc.type !== 'invoice') { errors.push({ transaction_id: row.transaction_id, code: 'not_found', message: 'Invoice not found' }); continue }
    if (!doc.number || doc.status === 'draft') { errors.push({ transaction_id: row.transaction_id, code: 'not_issued', message: 'Invoice not issued' }); continue }
    if (doc.status === 'cancelled') { errors.push({ transaction_id: row.transaction_id, code: 'cancelled', message: 'Invoice is cancelled' }); continue }

    const amount = roundCents(row.amount)
    const skonto = roundCents(row.skonto_amount ?? 0)
    // A paid Mahnung brings the open balance plus fees and interest: the invoice takes what is
    // open, the rest is recorded as 'fee' (not turnover, not part of the balance).
    const open = Math.max(0, roundCents(openOf(doc) - skonto))
    const recorded = earlier.get(row.transaction_id)
    const paid = recorded ?? (row.excess === 'fee' && amount > open + 0.005 ? open : amount)

    // A transaction recorded before keeps its payment; a retry after a half-finished run still
    // records the Skonto and fee below.
    if (recorded !== undefined) duplicates++
    else if (paid > 0) {
      const payErr = await insertPayment(row, doc.id, 'payment', paid, row.transaction_id)
      if (payErr && payErr.code !== '23505') { errors.push({ transaction_id: row.transaction_id, message: payErr.message }); continue }
      if (payErr) duplicates++
      else {
        doc.payments.push({ amount: paid, kind: 'payment' })
        imported++
      }
    }
    touched.add(doc.id)

    if (skonto > 0) {
      const skontoErr = await insertPayment(row, doc.id, 'skonto', skonto, `${row.transaction_id}:skonto`)
      if (!skontoErr) doc.payments.push({ amount: skonto, kind: 'skonto' })
      else if (skontoErr.code !== '23505') errors.push({ transaction_id: row.transaction_id, message: skontoErr.message })
    }

    const fee = roundCents(amount - paid)
    if (fee > 0.005) {
      const feeErr = await insertPayment(row, doc.id, 'fee', fee, `${row.transaction_id}:fee`)
      if (!feeErr) { doc.payments.push({ amount: fee, kind: 'fee' }); fees = roundCents(fees + fee); if (paid <= 0) imported++ }
      else if (feeErr.code === '23505') { if (paid <= 0) duplicates++ }
      else errors.push({ transaction_id: row.transaction_id, message: feeErr.message })
    }
  }

  // Every kind but 'fee' counts towards the balance, exactly like PaymentPanel.
  const paidIds: string[] = []
  for (const id of touched) {
    const doc = byId.get(id)!
    if (doc.status !== 'sent' && doc.status !== 'overdue') continue
    if (openOf(doc) <= 0.005) paidIds.push(id)
  }
  if (paidIds.length) {
    const { data: updated, error } = await supabase.from('documents').update({ status: 'paid' }).in('id', paidIds).in('status', ['sent', 'overdue']).select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const { id } of updated ?? []) await logEvent(supabase, id, 'status_changed', { from: byId.get(id)!.status, to: 'paid' })
  }

  return NextResponse.json({ imported, duplicates, paid: paidIds, fees, errors })
}
