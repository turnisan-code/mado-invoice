// The reads behind the document, client and project pages, shared with Claude's read tools. Each
// takes the RLS-bound client it is given (the cookie session on a page, the grant's aal2 session
// in a tool) and returns what the page used to query itself. Pure helpers stay importable from
// client components: the lists word their statuses with the same functions.
import type { SupabaseClient } from '@supabase/supabase-js'
import { calcTotals, orderItems, roundCents } from '@/lib/utils/document'
import { clientDisplayName } from '@/lib/utils/clients'
import { creditNoteSettled, displayStatus, isOverdue } from '@/lib/status'
import type { CatalogueItem, Client, DocumentType, InvoiceKind, Payment, Project, ProjectExpense, RecurringSchedule, TimeEntry } from '@/types'
import { coveredPeriods, type CoveredPeriod } from '@/lib/utils/recurring'

type ListItem = {
  line_type?: string | null
  sort_order?: number | null
  quantity: number | null
  unit_price: number | null
  vat_rate: number | null
  discount_type?: string | null
  discount_value?: number | null
}
type Totaled = { document_items: ListItem[]; tax_treatment?: string | null; discount_type?: string | null; discount_value?: number | null }
type Paid = { payments?: { amount: number; kind?: string }[] | null }
type Stated = { status: string; due_date: string | null }

const discountOf = (d: Totaled) =>
  d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null

// ─── List statuses (InvoiceList, QuoteList, CreditNoteList and search_documents) ───

export function invoiceTotals(d: Totaled & Paid) {
  return calcTotals(d.document_items, d.payments ?? [], discountOf(d), d.tax_treatment)
}
export const invoiceTotal = (d: Totaled & Paid) => invoiceTotals(d).total
// Nothing is owed on a draft (not issued yet) or a cancelled invoice (settled by its Storno).
export const invoiceBalance = (d: Totaled & Paid & { status: string }) =>
  d.status === 'draft' || d.status === 'cancelled' ? 0 : invoiceTotals(d).balance_due
// Outstanding: issued and still owing something; a zero total or a settled balance never is.
export const isOpenInvoice = (d: Totaled & Paid & { status: string }) =>
  (d.status === 'sent' || d.status === 'overdue') && invoiceTotal(d) > 0.005 && invoiceBalance(d) > 0.005
// Between sent and overdue the due date decides, as in the filters and on the dashboard: the daily
// run only catches the stored status up, e.g. after a due date was extended.
export const invoiceListStatus = (d: Totaled & Paid & Stated, todayStr: string) =>
  d.status === 'sent' || d.status === 'overdue' ? (isOpenInvoice(d) && isOverdue(d, todayStr) ? 'overdue' : 'sent') : d.status
// Partly paid and written-off invoices show that instead of their stored status. Dunning fees
// and interest are paid on top and never change it.
export const invoiceShownStatus = (d: Totaled & Paid & Stated, todayStr: string) =>
  displayStatus({ type: 'invoice', status: invoiceListStatus(d, todayStr), total: invoiceTotal(d), payments: (d.payments ?? []).filter(p => p.kind !== 'fee') }, todayStr)

// Quotes and credit notes: the lines alone (payments never change a quote's or credit note's total).
export function linesTotal(d: Totaled) {
  return calcTotals(d.document_items, [], discountOf(d), d.tax_treatment).total
}
export const quoteExpired = (d: Stated, todayStr: string) => d.status === 'sent' && !!d.due_date && d.due_date < todayStr
export const quoteShownStatus = (d: Stated, todayStr: string) => quoteExpired(d, todayStr) ? 'expired' : d.status

// `applied`: the 'credit' rows that apply the credit note to its invoice; refunds are its own payments.
export function creditNoteIsSettled(d: Totaled & Paid & { applied?: number }) {
  const refunded = (d.payments ?? []).filter(p => p.kind === 'refund').reduce((s, p) => s + Number(p.amount), 0)
  return creditNoteSettled(linesTotal(d), d.applied ?? 0, refunded)
}
export const creditNoteShownStatus = (d: Totaled & Paid & { status: string; applied?: number }, todayStr: string) =>
  displayStatus({ type: 'credit_note', status: d.status, creditSettled: creditNoteIsSettled(d) }, todayStr)

