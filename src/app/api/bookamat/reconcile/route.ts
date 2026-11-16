import { NextResponse } from 'next/server'
import { databaseError, requireUser, settingsUnavailable } from '@/lib/auth'
import { BOOKAMAT_SETTINGS_COLUMNS, BookamatError, bookamatFetch, credentialsOf, type BookamatSettings } from '@/lib/bookamat'
import { BOOKING_COLUMNS, type MoneyRow } from '@/lib/bookamat-client'
import { reconcile, type ReconcileDoc } from '@/lib/bookamat-reconcile'
import { readYear, type BookingLite, type GetPage } from '@/lib/bookamat-search'
import { isBookamatConfigured } from '@/lib/public-settings'
import { clientDisplayName } from '@/lib/utils/clients'
import { today } from '@/lib/utils/document'

export const maxDuration = 60

const DOC_COLS = `id, type, number, status, currency, tax_treatment, discount_type, discount_value,
  document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value),
  payments(date, amount, kind, method), bookamat_bookings(${BOOKING_COLUMNS}), clients(name, company)`
const PAGE = 1000

// Settings → Bookamat → „Mit Bookamat abgleichen“: this and last year's bookings in Bookamat against
// Mado's documents (src/lib/bookamat-reconcile.ts). Reads only, also on a preview.
export async function GET() {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const { data: settingsRow, error: settingsErr } = await supabase.from('settings').select(`${BOOKAMAT_SETTINGS_COLUMNS}, invoice_prefix`).single()
  if (settingsErr || !settingsRow) return settingsUnavailable(settingsErr)
  const settings = settingsRow as unknown as BookamatSettings & { invoice_prefix: string | null }
  if (!isBookamatConfigured(settings)) return NextResponse.json({ error: 'Bookamat is not fully configured', code: 'not_configured' }, { status: 400 })

  type Row = Omit<ReconcileDoc, 'client' | 'payments'> & { payments: MoneyRow[] | null; clients: { name: string; company: string | null } | null }
  // Every issued invoice and credit note, page by page (the database answers at most 1000 rows).
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('documents').select(DOC_COLS)
      .in('type', ['invoice', 'credit_note']).not('number', 'is', null).order('id').range(from, from + PAGE - 1)
    if (error) return databaseError(error)
    rows.push(...((data ?? []) as unknown as Row[]))
    if ((data ?? []).length < PAGE) break
  }
  // What credit notes credited to invoices: with their refunds it settles them.
  const applied: Record<string, number> = {}
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('payments').select('id, credit_note_id, amount').eq('kind', 'credit').order('id').range(from, from + PAGE - 1)
    if (error) return databaseError(error)
    for (const p of (data ?? []) as { credit_note_id: string | null; amount: number }[]) {
      if (p.credit_note_id) applied[p.credit_note_id] = (applied[p.credit_note_id] ?? 0) + Number(p.amount)
    }
    if ((data ?? []).length < PAGE) break
  }

  const year = Number(today().slice(0, 4))
  const years = [year - 1, year]
  const creds = credentialsOf(settings)
  // Ends in time for an answer within the function's 60 s.
  const deadline = Date.now() + 45_000
  const get: GetPage = (y, path) => bookamatFetch(creds, y, path, { deadline })
  const bookings: BookingLite[] = []
  try {
    for (const y of years) bookings.push(...await readYear(get, y))
  } catch (err) {
    const e = err instanceof BookamatError ? err : null
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Bookamat request failed', code: e?.code ?? 'bookamat', detail: e?.detail }, { status: 502 })
  }

  const docs: ReconcileDoc[] = rows.map(({ clients, ...d }) => ({ ...d, client: clientDisplayName(clients) }))
  return NextResponse.json(reconcile({ docs, bookings, years, invoicePrefix: settings.invoice_prefix, applied }))
}
