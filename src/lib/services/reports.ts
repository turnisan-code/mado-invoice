// The figures behind the dashboard, the VAT report (Ist) and the client statement, shared with
// Claude's read tools. Each takes the RLS-bound client it is given and returns numbers and rows
// only; the pages and the statement route word and render them.
import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, roundCents } from '@/lib/utils/document'
import { creditNoteOpen, isOverdue } from '@/lib/status'
import { unappliedCreditNotes, type UnappliedCredit } from '@/lib/credits'
import { selectStatementRows, statementRows, statementSums, type StatementDoc, type StatementRow, type StatementSum } from '@/lib/statement'
import { fetchZmRows } from '@/app/(app)/reports/zm'
import { istTurnover, type InvoiceHistory } from '@/app/(app)/reports/ist'
import type { Period } from '@/app/(app)/reports/period'
import type { Client } from '@/types'

type ClientRef = { name: string; company: string | null } | null
type DocItems = Parameters<typeof calcTotals>[0]

// ─── Dashboard ───────────────────────────────────────────────────────────────

// Month keys come from the Vienna calendar date and are shifted in UTC, so neither the server's
// time zone nor a 31st (setMonth overflow) can move a payment into the wrong month.
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export type DashboardInvoice = {
  id: string
  number: string | null
  status: string
  due_date: string | null
  currency: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  clients: ClientRef
  document_items: DocItems
  payments: { amount: number; kind?: string | null }[]
}

export type PortalResponse = { id: string; created_at: string; detail: { action?: string }; documents: { id: string; number: string | null; clients: ClientRef } }

export interface DashboardFigures {
  now: string
  thisMonth: string
  thisYear: string
  overdue: DashboardInvoice[]
  open: DashboardInvoice[]
  overdueTotal: number
  openTotal: number
  outstanding: number
  outstandingCount: number
  oldestOverdueDays: number | null
  revenueThisMonth: number
  revenueLastMonth: number
  paidThisMonthCount: number
  momDelta: number | null
  revenueThisYear: number
  recentPaid: { doc: DashboardInvoice; paidOn: string }[]
  // The last 12 months, oldest first.
  months: { yearMonth: string; revenue: number; current: boolean }[]
  chartTotal: number
  pendingQuotes: { id: string; number: string | null; date: string; due_date: string | null; clients: ClientRef }[]
  responses: PortalResponse[]
  unapplied: UnappliedCredit[]
  unarchived: { id: string; type: string; number: string | null }[]
  unarchivedCount: number
}

