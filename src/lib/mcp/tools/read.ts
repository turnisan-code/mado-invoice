// Read-only tools (scope mado:read), in the order tools/list shows them. They read through the
// same services as the pages, so Claude sees the figures and statuses the owner sees.
import { z } from 'zod'
import { expectedNumber } from '@/components/forms/builder/model'
import { bookamatState } from '@/lib/bookamat-client'
import { loadCreditNoteSettlement } from '@/lib/credits'
import { depositTotals, loadDepositCheck, loadMoneyLock, loadQuoteDeposits } from '@/lib/deposits'
import { INVOICE_GROUPINGS, budgetUse, buildInvoiceLines, isUnbilled, linesNet, projectTotals } from '@/lib/projects'
import { isBookamatConfigured, isGoogleExpired } from '@/lib/public-settings'
import { displayStatus, paymentState } from '@/lib/status'
import { cataloguePrice, rateMap } from '@/lib/utils/catalogue'
import { clientDisplayName, clientMatches } from '@/lib/utils/clients'
import { calcTotals, lineAmount, roundCents, today } from '@/lib/utils/document'
import { issueProblemMessage, issueProblems, type IssueCheckInput } from '@/lib/utils/issue-checks'
import { makePeriod } from '@/app/(app)/reports/period'
import {
  filterDocuments, getClientDetail, getDocumentDetail, getProjectDetail, invoiceShownStatus, listClients, listDocuments, listProjectRows,
  listRecurringSchedules, summarizeDocument,
} from '@/lib/services/queries'
import { dashboardInvoiceTotals, loadClientStatement, loadDashboardFigures, loadIstReport } from '@/lib/services/reports'
import type { CatalogueItem, InvoiceGrouping, Project, ProjectStatus, VatRate } from '@/types'
import { ACTION_TTL, appUrl, clientUrl, documentPdfUrl, documentUrl, projectUrl } from '../config'
import { McpToolError } from '../errors'
import { ACTION_KINDS, defineTool, type AnyToolDef, type ToolContext } from '../types'

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const uuid = (what: string) => z.string().regex(UUID, 'must be a uuid').describe(what)
const isoDate = (what: string) => z.string().regex(ISO_DATE, 'must be YYYY-MM-DD').describe(what)
const DOCUMENT_TYPES = ['invoice', 'quote', 'credit_note'] as const
// Long histories, projects and statements are cut here so one result stays within MAX_RESULT_CHARS;
// the totals say how many there are.
const HISTORY_SHOWN = 50
const ENTRIES_SHOWN = 200
const STATEMENT_ROWS_SHOWN = 200

// Paging inputs, the same on every list: offset is the previous answer's next_offset.
const limitArg = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`How many to return (at most ${max})`)
const offsetArg = (what = 'next_offset') =>
  z.number().int().min(0).default(0).describe(`How many to skip; pass the previous answer's ${what} for the next page`)

function page<T>(rows: readonly T[], offset: number, limit: number) {
  const items = rows.slice(offset, offset + limit)
  return { items, total: rows.length, offset, next_offset: offset + items.length < rows.length ? offset + items.length : null }
}

function shown(count: number, total: number, noun: string, offset = 0): string {
  if (!total) return `No ${noun} found.`
  return count === total ? `${total} ${noun}.` : `${total} ${noun}; showing ${offset + 1}–${offset + count}.`
}

async function check<T>(result: { data: T; error: unknown }): Promise<T> {
  if (result.error) throw result.error
  return result.data
}

// ─── get_context ─────────────────────────────────────────────────────────────

const getContext = defineTool({
  name: 'get_context',
  title: 'Business context',
  description: 'Start here. Today\'s date (Vienna), the business, the numbering formats and the next number per document type, default VAT and terms, which integrations are connected, and what this connection may do (scopes, how each irreversible action is approved). No secrets.',
  scope: 'mado:read',
  inputSchema: z.object({}),
  hints: READ,
  async run(_args, ctx) {
    const s = await ctx.settings()
    const date = today()
    const policy = s.mcp_confirm_policy ?? {}
    return {
      summary: `${s.company_name || 'The business'} · today is ${date} (Europe/Vienna).`,
      data: {
        today: date,
        time_zone: 'Europe/Vienna',
        currency: 'EUR',
        vat_basis: 'Ist-Besteuerung (VAT is due when the money arrives)',
        business: {
          company_name: s.company_name, owner_name: s.owner_name, email: s.email, phone: s.phone, website: s.website,
          address: [s.address_line1, s.address_line2, `${s.zip} ${s.city}`.trim(), s.country].filter(Boolean).join(', '),
          uid_number: s.uid_number,
        },
        numbering: Object.fromEntries(DOCUMENT_TYPES.map(type => [type, {
          format: s[`${type}_number_format`], prefix: s[`${type}_prefix`], next_if_issued_today: expectedNumber(s, type, date) || null,
        }])),
        defaults: {
          vat_rate: s.default_vat_rate, payment_days: s.default_payment_days, quote_validity_days: s.default_quote_validity_days,
          tax_treatment: s.default_tax_treatment, language: s.default_language, unit: s.default_unit,
          skonto_percent: s.default_skonto_percent ?? null, skonto_days: s.default_skonto_days ?? null,
        },
        reminders: { enabled: s.reminders_enabled, grace_days: s.reminder_grace_days, interval_days: s.reminder_interval_days, max_level: s.reminder_max_level, fee: s.reminder_fee },
        integrations: {
          gmail: !!s.gmail_refresh_token, google_reconnect_needed: isGoogleExpired(s),
          drive: !!s.gmail_refresh_token && !!s.drive_folder_id, bookamat: isBookamatConfigured(s),
        },
        connection: {
          client: ctx.grant.clientName,
          kind: ctx.grant.clientKind,
          scopes: ctx.grant.scopes,
          approval: Object.fromEntries(ACTION_KINDS.map(kind => [kind, policy[kind] === 'chat' ? 'chat' : 'app'])),
          approval_code_required: s.mcp_approval_totp !== false,
          prepared_actions_expire_minutes: ACTION_TTL / 60,
        },
        app_url: appUrl('/dashboard'),
      },
    }
  },
})