// ─── Document lists ──────────────────────────────────────────────────────────

const ITEM_COLUMNS = 'document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)'

export const DOCUMENT_LIST_COLUMNS: Record<DocumentType, string> = {
  invoice: `id, number, status, invoice_kind, date, due_date, currency, client_id, tax_treatment, discount_type, discount_value, pdf_path, bookamat_error, bookamat_booking_id, clients(name, company), ${ITEM_COLUMNS}, payments(amount, kind), bookamat_bookings(year, booking_id)`,
  quote: `id, number, status, date, due_date, currency, client_id, tax_treatment, discount_type, discount_value, clients(name, company), ${ITEM_COLUMNS}`,
  credit_note: `id, number, status, date, currency, client_id, tax_treatment, discount_type, discount_value, clients(name, company), ${ITEM_COLUMNS}, payments(amount, kind)`,
}

export interface ListedDocument extends Totaled, Paid {
  id: string
  number: string | null
  status: string
  date: string | null
  due_date?: string | null
  currency: string | null
  client_id: string | null
  clients: { name: string; company: string | null } | null
  invoice_kind?: InvoiceKind | null
  pdf_path?: string | null
  bookamat_error?: string | null
  bookamat_booking_id?: string | null
  bookamat_bookings?: { year: number; booking_id: string }[] | null
  // Credit notes: the sum of the 'credit' rows that apply it to its invoice.
  applied?: number
}

type DbError = { message: string; code?: string | null; details?: string | null }

// Every document of a type, newest first, as its list page shows them.
export async function listDocuments(supabase: SupabaseClient, type: DocumentType): Promise<{ data: ListedDocument[] | null; error: DbError | null }> {
  const docs = supabase.from('documents').select(DOCUMENT_LIST_COLUMNS[type]).eq('type', type).order('date', { ascending: false })
  if (type !== 'credit_note') {
    const { data, error } = await docs
    return { data: data as unknown as ListedDocument[] | null, error }
  }
  // A credit note is settled by refunds (its own payments) and by 'credit' rows on the invoice
  // it was applied to, which only point back through credit_note_id.
  const [{ data, error }, { data: credits }] = await Promise.all([
    docs,
    supabase.from('payments').select('credit_note_id, amount').eq('kind', 'credit'),
  ])
  const applied = new Map<string, number>()
  for (const row of credits ?? []) {
    if (row.credit_note_id) applied.set(row.credit_note_id, (applied.get(row.credit_note_id) ?? 0) + Number(row.amount))
  }
  const rows = ((data ?? []) as unknown as ListedDocument[]).map(d => ({ ...d, applied: applied.get(d.id) ?? 0 }))
  return { data: rows, error }
}

export type DocumentView = 'open' | 'overdue' | 'partially_paid' | 'written_off' | 'expired' | 'settled'

export interface DocumentSearch {
  type: DocumentType
  status?: string
  view?: DocumentView
  clientId?: string
  q?: string
  dateFrom?: string
  dateTo?: string
}

export interface DocumentSummary {
  id: string
  type: DocumentType
  number: string | null
  status: string
  display_status: string
  date: string | null
  due_date: string | null
  client: { id: string | null; name: string }
  currency: string
  total: number
  // Invoices: what is still owed. Credit notes: what is not applied or paid back yet. Quotes: null.
  balance_due: number | null
  invoice_kind?: InvoiceKind | null
}

type SummaryWork = DocumentSummary & { listStatus: string; open: boolean; searchText: string }

