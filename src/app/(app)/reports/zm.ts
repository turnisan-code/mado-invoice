import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays, calcTotals, roundCents } from '@/lib/utils/document'
import { normalizeVatId } from '@/lib/utils/validation'
import { clientDisplayName } from '@/lib/utils/clients'

// Zusammenfassende Meldung: reverse-charge services to EU businesses are reported per recipient
// UID in the period the service was performed (§ 21 Abs 3 UStG), not when the money arrived.

export interface ZmClient { name: string; company: string | null; uid_number: string | null; country: string | null }

export interface ZmDoc {
  id: string
  type: string
  number: string | null
  status: string
  date: string
  service_date: string | null
  service_date_end: string | null
  converted_from_id: string | null
  client_id: string
  discount_type: string | null
  discount_value: number | null
  document_items: Parameters<typeof calcTotals>[0]
  clients: ZmClient | null
}

export interface ZmRow {
  key: string
  country: string
  uid: string | null
  client: string
  net: number
  documents: { id: string; type: string; number: string }[]
}

const ZM_COLUMNS = 'id, type, number, status, date, service_date, service_date_end, converted_from_id, client_id, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), clients(name, company, uid_number, country)'

// Documents are dated up to two years before (billed in advance) or after (billed late) the
// service they report; the window keeps the query bounded, buildZmRows picks the period exactly.
// `error` is the database's English text, for logs only.
export async function fetchZmRows(supabase: SupabaseClient, start: string, end: string): Promise<{ rows: ZmRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('documents')
    .select(ZM_COLUMNS)
    .in('type', ['invoice', 'credit_note'])
    .eq('tax_treatment', 'eu_reverse_charge')
    .not('number', 'is', null)
    .gte('date', addDays(start, -731))
    .lte('date', addDays(end, 731))
  if (error) {
    console.error('[zm] documents not loaded:', error.code, error.message)
    return { rows: [], error: error.message }
  }
  return { rows: buildZmRows((data ?? []) as unknown as ZmDoc[], start, end), error: null }
}

export function attributionDate(d: Pick<ZmDoc, 'date' | 'service_date' | 'service_date_end'>): string {
  return d.service_date_end || d.service_date || d.date
}

// Invoices count with their net, cancelled ones included (their Storno offsets them); a credit
// note corrects the period of the invoice it refers to and counts negative; a voided credit
// note counts nothing. Recipients whose documents net to zero are left out.
export function buildZmRows(docs: ZmDoc[], start: string, end: string): ZmRow[] {
  const byId = new Map(docs.map(d => [d.id, d]))
  const rows = new Map<string, ZmRow>()
  for (const d of docs) {
    if (!d.number) continue
    const isCredit = d.type === 'credit_note'
    if (isCredit && d.status === 'cancelled') continue
    if (!isCredit && d.type !== 'invoice') continue
    const original = isCredit && d.converted_from_id ? byId.get(d.converted_from_id) : undefined
    const when = attributionDate(original ?? d)
    if (when < start || when > end) continue

    const t = calcTotals(d.document_items ?? [], [], d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null, 'eu_reverse_charge')
    const net = (t.subtotal - t.discount_amount) * (isCredit ? -1 : 1)
    const uid = d.clients?.uid_number ? normalizeVatId(d.clients.uid_number) : null
    const key = uid ?? `client:${d.client_id}`
    const row = rows.get(key) ?? {
      key,
      country: uid ? uid.slice(0, 2) : '',
      uid,
      client: clientDisplayName(d.clients),
      net: 0,
      documents: [],
    }
    row.net = roundCents(row.net + net)
    row.documents.push({ id: d.id, type: d.type, number: d.number })
    rows.set(key, row)
  }
  return [...rows.values()]
    .filter(r => r.net !== 0)
    .sort((a, b) => a.country.localeCompare(b.country) || a.client.localeCompare(b.client))
}