// ─── search_documents ────────────────────────────────────────────────────────

const searchDocuments = defineTool({
  name: 'search_documents',
  title: 'Search documents',
  description: 'Find invoices, quotes or credit notes, newest first. Each row has id, number (null for a draft), status, display_status (e.g. overdue by the due date, partially_paid, expired, settled), dates, client, total and balance_due (invoices: still owed; credit notes: not yet applied or refunded). Filter by status (invoices: sent or overdue by the due date), view, client, dates or q (number or client name). Page with offset/next_offset. Searches the newest 1000 documents of the type; older ones are not found here (get_client lists every document of a client).',
  scope: 'mado:read',
  inputSchema: z.object({
    type: z.enum(DOCUMENT_TYPES).describe('Which kind of document to search'),
    status: z.enum(['draft', 'sent', 'overdue', 'paid', 'accepted', 'rejected', 'cancelled']).optional()
      .describe('Stored status; for invoices sent and overdue follow the due date. Invoices: draft, sent, overdue, paid, cancelled. Quotes: draft, sent, accepted, rejected, cancelled. Credit notes: draft, sent, cancelled'),
    view: z.enum(['open', 'overdue', 'partially_paid', 'written_off', 'expired', 'settled']).optional()
      .describe('open: invoices still owed, quotes awaiting an answer, credit notes not settled'),
    client_id: uuid('Only this client\'s documents').optional(),
    q: z.string().max(200).optional().describe('Part of the number or the client name'),
    date_from: isoDate('Document date from').optional(),
    date_to: isoDate('Document date to').optional(),
    limit: limitArg(50, 25),
    offset: offsetArg(),
  }),
  hints: READ,
  async run(args, ctx) {
    const rows = (await check(await listDocuments(ctx.supabase, args.type))) ?? []
    const date = today()
    const found = filterDocuments(rows.map(d => summarizeDocument(args.type, d, date)), {
      type: args.type, status: args.status, view: args.view, clientId: args.client_id, q: args.q, dateFrom: args.date_from, dateTo: args.date_to,
    })
    const { items, ...paging } = page(found, args.offset, args.limit)
    const noun = { invoice: 'invoices', quote: 'quotes', credit_note: 'credit notes' }[args.type]
    return {
      summary: shown(items.length, found.length, noun, args.offset),
      data: { ...paging, documents: items.map(d => ({ ...d, app_url: documentUrl(args.type, d.id) })) },
    }
  },
})

// ─── get_document ────────────────────────────────────────────────────────────

