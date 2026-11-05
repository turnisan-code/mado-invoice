// Reversible writes (scope mado:write): drafts, clients, payments, projects and time, in the order
// tools/list shows them. Drafts only: every document edit refuses a document that has a number or
// is not a draft; issued documents are corrected with a credit note or a Storno. The template of a
// recurring schedule is never edited here (MI045, src/lib/mcp/recurring.ts).
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { initialForm, linesFromItems, type FormState } from '@/components/forms/builder/model'
import { applyCreditNote, documentTotal, loadCreditNoteSettlement, unappliedCreditNotes } from '@/lib/credits'
import { writeDeductions } from '@/lib/deposits'
import { entryAmount, expensePrice, formatDuration, INVOICE_GROUPINGS, MAX_ENTRY_MINUTES, parseDuration, PROJECT_STATUSES } from '@/lib/projects'
import { toPublicSettings } from '@/lib/public-settings'
import { clientSchema, saveClient, toClientPayload, toClientValues, type ClientValues } from '@/lib/services/clients'
import { draftPayload, duplicateDocument, saveDraft, setDepositLink, type SaveDraftError } from '@/lib/services/drafts'
import { ServiceError } from '@/lib/services/errors'
import { deleteDraft, setDocumentStatus } from '@/lib/services/lifecycle'
import {
  markPaid, mcpPaymentRef, PAYABLE, paymentRefusal, paymentRows, recordInvoicePayments, recordRefund, removePayment, reopensOnRemoval, settledSum,
  settlementRow, skontoOffered, type NewPayment, type RecordedPayments, type RemovedPayment,
} from '@/lib/services/payments'
import {
  deleteEntry, expenseProblem, expenseRow, invoiceProjectEntries, projectProblem, projectRow, releaseEntries, saveExpense, saveProject,
  saveTimeEntry, timeEntryProblem, type ExpenseValues, type ProjectValues,
} from '@/lib/services/projects'
import { convertQuote, createAdvanceInvoice } from '@/lib/services/quotes'
import { SMALL_DIFFERENCE, creditNoteOpen, paymentDateIssue, paymentState } from '@/lib/status'
import { clientWithNumber, findDuplicateClients, toClientDefaults } from '@/lib/utils/clients'
import { suggestTaxTreatment } from '@/lib/utils/country'
import { formatMoney, roundCents, today } from '@/lib/utils/document'
import { isValidVatId, normalizeVatId } from '@/lib/utils/validation'
import type { Client, Payment, PaymentMethod, Project, ProjectExpense, TimeEntry, VatRate } from '@/types'
import { appUrl, clientUrl, projectUrl } from '../config'
import {
  applyClientChange, applyHeader, applyLineOps, describeDocument, headerInput, id, isoDate, lineInput, lineOpsInput, loadCatalogue,
  MAX_AMOUNT, MAX_LINES, newLines, replaceLines, type LineInput,
} from '../draft-form'
import { McpToolError } from '../errors'
import { issueSchedulesOfClient, refuseScheduleTemplate, type TemplateSchedule } from '../recurring'
import { defineTool, type AnyToolDef, type ToolContext } from '../types'

const WRITE = { readOnlyHint: false, openWorldHint: false } as const
const money = (amount: number, currency = 'EUR') => formatMoney(amount, currency, 'en')
const invalid = (message: string, details?: Record<string, unknown>) => new McpToolError('invalid_input', { message, details })
const notFound = () => new McpToolError('not_found')

async function loadClient(supabase: SupabaseClient, clientId: string): Promise<Client> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle()
  if (error) throw error
  if (!data) throw notFound()
  return data as Client
}

function saveFailure(e: SaveDraftError, ctx: ToolContext): Error {
  if (e.kind === 'draft_only') return new McpToolError('draft_only')
  if (e.kind === 'recurring_period') return invalid(ctx.t('messages.recurringDateTaken'), { kept_date: e.stored?.date ?? null })
  return e.error
}