export function summarizeDocument(type: DocumentType, d: ListedDocument, todayStr: string): SummaryWork {
  const base = {
    id: d.id, type, number: d.number, date: d.date, due_date: type === 'credit_note' ? null : d.due_date ?? null,
    client: { id: d.client_id, name: clientDisplayName(d.clients) }, currency: d.currency ?? 'EUR',
    // The lists' search: number, contact name and company.
    searchText: `${d.number ?? ''} ${d.clients?.name ?? ''} ${d.clients?.company ?? ''}`.toLowerCase(),
  }
  if (type === 'invoice') {
    const open = isOpenInvoice(d)
    return {
      ...base, status: d.status, display_status: invoiceShownStatus({ ...d, due_date: d.due_date ?? null }, todayStr),
      total: invoiceTotal(d), balance_due: invoiceBalance(d), invoice_kind: d.invoice_kind ?? 'standard',
      listStatus: invoiceListStatus({ ...d, due_date: d.due_date ?? null }, todayStr), open,
    }
  }
  const total = linesTotal(d)
  if (type === 'quote') {
    const shown = quoteShownStatus({ status: d.status, due_date: d.due_date ?? null }, todayStr)
    return { ...base, status: d.status, display_status: shown, total, balance_due: null, listStatus: d.status, open: shown === 'sent' }
  }
  const refunded = (d.payments ?? []).filter(p => p.kind === 'refund').reduce((s, p) => s + Number(p.amount), 0)
  const issued = !!d.number && d.status === 'sent'
  const openCredit = issued ? Math.max(0, roundCents(total - (d.applied ?? 0) - refunded)) : 0
  return {
    ...base, status: d.status, display_status: creditNoteShownStatus(d, todayStr), total, balance_due: openCredit,
    listStatus: d.status, open: openCredit > 0.005,
  }
}

// The filters of the list pages: stored status (invoices: sent/overdue by the due date, as the
// list shows it), a derived view, client, date range and the search of the lists (number or client).
export function filterDocuments(rows: SummaryWork[], search: DocumentSearch): DocumentSummary[] {
  const q = search.q?.trim().toLowerCase()
  return rows
    .filter(r => !search.status || r.listStatus === search.status)
    .filter(r => {
      switch (search.view) {
        case undefined: return true
        case 'open': return r.open
        case 'overdue': return r.listStatus === 'overdue'
        default: return r.display_status === search.view
      }
    })
    .filter(r => !search.clientId || r.client.id === search.clientId)
    .filter(r => !search.dateFrom || (!!r.date && r.date >= search.dateFrom))
    .filter(r => !search.dateTo || (!!r.date && r.date <= search.dateTo))
    .filter(r => !q || r.searchText.includes(q))
    .map(r => {
      const summary: DocumentSummary & Partial<Pick<SummaryWork, 'listStatus' | 'open' | 'searchText'>> = { ...r }
      delete summary.listStatus
      delete summary.open
      delete summary.searchText
      return summary
    })
}

// ─── One document ────────────────────────────────────────────────────────────

export type DetailDocument = {
  id: string
  type: DocumentType
  number: string | null
  status: string
  client_id: string
  date: string
  due_date: string | null
  service_date: string | null
  service_date_end?: string | null
  language: string
  currency: string
  tax_treatment: string
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  notes: string | null
  notes_internal: string | null
  invoice_kind?: InvoiceKind | null
  converted_from_id: string | null
  cancels_document_id?: string | null
  final_invoice_id?: string | null
  issued_at?: string | null
  issued_total?: number | null
  pdf_path?: string | null
  sent_at?: string | null
  reminder_level?: number | null
  bookamat_booking_id?: string | null
  bookamat_error?: string | null
  buyer_reference?: string | null
  skonto_percent?: number | null
  skonto_days?: number | null
  // Claude recorded, changed or removed a payment and the owner has not confirmed them since
  // (20261105_mcp_drafts.sql); absent before that migration.
  mcp_payments_at?: string | null
  document_items: (ListItem & { id: string; description: string | null; unit: string | null; service_date: string | null; service_date_end?: string | null; catalogue_item_id: string | null })[] | null
  payments: Payment[] | null
  clients: Record<string, unknown> & { id: string; name: string; company: string | null; uid_number: string | null; country: string | null } | null
}