const getDocument = defineTool({
  name: 'get_document',
  title: 'Get document',
  description: 'One invoice, quote or credit note in full: client, lines in order, display_status (as search_documents shows it), totals, payments and payment state, the total it was issued with, history (newest 50, with actor: claude_ai, claude_code or null for the app), reminders, deposits, credit-note settlement and Bookamat state. For a draft: the problems that block issuing and the number it would get if issued today. app_url opens it in Mado; pdf_url (issued only) opens the stored PDF in the owner\'s browser.',
  scope: 'mado:read',
  inputSchema: z.object({ id: uuid('Document id') }),
  hints: READ,
  async run({ id }, ctx) {
    const detail = await getDocumentDetail(ctx.supabase, id)
    if (!detail) throw new McpToolError('not_found')
    const { doc, items } = detail
    const payments = doc.payments ?? []
    const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
    const totals = calcTotals(items, payments, discount, doc.tax_treatment)
    const date = today()
    const extras = await documentExtras(ctx, detail, totals.total)
    // As in search_documents and the lists: an invoice's due date decides between sent and overdue.
    const shownStatus = doc.type === 'invoice'
      ? invoiceShownStatus({
          document_items: items, payments, tax_treatment: doc.tax_treatment, discount_type: doc.discount_type, discount_value: doc.discount_value,
          status: doc.status, due_date: doc.due_date,
        }, date)
      : displayStatus({ type: doc.type, status: doc.status, due_date: doc.due_date, creditSettled: extras.credit_settlement?.settled }, date)
    const client = doc.clients
    return {
      summary: `${doc.type.replace('_', ' ')} ${doc.number ?? '(draft)'} · ${clientDisplayName(client)} · ${shownStatus} · EUR ${totals.total.toFixed(2)} gross`,
      data: {
        id: doc.id,
        type: doc.type,
        number: doc.number,
        status: doc.status,
        display_status: shownStatus,
        invoice_kind: doc.type === 'invoice' ? doc.invoice_kind ?? 'standard' : undefined,
        storno_of: doc.cancels_document_id ?? null,
        converted_from_id: doc.converted_from_id,
        date: doc.date,
        due_date: doc.due_date,
        service_date: doc.service_date,
        service_date_end: doc.service_date_end ?? null,
        language: doc.language,
        currency: doc.currency,
        tax_treatment: doc.tax_treatment,
        buyer_reference: doc.buyer_reference ?? null,
        skonto: doc.skonto_percent ? { percent: doc.skonto_percent, days: doc.skonto_days ?? null } : null,
        client: client && {
          id: client.id, name: clientDisplayName(client), company: client.company, contact: client.name,
          client_number: client.client_number ?? null, email: client.email ?? null, cc_emails: client.cc_emails ?? [],
          country: client.country, uid_number: client.uid_number, tax_treatment: client.tax_treatment ?? null, language: client.language ?? null,
        },
        lines: items.map((i, n) => ({
          id: i.id,
          position: n + 1,
          line_type: i.line_type ?? 'item',
          description: i.description,
          ...((i.line_type ?? 'item') === 'item' || i.line_type === 'deduction'
            ? {
                quantity: i.quantity, unit: i.unit, unit_price: i.unit_price, vat_rate: i.vat_rate,
                discount: i.discount_type && i.discount_value ? { type: i.discount_type, value: i.discount_value } : null,
                net: lineAmount(i), service_date: i.service_date, service_date_end: i.service_date_end ?? null,
                catalogue_item_id: i.catalogue_item_id,
              }
            : {}),
        })),
        document_discount: discount,
        totals: {
          net: roundCents(totals.subtotal - totals.discount_amount), discount: totals.discount_amount,
          vat: totals.vat_groups.map(g => ({ rate: g.rate, base: g.base, vat: g.amount })), total_vat: totals.total_vat,
          gross: totals.total, paid: totals.total_paid, balance_due: doc.type === 'invoice' ? totals.balance_due : undefined,
        },
        payment_state: doc.type === 'invoice' ? paymentState(totals.total, payments) : undefined,
        payments: payments.map(p => ({ id: p.id, date: p.date, amount: p.amount, kind: p.kind, method: p.method, note: p.note, credit_note_id: p.credit_note_id })),
        issued: doc.number
          ? {
              at: doc.issued_at ?? null, issued_total: doc.issued_total ?? null,
              changed_since_issue: doc.issued_total != null && Math.abs(doc.issued_total - totals.total) > 0.005,
              archive_pdf_stored: !!doc.pdf_path, sent_at: doc.sent_at ?? null, reminder_level: doc.reminder_level ?? 0,
            }
          : null,
        ...extras,
        notes: doc.notes,
        internal_notes: doc.notes_internal,
        history: detail.history.slice(0, HISTORY_SHOWN).map(e => ({ at: e.created_at, type: e.type, actor: e.actor ?? null, detail: e.detail })),
        history_total: detail.history.length,
        reminders: detail.reminders,
        app_url: documentUrl(doc.type, doc.id),
        pdf_url: doc.number ? documentPdfUrl(doc.id) : null,
      },
    }
  },
})