async function documentReply(ctx: ToolContext, documentId: string, lead: string, extra: Record<string, unknown> = {}, warnings: string[] = []) {
  const described = await describeDocument(ctx.supabase, await ctx.settings(), ctx.t, documentId)
  return {
    summary: [lead, described.line, ...warnings].filter(Boolean).join(' '),
    data: { ...extra, ...described.data, ...(warnings.length ? { warnings } : {}) },
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────────

const clientFields = {
  name: z.string().max(200).optional().describe('Contact name; a client has a name, a company or both.'),
  company: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  cc_emails: z.array(z.string().max(320)).max(20).optional().describe('Further recipients copied on every email to the client.'),
  phone: z.string().max(100).optional(),
  street: z.string().max(200).optional(),
  address_line2: z.string().max(200).optional(),
  zip: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2, e.g. AT, DE.'),
  vat_id: z.string().max(30).optional().describe('UID / VAT ID, e.g. ATU12345678.'),
  tax_treatment: z.enum(['at_vat', 'eu_reverse_charge', 'non_eu']).optional().describe('Default: suggested from country and VAT ID.'),
  language: z.enum(['de', 'en']).optional(),
  payment_terms_days: z.number().int().min(0).max(365).nullable().optional().describe('Days to pay; null: the default from Settings.'),
  skonto_percent: z.number().min(0).max(100).nullable().optional(),
  skonto_days: z.number().int().min(0).max(365).nullable().optional(),
  einvoice_format: z.enum(['ebinterface', 'ubl']).nullable().optional(),
  buyer_reference: z.string().max(200).optional(),
  notes: z.string().max(10_000).optional(),
}
const clientPatch = z.object({ ...clientFields, status: z.enum(['active', 'inactive', 'lead']).optional().describe('inactive keeps a client that has documents out of the pickers.') })
type ClientPatch = z.output<typeof clientPatch>

function withPatch(values: ClientValues, p: ClientPatch): ClientValues {
  const v = { ...values }
  if (p.name !== undefined) v.name = p.name
  if (p.company !== undefined) v.company = p.company
  if (p.email !== undefined) v.email = p.email
  if (p.cc_emails !== undefined) v.cc_emails = p.cc_emails.join(', ')
  if (p.phone !== undefined) v.phone = p.phone
  if (p.street !== undefined) v.address_line1 = p.street
  if (p.address_line2 !== undefined) v.address_line2 = p.address_line2
  if (p.zip !== undefined) v.zip = p.zip
  if (p.city !== undefined) v.city = p.city
  if (p.country !== undefined) v.country = p.country.toUpperCase()
  if (p.vat_id !== undefined) v.uid_number = p.vat_id
  if (p.tax_treatment !== undefined) v.tax_treatment = p.tax_treatment
  if (p.language !== undefined) v.language = p.language
  if (p.payment_terms_days !== undefined) v.payment_days = p.payment_terms_days
  if (p.skonto_percent !== undefined) v.skonto_percent = p.skonto_percent
  if (p.skonto_days !== undefined) v.skonto_days = p.skonto_days
  if (p.einvoice_format !== undefined) v.einvoice_format = p.einvoice_format ?? ''
  if (p.buyer_reference !== undefined) v.buyer_reference = p.buyer_reference
  if (p.notes !== undefined) v.notes = p.notes
  if (p.status !== undefined) v.status = p.status
  return v
}

const suggestion = (v: ClientValues) => suggestTaxTreatment(v.country, isValidVatId(normalizeVatId(v.uid_number)))

// clients.mcp_recipients (20261105_mcp_drafts.sql): an address a Claude session writes onto a
// client is marked until the owner saves the client in Mado; an email naming it is approved in
// Mado whatever the confirmation policy says.
const RECIPIENTS_NOTE = 'An email address or CC written here never counts as on the client record until the owner saves the client in Mado: emails to it are approved in Mado.'

// clients.mcp_written_at (20261105_mcp_drafts.sql): nothing goes out unattended for a client a
// Claude session created or changed until the owner saves it in Mado: the reminder cron skips its
// invoices and its Bookamat step the client's documents (src/app/api/cron/reminders/route.ts,
// autoSyncBookamat), a schedule that issues automatically creates its invoices as drafts
// (src/lib/utils/recurring.ts), no archive copy is rendered from it (getIssuedPdf) and the portal
// leaves its recipient block out. A reminder sent from Gmail, a Storno or a Bookamat sync for its
// documents is refused when prepared (refuseClaudeClient, actions/common.ts).
const UNATTENDED_NOTE = 'Until the owner saves the client in Mado, nothing goes out for it unattended: automatic reminders skip its invoices, the automatic Bookamat sync skips its documents, a recurring schedule that issues invoices automatically for it creates them as drafts instead, no archive copy (the frozen PDF) of its issued documents is made from it, and share links leave its name and address out, so no reminder, booking, numbered invoice or frozen PDF made without approval carries client data Claude wrote (name, company, address, VAT ID, terms). For the same reason prepare_send_reminder (gmail), prepare_storno and prepare_bookamat_sync refuse its documents until then.'

// documents.mcp_payments_at (20261105_mcp_drafts.sql): a payment row a Claude session records,
// changes or removes on an invoice, or a refund on a credit note, holds the document's automatic
// reminders and its automatic Bookamat sync until the owner confirms its payments on its page in
// Mado (src/app/api/cron/reminders/route.ts, autoSyncBookamat); meanwhile no archive copy is made
// of it (getIssuedPdf) and its share link shows no payments. An applied credit marks the credit
// note it names as well: it settles the credit note, whose refunds are then booked.
const PAYMENTS_NOTE = 'Recording, settling or removing money on an invoice, or a refund on a credit note, holds its automatic reminders and its automatic Bookamat sync until the owner confirms its payments on its page in Mado (an applied credit holds the credit note as well), so no Mahnung or Bookamat booking is made unattended from payments Claude wrote; meanwhile no archive copy (frozen PDF) is made of it and its share link shows no payments, balance or payment details.'
// What the mark holds for the document as it is now: reminders only while an invoice is open (the
// reminder cron looks at no other), the Bookamat sync always (it books paid invoices, cancelled
// ones and refunded credit notes).
function paymentsHeld(type: string, status: string) {
  const reminders = type === 'invoice' && (status === 'sent' || status === 'overdue')
  return {
    summary: reminders
      ? 'Until the owner confirms its payments in Mado, automatic reminders and the automatic Bookamat sync skip it; tell the owner.'
      : 'Until the owner confirms its payments in Mado, the automatic Bookamat sync skips it; tell the owner.',
    data: { ...(reminders ? { reminders_held: true } : {}), bookamat_sync_held: true },
  }
}
// apply_credit_note: the credit goes onto the invoice, and both the invoice and the credit note it
// names are marked (the credit settles the credit note, whose refunds are then booked).
const CREDIT_HELD = 'Until the owner confirms the payments of the invoice and of the credit note on their pages in Mado, the invoice\'s automatic reminders and the automatic Bookamat sync of both skip them; tell the owner.'

// The schedules that issue automatically for a client Claude has just changed: they now create
// drafts. Only for the reply; a failed lookup leaves the note out.
async function heldSchedules(supabase: SupabaseClient, client: Client): Promise<TemplateSchedule[]> {
  if (!client.mcp_written_at) return []
  try {
    return await issueSchedulesOfClient(supabase, client.id)
  } catch {
    return []
  }
}

// The addresses this write put on the client, as the database marks them.
function writtenAddresses(before: Pick<Client, 'email' | 'cc_emails'> | null, after: Client): string[] {
  const list = (c: Pick<Client, 'email' | 'cc_emails'>) => [c.email ?? '', ...(c.cc_emails ?? [])].map(a => a.trim().toLowerCase()).filter(Boolean)
  const known = new Set(before ? list(before) : [])
  return [...new Set(list(after).filter(a => !known.has(a)))]
}

// A client that already has this email or VAT ID is only a warning in the client form; here the
// call is refused until Claude confirms with allow_duplicate.
async function duplicatesOf(supabase: SupabaseClient, email: string | null, uid: string | null, exceptId?: string) {
  const found = await findDuplicateClients(supabase, { email, uid }, exceptId)
  return found.map(d => ({ id: d.client.id, client: clientWithNumber(d.client), reasons: d.reasons }))
}

function clientReply(client: Client, lead: string, extra: Record<string, unknown> = {}, written: string[] = [], held: TemplateSchedule[] = []) {
  // Set by the database for every write of a Claude session that changes the client.
  const changed = !!client.mcp_written_at
  const schedules = held.length
    ? `, and ${held.length === 1 ? 'the schedule' : 'the schedules'} ${held.map(h => `"${h.name}"`).join(', ')}, which ${held.length === 1 ? 'issues' : 'issue'} invoices for it automatically, ${held.length === 1 ? 'creates' : 'create'} drafts instead`
    : ''
  return {
    summary: [
      `${lead} ${clientWithNumber(client)}.`,
      written.length ? `Every later email to the client goes to ${written.join(', ')} too; until the owner saves this client in Mado, those emails are approved in Mado.` : '',
      changed ? `Until the owner saves this client in Mado, automatic reminders and the automatic Bookamat sync skip its documents${schedules}; tell the owner.` : '',
    ].filter(Boolean).join(' '),
    data: {
      id: client.id, client_number: client.client_number, name: client.name, company: client.company, email: client.email,
      cc_emails: client.cc_emails ?? [], country: client.country, vat_id: client.uid_number, tax_treatment: client.tax_treatment,
      language: client.language, payment_terms_days: client.payment_days, status: client.status, app_url: clientUrl(client.id), ...extra,
      ...(written.length ? { approved_in_mado: written } : {}),
      ...(changed ? { reminders_held: true, bookamat_sync_held: true, prepare_refused: ['send_reminder', 'storno', 'bookamat_sync'] } : {}),
      ...(held.length ? { auto_issue_held: held.map(h => ({ schedule_id: h.id, name: h.name, app_url: appUrl('/recurring') })) } : {}),
    },
  }
}

const createClient = defineTool({
  name: 'create_client',
  title: 'Create client',
  description: `Create a client. The client number is assigned by Mado. Without tax_treatment it follows the country and VAT ID. A client with the same email address or VAT ID is refused unless allow_duplicate is true (prefer the existing client). ${RECIPIENTS_NOTE} ${UNATTENDED_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({ ...clientFields, country: clientFields.country.unwrap(), allow_duplicate: z.boolean().optional() }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const defaults = toClientDefaults(await ctx.settings())
    let values = withPatch(toClientValues(undefined, defaults), args)
    if (args.tax_treatment === undefined) values = { ...values, tax_treatment: suggestion(values) ?? defaults.tax_treatment }
    const payload = toClientPayload(clientSchema(ctx.t).parse(values))
    const duplicates = await duplicatesOf(ctx.supabase, payload.email || null, payload.uid_number)
    if (duplicates.length && !args.allow_duplicate) {
      throw invalid(`A client with this email address or VAT ID exists already: ${duplicates.map(d => d.client).join('; ')}. Use it, or pass allow_duplicate: true to create another one.`, { duplicates })
    }
    const { client, error } = await saveClient(ctx.supabase, payload)
    if (error) throw error
    if (!client) throw notFound()
    return clientReply(client, 'Created client', { suggested_tax_treatment: suggestion(values), ...(duplicates.length ? { duplicates } : {}) }, writtenAddresses(null, client))
  },
})

const updateClient = defineTool({
  name: 'update_client',
  title: 'Update client',
  description: `Change a client's fields; only the fields in patch change. The new values apply to documents created later; existing documents keep theirs. A new email or CC list applies to every later email to the client, from Mado too. An email address or VAT ID another client has is refused unless allow_duplicate is true. ${RECIPIENTS_NOTE} ${UNATTENDED_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({ id, patch: clientPatch, allow_duplicate: z.boolean().optional() }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const current = await loadClient(ctx.supabase, args.id)
    const values = withPatch(toClientValues(current, toClientDefaults(await ctx.settings())), args.patch)
    const payload = toClientPayload(clientSchema(ctx.t).parse(values))
    const duplicates = await duplicatesOf(
      ctx.supabase,
      payload.email && payload.email.toLowerCase() !== (current.email ?? '').toLowerCase() ? payload.email : null,
      payload.uid_number && payload.uid_number !== current.uid_number ? payload.uid_number : null,
      current.id,
    )
    if (duplicates.length && !args.allow_duplicate) {
      throw invalid(`Another client has this email address or VAT ID: ${duplicates.map(d => d.client).join('; ')}. Pass allow_duplicate: true to save anyway.`, { duplicates })
    }
    const { client, error } = await saveClient(ctx.supabase, payload, current.id)
    if (error) throw error
    if (!client) throw notFound()
    const suggested = suggestion(values)
    return clientReply(client, 'Updated client', suggested && suggested !== client.tax_treatment ? { suggested_tax_treatment: suggested } : {}, writtenAddresses(current, client), await heldSchedules(ctx.supabase, client))
  },
})

// ─── Documents ───────────────────────────────────────────────────────────────

const LINES_HINT = `Lines in order (at most ${MAX_LINES}); amounts are net EUR. 'deduction' lines are never written: a final invoice's deductions follow the invoices it deducts.`

const createDocument = defineTool({
  name: 'create_document',
  title: 'Create draft',
  description: "Create an invoice or quote DRAFT (no number, EUR). The client's language, tax treatment, payment terms and Skonto apply unless given. Returns the draft with totals, what would stop issuing it, the number it would get and its link in Mado. Issuing is a separate, approved step (prepare_issue).",
  scope: 'mado:write',
  inputSchema: z.object({
    type: z.enum(['invoice', 'quote']),
    client_id: id,
    ...headerInput,
    invoice_kind: z.enum(['standard', 'partial']).optional().describe("Invoices: 'partial' is a Teilrechnung a final invoice may deduct later. Advance and final invoices come from convert_quote."),
    lines: z.array(lineInput).max(MAX_LINES).describe(LINES_HINT),
  }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const settings = await ctx.settings()
    const pub = toPublicSettings(settings)
    const client = await loadClient(ctx.supabase, args.client_id)
    let f = applyHeader(args.type, initialForm(args.type, pub, [client], undefined, client.id), args, { settings: pub, client, followDate: true })
    if (args.type === 'invoice' && args.invoice_kind) f = { ...f, invoiceKind: args.invoice_kind }
    const catalogue = await loadCatalogue(ctx.supabase, client.id, args.lines)
    f = { ...f, lines: newLines(args.lines, { language: f.language, catalogue, settings: pub }) }
    const { fields, items } = draftPayload(args.type, f, { mode: 'save', settings: pub, client })
    const saved = await saveDraft(ctx.supabase, { id: null, type: args.type, fields, items })
    if (saved.error) {
      // A draft without its lines is no draft; it goes again.
      if (saved.id) await deleteDraft(ctx.supabase, saved.id)
      throw saveFailure(saved.error, ctx)
    }
    return documentReply(ctx, saved.id!, 'Created.')
  },
})

const updateDocument = defineTool({
  name: 'update_document',
  title: 'Update draft',
  description: "Edit a DRAFT invoice, quote or credit note; anything with a number is refused (correct issued documents with a credit note or Storno). Header fields change only when given; a new client brings its language, tax treatment and terms. Lines: either `lines` (the full new list; give a line's id to keep it) or `line_ops`. A final invoice's deduction lines follow its deposits and cannot be edited. If the owner has the draft open in Mado's editor, its next autosave writes the editor's version back; ask them to close it first. The template of a recurring schedule (get_document shows recurring_template), whatever its mode, is refused: ask the owner to edit it in Mado.",
  scope: 'mado:write',
  inputSchema: z.object({
    id,
    header: z.object({
      client_id: id.optional(),
      ...headerInput,
      invoice_kind: z.enum(['standard', 'partial']).optional(),
    }).optional(),
    lines: z.array(lineInput).max(MAX_LINES).optional().describe('Replaces every line but deductions.'),
    line_ops: lineOpsInput.optional(),
  }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: false },
  async run(args, ctx) {
    if (args.lines && args.line_ops) throw invalid('Pass either lines or line_ops, not both.')
    const settings = await ctx.settings()
    const pub = toPublicSettings(settings)
    const { data: doc, error } = await ctx.supabase.from('documents').select('*, document_items(*)').eq('id', args.id).maybeSingle()
    if (error) throw error
    if (!doc) throw notFound()
    if (doc.number || doc.status !== 'draft') throw new McpToolError('draft_only')
    await refuseScheduleTemplate(ctx.supabase, doc.id)
    const header = args.header ?? {}
    if (header.invoice_kind && doc.type !== 'invoice') throw invalid('Only invoices have a kind.')
    const ids = [...new Set([doc.client_id as string, header.client_id].filter((v): v is string => !!v))]
    const { data: clients, error: clientsErr } = await ctx.supabase.from('clients').select('*').in('id', ids)
    if (clientsErr) throw clientsErr
    const list = (clients ?? []) as Client[]
    const previous = list.find(c => c.id === doc.client_id) ?? null

    // The stored lines as they are: the editor's blank first line of an empty document is no line.
    let f: FormState = { ...initialForm(doc.type, pub, list, { ...doc, items: doc.document_items ?? [] }), lines: linesFromItems(doc.document_items ?? []) }
    f = applyHeader(doc.type, f, header, { settings: pub })
    let client = previous
    if (header.client_id && header.client_id !== doc.client_id) {
      client = list.find(c => c.id === header.client_id) ?? null
      if (!client) throw notFound()
      f = applyClientChange(doc.type, f, header, pub, previous, client)
    }
    if (header.invoice_kind) f = { ...f, invoiceKind: header.invoice_kind }
    const inputs: LineInput[] = [...(args.lines ?? []), ...(args.line_ops?.add ?? []), ...(args.line_ops?.update ?? [])]
    const catalogue = await loadCatalogue(ctx.supabase, f.clientId, inputs)
    const lineCtx = { language: f.language, catalogue, settings: pub }
    if (args.lines) f = { ...f, lines: replaceLines(f.lines, args.lines, lineCtx) }
    else if (args.line_ops) f = { ...f, lines: applyLineOps(f.lines, args.line_ops, lineCtx) }

    const { fields, items } = draftPayload(doc.type, f, { mode: 'save', settings: pub, client })
    const saved = await saveDraft(ctx.supabase, { id: doc.id, type: doc.type, fields, items }, { draftOnly: true })
    if (saved.error) throw saveFailure(saved.error, ctx)
    const warnings: string[] = []
    if (doc.type === 'invoice' && f.invoiceKind === 'final') {
      try {
        await writeDeductions(ctx.supabase, doc.id)
      } catch (err) {
        console.error(`[mcp] deductions of ${doc.id} not written:`, err instanceof Error ? err.message : err)
        warnings.push('Its deduction lines could not be brought up to date; opening it in Mado does that.')
      }
    }
    return documentReply(ctx, doc.id, 'Saved.', {}, warnings)
  },
})

const duplicateDocumentTool = defineTool({
  name: 'duplicate_document',
  title: 'Duplicate document',
  description: "Copy any invoice, quote or credit note into a new DRAFT dated today, EUR, with the client's current terms. A final invoice's deduction lines are not copied (the copy is a standard invoice).",
  scope: 'mado:write',
  inputSchema: z.object({ id }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const copy = await duplicateDocument(ctx.supabase, args.id)
    if (copy.error) {
      if (copy.error.stage === 'load' && (!copy.error.cause || copy.error.cause.code === 'PGRST116')) throw notFound()
      throw copy.error.cause ?? new Error('Copy failed')
    }
    return documentReply(ctx, copy.id, 'Copied.', { copied_from: args.id })
  },
})

const convertQuoteTool = defineTool({
  name: 'convert_quote',
  title: 'Convert quote',
  description: "Make an invoice DRAFT from a sent or accepted quote: 'invoice' (all of it), 'advance' (an Anzahlungsrechnung for mode 'percent' or 'amount' gross of value), or 'final' (the Schlussrechnung that deducts the quote's issued advance and partial invoices). A sent quote becomes accepted, which cannot be undone: its share link shows it accepted at once and no longer takes the client's own answer, so convert only on the owner's word. For 'invoice' and 'final' a second call returns the draft made before.",
  scope: 'mado:write',
  inputSchema: z.object({
    quote_id: id,
    to: z.enum(['invoice', 'advance', 'final']),
    mode: z.enum(['percent', 'amount']).optional().describe("'advance' only."),
    value: z.number().positive().optional().describe("'advance' only: percent of the quote (at most 100) or a gross EUR amount."),
  }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: false },
  async run(args, ctx) {
    if (args.to === 'advance') {
      if (!args.mode || args.value === undefined) throw invalid("An advance invoice needs mode and value.")
      try {
        const { invoiceId, gross } = await createAdvanceInvoice(ctx.supabase, args.quote_id, { mode: args.mode, value: args.value })
        return documentReply(ctx, invoiceId, `Advance invoice draft for ${money(gross)} gross made; the quote is accepted.`, { quote_id: args.quote_id, existing: false })
      } catch (err) {
        if (err instanceof ServiceError && err.code === 'exceeds_quote') {
          const { amount, total } = err.details as { amount: number; total: number }
          throw new ServiceError(err.status, err.code, err.message, { amount: money(amount), total: money(total) })
        }
        throw err
      }
    }
    if (args.mode !== undefined || args.value !== undefined) throw invalid("mode and value are for to: 'advance' only.")
    const result = await convertQuote(ctx.supabase, args.quote_id, { final: args.to === 'final' })
    if (!result) throw notFound()
    const lead = result.existing
      ? 'The quote was converted before; this is its invoice.'
      : args.to === 'final' ? `Final invoice draft made, deducting ${result.linked} invoice(s); the quote is accepted.` : 'Invoice draft made; the quote is accepted.'
    return documentReply(ctx, result.invoiceId, lead, { quote_id: args.quote_id, existing: result.existing })
  },
})

const setQuoteStatus = defineTool({
  name: 'set_quote_status',
  title: 'Set quote status',
  description: "Mark a sent quote accepted or rejected (an accepted one rejected, or the other way round): what the client or the owner decided. A sent quote never becomes sent again, and its share link shows the new status at once and no longer takes the client's own answer, so set it only on the owner's word. Cancelling is prepare_cancel.",
  scope: 'mado:write',
  inputSchema: z.object({ id, status: z.enum(['accepted', 'rejected']) }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { data: doc, error } = await ctx.supabase.from('documents').select('type, status, number').eq('id', args.id).maybeSingle()
    if (error) throw error
    if (!doc) throw notFound()
    if (doc.type !== 'quote') throw invalid('Only quotes are accepted or rejected.')
    const result = await setDocumentStatus(ctx.supabase, args.id, args.status, { type: doc.type, status: doc.status })
    if (result.error) throw result.error
    return {
      summary: result.changed
        ? `Quote ${doc.number ?? '(draft)'} marked ${args.status} (was ${result.from}).${result.from === 'sent' ? " A share link to it shows this now and no longer takes the client's answer." : ''}`
        : `The quote is ${args.status} already.`,
      data: { id: args.id, number: doc.number, status: args.status, previous_status: result.from, changed: result.changed },
    }
  },
})

const linkDeposit = defineTool({
  name: 'link_deposit',
  title: 'Link deposit',
  description: "Deduct an issued advance or partial invoice of the same client on a final-invoice DRAFT (linked: true; the draft becomes a final invoice), or stop deducting it (linked: false). The draft's deduction lines are rewritten. A draft that is the template of a recurring schedule is refused.",
  scope: 'mado:write',
  inputSchema: z.object({ final_invoice_id: id, invoice_id: id, linked: z.boolean() }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { data: docs, error } = await ctx.supabase.from('documents').select('id, type, number, status, invoice_kind, client_id, final_invoice_id').in('id', [args.final_invoice_id, args.invoice_id])
    if (error) throw error
    const final = docs?.find(d => d.id === args.final_invoice_id)
    const deposit = docs?.find(d => d.id === args.invoice_id)
    if (!final || !deposit) throw notFound()
    if (final.type !== 'invoice') throw invalid(ctx.t('deposits.errors.invalidLink'))
    if (final.number || final.status !== 'draft') throw new McpToolError('draft_only')
    await refuseScheduleTemplate(ctx.supabase, final.id)
    if (args.linked && (deposit.type !== 'invoice' || !deposit.number || deposit.status === 'cancelled' || !['advance', 'partial'].includes(deposit.invoice_kind) || deposit.client_id !== final.client_id)) {
      throw invalid(ctx.t('deposits.errors.invalidLink'))
    }
    const taken = () => invalid(ctx.t('deposits.builder.taken', { number: deposit.number ?? '' }))
    if (args.linked && deposit.final_invoice_id && deposit.final_invoice_id !== final.id) throw taken()
    const already = args.linked === (deposit.final_invoice_id === final.id)
    // A repeat only brings the deduction lines in step with what is deducted now.
    const result = already ? (await writeDeductions(ctx.supabase, final.id), 'ok') : await setDepositLink(ctx.supabase, final.id, deposit.id, args.linked)
    if (result === 'taken') {
      // Another final invoice took it meanwhile; linkDeposit had already made this draft a final invoice.
      if (final.invoice_kind !== 'final') {
        const { error: kindErr } = await ctx.supabase.from('documents').update({ invoice_kind: final.invoice_kind ?? 'standard' }).eq('id', final.id).is('number', null)
        if (kindErr) console.error(`[mcp] kind of ${final.id} not restored:`, kindErr.message)
      }
      throw taken()
    }
    const lead = already ? `Unchanged: ${args.linked ? 'already' : 'not'} deducting ${deposit.number ?? 'it'}.`
      : args.linked ? `Now deducting ${deposit.number}.` : `No longer deducting ${deposit.number ?? 'it'}.`
    return documentReply(ctx, args.final_invoice_id, lead)
  },
})

// ─── Money ───────────────────────────────────────────────────────────────────

const INVOICE_MONEY_COLS = 'id, type, number, status, date, currency, skonto_percent, skonto_days, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(id, date, amount, kind, method, note, reference, import_ref, credit_note_id)'

type MoneyDoc = {
  id: string; type: string; number: string | null; status: string; date: string; currency: string
  skonto_percent: number | null; skonto_days: number | null
  tax_treatment: string | null; discount_type: string | null; discount_value: number | null
  document_items: Parameters<typeof documentTotal>[0]['document_items']
  payments: (Payment & { import_ref?: string | null })[] | null
}

async function loadMoneyDoc(supabase: SupabaseClient, documentId: string): Promise<MoneyDoc | null> {
  const { data, error } = await supabase.from('documents').select(INVOICE_MONEY_COLS).eq('id', documentId).maybeSingle()
  if (error) throw error
  return data as unknown as MoneyDoc | null
}

function payable(doc: MoneyDoc | null, date: string, ctx: ToolContext): MoneyDoc {
  if (doc?.type === 'credit_note') throw invalid('This is a credit note: payments and settlements go on invoices; money paid back on a credit note is record_refund.')
  const refusal = paymentRefusal(doc, date, today())
  if (refusal === 'not_found') throw notFound()
  if (refusal === 'not_issued') throw invalid(ctx.t('payments.issueBeforePayment'))
  if (refusal === 'cancelled') throw invalid(ctx.t('payments.cancelledInvoice'))
  if (refusal) throw invalid(ctx.t(refusal === 'date_required' ? 'lifecycle.payments.dateRequired' : 'lifecycle.payments.dateFuture'))
  return doc!
}

const balanceOf = (total: number, payments: { amount: number; kind?: string | null }[]) => roundCents(total - settledSum(payments))

const shortPayment = (p: Payment) => ({ id: p.id, date: p.date, amount: p.amount, kind: p.kind, method: p.method, reference: p.reference ?? null, note: p.note ?? null })

const recordPayment = defineTool({
  name: 'record_payment',
  title: 'Record payment',
  description: `Record money received on an ISSUED invoice (drafts are refused; nothing is issued implicitly). More than the open balance needs overpayment: 'fee' (the rest is dunning fees and interest, not turnover) or 'payment'. The invoice becomes paid once settled. Pass an idempotency_key to make a retry safe. ${PAYMENTS_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({
    invoice_id: id,
    amount: z.number().positive().max(MAX_AMOUNT).describe('EUR received.'),
    date: isoDate.describe('The day the money arrived; not in the future.'),
    method: z.enum(['bank', 'cash']),
    reference: z.string().max(140).optional(),
    note: z.string().max(200).optional(),
    overpayment: z.enum(['fee', 'payment']).optional(),
    idempotency_key: z.string().min(8).max(100).optional(),
  }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: true },
  async run(args, ctx) {
    const doc = payable(await loadMoneyDoc(ctx.supabase, args.invoice_id), args.date, ctx)
    const payments = doc.payments ?? []
    const key = args.idempotency_key ? mcpPaymentRef(doc.id, args.idempotency_key) : null
    if (key) {
      const earlier = payments.filter(p => p.import_ref === key || p.import_ref === `${key}:fee`)
      if (earlier.length) return paymentReply(doc, payments, earlier, await catchUpPaid(ctx, doc, payments), true)
    }
    const total = documentTotal(doc)
    if (paymentState(total, payments) === 'nothing_due') throw invalid(ctx.t('lifecycle.payments.nothingToPay'))
    const amount = roundCents(args.amount)
    const balance = balanceOf(total, payments)
    if (amount > balance + 0.005 && !args.overpayment) {
      throw invalid(`${money(amount, doc.currency)} is more than the open balance of ${money(Math.max(0, balance), doc.currency)}. Pass overpayment: 'fee' to record the rest as dunning fees and interest, or 'payment' to record all of it as payment.`, { balance_due: balance })
    }
    const row = (amt: number, kind: NewPayment['kind'] = 'payment'): NewPayment => ({
      date: args.date, amount: amt, note: args.note?.trim() || null, kind, method: args.method as PaymentMethod, reference: args.reference?.trim() || null,
      ...(key ? { import_ref: kind === 'fee' ? `${key}:fee` : key } : {}),
    })
    const rows = paymentRows(amount, balance, args.overpayment, row)
    const result = await recordInvoicePayments(ctx.supabase, { id: doc.id, status: doc.status, total, payments }, rows)
    if (result.error?.code === '23505' && key) {
      const again = await loadMoneyDoc(ctx.supabase, doc.id)
      const stored = (again?.payments ?? []).filter(p => p.import_ref === key || p.import_ref === `${key}:fee`)
      if (stored.length) return paymentReply(again!, again!.payments ?? [], stored, await catchUpPaid(ctx, again!, again!.payments ?? []), true)
    }
    if (result.error) throw result.error
    return paymentReply(doc, [...payments, ...result.added], result.added, paidOutcome(result), false)
  },
})

type PaidOutcome = { becamePaid: boolean; failed: boolean }

const paidOutcome = (r: RecordedPayments): PaidOutcome => ({ becamePaid: r.settled && !r.statusError, failed: r.settled && !!r.statusError })

// A retry finds its payment recorded; if marking the invoice paid failed that time, it goes again.
async function catchUpPaid(ctx: ToolContext, doc: MoneyDoc, all: Payment[]): Promise<PaidOutcome> {
  if (!PAYABLE.includes(doc.status) || settledSum(all) < documentTotal(doc) - 0.005) return { becamePaid: false, failed: false }
  const { updated, error } = await markPaid(ctx.supabase, [doc])
  if (error) console.error(`[mcp] ${doc.id} not marked paid:`, error.message)
  return { becamePaid: updated.length > 0, failed: !!error }
}

const NOT_MARKED_PAID = 'The money is recorded, but the invoice could not be marked paid; open it in Mado.'

function paymentReply(doc: MoneyDoc, all: Payment[], added: Payment[], { becamePaid, failed }: PaidOutcome, repeated: boolean) {
  const total = documentTotal(doc)
  const balance = balanceOf(total, all)
  const status = becamePaid ? 'paid' : doc.status
  const what = added.map(p => `${money(p.amount, doc.currency)}${p.kind === 'fee' ? ' as fees' : ''}`).join(' and ')
  const warning = failed ? NOT_MARKED_PAID : null
  // Set by the database on every payment row a Claude session writes (documents.mcp_payments_at).
  const held = repeated ? null : paymentsHeld(doc.type, status)
  return {
    summary: [
      repeated ? `Already recorded with this idempotency key on ${doc.number}: ${what}.` : `Recorded ${what} on ${doc.number}.`,
      becamePaid ? 'The invoice is paid.' : !repeated && balance > 0.005 ? `Open: ${money(balance, doc.currency)}.` : '',
      held?.summary ?? '',
      warning ?? '',
    ].filter(Boolean).join(' '),
    data: {
      invoice_id: doc.id, number: doc.number, added: added.map(shortPayment), repeated,
      total, balance_due: balance, status, became_paid: becamePaid,
      payment_state: paymentState(total, all),
      ...held?.data,
      ...(warning ? { warnings: [warning] } : {}),
    },
  }
}

const removePaymentTool = defineTool({
  name: 'remove_payment',
  title: 'Remove payment',
  description: `Delete a payment, fee, Skonto, write-off, applied credit or refund row. A paid invoice that is no longer settled is reopened (sent or overdue). Money an issued final invoice deducts stays (refused). ${PAYMENTS_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({ payment_id: id }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { data: row, error } = await ctx.supabase.from('payments').select('id, document_id, date, amount, kind, method').eq('id', args.payment_id).maybeSingle()
    if (error) throw error
    if (!row) throw notFound()
    const doc = await loadMoneyDoc(ctx.supabase, row.document_id)
    if (!doc) throw notFound()
    const remaining = (doc.payments ?? []).filter(p => p.id !== row.id)
    const total = documentTotal(doc)
    const reopen = doc.type === 'invoice' && reopensOnRemoval(doc.status, total, remaining)
    const { reopened, error: removeErr } = await removePayment(ctx.supabase, doc.id, row.id, { reopen, removed: row as RemovedPayment })
    if (removeErr) throw removeErr
    const status = reopened ?? doc.status
    const held = paymentsHeld(doc.type, status)
    return {
      summary: `Removed ${money(row.amount, doc.currency)} (${row.kind}) from ${doc.number ?? 'the document'}.${reopened ? ` It is ${reopened} again.` : ''} ${held.summary}`,
      data: {
        removed: { id: row.id, date: row.date, amount: row.amount, kind: row.kind, method: row.method },
        document_id: doc.id, number: doc.number, status, reopened: !!reopened,
        ...(doc.type === 'invoice' ? { balance_due: balanceOf(total, remaining) } : {}),
        ...held.data,
      },
    }
  },
})

const settleBalance = defineTool({
  name: 'settle_balance',
  title: 'Settle balance',
  description: `Close an issued invoice's remaining balance without money: 'skonto' (only when the money arrived within the Skonto period and covers the total less Skonto) or 'write_off' (a reason is required from EUR 1.00 up). The invoice becomes paid. ${PAYMENTS_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({ invoice_id: id, how: z.enum(['skonto', 'write_off']), reason: z.string().max(200).optional() }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: false },
  async run(args, ctx) {
    const doc = payable(await loadMoneyDoc(ctx.supabase, args.invoice_id), today(), ctx)
    const payments = doc.payments ?? []
    const total = documentTotal(doc)
    if (paymentState(total, payments) === 'nothing_due') throw invalid(ctx.t('lifecycle.payments.nothingToPay'))
    const balance = balanceOf(total, payments)
    if (balance <= 0.005) throw invalid(`Nothing is open on ${doc.number}.`)
    const reason = args.reason?.trim() || null
    if (args.how === 'skonto' && !skontoOffered({ total, date: doc.date, skontoPercent: doc.skonto_percent, skontoDays: doc.skonto_days, payments })) {
      throw invalid(`Skonto does not apply: the invoice needs a Skonto, the last payment must have arrived within its Skonto period, and the open ${money(balance, doc.currency)} must not exceed the Skonto.`)
    }
    if (args.how === 'write_off' && balance >= SMALL_DIFFERENCE && !reason) throw invalid(`Writing off ${money(balance, doc.currency)} needs a reason.`)
    const kind = args.how === 'skonto' ? 'skonto' : 'writeoff'
    const result = await recordInvoicePayments(ctx.supabase, { id: doc.id, status: doc.status, total, payments },
      [settlementRow(kind, balance, today(), { skontoPercent: doc.skonto_percent, reason })])
    if (result.error) throw result.error
    return paymentReply(doc, [...payments, ...result.added], result.added, paidOutcome(result), false)
  },
})

const applyCreditNoteTool = defineTool({
  name: 'apply_credit_note',
  title: 'Apply credit note',
  description: `Apply an issued credit note to the open balance of the invoice it corrects (credit_note_id), or catch up on every issued credit note not applied yet (all: true). Issuing a credit note applies it already; a repeat changes nothing. ${PAYMENTS_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({ credit_note_id: id.optional(), all: z.boolean().optional() }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: true },
  async run(args, ctx) {
    if (!!args.credit_note_id === !!args.all) throw invalid('Pass either credit_note_id or all: true.')
    if (args.credit_note_id) {
      const result = await applyCreditNote(ctx.supabase, args.credit_note_id)
      return {
        summary: result.applied
          ? `Applied ${money(result.applied)} to ${result.invoiceNumber}. ${CREDIT_HELD}`
          : 'Nothing to apply: the credit note is applied already, not issued, or its invoice has nothing open.',
        data: {
          credit_note_id: args.credit_note_id, applied: result.applied, invoice_id: result.invoiceId, invoice_number: result.invoiceNumber,
          ...(result.applied ? { reminders_held: true, bookamat_sync_held: true, credit_note_bookamat_sync_held: true } : {}),
        },
      }
    }
    const pending = await unappliedCreditNotes(ctx.supabase)
    const applied: { credit_note: string; invoice: string | null; amount: number }[] = []
    const failed: string[] = []
    for (const cn of pending) {
      try {
        const result = await applyCreditNote(ctx.supabase, cn.id, { date: cn.date })
        if (result.applied) applied.push({ credit_note: cn.number, invoice: result.invoiceNumber, amount: result.applied })
      } catch (err) {
        console.error(`[mcp] ${cn.number} not applied:`, err instanceof Error ? err.message : err)
        failed.push(cn.number)
      }
    }
    return {
      summary: applied.length || failed.length
        ? `Applied ${applied.length} credit note(s).${failed.length ? ` Not applied: ${failed.join(', ')}.` : ''}${applied.length ? ' Until the owner confirms the payments of those invoices and credit notes on their pages in Mado, the invoices\' automatic reminders and the automatic Bookamat sync of both skip them; tell the owner.' : ''}`
        : 'Every issued credit note is applied already.',
      data: { applied, failed, ...(applied.length ? { reminders_held: true, bookamat_sync_held: true, credit_note_bookamat_sync_held: true } : {}) },
    }
  },
})

const recordRefundTool = defineTool({
  name: 'record_refund',
  title: 'Record refund',
  description: `Record money paid back to the client on an ISSUED credit note. More than is still open on the credit note needs allow_over_open: true. ${PAYMENTS_NOTE}`,
  scope: 'mado:write',
  inputSchema: z.object({
    credit_note_id: id,
    amount: z.number().positive().max(MAX_AMOUNT),
    date: isoDate.describe('The day the money left; not in the future.'),
    method: z.enum(['bank', 'cash']),
    reference: z.string().max(140).optional(),
    note: z.string().max(200).optional(),
    allow_over_open: z.boolean().optional(),
  }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const { data: cn, error } = await ctx.supabase.from('documents')
      .select('id, type, number, status, currency, converted_from_id, tax_treatment, discount_type, discount_value, document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value), payments(*)')
      .eq('id', args.credit_note_id).maybeSingle()
    if (error) throw error
    if (!cn || cn.type !== 'credit_note') throw notFound()
    if (!cn.number || cn.status === 'draft') throw invalid(ctx.t('lifecycle.credit.notIssued'))
    const issue = paymentDateIssue(args.date, today())
    if (issue) throw invalid(ctx.t(issue === 'required' ? 'lifecycle.payments.dateRequired' : 'lifecycle.payments.dateFuture'))
    const settlement = await loadCreditNoteSettlement(ctx.supabase, cn)
    const sum = (rows: { amount: number }[]) => roundCents(rows.reduce((s, r) => s + r.amount, 0))
    const open = creditNoteOpen(settlement.total, sum(settlement.applied), sum(settlement.refunds))
    const amount = roundCents(args.amount)
    if (amount > open + 0.005 && !args.allow_over_open) {
      throw invalid(`${money(amount, cn.currency)} is more than the ${money(open, cn.currency)} still open on ${cn.number}. Pass allow_over_open: true if that is right.`, { open })
    }
    const { refund, error: insErr } = await recordRefund(ctx.supabase, cn.id, {
      date: args.date, amount, method: args.method, reference: args.reference?.trim() || null, note: args.note?.trim() || null,
    })
    if (insErr) throw insErr
    const left = Math.max(0, roundCents(open - amount))
    // Set by the database on the refund row (documents.mcp_payments_at).
    const held = paymentsHeld(cn.type, cn.status)
    return {
      summary: `Recorded a refund of ${money(amount, cn.currency)} on ${cn.number}. ${left > 0.005 ? `Still open: ${money(left, cn.currency)}.` : 'The credit note is settled.'} ${held.summary}`,
      data: { credit_note_id: cn.id, number: cn.number, refund: refund && shortPayment(refund), open: left, ...held.data },
    }
  },
})

// ─── Projects and time ───────────────────────────────────────────────────────

async function loadProject(supabase: SupabaseClient, projectId: string): Promise<Project> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle()
  if (error) throw error
  if (!data) throw notFound()
  return data as Project
}

const saveProjectTool = defineTool({
  name: 'save_project',
  title: 'Save project',
  description: "Create a project (client_id and name required) or change one (id; only the given fields change). Status: active, done or archived. A project with billed entries keeps its client.",
  scope: 'mado:write',
  inputSchema: z.object({
    id: id.optional(),
    client_id: id.optional(),
    name: z.string().max(160).optional(),
    status: z.enum(PROJECT_STATUSES as ['active', 'done', 'archived']).optional(),
    hourly_rate: z.number().min(0).max(100_000).nullable().optional().describe('Net EUR for time entries without a rate of their own.'),
    budget_hours: z.number().min(0).max(1_000_000).nullable().optional().describe('0 or null: no budget.'),
    budget_amount: z.number().min(0).max(MAX_AMOUNT).nullable().optional().describe('Net EUR; 0 or null: no budget.'),
    notes: z.string().max(10_000).optional(),
  }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: false },
  async run(args, ctx) {
    const current = args.id ? await loadProject(ctx.supabase, args.id) : null
    if (current && args.client_id && args.client_id !== current.client_id) {
      const [{ count: time }, { count: expenses }] = await Promise.all([
        ctx.supabase.from('time_entries').select('id', { count: 'exact', head: true }).eq('project_id', current.id).not('invoiced_document_id', 'is', null),
        ctx.supabase.from('project_expenses').select('id', { count: 'exact', head: true }).eq('project_id', current.id).not('invoiced_document_id', 'is', null),
      ])
      if ((time ?? 0) + (expenses ?? 0) > 0) throw invalid('This project has billed entries, so it stays with its client.')
    }
    const values: ProjectValues = {
      client_id: args.client_id ?? current?.client_id ?? '',
      name: args.name ?? current?.name ?? '',
      status: args.status ?? current?.status ?? 'active',
      hourly_rate: args.hourly_rate !== undefined ? args.hourly_rate : current?.hourly_rate ?? null,
      budget_hours: args.budget_hours !== undefined ? args.budget_hours : current?.budget_hours ?? null,
      budget_amount: args.budget_amount !== undefined ? args.budget_amount : current?.budget_amount ?? null,
      notes: args.notes ?? current?.notes ?? '',
    }
    const problem = projectProblem(values)
    if (problem) throw invalid(ctx.t(problem))
    if (!current) await loadClient(ctx.supabase, values.client_id)
    const { id: savedId, error } = await saveProject(ctx.supabase, projectRow(values), current?.id)
    if (error) throw error
    const project = await loadProject(ctx.supabase, savedId!)
    return {
      summary: `${current ? 'Saved' : 'Created'} project ${project.name} (${project.status}).`,
      data: { ...project, app_url: projectUrl(project.id) },
    }
  },
})

const durationInput = z.union([z.string().max(20), z.number().int()]).describe(`'1:30', '1.5h', '90m', or whole minutes (1 to ${MAX_ENTRY_MINUTES}).`)
const minutesOf = (d: string | number) => (typeof d === 'number' ? (d >= 1 && d <= MAX_ENTRY_MINUTES ? d : null) : parseDuration(d))

const timeFields = {
  date: isoDate,
  duration: durationInput,
  description: z.string().max(500).optional(),
  billable: z.boolean().optional().describe('Default true.'),
  rate: z.number().min(0).max(100_000).nullable().optional().describe("Net EUR per hour; null: the project's rate."),
}

function timeReply(entry: TimeEntry, project: Project, lead: string) {
  return {
    summary: `${lead} ${formatDuration(entry.minutes)} on ${project.name} (${entry.date})${entry.billable ? `, ${money(entryAmount(entry, project))} net` : ', not billable'}.`,
    data: { kind: 'time', ...entry, amount: entry.billable ? entryAmount(entry, project) : 0, project_name: project.name, app_url: projectUrl(project.id) },
  }
}

function expenseReply(expense: ProjectExpense, project: Project, lead: string) {
  return {
    summary: `${lead} ${expense.description} on ${project.name}: ${money(expensePrice(expense))} net${expense.billable ? '' : ', not billable'}.`,
    data: { kind: 'expense', ...expense, price: expensePrice(expense), project_name: project.name, app_url: projectUrl(project.id) },
  }
}

const logTime = defineTool({
  name: 'log_time',
  title: 'Log time',
  description: 'Log a time entry on a project.',
  scope: 'mado:write',
  inputSchema: z.object({ project_id: id, ...timeFields }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const project = await loadProject(ctx.supabase, args.project_id)
    const minutes = minutesOf(args.duration)
    const rate = args.rate ?? null
    const problem = timeEntryProblem({ project_id: project.id, date: args.date, minutes, rate })
    if (problem || minutes === null) throw invalid(ctx.t(problem ?? 'projects.time.durationInvalid'))
    const { entry, error } = await saveTimeEntry(ctx.supabase, { project_id: project.id, date: args.date, minutes, description: (args.description ?? '').trim(), billable: args.billable ?? true, rate })
    if (error) throw error
    if (!entry) throw notFound()
    return timeReply(entry, project, 'Logged')
  },
})

const expenseFields = {
  date: isoDate,
  description: z.string().min(1).max(500),
  net_amount: z.number().positive().max(MAX_AMOUNT).describe('Net EUR.'),
  vat_rate: z.union([z.literal(0), z.literal(10), z.literal(13), z.literal(20)]),
  billable: z.boolean().optional().describe('Default true.'),
  markup_percent: z.number().min(0).max(1000).nullable().optional(),
}

const logExpense = defineTool({
  name: 'log_expense',
  title: 'Log expense',
  description: 'Log a cost on a project, passed on to the client at its net amount plus an optional markup.',
  scope: 'mado:write',
  inputSchema: z.object({ project_id: id, ...expenseFields }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    const project = await loadProject(ctx.supabase, args.project_id)
    const values: ExpenseValues = {
      date: args.date, description: args.description, net_amount: args.net_amount, vat_rate: args.vat_rate as VatRate,
      billable: args.billable ?? true, markup_percent: args.markup_percent ?? null,
    }
    const problem = expenseProblem(values)
    if (problem) throw invalid(ctx.t(problem))
    const { expense, error } = await saveExpense(ctx.supabase, expenseRow(project.id, values))
    if (error) throw error
    if (!expense) throw notFound()
    return expenseReply(expense, project, 'Logged')
  },
})

const BILLED = 'This entry is billed on an invoice and stays as it is; release it first if that invoice is a draft or cancelled.'

const updateEntry = defineTool({
  name: 'update_entry',
  title: 'Update entry',
  description: 'Change an UNBILLED time entry or expense; only the fields in patch change. Billed entries cannot be changed.',
  scope: 'mado:write',
  inputSchema: z.object({
    kind: z.enum(['time', 'expense']),
    id,
    patch: z.object({
      date: isoDate.optional(),
      duration: durationInput.optional().describe('Time entries.'),
      description: z.string().max(500).optional(),
      billable: z.boolean().optional(),
      rate: timeFields.rate.describe('Time entries.'),
      net_amount: expenseFields.net_amount.optional().describe('Expenses.'),
      vat_rate: expenseFields.vat_rate.optional().describe('Expenses.'),
      markup_percent: expenseFields.markup_percent.describe('Expenses.'),
    }),
  }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const p = args.patch
    if (args.kind === 'time') {
      const { data: entry, error } = await ctx.supabase.from('time_entries').select('*').eq('id', args.id).maybeSingle()
      if (error) throw error
      if (!entry) throw notFound()
      if (entry.invoiced_document_id) throw invalid(BILLED)
      if (p.net_amount !== undefined || p.vat_rate !== undefined || p.markup_percent !== undefined) throw invalid('net_amount, vat_rate and markup_percent belong to expenses.')
      const minutes = p.duration !== undefined ? minutesOf(p.duration) : entry.minutes
      const rate = p.rate !== undefined ? p.rate : entry.rate
      const date = p.date ?? entry.date
      const problem = timeEntryProblem({ project_id: entry.project_id, date, minutes, rate })
      if (problem || minutes === null) throw invalid(ctx.t(problem ?? 'projects.time.durationInvalid'))
      const { entry: saved, error: saveErr } = await saveTimeEntry(ctx.supabase, {
        project_id: entry.project_id, date, minutes, description: (p.description ?? entry.description).trim(), billable: p.billable ?? entry.billable, rate,
      }, entry.id)
      if (saveErr) throw saveErr
      if (!saved) throw invalid(BILLED)
      return timeReply(saved, await loadProject(ctx.supabase, saved.project_id), 'Saved')
    }
    const { data: expense, error } = await ctx.supabase.from('project_expenses').select('*').eq('id', args.id).maybeSingle()
    if (error) throw error
    if (!expense) throw notFound()
    if (expense.invoiced_document_id) throw invalid(BILLED)
    if (p.duration !== undefined || p.rate !== undefined) throw invalid('duration and rate belong to time entries.')
    const values: ExpenseValues = {
      date: p.date ?? expense.date,
      description: p.description ?? expense.description,
      net_amount: p.net_amount ?? expense.net_amount,
      vat_rate: (p.vat_rate ?? expense.vat_rate) as VatRate,
      billable: p.billable ?? expense.billable,
      markup_percent: p.markup_percent !== undefined ? p.markup_percent : expense.markup_percent,
    }
    const problem = expenseProblem(values)
    if (problem) throw invalid(ctx.t(problem))
    const { expense: saved, error: saveErr } = await saveExpense(ctx.supabase, expenseRow(expense.project_id, values), expense.id)
    if (saveErr) throw saveErr
    if (!saved) throw invalid(BILLED)
    return expenseReply(saved, await loadProject(ctx.supabase, saved.project_id), 'Saved')
  },
})

const deleteEntryTool = defineTool({
  name: 'delete_entry',
  title: 'Delete entry',
  description: 'Delete an UNBILLED time entry or expense. Billed entries cannot be deleted.',
  scope: 'mado:write',
  inputSchema: z.object({ kind: z.enum(['time', 'expense']), id }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { deleted, error } = await deleteEntry(ctx.supabase, args.kind, args.id)
    if (error) throw error
    if (!deleted) {
      const { data } = await ctx.supabase.from(args.kind === 'time' ? 'time_entries' : 'project_expenses').select('invoiced_document_id').eq('id', args.id).maybeSingle()
      if (data?.invoiced_document_id) throw invalid(BILLED)
      throw notFound()
    }
    return { summary: `Deleted the ${args.kind === 'time' ? 'time entry' : 'expense'}.`, data: { kind: args.kind, id: args.id, deleted: true } }
  },
})

const ids500 = z.array(id).max(500)

const invoiceProject = defineTool({
  name: 'invoice_project',
  title: 'Invoice project work',
  description: "Turn unbilled billable time entries and expenses of a project into one invoice DRAFT for its client, and link them to its lines. Without ids, all of the project's unbilled billable work is used. grouping: one line per entry, per description or per day.",
  scope: 'mado:write',
  inputSchema: z.object({
    project_id: id,
    time_entry_ids: ids500.optional(),
    expense_ids: ids500.optional(),
    grouping: z.enum(INVOICE_GROUPINGS as ['entry', 'description', 'day']).optional().describe("Default 'entry'."),
  }),
  hints: { ...WRITE, destructiveHint: false, idempotentHint: false },
  async run(args, ctx) {
    let timeEntryIds = [...new Set(args.time_entry_ids ?? [])]
    let expenseIds = [...new Set(args.expense_ids ?? [])]
    if (!args.time_entry_ids && !args.expense_ids) {
      const [time, expenses] = await Promise.all([
        ctx.supabase.from('time_entries').select('id').eq('project_id', args.project_id).eq('billable', true).is('invoiced_document_id', null).limit(500),
        ctx.supabase.from('project_expenses').select('id').eq('project_id', args.project_id).eq('billable', true).is('invoiced_document_id', null).limit(500),
      ])
      if (time.error) throw time.error
      if (expenses.error) throw expenses.error
      timeEntryIds = (time.data ?? []).map(r => r.id as string)
      expenseIds = (expenses.data ?? []).map(r => r.id as string)
    }
    const result = await invoiceProjectEntries(ctx.supabase, args.project_id, { timeEntryIds, expenseIds, grouping: args.grouping ?? 'entry' })
    if (!result.ok) {
      if (result.code === 'not_found') throw notFound()
      if (result.code === 'nothing') throw invalid(ctx.t('projects.invoice.nothing'))
      if (result.code === 'entries_changed') throw invalid('Some of these entries are billed already or no longer billable. Fetch the project again and pick its unbilled entries.')
      throw result.error ?? new Error(result.message)
    }
    return documentReply(ctx, result.documentId, `Invoice draft made from ${result.timeEntries} time entr${result.timeEntries === 1 ? 'y' : 'ies'} and ${result.expenses} expense(s).`, { project_id: args.project_id })
  },
})

const releaseProjectEntries = defineTool({
  name: 'release_project_entries',
  title: 'Release project entries',
  description: 'Unlink time entries and expenses from the DRAFT or cancelled invoice they are billed on, so they count as unbilled again. What an issued invoice billed stays billed.',
  scope: 'mado:write',
  inputSchema: z.object({ time_entry_ids: ids500.optional(), expense_ids: ids500.optional() }),
  hints: { ...WRITE, destructiveHint: true, idempotentHint: true },
  async run(args, ctx) {
    const timeEntryIds = [...new Set(args.time_entry_ids ?? [])]
    const expenseIds = [...new Set(args.expense_ids ?? [])]
    if (!timeEntryIds.length && !expenseIds.length) throw invalid('Pass time_entry_ids or expense_ids.')
    const { released, error } = await releaseEntries(ctx.supabase, { timeEntryIds, expenseIds })
    if (error) throw error
    const asked = timeEntryIds.length + expenseIds.length
    return {
      summary: released
        ? `Released ${released} of ${asked} entr${asked === 1 ? 'y' : 'ies'}; they count as unbilled again.`
        : 'Nothing was released: these entries are unbilled already or billed on an issued invoice.',
      data: { released, requested: asked },
    }
  },
})

export const DRAFT_TOOLS: readonly AnyToolDef[] = [
  createClient,
  updateClient,
  createDocument,
  updateDocument,
  duplicateDocumentTool,
  convertQuoteTool,
  setQuoteStatus,
  linkDeposit,
  recordPayment,
  removePaymentTool,
  settleBalance,
  applyCreditNoteTool,
  recordRefundTool,
  saveProjectTool,
  logTime,
  logExpense,
  updateEntry,
  deleteEntryTool,
  invoiceProject,
  releaseProjectEntries,
]