export type HistoryEvent = { id: string; created_at: string; type: string; detail: Record<string, unknown>; actor?: string | null }
export type ReminderEntry = { level: number; sent_at: string; to_email: string | null; subject: string | null }

export interface DocumentDetail {
  doc: DetailDocument
  items: NonNullable<DetailDocument['document_items']>
  history: HistoryEvent[]
  reminders: ReminderEntry[]
  bookings: { year: number; booking_id: string; amount: number; kind: string; booked_on: string | null }[]
}

// The document as its page and PDF read it (lines in order, payments, the client), with its
// history (newest first, at most 200), reminders and Bookamat bookings. Null when RLS shows none.
export async function getDocumentDetail(supabase: SupabaseClient, id: string): Promise<DocumentDetail | null> {
  const [{ data, error }, { data: events, error: eventsError }, { data: reminders, error: remindersError }, { data: bookings, error: bookingsError }] = await Promise.all([
    supabase.from('documents').select('*, document_items(*), payments(*), clients(*)').eq('id', id).maybeSingle(),
    supabase.from('document_events').select('id, created_at, type, detail, actor').eq('document_id', id).order('created_at', { ascending: false }).limit(200),
    supabase.from('reminder_log').select('level, sent_at, to_email, subject').eq('document_id', id).order('sent_at', { ascending: false }),
    supabase.from('bookamat_bookings').select('year, booking_id, amount, kind, booked_on').eq('document_id', id).order('year'),
  ])
  const failed = error ?? eventsError ?? remindersError ?? bookingsError
  if (failed) throw failed
  if (!data) return null
  const doc = data as DetailDocument
  return {
    doc,
    items: orderItems(doc.document_items ?? []),
    history: (events ?? []) as HistoryEvent[],
    reminders: (reminders ?? []) as ReminderEntry[],
    bookings: (bookings ?? []) as DocumentDetail['bookings'],
  }
}

// ─── Numbering ───────────────────────────────────────────────────────────────

const NUMBERS_PAGE = 1000