async function documentExtras(ctx: ToolContext, detail: NonNullable<Awaited<ReturnType<typeof getDocumentDetail>>>, total: number) {
  const { doc, items } = detail
  const supabase = ctx.supabase
  const payments = doc.payments ?? []
  const bookamat = {
    state: bookamatState({ type: doc.type, number: doc.number, status: doc.status, payments, bookamat_bookings: detail.bookings, bookamat_booking_id: doc.bookamat_booking_id, bookamat_error: doc.bookamat_error }),
    error: doc.bookamat_error ?? null,
    bookings: detail.bookings,
  }

  let draft: { issue_problems: { code: string; message: string }[]; expected_number: string | null } | undefined
  if (!doc.number && doc.status === 'draft') {
    const settings = await ctx.settings()
    const deposit = await loadDepositCheck(supabase, { ...doc, document_items: items })
    const problems = issueProblems({
      type: doc.type,
      currency: doc.currency,
      taxTreatment: doc.tax_treatment,
      serviceDate: doc.service_date,
      serviceDateEnd: doc.service_date_end ?? null,
      isStorno: !!doc.cancels_document_id,
      client: doc.clients ? { uid_number: doc.clients.uid_number, country: doc.clients.country } : null,
      items: items as IssueCheckInput['items'],
      settings,
      deposit,
    })
    const issueDate = doc.date > today() ? doc.date : today()
    draft = {
      issue_problems: problems.map(p => ({ code: p.code, message: issueProblemMessage(p, ctx.t) })),
      expected_number: expectedNumber(settings, doc.type, issueDate) || null,
    }
  }

  let deposits: Record<string, unknown> | undefined
  if (doc.type === 'quote') {
    const invoices = await loadQuoteDeposits(supabase, doc.id)
    deposits = {
      invoices: invoices.map(d => ({ id: d.id, number: d.number, kind: d.invoice_kind, status: d.status, gross: depositTotals(d).total, final_invoice: d.final })),
    }
  } else if (doc.type === 'invoice' && (doc.invoice_kind === 'advance' || doc.invoice_kind === 'partial')) {
    deposits = { final_invoice_id: doc.final_invoice_id ?? null, money_locked_by: await loadMoneyLock(supabase, doc.id) }
  }

  let creditSettlement: { settled: boolean } & Record<string, unknown> | undefined
  if (doc.type === 'credit_note') {
    const s = await loadCreditNoteSettlement(supabase, { ...doc, document_items: items, payments })
    creditSettlement = {
      total: s.total, invoice: s.invoice, applied: s.applied,
      refunds: s.refunds.map(r => ({ id: r.id, date: r.date, amount: r.amount, method: r.method })),
      open: Math.max(0, roundCents(total - s.applied.reduce((a, r) => a + r.amount, 0) - s.refunds.reduce((a, r) => a + r.amount, 0))),
      settled: s.settled,
    }
  }

  return {
    bookamat,
    ...(draft ? { draft } : {}),
    ...(deposits ? { deposits } : {}),
    ...(creditSettlement ? { credit_settlement: creditSettlement } : {}),
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────────

const listClientsTool = defineTool({
  name: 'list_clients',
  title: 'List clients',
  description: 'Clients by name with client number, email, country, VAT ID, tax treatment, open balance (still owed on issued invoices) and the date last invoiced. q searches number, name, company, email, city, VAT ID and tags. Inactive clients are left out unless include_archived is true.',
  scope: 'mado:read',
  inputSchema: z.object({
    q: z.string().max(200).optional().describe('Part of the number, name, company, email, city, VAT ID or a tag'),
    include_archived: z.boolean().default(false).describe('Also list inactive clients'),
    limit: limitArg(100, 50),
    offset: offsetArg(),
  }),
  hints: READ,
  async run(args, ctx) {
    const { rows, lastInvoiced, balances } = await listClients(ctx.supabase)
    const found = rows
      .filter(c => args.include_archived || c.status !== 'inactive')
      .filter(c => !args.q || clientMatches(c, args.q))
    const { items, ...paging } = page(found, args.offset, args.limit)
    return {
      summary: shown(items.length, found.length, 'clients', args.offset),
      data: {
        ...paging,
        clients: items.map(c => ({
          id: c.id, client_number: c.client_number, name: clientDisplayName(c), company: c.company, contact: c.name, email: c.email,
          city: c.city, country: c.country, uid_number: c.uid_number, tax_treatment: c.tax_treatment, language: c.language,
          payment_days: c.payment_days, status: c.status, tags: c.tags,
          open_balance: balances[c.id] ?? 0, last_invoiced: lastInvoiced[c.id] ?? null, app_url: clientUrl(c.id),
        })),
      },
    }
  },
})

const getClient = defineTool({
  name: 'get_client',
  title: 'Get client',
  description: 'One client: address, tax data, terms, e-invoice settings, notes, rate card (catalogue prices for this client), money received, open balance, its projects (newest first) and its documents (newest first, with the status the app shows). Documents and projects come a page at a time: documents_total and documents_next_offset (projects_total, projects_next_offset) say how to fetch more.',
  scope: 'mado:read',
  inputSchema: z.object({
    id: uuid('Client id'),
    documents_limit: limitArg(50, 50),
    documents_offset: offsetArg('documents_next_offset'),
    projects_limit: limitArg(50, 25),
    projects_offset: offsetArg('projects_next_offset'),
  }),
  hints: READ,
  async run({ id, documents_limit, documents_offset, projects_limit, projects_offset }, ctx) {
    const [detail, projects] = await Promise.all([
      getClientDetail(ctx.supabase, id, today(), 'id', { offset: documents_offset, limit: documents_limit }),
      ctx.supabase.from('projects').select('id, name, status, hourly_rate', { count: 'exact' }).eq('client_id', id)
        .order('created_at', { ascending: false }).order('id').range(projects_offset, projects_offset + projects_limit - 1),
    ])
    if (!detail) throw new McpToolError('not_found')
    if (projects.error) throw projects.error
    const projectRows = projects.data ?? []
    const documentsTotal = detail.documentCount ?? documents_offset + detail.documents.length
    const projectsTotal = projects.count ?? projects_offset + projectRows.length
    const next = (offset: number, count: number, total: number) => (offset + count < total ? offset + count : null)
    const c = detail.client
    const names = new Map(detail.catalogue.map(i => [i.id, i.name_de || i.name_en]))
    return {
      summary: `${clientDisplayName(c)} · open balance EUR ${roundCents(detail.openBalance).toFixed(2)} · ${detail.invoiceCount} invoices`,
      data: {
        client: {
          id: c.id, client_number: c.client_number, name: clientDisplayName(c), company: c.company, contact: c.name, email: c.email,
          cc_emails: c.cc_emails ?? [], phone: c.phone,
          address: { line1: c.address_line1, line2: c.address_line2, zip: c.zip, city: c.city, country: c.country },
          uid_number: c.uid_number, tax_treatment: c.tax_treatment, language: c.language, currency: c.currency,
          payment_days: c.payment_days, skonto_percent: c.skonto_percent ?? null, skonto_days: c.skonto_days ?? null,
          status: c.status, tags: c.tags, notes: c.notes, reminders_opt_out: c.reminders_opt_out,
          einvoice: { format: c.einvoice_format ?? null, peppol_scheme: c.peppol_scheme ?? null, peppol_id: c.peppol_id ?? null, buyer_reference: c.buyer_reference ?? null, supplier_number: c.supplier_number ?? null },
        },
        stats: { money_received: detail.totalRevenue, open_balance: roundCents(detail.openBalance), invoice_count: detail.invoiceCount },
        rates: detail.rates.map(r => ({ catalogue_item_id: r.catalogue_item_id, item: names.get(r.catalogue_item_id) ?? null, price: Number(r.price), note: r.note })),
        projects_total: projectsTotal,
        projects_next_offset: next(projects_offset, projectRows.length, projectsTotal),
        projects: projectRows.map(p => ({ ...p, app_url: projectUrl(p.id) })),
        documents_total: documentsTotal,
        documents_next_offset: next(documents_offset, detail.documents.length, documentsTotal),
        documents: detail.documents.map(({ doc, total, shown: status }) => ({
          id: doc.id, type: doc.type, number: doc.number, date: doc.date, due_date: doc.due_date, display_status: status, total,
          app_url: documentUrl(doc.type, doc.id),
        })),
        app_url: clientUrl(c.id),
      },
    }
  },
})

// ─── Catalogue ───────────────────────────────────────────────────────────────

const listCatalogue = defineTool({
  name: 'list_catalogue',
  title: 'List catalogue',
  description: 'Catalogue items in catalogue order for building document lines: names and descriptions in German and English, unit, VAT rate, default net price and, with client_id, the price on that client\'s rate card. Inactive items only with include_inactive. Page with offset/next_offset.',
  scope: 'mado:read',
  inputSchema: z.object({
    client_id: uuid('Price the items for this client').optional(),
    include_inactive: z.boolean().default(false).describe('Also list items switched off in the catalogue'),
    limit: limitArg(50, 50),
    offset: offsetArg(),
  }),
  hints: READ,
  async run(args, ctx) {
    const [items, usage, rates] = await Promise.all([
      check(await ctx.supabase.from('catalogue_items').select('*').order('sort_order')),
      ctx.supabase.rpc('catalogue_usage'),
      args.client_id
        ? check(await ctx.supabase.from('client_rates').select('catalogue_item_id, price').eq('client_id', args.client_id))
        : Promise.resolve([]),
    ])
    const used = new Map(((usage.data ?? []) as { catalogue_item_id: string; uses: number; last_used: string | null }[]).map(r => [r.catalogue_item_id, r]))
    const card = rateMap((rates ?? []) as { catalogue_item_id: string; price: number }[])
    const list = ((items ?? []) as CatalogueItem[]).filter(i => args.include_inactive || i.active)
    const { items: shownItems, ...paging } = page(list, args.offset, args.limit)
    return {
      summary: shown(shownItems.length, list.length, 'catalogue items', args.offset),
      data: {
        ...paging,
        items: shownItems.map(i => ({
          id: i.id, name_de: i.name_de, name_en: i.name_en, description_de: i.description_de, description_en: i.description_en,
          unit: i.unit, vat_rate: i.vat_rate, default_price: Number(i.default_price), category: i.category, active: i.active,
          ...(args.client_id ? { client_price: cataloguePrice(i, card), has_client_rate: i.id in card } : {}),
          uses: Number(used.get(i.id)?.uses ?? 0), last_used: used.get(i.id)?.last_used ?? null,
        })),
      },
    }
  },
})

// ─── Projects ────────────────────────────────────────────────────────────────

const PROJECT_STATUSES = ['active', 'done', 'archived'] as const

function projectFigures(p: Pick<Project, 'hourly_rate' | 'budget_hours' | 'budget_amount'>, totals: ReturnType<typeof projectTotals>) {
  const use = budgetUse(p, totals)
  return {
    hours: roundCents(totals.minutes / 60), billable_hours: roundCents(totals.billableMinutes / 60),
    unbilled: { hours: roundCents(totals.unbilledMinutes / 60), time: totals.unbilledTime, expenses: totals.unbilledExpenses, net: totals.unbilledAmount, entries: totals.unbilledCount },
    billed: { hours: roundCents(totals.billedMinutes / 60), net: totals.billedAmount },
    value: totals.value,
    budget: { hours: p.budget_hours, amount: p.budget_amount, hours_used: use.hours, amount_used: use.amount },
  }
}

const listProjects = defineTool({
  name: 'list_projects',
  title: 'List projects',
  description: 'Projects, newest first, with hourly rate, logged and billable hours, unbilled time and expenses (net), billed amounts and budget use (1 = the whole budget). Page with offset/next_offset.',
  scope: 'mado:read',
  inputSchema: z.object({
    client_id: uuid('Only this client\'s projects').optional(),
    status: z.enum(PROJECT_STATUSES).optional().describe('Only projects with this status'),
    limit: limitArg(50, 25),
    offset: offsetArg(),
  }),
  hints: READ,
  async run(args, ctx) {
    const rows = (await check(await listProjectRows(ctx.supabase))) ?? []
    const list = rows
      .filter(p => !args.client_id || p.client_id === args.client_id)
      .filter(p => !args.status || p.status === (args.status as ProjectStatus))
    const { items, ...paging } = page(list, args.offset, args.limit)
    return {
      summary: shown(items.length, list.length, 'projects', args.offset),
      data: {
        ...paging,
        projects: items.map(p => ({
          id: p.id, name: p.name, status: p.status, client: { id: p.client_id, name: clientDisplayName(p.clients) },
          hourly_rate: p.hourly_rate, ...projectFigures(p, projectTotals(p, p.time_entries ?? [], p.project_expenses ?? [])),
          app_url: projectUrl(p.id),
        })),
      },
    }
  },
})

const getProject = defineTool({
  name: 'get_project',
  title: 'Get project',
  description: 'One project with its time entries and expenses (unbilled ones by default; include_billed for all; newest 200 each), totals, and the invoice lines its unbilled work would produce with grouping entry, description or day, at the default VAT rate.',
  scope: 'mado:read',
  inputSchema: z.object({
    id: uuid('Project id'),
    include_billed: z.boolean().default(false).describe('Also list time and expenses already invoiced'),
    grouping: z.enum(INVOICE_GROUPINGS as [InvoiceGrouping, ...InvoiceGrouping[]]).default('entry')
      .describe('How the invoice preview groups the unbilled work: one line per entry, per description or per day'),
  }),
  hints: READ,
  async run(args, ctx) {
    const detail = await getProjectDetail(ctx.supabase, args.id)
    if (!detail) throw new McpToolError('not_found')
    const { project, entries, expenses, invoices } = detail
    const totals = projectTotals(project, entries, expenses)
    const unbilledEntries = entries.filter(isUnbilled)
    const unbilledExpenses = expenses.filter(isUnbilled)
    const lines = buildInvoiceLines(project, unbilledEntries, unbilledExpenses, args.grouping, (detail.defaultVatRate ?? 20) as VatRate)
    const client = detail.clients.find(c => c.id === project.client_id)
    const shownEntries = args.include_billed ? entries : unbilledEntries
    const shownExpenses = args.include_billed ? expenses : unbilledExpenses
    return {
      summary: `${project.name} · ${roundCents(totals.unbilledMinutes / 60)} h and EUR ${totals.unbilledAmount.toFixed(2)} net unbilled`,
      data: {
        project: {
          id: project.id, name: project.name, status: project.status, notes: project.notes, hourly_rate: project.hourly_rate,
          client: { id: project.client_id, name: clientDisplayName(client) },
        },
        ...projectFigures(project, totals),
        time_entries_total: shownEntries.length,
        expenses_total: shownExpenses.length,
        time_entries: shownEntries.slice(0, ENTRIES_SHOWN).map(e => ({
          id: e.id, date: e.date, minutes: e.minutes, description: e.description, billable: e.billable, rate: e.rate,
          billed_rate: e.billed_rate, invoiced_document_id: e.invoiced_document_id,
        })),
        expenses: shownExpenses.slice(0, ENTRIES_SHOWN).map(x => ({
          id: x.id, date: x.date, description: x.description, net_amount: x.net_amount, vat_rate: x.vat_rate,
          markup_percent: x.markup_percent, billable: x.billable, invoiced_document_id: x.invoiced_document_id,
        })),
        invoices: invoices.map(i => ({ ...i, app_url: documentUrl('invoice', i.id) })),
        invoice_preview: {
          grouping: args.grouping,
          net: linesNet(lines),
          lines: lines.map(({ time_entry_ids, expense_ids, ...line }) => ({ ...line, entries: time_entry_ids.length + expense_ids.length })),
        },
        app_url: projectUrl(project.id),
      },
    }
  },
})

// ─── Reports ─────────────────────────────────────────────────────────────────

const getDashboard = defineTool({
  name: 'get_dashboard',
  title: 'Dashboard',
  description: 'The dashboard figures: outstanding and overdue invoices (balance still owed, oldest overdue), money received this month, last month, this year and per month for 12 months (payments less refunds), recently paid invoices, quotes awaiting an answer, unread portal responses, credit notes not yet applied and issued documents missing their archive PDF.',
  scope: 'mado:read',
  inputSchema: z.object({}),
  hints: READ,
  async run(_args, ctx) {
    const f = await loadDashboardFigures(ctx.supabase, today())
    const ref = (d: { id: string; number: string | null; clients: { name: string; company: string | null } | null }) =>
      ({ id: d.id, number: d.number, client: clientDisplayName(d.clients) })
    return {
      summary: `Outstanding EUR ${f.outstanding.toFixed(2)} on ${f.outstandingCount} invoices (${f.overdue.length} overdue, EUR ${f.overdueTotal.toFixed(2)}); received EUR ${f.revenueThisMonth.toFixed(2)} this month.`,
      data: {
        today: f.now,
        outstanding: { count: f.outstandingCount, amount: f.outstanding },
        overdue: {
          count: f.overdue.length, amount: f.overdueTotal, oldest_days: f.oldestOverdueDays,
          invoices: f.overdue.map(d => ({ ...ref(d), due_date: d.due_date, balance_due: dashboardInvoiceTotals(d).balance_due, app_url: documentUrl('invoice', d.id) })),
        },
        not_yet_due: { count: f.open.length, amount: f.openTotal },
        received: {
          this_month: f.revenueThisMonth, last_month: f.revenueLastMonth, change_percent: f.momDelta, this_year: f.revenueThisYear,
          invoices_paid_this_month: f.paidThisMonthCount,
          months: f.months.map(m => ({ month: m.yearMonth, amount: m.revenue })), twelve_months: f.chartTotal,
        },
        recently_paid: f.recentPaid.map(({ doc, paidOn }) => ({ ...ref(doc), total: dashboardInvoiceTotals(doc).total, paid_on: paidOn })),
        quotes_awaiting_answer: f.pendingQuotes.map(q => ({ ...ref(q), date: q.date, valid_until: q.due_date, expired: !!q.due_date && q.due_date < f.now })),
        portal_responses: f.responses.map(r => ({ at: r.created_at, answer: r.detail?.action ?? null, quote: ref(r.documents) })),
        credit_notes_not_applied: f.unapplied.map(u => ({ id: u.id, number: u.number, invoice_id: u.invoiceId, invoice_number: u.invoiceNumber, amount: u.amount })),
        missing_archive_pdf: { count: f.unarchivedCount, documents: f.unarchived },
        app_url: appUrl('/dashboard'),
      },
    }
  },
})

const KZ: Record<number, string> = { 20: '022', 13: '006', 10: '029' }

const getVatReport = defineTool({
  name: 'get_vat_report',
  title: 'VAT report (Ist)',
  description: 'VAT figures for a month, quarter or year on the Ist basis (VAT due when money arrives), exactly as the Reports page shows them: taxable base and VAT per rate with the UVA field (KZ 022 20 %, 006 13 %, 029 10 %), reverse-charge and non-EU bases, the ZM (recurring EU services per recipient VAT ID, by service period), credit notes not yet settled, counts and dunning fees received. Figures for the owner\'s accountant; not a filing.',
  scope: 'mado:read',
  inputSchema: z.object({
    period: z.enum(['month', 'quarter', 'year']).describe('The length of the reporting period'),
    year: z.number().int().min(2000).max(2100).describe('Calendar year, e.g. 2026'),
    quarter: z.number().int().min(1).max(4).optional().describe('1–4. Required when period is quarter'),
    month: z.number().int().min(1).max(12).optional().describe('1–12. Required when period is month'),
  }),
  hints: READ,
  async run(args, ctx) {
    const index = args.period === 'quarter' ? args.quarter : args.period === 'month' ? args.month : 0
    if (index === undefined) throw new McpToolError('invalid_input', { message: `${ctx.t('mcp.errors.invalidInput')} ${args.period} needs ${args.period === 'quarter' ? 'quarter' : 'month'}.` })
    const period = makePeriod(args.period, args.year, index)
    const r = await loadIstReport(ctx.supabase, period)
    return {
      summary: `${period.start} – ${period.end}: VAT EUR ${r.totalVat.toFixed(2)} on a taxable base of EUR ${r.taxableBase.toFixed(2)}; ${r.countedPayments.length} payments on ${r.invoiceCount} invoices.`,
      data: {
        period: { kind: period.kind, start: period.start, end: period.end },
        basis: 'Ist',
        uva: {
          kz_000_taxable_base: r.taxableBase,
          rates: r.rates.map(rate => ({ rate, kz: KZ[rate] ?? null, base: roundCents(r.vat[rate].base), vat: roundCents(r.vat[rate].vat) })),
          reverse_charge_base: r.rcBase,
          non_eu_base: r.nonEuBase,
          total_vat: r.totalVat,
        },
        summary: { net: r.netTotal, vat: r.totalVat, gross: roundCents(r.netTotal + r.totalVat), dunning_fees_received: r.feesReceived },
        zm: r.zm.error
          ? { error: 'The ZM could not be loaded.' }
          : { rows: r.zm.rows.map(z => ({ country: z.country, uid: z.uid, client: z.client, net: z.net, documents: z.documents.map(d => d.number) })), total: r.zmTotal, missing_vat_id: r.zmMissingUid },
        counted: {
          payments: r.countedPayments.length, invoices: r.invoiceCount, credit_notes: r.creditNoteCount, credit_notes_deducted: r.deductedCount,
          issued_documents_in_period: r.issuedCount,
        },
        credit_notes_not_settled: r.unsettled.map(u => ({ id: u.doc.id, number: u.doc.number, open: u.open })),
        credit_notes_not_applied: r.unapplied.length,
        app_url: appUrl(`/reports?period=${period.kind}&year=${period.year}${period.kind === 'quarter' ? `&quarter=${period.quarter}` : period.kind === 'month' ? `&month=${period.month}` : ''}`),
      },
    }
  },
})

const getClientStatement = defineTool({
  name: 'get_client_statement',
  title: 'Client statement',
  description: 'A client\'s statement of account as of today: every issued invoice and credit note dated from…to (default: this year up to today) plus older ones still open, with total, settled (paid, credited, Skonto, written off) and open amounts (credit notes negative), and the sums (the latest 200 rows are listed; the sums cover all). open_only lists every open document up to `to`. statement_pdf_url opens the PDF in the owner\'s browser.',
  scope: 'mado:read',
  inputSchema: z.object({
    client_id: uuid('Client id'),
    from: isoDate('Period start').optional(),
    to: isoDate('Period end, default today').optional(),
    open_only: z.boolean().default(false).describe('List every document still open up to `to`, whatever its date, instead of the period'),
  }),
  hints: READ,
  async run(args, ctx) {
    const to = args.to ?? today()
    const from = args.from ?? `${to.slice(0, 4)}-01-01`
    if (!args.open_only && from > to) throw new McpToolError('invalid_input', { message: `${ctx.t('mcp.errors.invalidInput')} from is after to.` })
    const statement = await loadClientStatement(ctx.supabase, args.client_id, { from, to, openOnly: args.open_only })
    if (!statement) throw new McpToolError('not_found')
    const eur = statement.sums.find(s => s.currency === 'EUR')
    const params = new URLSearchParams({ to, ...(args.open_only ? { open: '1' } : { from }) })
    return {
      summary: `${clientDisplayName(statement.client)}: ${statement.rows.length} documents, open EUR ${(eur?.open ?? 0).toFixed(2)}.`,
      data: {
        client: { id: statement.client.id, name: clientDisplayName(statement.client) },
        from: args.open_only ? null : from, to, open_only: args.open_only,
        rows_total: statement.rows.length,
        rows: statement.rows.slice(-STATEMENT_ROWS_SHOWN).map(r => ({ ...r, app_url: documentUrl(r.kind === 'invoice' ? 'invoice' : 'credit_note', r.id) })),
        sums: statement.sums,
        statement_pdf_url: appUrl(`/api/clients/${args.client_id}/statement?${params}`),
      },
    }
  },
})

const listRecurring = defineTool({
  name: 'list_recurring',
  title: 'Recurring schedules',
  description: 'Recurring invoice schedules by next date: name, interval, next and end date, whether it creates drafts or issues them, active/paused/ended, the template invoice and the last generated one.',
  scope: 'mado:read',
  inputSchema: z.object({}),
  hints: READ,
  async run(_args, ctx) {
    const rows = await listRecurringSchedules(ctx.supabase)
    return {
      summary: shown(rows.length, rows.length, 'recurring schedules'),
      data: {
        schedules: rows.map(s => ({
          id: s.id, name: s.name, interval: s.interval, anchor_day: s.anchor_day, next_date: s.next_date, end_date: s.end_date,
          mode: s.mode, in_advance: s.in_advance,
          state: s.active ? 'active' : s.end_date && s.next_date > s.end_date ? 'ended' : 'paused',
          last_generated_at: s.last_generated_at,
          template: s.source && { ...s.source, app_url: documentUrl('invoice', s.source.id) },
          last_document: s.last && { ...s.last, app_url: documentUrl('invoice', s.last.id) },
        })),
        app_url: appUrl('/recurring'),
      },
    }
  },
})

export const READ_TOOLS: readonly AnyToolDef[] = [
  getContext,
  searchDocuments,
  getDocument,
  listClientsTool,
  getClient,
  listCatalogue,
  listProjects,
  getProject,
  getDashboard,
  getVatReport,
  getClientStatement,
  listRecurring,
]

