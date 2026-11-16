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

  const { data: docs, error: docsErr } = await supabase.from('documents').select(DOC_COLS).in('type', ['invoice', 'credit_note']).not('number', 'is', null)
  if (docsErr) return databaseError(docsErr)

  const year = Number(today().slice(0, 4))
  const years = [year - 1, year]
  const creds = credentialsOf(settings)
  const get: GetPage = (y, path) => bookamatFetch(creds, y, path)
  const bookings: BookingLite[] = []
  try {
    for (const y of years) bookings.push(...await readYear(get, y))
  } catch (err) {
    const e = err instanceof BookamatError ? err : null
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Bookamat request failed', code: e?.code ?? 'bookamat', detail: e?.detail }, { status: 502 })
  }

  type Row = Omit<ReconcileDoc, 'client' | 'payments'> & { payments: MoneyRow[] | null; clients: { name: string; company: string | null } | null }
  const input: ReconcileDoc[] = ((docs ?? []) as unknown as Row[]).map(({ clients, ...d }) => ({ ...d, client: clientDisplayName(clients) }))
  return NextResponse.json(reconcile({ docs: input, bookings, years, invoicePrefix: settings.invoice_prefix }))
}