export function dashboardInvoiceTotals(doc: DashboardInvoice) {
  return calcTotals(
    doc.document_items ?? [],
    doc.payments ?? [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )
}

export async function loadDashboardFigures(supabase: SupabaseClient, now: string): Promise<DashboardFigures> {
  const thisMonth = now.slice(0, 7)
  const thisYear = now.slice(0, 4)
  const lastMonth = shiftMonth(thisMonth, -1)
  const chartMonths = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, i - 11))
  // The earliest month any figure needs: the chart window, last month or 1 January.
  const since = `${[chartMonths[0], lastMonth, `${thisYear}-01`].sort()[0]}-01`

  const items = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
  const invoiceCols = `id, number, status, due_date, currency, tax_treatment, discount_type, discount_value, clients(name, company), ${items}, payments(amount, kind)`

  const [{ data: activeInvoices }, { data: received }, { data: refundRows }, { data: paidPayments }, { data: quotes }, { data: responseEvents }, unapplied, { data: unarchived, count: unarchivedCount }] = await Promise.all([
    supabase.from('documents').select(invoiceCols).eq('type', 'invoice').in('status', ['sent', 'overdue']),
    // Revenue is cash-based (Ist-Besteuerung): every money payment counts on the day it arrived,
    // whatever the invoice status; Skonto and write-offs close invoices without revenue.
    supabase.from('payments').select('amount, date, document_id, documents!inner(type)').eq('documents.type', 'invoice').eq('kind', 'payment').gte('date', since),
    // Money paid back on credit notes leaves again on the day it was paid.
    supabase.from('payments').select('amount, date').eq('kind', 'refund').gte('date', since),
    // Recently paid = the invoices whose latest payment is newest, not the newest invoices.
    supabase
      .from('payments')
      .select(`id, date, document_id, documents!inner(type, ${invoiceCols})`)
      .eq('documents.type', 'invoice')
      .eq('documents.status', 'paid')
      // An applied credit note is no money received and fees come on top; neither dates a payment here.
      .in('kind', ['payment', 'skonto', 'writeoff'])
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .limit(40),
    supabase.from('documents').select('id, number, date, due_date, clients(name, company)').eq('type', 'quote').eq('status', 'sent').order('date', { ascending: false }).limit(5),
    // Client answers in the portal stay here until the owner opens the quote.
    supabase
      .from('document_events')
      .select('id, created_at, detail, documents!inner(id, number, clients(name, company))')
      .eq('type', 'portal_responded')
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(10),
    // Credit notes that should already have reduced their invoice's balance.
    unappliedCreditNotes(supabase).catch(err => {
      console.error('[dashboard] unapplied credit notes:', err)
      return []
    }),
    // Issued documents whose frozen PDF (the archive copy) was never stored.
    supabase
      .from('documents')
      .select('id, type, number', { count: 'exact' })
      .in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null)
      .is('pdf_path', null)
      .order('date', { ascending: false })
      .limit(5),
  ])
  const responses = (responseEvents ?? []) as unknown as PortalResponse[]

  const active = (activeInvoices ?? []) as unknown as DashboardInvoice[]
  const payments = (received ?? []) as unknown as { amount: number; date: string; document_id: string }[]
  // Revenue is money received less money paid back.
  const moneyRows = [...payments, ...((refundRows ?? []) as { amount: number; date: string }[]).map(r => ({ amount: -r.amount, date: r.date }))]

  // Only what is still owed counts: an invoice with a zero total or a settled balance is neither
  // outstanding nor overdue, and the due date decides which of the two (isOverdue).
  const owing = active.filter(i => {
    const totals = dashboardInvoiceTotals(i)
    return totals.total > 0.005 && totals.balance_due > 0.005
  })
  const overdue = owing.filter(i => isOverdue(i, now))
  const open = owing.filter(i => !isOverdue(i, now))

  // Outstanding money is what is still unpaid, not the invoice totals
  const overdueTotal = roundCents(overdue.reduce((s, d) => s + dashboardInvoiceTotals(d).balance_due, 0))
  const openTotal = roundCents(open.reduce((s, d) => s + dashboardInvoiceTotals(d).balance_due, 0))
  const outstanding = roundCents(overdueTotal + openTotal)
  const outstandingCount = open.length + overdue.length

  const withDueDate = overdue.filter(i => i.due_date)
  const oldestOverdueDays = withDueDate.length
    ? Math.max(...withDueDate.map(i => Math.floor((new Date(now).getTime() - new Date(i.due_date!).getTime()) / 86400000)))
    : null

  const inMonth = (m: string) => moneyRows.filter(p => p.date?.startsWith(m))
  const sum = (ps: { amount: number }[]) => roundCents(ps.reduce((s, p) => s + p.amount, 0))
  const revenueThisMonth = sum(inMonth(thisMonth))
  const revenueLastMonth = sum(inMonth(lastMonth))
  const paidThisMonthCount = new Set(payments.filter(p => p.date?.startsWith(thisMonth)).map(p => p.document_id)).size
  const momDelta = revenueLastMonth > 0
    ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
    : null
  const revenueThisYear = sum(moneyRows.filter(p => p.date?.startsWith(thisYear)))

  const recentPaid: { doc: DashboardInvoice; paidOn: string }[] = []
  const seen = new Set<string>()
  for (const p of (paidPayments ?? []) as unknown as { date: string; document_id: string; documents: DashboardInvoice }[]) {
    if (seen.has(p.document_id)) continue
    seen.add(p.document_id)
    recentPaid.push({ doc: p.documents, paidOn: p.date })
    if (recentPaid.length === 6) break
  }

  // Last 12 months from payment dates
  const months = chartMonths.map(key => ({ yearMonth: key, revenue: sum(inMonth(key)), current: key === thisMonth }))
  const chartTotal = sum(months.map(m => ({ amount: m.revenue })))

  return {
    now, thisMonth, thisYear,
    overdue, open, overdueTotal, openTotal, outstanding, outstandingCount, oldestOverdueDays,
    revenueThisMonth, revenueLastMonth, paidThisMonthCount, momDelta, revenueThisYear,
    recentPaid, months, chartTotal,
    pendingQuotes: (quotes ?? []) as unknown as DashboardFigures['pendingQuotes'],
    responses,
    unapplied,
    unarchived: (unarchived ?? []) as DashboardFigures['unarchived'],
    unarchivedCount: unarchivedCount ?? 0,
  }
}