// Every number issued for one document type (Storno and cancelled ones included, as their numbers
// stay used), read in pages so a long history is not cut at the API's row limit.
export async function listIssuedNumbers(supabase: SupabaseClient, type: DocumentType): Promise<string[]> {
  const numbers: string[] = []
  for (let from = 0; ; from += NUMBERS_PAGE) {
    const { data, error } = await supabase.from('documents').select('number').eq('type', type).not('number', 'is', null)
      .order('id').range(from, from + NUMBERS_PAGE - 1)
    if (error) throw error
    for (const row of data ?? []) if (typeof row.number === 'string') numbers.push(row.number)
    if ((data?.length ?? 0) < NUMBERS_PAGE) return numbers
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export const CLIENT_LIST_COLUMNS = 'id, client_number, name, company, email, phone, address_line1, address_line2, zip, city, country, uid_number, tax_treatment, language, payment_days, status, tags'

export interface ClientListRow {
  id: string
  client_number: string | null
  name: string
  company: string | null
  email: string
  phone: string | null
  address_line1: string
  address_line2: string | null
  zip: string
  city: string
  country: string
  uid_number: string | null
  tax_treatment: string
  language: string
  payment_days: number | null
  status: string
  tags: string[]
}

// The clients page: every client with its newest issued invoice date and its open balance (what
// is still owed on issued, unpaid invoices; calcTotals leaves dunning fees out).
export async function listClients(supabase: SupabaseClient): Promise<{ rows: ClientListRow[]; lastInvoiced: Record<string, string>; balances: Record<string, number> }> {
  const [{ data: clients }, { data: open }] = await Promise.all([
    // Each client brings only its newest issued invoice: drafts are not invoiced yet and a
    // cancelled invoice was taken back by its Storno.
    supabase
      .from('clients')
      .select(`${CLIENT_LIST_COLUMNS}, documents(date)`)
      .eq('documents.type', 'invoice')
      .in('documents.status', ['sent', 'paid', 'overdue'])
      .order('date', { referencedTable: 'documents', ascending: false })
      .limit(1, { referencedTable: 'documents' })
      .order('name'),
    supabase
      .from('documents')
      .select('client_id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
      .eq('type', 'invoice')
      .in('status', ['sent', 'overdue']),
  ])

  const rows: ClientListRow[] = []
  const lastInvoiced: Record<string, string> = {}
  for (const { documents, ...client } of (clients ?? []) as unknown as (ClientListRow & { documents: { date: string }[] | null })[]) {
    rows.push(client)
    if (documents?.[0]?.date) lastInvoiced[client.id] = documents[0].date
  }

  const balances: Record<string, number> = {}
  for (const d of open ?? []) {
    const { balance_due } = calcTotals(
      d.document_items ?? [],
      d.payments ?? [],
      d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
      d.tax_treatment,
    )
    balances[d.client_id] = roundCents((balances[d.client_id] ?? 0) + balance_due)
  }
  return { rows, lastInvoiced, balances }
}

type ClientDocRow = {
  id: string
  type: DocumentType
  number: string | null
  date: string
  due_date: string | null
  status: string
  currency: string
  tax_treatment: string | null
  discount_type: string | null
  discount_value: number | null
  document_items: ListItem[] | null
  payments: { amount: number; kind?: string | null }[] | null
}

export interface ClientDocument {
  doc: ClientDocRow
  total: number
  shown: string
}

export interface ClientDetail<S> {
  client: Client
  documents: ClientDocument[]
  // With a documents page: how many documents the client has in all.
  documentCount: number | null
  totalRevenue: number
  openBalance: number
  invoiceCount: number
  // The settings columns the caller asked for.
  settings: S | null
  catalogue: CatalogueItem[]
  rates: { id: string; client_id: string; catalogue_item_id: string; price: number; note: string | null }[]
}

const CLIENT_DOCUMENT_COLUMNS = 'id, type, number, date, due_date, status, currency, tax_treatment, discount_type, discount_value, document_items(*), payments(*)'

// The client page: the 50 latest documents with the status the lists show, the money received
// (payments less refunds), the open balance and the invoice count over every invoice, the rate card.
// With documentsPage (Claude's get_client) one page of the documents, newest first, and their count.
export async function getClientDetail<S = Record<string, unknown>>(
  supabase: SupabaseClient, id: string, todayStr: string, settingsColumns: string,
  documentsPage?: { offset: number; limit: number },
): Promise<ClientDetail<S> | null> {
  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single()
  if (!client) return null

  // The history list shows the 50 latest documents; the stats aggregate every invoice.
  const documentQuery = documentsPage
    ? supabase.from('documents').select(CLIENT_DOCUMENT_COLUMNS, { count: 'exact' }).eq('client_id', id)
      .order('date', { ascending: false }).order('id').range(documentsPage.offset, documentsPage.offset + documentsPage.limit - 1)
    : supabase.from('documents').select(CLIENT_DOCUMENT_COLUMNS).eq('client_id', id).order('date', { ascending: false }).limit(50)
  const [{ data: documents, count: documentCount }, { data: invoices }, { data: settings }, { data: refunds }, { data: catalogue }, { data: rates }] = await Promise.all([
    documentQuery,
    supabase
      .from('documents')
      .select('status, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(amount, kind)')
      .eq('client_id', id)
      .eq('type', 'invoice'),
    supabase.from('settings').select(settingsColumns).maybeSingle(),
    // Money paid back to the client on credit notes.
    supabase.from('payments').select('amount, documents!inner(client_id)').eq('kind', 'refund').eq('documents.client_id', id),
    supabase.from('catalogue_items').select('*').order('sort_order'),
    supabase.from('client_rates').select('id, client_id, catalogue_item_id, price, note').eq('client_id', id),
  ])

  const allDocs = (documents ?? []) as unknown as ClientDocRow[]
  const allInvoices = (invoices ?? []) as unknown as (Totaled & { status: string; payments: { amount: number; kind?: string | null }[] | null })[]
  const docTotals = (d: { document_items: ListItem[] | null; payments: { amount: number; kind?: string | null }[] | null; discount_type?: string | null; discount_value?: number | null; tax_treatment?: string | null }) => calcTotals(
    d.document_items ?? [],
    d.payments ?? [],
    d.discount_type && d.discount_value ? { type: d.discount_type as 'percent' | 'fixed', value: d.discount_value } : null,
    d.tax_treatment,
  )
  // Revenue is money: payments received less refunds. Skonto, write-offs, applied credit notes and
  // dunning fees are no revenue.
  const received = allInvoices.reduce((s, d) => s + (d.payments ?? []).filter(p => p.kind === 'payment').reduce((a, p) => a + Number(p.amount), 0), 0)
  const totalRevenue = roundCents(received - (refunds ?? []).reduce((s, r) => s + Number(r.amount), 0))
  const openBalance = allInvoices
    .filter(d => d.status === 'sent' || d.status === 'overdue')
    .reduce((s, d) => s + docTotals(d).balance_due, 0)
  const invoiceCount = allInvoices.length

  // A credit note is settled by its refunds and by the 'credit' rows that apply it to its invoice.
  const creditNoteIds = allDocs.filter(d => d.type === 'credit_note' && d.status === 'sent').map(d => d.id)
  const { data: credits } = creditNoteIds.length
    ? await supabase.from('payments').select('credit_note_id, amount').eq('kind', 'credit').in('credit_note_id', creditNoteIds)
    : { data: [] }
  const applied = new Map<string, number>()
  for (const c of credits ?? []) applied.set(c.credit_note_id, (applied.get(c.credit_note_id) ?? 0) + Number(c.amount))
  const settledCredit = (doc: ClientDocRow, total: number) => {
    const refunded = (doc.payments ?? []).filter(p => p.kind === 'refund').reduce((s, p) => s + Number(p.amount), 0)
    return creditNoteSettled(total, applied.get(doc.id) ?? 0, refunded)
  }

  return {
    client: client as Client,
    documents: allDocs.map(doc => {
      const totals = docTotals(doc)
      // As in the lists: partly paid / written off from the payments, expired from the date,
      // settled from refunds and applied credits.
      const shown = displayStatus({
        type: doc.type, status: doc.status, due_date: doc.due_date, total: totals.total, payments: doc.payments ?? [],
        creditSettled: doc.type === 'credit_note' && settledCredit(doc, totals.total),
      }, todayStr)
      return { doc, total: totals.total, shown }
    }),
    documentCount: documentsPage ? documentCount ?? null : null,
    totalRevenue,
    openBalance,
    invoiceCount,
    settings: (settings ?? null) as S | null,
    catalogue: (catalogue ?? []) as CatalogueItem[],
    rates: (rates ?? []) as ClientDetail<S>['rates'],
  }
}

// ─── Projects ────────────────────────────────────────────────────────────────

// PostgREST returns at most 1000 rows per request; a long project can have more entries.
const PAGE = 1000

async function loadAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as T[]))
    if ((data?.length ?? 0) < PAGE) return rows
  }
}

