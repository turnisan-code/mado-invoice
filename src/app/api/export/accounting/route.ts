import { NextRequest, NextResponse } from 'next/server'
import type { createClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth'
import { calcTotals, formatDate, today } from '@/lib/utils/document'
import { toCsv, csvDate, type CsvValue } from '@/lib/utils/csv'
import { createZipStream, type ZipEntry } from '@/lib/utils/zip'
import { toPublicSettings } from '@/lib/public-settings'
import { getT } from '@/lib/i18n/server'
import type { DictKey, TFn } from '@/lib/i18n'
import type { DocumentType, Settings } from '@/types'
import { docTypeLabel, statusLabel } from '@/lib/document-labels'
import { parsePeriod, periodLabel, periodSlug, MAX_PDFS, MAX_YEAR, MIN_YEAR, type Period } from '@/app/(app)/reports/period'
import { fetchZmRows } from '@/app/(app)/reports/zm'

// A year's PDF ZIP downloads hundreds of files from storage while it streams.
export const maxDuration = 300

const ITEM_COLS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
const RATES = [20, 13, 10, 0] as const
const KINDS = ['documents', 'payments', 'zm', 'pdfs', 'backup'] as const
type Kind = typeof KINDS[number]
const PAGE = 1000
// PostgREST's "table not in the schema cache" and Postgres' "relation does not exist".
const MISSING_TABLE = new Set(['PGRST205', '42P01'])

type Supabase = Awaited<ReturnType<typeof createClient>>
type ClientRef = { name: string; company: string | null; uid_number?: string | null } | null

const clientLabel = (c: ClientRef) => c ? (c.company && c.name ? `${c.company} (${c.name})` : c.company || c.name) : ''

function servicePeriod(start: string | null, end: string | null) {
  if (!start) return ''
  return end && end !== start ? `${csvDate(start)} – ${csvDate(end)}` : csvDate(start)
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

// One row per issued document; credit notes carry negative amounts so column sums are the
// period's turnover. A voided credit note keeps its row (its number stays in the sequence) but no
// amounts, so the sums agree with the UVA, which ignores it. A cancelled invoice keeps its amounts:
// its Storno offsets them. Paid/open only exist for invoices (refunds are in the payments CSV).
async function documentsCsv(supabase: Supabase, period: Period, t: TFn) {
  const result = await fetchPaged((from, to) => supabase
    .from('documents')
    .select(`type, number, date, service_date, service_date_end, status, tax_treatment, discount_type, discount_value, bookamat_booking_id, clients(name, company, uid_number), ${ITEM_COLS}, payments(amount, kind), bookamat_bookings(year, booking_id)`)
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .gte('date', period.start)
    .lte('date', period.end)
    .order('date')
    .order('number')
    .range(from, to))
  if ('error' in result) return result

  const rows: CsvValue[][] = result.rows.map(d => {
    const totals = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    const isInvoice = d.type === 'invoice'
    const voided = !isInvoice && d.status === 'cancelled'
    const amount = (n: number) => voided ? null : (isInvoice ? n : -n)
    const client = d.clients as unknown as ClientRef
    return [
      docTypeLabel(t, d.type as DocumentType),
      d.number,
      csvDate(d.date),
      servicePeriod(d.service_date, d.service_date_end),
      clientLabel(client),
      client?.uid_number ?? '',
      ...RATES.map(r => amount(totals.vat_groups.find(g => g.rate === r)?.base ?? 0)),
      amount(totals.total_vat),
      amount(totals.total),
      isInvoice ? totals.total_paid : null,
      isInvoice ? (d.status === 'cancelled' ? 0 : totals.balance_due) : null,
      statusLabel(t, d.status),
      t(`taxTreatmentsShort.${d.tax_treatment}` as DictKey),
      bookamatIds(d.bookamat_bookings as { year: number; booking_id: string }[] | null, d.bookamat_booking_id),
    ]
  })
  const header = (['type', 'number', 'date', 'servicePeriod', 'client', 'uid', 'net20', 'net13', 'net10', 'net0', 'vat', 'gross', 'paid', 'open', 'status', 'tax', 'bookamat'] as const)
    .map(k => t(`exports.csv.${k}`))
  return { csv: toCsv(header, rows) }
}

// "123 (2025); 456 (2026)": one Bookamat booking per year of money received.
function bookamatIds(bookings: { year: number; booking_id: string }[] | null, legacy: string | null): string {
  if (bookings?.length) return [...bookings].sort((a, b) => a.year - b.year).map(b => `${b.booking_id} (${b.year})`).join('; ')
  return legacy ?? ''
}

// Every row that settled or moved money on an invoice or credit note, labelled by kind; a refund
// paid back on a credit note is negative.
async function paymentsCsv(supabase: Supabase, period: Period, t: TFn) {
  const result = await fetchPaged((from, to) => supabase
    .from('payments')
    .select('date, amount, note, kind, method, reference, import_ref, documents!inner(number, type, clients(name, company))')
    .in('documents.type', ['invoice', 'credit_note'])
    .gte('date', period.start)
    .lte('date', period.end)
    .order('date')
    .order('id')
    .range(from, to))
  if ('error' in result) return result

  const kindLabel: Record<string, string> = {
    payment: t('exports.csv.kindPayment'), skonto: t('exports.csv.kindSkonto'), writeoff: t('exports.csv.kindWriteoff'),
    credit: t('books.csv.kindCredit'), refund: t('books.csv.kindRefund'), fee: t('books.csv.kindFee'),
  }
  const rows: CsvValue[][] = result.rows.map(p => {
    const doc = p.documents as unknown as { number: string | null; type: DocumentType; clients: ClientRef }
    return [
      csvDate(p.date),
      docTypeLabel(t, doc.type),
      doc.number ?? '',
      clientLabel(doc.clients),
      kindLabel[p.kind] ?? p.kind,
      p.method === 'cash' ? t('payments.methodCash') : t('payments.methodBank'),
      p.kind === 'refund' ? -p.amount : p.amount,
      p.reference ?? '',
      p.note ?? '',
      p.import_ref ?? '',
    ]
  })
  const header = [
    t('exports.csv.date'), t('exports.csv.type'), t('books.csv.document'), t('exports.csv.client'), t('exports.csv.kind'),
    t('exports.csv.method'), t('exports.csv.amount'), t('books.csv.reference'), t('exports.csv.note'), t('exports.csv.importRef'),
  ]
  return { csv: toCsv(header, rows) }
}

async function zmCsv(supabase: Supabase, period: Period, t: TFn) {
  const { rows, error } = await fetchZmRows(supabase, period.start, period.end)
  if (error) return { error }
  const header = (['country', 'uid', 'client', 'netAmount', 'otherService', 'documents'] as const).map(k => t(`exports.csv.${k}`))
  return {
    csv: toCsv(header, rows.map(r => [r.country, r.uid ?? '', r.client, r.net, t('exports.csv.yes'), r.documents.map(d => d.number).join(', ')])),
  }
}

// PostgREST returns at most 1000 rows per request; a year's export or a backup must not be cut
// off silently. The query must have a stable order.
async function fetchPaged<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>): Promise<{ rows: T[] } | { error: string; code?: string }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1)
    if (error) return { error: error.message, code: error.code }
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < PAGE) return { rows }
  }
}

