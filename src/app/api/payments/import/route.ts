import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calcTotals, roundCents } from '@/lib/utils/document'

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
  skonto_amount?: number
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
    && (o.skonto_amount === undefined || (typeof o.skonto_amount === 'number' && Number.isFinite(o.skonto_amount) && o.skonto_amount >= 0))
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  let imported = 0
  let duplicates = 0
  const errors: ImportError[] = []
  const touched = new Set<string>()

  for (const row of rows) {
    const doc = byId.get(row.document_id)
    if (!doc || doc.type !== 'invoice') { errors.push({ transaction_id: row.transaction_id, code: 'not_found', message: 'Invoice not found' }); continue }
    if (!doc.number || doc.status === 'draft') { errors.push({ transaction_id: row.transaction_id, code: 'not_issued', message: 'Invoice not issued' }); continue }
    if (doc.status === 'cancelled') { errors.push({ transaction_id: row.transaction_id, code: 'cancelled', message: 'Invoice is cancelled' }); continue }

    const amount = roundCents(row.amount)
    const { error: payErr } = await supabase.from('payments').insert({
      document_id: doc.id,
      date: row.date,
      amount,
      note: row.note?.trim().slice(0, 200) || null,
      kind: 'payment',
      import_ref: row.transaction_id,
    })
    if (payErr && payErr.code !== '23505') { errors.push({ transaction_id: row.transaction_id, message: payErr.message }); continue }
    // 23505: the unique import_ref index already holds this statement transaction, and the lookup
    // above already counted that row. A retry after a half-finished run still records the Skonto
    // below and re-checks the status, so the invoice ends up paid.
    if (payErr) duplicates++
    else { doc.payments.push({ amount, kind: 'payment' }); imported++ }
    touched.add(doc.id)

    const skonto = roundCents(row.skonto_amount ?? 0)
    if (skonto > 0) {
      const { error: skontoErr } = await supabase.from('payments').insert({
        document_id: doc.id,
        date: row.date,
        amount: skonto,
        note: 'Skonto',
        kind: 'skonto',
        import_ref: `${row.transaction_id}:skonto`,
      })
      if (!skontoErr) doc.payments.push({ amount: skonto, kind: 'skonto' })
      else if (skontoErr.code !== '23505') errors.push({ transaction_id: row.transaction_id, message: skontoErr.message })
    }
  }

  // Every payment kind counts towards the balance, exactly like PaymentPanel.
  const paid: string[] = []
  for (const id of touched) {
    const doc = byId.get(id)!
    if (doc.status !== 'sent' && doc.status !== 'overdue') continue
    const totals = calcTotals(
      doc.document_items ?? [],
      doc.payments,
      doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null,
      doc.tax_treatment,
    )
    if (totals.total_paid >= totals.total - 0.005) paid.push(id)
  }
  if (paid.length) {
    const { error } = await supabase.from('documents').update({ status: 'paid' }).in('id', paid).in('status', ['sent', 'overdue'])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ imported, duplicates, paid, errors })
}