export type LinkedInvoiceRow = { id: string; number: string | null; status: string; date: string }
export type ClientOptionRow = { id: string; name: string; company: string | null }

export interface ProjectDetail {
  project: Project
  entries: TimeEntry[]
  expenses: ProjectExpense[]
  invoices: LinkedInvoiceRow[]
  clients: ClientOptionRow[]
  defaultVatRate: number | null
}

// The project page: the project, every time entry and expense (newest first), the invoices they
// were billed on (newest first), the clients for the edit dialog and the default VAT rate.
export async function getProjectDetail(supabase: SupabaseClient, id: string): Promise<ProjectDetail | null> {
  const [{ data: project }, timeRows, expenseRows, { data: clients }, { data: settings }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', id).maybeSingle(),
    loadAll<TimeEntry>((from, to) => supabase.from('time_entries').select('*').eq('project_id', id)
      .order('date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)),
    loadAll<ProjectExpense>((from, to) => supabase.from('project_expenses').select('*').eq('project_id', id)
      .order('date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)),
    supabase.from('clients').select('id, name, company').order('name'),
    supabase.from('settings').select('default_vat_rate').maybeSingle(),
  ])
  if (!project) return null

  // .in() lists travel in the URL, so the invoices are looked up 100 at a time.
  const invoiceIds = [...new Set([...timeRows, ...expenseRows].map(r => r.invoiced_document_id).filter((v): v is string => !!v))]
  const slices: string[][] = []
  for (let i = 0; i < invoiceIds.length; i += 100) slices.push(invoiceIds.slice(i, i + 100))
  const invoices = (await Promise.all(slices.map(slice => supabase.from('documents').select('id, number, status, date').in('id', slice))))
    .flatMap(r => (r.data ?? []) as LinkedInvoiceRow[])
    .sort((x, y) => y.date.localeCompare(x.date))

  return {
    project: project as Project,
    entries: timeRows,
    expenses: expenseRows,
    invoices,
    clients: (clients ?? []) as ClientOptionRow[],
    defaultVatRate: (settings?.default_vat_rate ?? null) as number | null,
  }
}

export type ProjectListRow = Project & {
  clients: { name: string; company: string | null } | null
  time_entries: Pick<TimeEntry, 'minutes' | 'rate' | 'billed_rate' | 'billable' | 'invoiced_document_id'>[] | null
  project_expenses: Pick<ProjectExpense, 'net_amount' | 'markup_percent' | 'billable' | 'invoiced_document_id'>[] | null
}

// The projects page: every project, newest first, with the amounts its totals need.
export async function listProjectRows(supabase: SupabaseClient): Promise<{ data: ProjectListRow[] | null; error: DbError | null }> {
  const { data, error } = await supabase
    .from('projects')
    .select('*, clients(name, company), time_entries(minutes, rate, billed_rate, billable, invoiced_document_id), project_expenses(net_amount, markup_percent, billable, invoiced_document_id)')
    .order('created_at', { ascending: false })
  return { data: data as unknown as ProjectListRow[] | null, error }
}

// ─── Recurring schedules ─────────────────────────────────────────────────────

export interface RecurringRow extends RecurringSchedule {
  source: { id: string; number: string | null; client: string } | null
  last: { id: string; number: string | null } | null
  // The service periods its invoices already cover (planNextPeriod in src/lib/utils/recurring.ts).
  covered: CoveredPeriod[]
}

type DocRef = { id: string; number: string | null; clients: { name: string; company: string | null } | null }

// The recurring page: every schedule by next date, with its template, last generated document and
// the periods its invoices cover (what the generator skips, so the page and Claude show the invoice
// a schedule really creates next).
export async function listRecurringSchedules(supabase: SupabaseClient): Promise<RecurringRow[]> {
  const { data: schedules } = await supabase.from('recurring_schedules').select('*').order('next_date')
  const list = (schedules ?? []) as RecurringSchedule[]

  const ids = Array.from(new Set(list.flatMap(s => [s.source_document_id, s.last_document_id]).filter((id): id is string => !!id)))
  // Without generated DB types supabase-js types the to-one `clients` embed as an array.
  const [docs, covered] = await Promise.all([
    ids.length
      ? supabase.from('documents').select('id, number, clients(name, company)').in('id', ids).then(r => (r.data ?? []) as unknown as DocRef[])
      : Promise.resolve([] as DocRef[]),
    coveredPeriods(supabase, list.map(s => s.id)),
  ])
  const byId = new Map(docs.map(d => [d.id, d]))

  return list.map(s => {
    const source = byId.get(s.source_document_id)
    const last = s.last_document_id ? byId.get(s.last_document_id) : undefined
    return {
      ...s,
      source: source ? { id: source.id, number: source.number, client: clientDisplayName(source.clients) || '—' } : null,
      last: last ? { id: last.id, number: last.number } : null,
      covered: covered.get(s.id) ?? [],
    }
  })
}
