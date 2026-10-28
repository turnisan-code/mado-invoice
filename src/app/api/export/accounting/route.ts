import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calcTotals } from '@/lib/utils/document'
import { toCsv, csvDate, type CsvValue } from '@/lib/utils/csv'

const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
const RATES = [20, 13, 10, 0]
const TYPE_LABEL: Record<string, string> = { invoice: 'Rechnung', credit_note: 'Gutschrift' }
const TAX_LABEL: Record<string, string> = { at_vat: 'USt', eu_reverse_charge: 'Reverse Charge', non_eu: 'Drittland' }

type Supabase = Awaited<ReturnType<typeof createClient>>
type ClientRef = { name: string; company: string | null } | null

const clientLabel = (c: ClientRef) => c ? (c.company && c.name ? `${c.company} (${c.name})` : c.company || c.name) : ''

function servicePeriod(start: string | null, end: string | null) {
  if (!start) return ''
  return end && end !== start ? `${csvDate(start)} – ${csvDate(end)}` : csvDate(start)
}

// One row per issued document; credit notes carry negative amounts so column sums are the
// year's turnover. A voided credit note keeps its row (its number stays in the sequence) but no
// amounts, so the sums agree with the UVA, which ignores it. A cancelled invoice keeps its amounts:
// its Storno offsets them. Paid/open only exist for invoices: the app records no refunds.
async function documentsCsv(supabase: Supabase, start: string, end: string) {
  const { data, error } = await supabase
    .from('documents')
    .select(`type, number, date, service_date, service_date_end, status, tax_treatment, discount_type, discount_value, bookamat_booking_id, clients(name, company), ${ITEM_COLS}, payments(amount)`)
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .gte('date', start)
    .lte('date', end)
    .order('date')
    .order('number')
  if (error) return { error: error.message }

  const rows: CsvValue[][] = (data ?? []).map(d => {
    const t = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    const isInvoice = d.type === 'invoice'
    const voided = !isInvoice && d.status === 'cancelled'
    const amount = (n: number) => voided ? null : (isInvoice ? n : -n)
    return [
      TYPE_LABEL[d.type] ?? d.type,
      d.number,
      csvDate(d.date),
      servicePeriod(d.service_date, d.service_date_end),
      clientLabel(d.clients as unknown as ClientRef),
      ...RATES.map(r => amount(t.vat_groups.find(g => g.rate === r)?.base ?? 0)),
      amount(t.total_vat),
      amount(t.total),
      isInvoice ? t.total_paid : null,
      isInvoice ? (d.status === 'cancelled' ? 0 : t.balance_due) : null,
      d.status,
      TAX_LABEL[d.tax_treatment] ?? d.tax_treatment,
      d.bookamat_booking_id ?? '',
    ]
  })
  return {
    csv: toCsv(
      ['Art', 'Nummer', 'Datum', 'Leistungszeitraum', 'Kunde', 'Netto 20 %', 'Netto 13 %', 'Netto 10 %', 'Netto 0 %', 'USt', 'Brutto', 'Bezahlt', 'Offen', 'Status', 'Steuer', 'Bookamat-Buchung'],
      rows,
    ),
  }
}

async function paymentsCsv(supabase: Supabase, start: string, end: string) {
  const { data, error } = await supabase
    .from('payments')
    .select('date, amount, note, documents!inner(number, type, clients(name, company))')
    .eq('documents.type', 'invoice')
    .gte('date', start)
    .lte('date', end)
    .order('date')
  if (error) return { error: error.message }

  const rows: CsvValue[][] = (data ?? []).map(p => {
    const doc = p.documents as unknown as { number: string | null; clients: ClientRef }
    return [csvDate(p.date), doc.number ?? '', clientLabel(doc.clients), p.amount, p.note ?? '']
  })
  return { csv: toCsv(['Datum', 'Rechnung', 'Kunde', 'Betrag', 'Notiz'], rows) }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const year = parseInt(req.nextUrl.searchParams.get('year') ?? '', 10)
  const kind = req.nextUrl.searchParams.get('kind')
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || (kind !== 'documents' && kind !== 'payments')) {
    return NextResponse.json({ error: 'year=YYYY and kind=documents|payments required' }, { status: 400 })
  }

  const start = `${year}-01-01`
  const end = `${year}-12-31`
  const result = kind === 'documents' ? await documentsCsv(supabase, start, end) : await paymentsCsv(supabase, start, end)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 500 })

  const filename = kind === 'documents' ? `belege-${year}.csv` : `zahlungen-${year}.csv`
  return new NextResponse(result.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