// ─── VAT report (Ist) ────────────────────────────────────────────────────────

export type ReportDoc = {
  id: string
  number: string | null
  date: string
  type?: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: DocItems
  clients?: ClientRef
}

function docTotals(d: ReportDoc) {
  return calcTotals(
    d.document_items ?? [],
    [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
}

export interface IstReport {
  countedPayments: { id: string; date: string; amount: number; method: string; doc: ReportDoc }[]
  invoiceCount: number
  countedCredits: { key: string; doc: ReportDoc; date: string; amount: number; appliedTo: string | null }[]
  creditNoteCount: number
  deductedCount: number
  unsettled: { doc: ReportDoc; open: number }[]
  unapplied: UnappliedCredit[]
  vat: Record<number, { base: number; vat: number }>
  // Rates with a base or VAT left, highest first.
  rates: number[]
  taxableBase: number
  totalVat: number
  rcBase: number
  nonEuBase: number
  netTotal: number
  zm: Awaited<ReturnType<typeof fetchZmRows>>
  zmTotal: number
  zmMissingUid: boolean
  issuedCount: number | null
  feesReceived: number
}

// Ist-Besteuerung (see ist.ts): money received on invoices, split at the rates left after the
// credit notes applied to them, and refunds paid on credit notes, each in the period it
// happened. Skonto and write-offs close invoices without revenue and are not read at all.
export async function loadIstReport(supabase: SupabaseClient, period: Period): Promise<IstReport> {
  const itemCols = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'
  const docCols = `id, number, date, type, tax_treatment, discount_type, discount_value, ${itemCols}, clients(name, company)`
  const [{ data: payments }, { data: credits }, { data: refunds }, { data: openCreditNotes }, zm, { count: issuedCount }, unapplied, { data: feeRows }] = await Promise.all([
    supabase
      .from('payments')
      .select(`id, amount, date, method, document_id, documents!inner(${docCols})`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'payment')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    // Every credit note applied to its invoice (rows on the invoice): a credit before the period
    // changes how the period's payments split, and the open ones below need all of them.
    supabase
      .from('payments')
      .select(`id, amount, date, credit_note_id, documents!inner(${docCols})`)
      .eq('documents.type', 'invoice')
      .eq('kind', 'credit')
      .order('date'),
    // Money paid back on credit notes in the period.
    supabase
      .from('payments')
      .select(`id, amount, date, method, documents!inner(${docCols})`)
      .eq('documents.type', 'credit_note')
      .eq('kind', 'refund')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date'),
    // Issued credit notes up to the period end, to point out the ones not settled yet.
    supabase
      .from('documents')
      .select(`${docCols}, payments(amount, kind)`)
      .eq('type', 'credit_note')
      .eq('status', 'sent')
      .not('number', 'is', null)
      .lte('date', period.end)
      .order('date'),
    fetchZmRows(supabase, period.start, period.end),
    supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null)
      .gte('date', period.start)
      .lte('date', period.end),
    unappliedCreditNotes(supabase).catch(err => {
      console.error('[reports] unapplied credit notes:', err)
      return []
    }),
    // Dunning fees and interest received: money, but no turnover; only mentioned.
    supabase.from('payments').select('amount').eq('kind', 'fee').gte('date', period.start).lte('date', period.end),
  ])
  const feesReceived = roundCents((feeRows ?? []).reduce((s, r) => s + Number(r.amount), 0))
  const creditRows = (credits ?? []) as unknown as { id: string; amount: number; date: string; credit_note_id: string; documents: ReportDoc }[]
  const refundRows = (refunds ?? []) as unknown as { id: string; amount: number; date: string; method: string; documents: ReportDoc }[]
  const unsettledCns = (openCreditNotes ?? []) as unknown as (ReportDoc & { payments: { amount: number; kind: string }[] | null })[]
  const invoiceIds = new Set<string>()
  const countedPayments: IstReport['countedPayments'] = []
  for (const p of payments ?? []) {
    const d = p.documents as unknown as ReportDoc
    if (!docTotals(d).total) continue
    invoiceIds.add(d.id)
    countedPayments.push({ id: p.id, date: p.date, amount: p.amount, method: p.method, doc: d })
  }
  const inPeriod = (date: string) => date >= period.start && date <= period.end
  const periodCredits = creditRows.filter(r => inPeriod(r.date))
  // Invoices the period touches (a payment or a credit in it) need their history: credits up to
  // its end re-split the money, and money received before it caps what still counts (an
  // overpayment is no turnover).
  const touched = new Set([...invoiceIds, ...periodCredits.map(r => r.documents.id)])
  const historyCredits = creditRows.filter(r => r.date <= period.end && touched.has(r.documents.id))
  // payments.credit_note_id has no embeddable foreign key, so the credit notes are looked up by id.
  const cnIds = [...new Set(historyCredits.map(r => r.credit_note_id))]
  const touchedIds = [...touched]
  const [{ data: cnDocs }, earlierPayments] = await Promise.all([
    cnIds.length
      ? supabase.from('documents').select(docCols).in('id', cnIds)
      : Promise.resolve({ data: [] as unknown[] }),
    // .in() filters travel in the URL: a year's invoices are looked up in slices.
    Promise.all(Array.from({ length: Math.ceil(touchedIds.length / 100) }, (_, i) =>
      supabase.from('payments').select('document_id, date, amount').eq('kind', 'payment').in('document_id', touchedIds.slice(i * 100, i * 100 + 100)).lt('date', period.start),
    )).then(results => results.flatMap(r => {
      if (r.error) console.error('[reports] earlier payments:', r.error.message)
      return r.data ?? []
    })),
  ])
  const cnById = new Map(((cnDocs ?? []) as unknown as ReportDoc[]).map(d => [d.id, d]))

  const histories = new Map<string, InvoiceHistory>()
  const historyOf = (doc: ReportDoc) => {
    let h = histories.get(doc.id)
    if (!h) histories.set(doc.id, h = { invoice: doc, payments: [], credits: [] })
    return h
  }
  for (const p of countedPayments) historyOf(p.doc).payments.push({ date: p.date, amount: p.amount })
  const applied: { id: string; date: string; amount: number; invoice: ReportDoc; creditNote: ReportDoc }[] = []
  for (const r of historyCredits) {
    const creditNote = cnById.get(r.credit_note_id)
    if (!creditNote) continue
    historyOf(r.documents).credits.push({ date: r.date, amount: r.amount, creditNote })
    if (inPeriod(r.date)) applied.push({ id: r.id, date: r.date, amount: r.amount, invoice: r.documents, creditNote })
  }
  for (const p of earlierPayments as { document_id: string; date: string; amount: number }[]) {
    histories.get(p.document_id)?.payments.push({ date: p.date, amount: p.amount })
  }
  const refunded = refundRows.map(r => ({ id: r.id, date: r.date, amount: r.amount, creditNote: r.documents }))
  const { vat, rcBase: rcRaw, nonEuBase: nonEuRaw } = istTurnover({
    start: period.start,
    end: period.end,
    invoices: [...histories.values()],
    refunded,
  })
  const rcBase = roundCents(rcRaw)
  const nonEuBase = roundCents(nonEuRaw)

  const countedCredits = [
    ...applied.map(a => ({ key: `a-${a.id}`, doc: a.creditNote, date: a.date, amount: a.amount, appliedTo: a.invoice.number ?? '' })),
    ...refunded.map(r => ({ key: `r-${r.id}`, doc: r.creditNote, date: r.date, amount: r.amount, appliedTo: null })),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const creditNoteCount = new Set(countedCredits.map(c => c.doc.id)).size
  // Only refunds take turnover off; an applied credit moves no money.
  const deductedCount = new Set(refunded.map(r => r.creditNote.id)).size

  const appliedByCn = new Map<string, number>()
  for (const r of creditRows) {
    appliedByCn.set(r.credit_note_id, (appliedByCn.get(r.credit_note_id) ?? 0) + r.amount)
  }
  const unsettled = unsettledCns
    .map(cn => ({
      doc: cn,
      open: creditNoteOpen(
        docTotals(cn).total,
        appliedByCn.get(cn.id) ?? 0,
        (cn.payments ?? []).filter(p => p.kind === 'refund').reduce((s, p) => s + p.amount, 0),
      ),
    }))
    .filter(c => c.open > 0.005)

  // A credit can leave a rate at zero (its line credited in full): no row for it.
  const rates = Object.keys(vat).map(Number)
    .filter(r => roundCents(vat[r].base) !== 0 || roundCents(vat[r].vat) !== 0)
    .sort((a, b) => b - a)
  const taxableBase = roundCents(rates.reduce((s, r) => s + vat[r].base, 0))
  const totalVat = roundCents(rates.reduce((s, r) => s + vat[r].vat, 0))
  const netTotal = roundCents(taxableBase + rcBase + nonEuBase)
  const zmTotal = roundCents(zm.rows.reduce((s, r) => s + r.net, 0))
  const zmMissingUid = zm.rows.some(r => !r.uid)

  return {
    countedPayments, invoiceCount: invoiceIds.size, countedCredits, creditNoteCount, deductedCount, unsettled, unapplied,
    vat, rates, taxableBase, totalVat, rcBase, nonEuBase, netTotal, zm, zmTotal, zmMissingUid, issuedCount: issuedCount ?? null, feesReceived,
  }
}

// ─── Client statement ────────────────────────────────────────────────────────

const STATEMENT_COLUMNS = 'id, type, number, date, due_date, status, currency, tax_treatment, discount_type, discount_value, cancels_document_id, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind, credit_note_id)'

// .in() lists travel in the URL, so long id lists are fetched in slices.
const SLICE = 100

async function inSlices<T>(ids: string[], fetch: (slice: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += SLICE) {
    const { data, error } = await fetch(ids.slice(i, i + SLICE))
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

// The Storno of every cancelled invoice and the invoice of every Storno that the statement's
// documents do not hold already (a Storno dated after `to`), so each pair nets out.
async function loadCounterparts(supabase: SupabaseClient, docs: StatementDoc[]): Promise<StatementDoc[]> {
  const ids = new Set(docs.map(d => d.id))
  const cancelledWithoutStorno = docs
    .filter(d => d.type === 'invoice' && d.status === 'cancelled' && !docs.some(c => c.cancels_document_id === d.id))
    .map(d => d.id)
  const missingInvoices = [...new Set(docs.map(d => d.cancels_document_id).filter((v): v is string => !!v && !ids.has(v)))]
  const [stornos, invoices] = await Promise.all([
    inSlices<StatementDoc>(cancelledWithoutStorno, slice => supabase
      .from('documents').select(STATEMENT_COLUMNS).eq('type', 'credit_note').not('number', 'is', null).in('cancels_document_id', slice)),
    inSlices<StatementDoc>(missingInvoices, slice => supabase
      .from('documents').select(STATEMENT_COLUMNS).eq('type', 'invoice').not('number', 'is', null).in('id', slice)),
  ])
  return [...stornos, ...invoices].filter(d => !ids.has(d.id))
}

export interface ClientStatement {
  client: Client
  rows: StatementRow[]
  sums: StatementSum[]
}

// Every issued invoice and credit note dated from…to plus older ones still open (with openOnly:
// every open one up to `to`), as of today. Null when the client is not found; throws on a failed query.
export async function loadClientStatement(
  supabase: SupabaseClient,
  clientId: string,
  period: { from: string; to: string; openOnly: boolean },
): Promise<ClientStatement | null> {
  // Everything up to `to`: older documents still open belong on the statement too.
  const [{ data: client, error: clientErr }, { data: docs, error: docsErr }] = await Promise.all([
    supabase.from('clients').select('*').eq('id', clientId).maybeSingle(),
    supabase
      .from('documents')
      .select(STATEMENT_COLUMNS)
      .eq('client_id', clientId)
      .in('type', ['invoice', 'credit_note'])
      .not('number', 'is', null)
      .lte('date', period.to)
      .order('date'),
  ])
  if (clientErr || docsErr) throw new Error((clientErr ?? docsErr)!.message)
  if (!client) return null

  const loaded = (docs ?? []) as unknown as StatementDoc[]
  const documents = [...loaded, ...await loadCounterparts(supabase, loaded)]
  // Applied credit notes are 'credit' rows on the invoice they correct, not on the credit note.
  const applied = new Map<string, number>()
  const credits = await inSlices<{ amount: number; credit_note_id: string }>(
    documents.filter(d => d.type === 'credit_note').map(d => d.id),
    slice => supabase.from('payments').select('amount, credit_note_id').eq('kind', 'credit').in('credit_note_id', slice),
  )
  for (const p of credits) applied.set(p.credit_note_id, (applied.get(p.credit_note_id) ?? 0) + Number(p.amount))

  const rows = selectStatementRows(statementRows(documents, applied), period)
  return { client: client as Client, rows, sums: statementSums(rows) }
}