function fetchAll(supabase: Supabase, table: string) {
  return fetchPaged<Record<string, unknown>>((from, to) => supabase.from(table).select('*').order('id').range(from, to))
}

const BACKUP_TABLES = ['clients', 'catalogue_items', 'documents', 'document_items', 'payments', 'reminder_log', 'recurring_schedules'] as const
// Tables that only exist once their migration has run; a backup without them is still complete.
const OPTIONAL_TABLES = ['document_events', 'bookamat_bookings'] as const

async function backupResponse(supabase: Supabase) {
  const tables: Record<string, unknown[]> = {}
  const settings = await fetchAll(supabase, 'settings')
  if ('error' in settings) return NextResponse.json({ error: settings.error }, { status: 500 })
  // Gmail tokens and the Bookamat key are credentials, not data: they never leave the server.
  tables.settings = settings.rows.map(s => ({ ...toPublicSettings(s as unknown as Settings), drive_folder_id: s.drive_folder_id ?? null }))
  for (const table of BACKUP_TABLES) {
    const result = await fetchAll(supabase, table)
    if ('error' in result) return NextResponse.json({ error: `${table}: ${result.error}` }, { status: 500 })
    tables[table] = result.rows
  }
  for (const table of OPTIONAL_TABLES) {
    const result = await fetchAll(supabase, table)
    if ('rows' in result) tables[table] = result.rows
    else if (!MISSING_TABLE.has(result.code ?? '')) return NextResponse.json({ error: `${table}: ${result.error}` }, { status: 500 })
  }

  const body = JSON.stringify({ format: 'mado-invoice-backup', version: 1, exported_at: new Date().toISOString(), tables }, null, 2)
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="mado-invoice-backup-${today()}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}

// The frozen PDFs exactly as issued; the next file downloads from storage while the current one
// streams out, so at most two PDFs are held in memory.
async function pdfZipResponse(supabase: Supabase, period: Period, t: TFn, lang: 'de' | 'en') {
  const { data, error } = await supabase
    .from('documents')
    .select('id, number, date, pdf_path')
    .in('type', ['invoice', 'credit_note'])
    .not('number', 'is', null)
    .gte('date', period.start)
    .lte('date', period.end)
    .order('date')
    .order('number')
    .limit(MAX_PDFS + 1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const docs = data ?? []
  if (docs.length > MAX_PDFS) {
    return NextResponse.json({ error: t('exports.files.tooMany', { count: `${MAX_PDFS}+` }) }, { status: 413 })
  }
  if (!docs.length) {
    const label = periodLabel(period, lang, t('reports.yearLabel', { year: period.year }))
    return NextResponse.json({ error: t('exports.files.pdfsNone', { period: label }) }, { status: 404 })
  }

  async function load(path: string | null): Promise<Uint8Array | null> {
    if (!path) return null
    try {
      const { data: file, error: downloadErr } = await supabase.storage.from('documents').download(path)
      return downloadErr || !file ? null : new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  async function* entries(): AsyncGenerator<ZipEntry> {
    const missing: string[] = []
    let next = load(docs[0].pdf_path)
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      const bytes = await next
      if (i + 1 < docs.length) next = load(docs[i + 1].pdf_path)
      const label = `${doc.number} (${formatDate(doc.date, lang)})`
      if (!doc.pdf_path) { missing.push(label); continue }
      if (!bytes) { missing.push(`${label} — ${t('exports.files.missingFile')}`); continue }
      yield { name: doc.pdf_path, data: bytes }
    }
    if (missing.length) {
      yield { name: 'missing.txt', data: new TextEncoder().encode(`${t('exports.files.missingTitle')}\r\n\r\n${missing.join('\r\n')}\r\n`) }
    }
  }

  return new NextResponse(createZipStream(entries()), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="belege-${periodSlug(period)}.zip"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(req: NextRequest) {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const params = req.nextUrl.searchParams
  const kind = params.get('kind') as Kind
  const yearParam = params.get('year')
  const year = Number(yearParam)
  if (!KINDS.includes(kind) || (yearParam !== null && (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR))) {
    return NextResponse.json({ error: `kind=${KINDS.join('|')} and an optional period=month|quarter|year, year=YYYY, quarter=1-4, month=1-12` }, { status: 400 })
  }

  const { t, lang } = await getT()
  if (kind === 'backup') return backupResponse(supabase)

  // Without a period the export covers the whole year, as the original year-only links did.
  const period = parsePeriod({
    period: params.get('period'), year: yearParam, quarter: params.get('quarter'), month: params.get('month'),
  }, today(), 'year')
  if (kind === 'pdfs') return pdfZipResponse(supabase, period, t, lang)

  const slug = periodSlug(period)
  const result = kind === 'documents' ? await documentsCsv(supabase, period, t)
    : kind === 'payments' ? await paymentsCsv(supabase, period, t)
    : await zmCsv(supabase, period, t)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 500 })

  const filename = kind === 'documents' ? `belege-${slug}.csv` : kind === 'payments' ? `zahlungen-${slug}.csv` : `zm-${slug}.csv`
  return csvResponse(result.csv, filename)
}
