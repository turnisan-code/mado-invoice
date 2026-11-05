// Emailing an issued document from the connected Gmail account: the frozen PDF, optionally the
// e-invoice, then the Drive copy when asked.
import { z } from 'zod'
import { pdfFilename } from '@/lib/pdf/render'
import { exportEInvoice } from '@/lib/einvoice/export'
import { einvoiceFilename } from '@/lib/einvoice/common'
import {
  composeDocumentEmail, documentEmailTemplate, hasPortalLinkToken, sendDocumentEmail,
  type EmailFailure,
} from '@/lib/services/email'
import type { PrintedClient } from '@/lib/services/issue'
import { parseEmailList, templateLang } from '@/lib/templates'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals } from '@/lib/utils/document'
import type { DocumentType, EInvoiceFormat, InvoiceKind, Settings } from '@/types'
import { APP_URL, documentPdfUrl, documentUrl } from '../config'
import { McpToolError } from '../errors'
import { cents, exact, fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext, type ToolContext } from '../types'
import {
  checkAddresses, claudeWrittenAt, codedError, emailArgs, gmailConnected, itemsState, newRecipients, notice, paymentsState, printedClient, refuse,
  refuseClaudeClient, refuseClaudePayments, uniqueAddresses,
} from './common'
import { clip, money, word, type Worded } from './words'

const EMAIL_DOC_COLUMNS = [
  // The whole rows: Claude's marks (documents.mcp_payments_at, clients.mcp_written_at) are read
  // without naming the columns (a database without them has nothing from Claude).
  '*',
  'clients(*)',
  'document_items(id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate, discount_type, discount_value, service_date, service_date_end, catalogue_item_id)',
  'payments(id, date, amount, kind, method)',
].join(', ')

export type EmailClient = PrintedClient & { id: string; cc_emails: string[] | null; einvoice_format: EInvoiceFormat | null }

export type EmailDoc = {
  id: string
  type: DocumentType
  number: string | null
  status: string
  date: string
  due_date: string | null
  language: string | null
  currency: string | null
  tax_treatment: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  skonto_percent: number | null
  skonto_days: number | null
  invoice_kind: InvoiceKind | null
  issued_total: number | null
  drive_file_id: string | null
  service_date: string | null
  service_date_end: string | null
  buyer_reference: string | null
  notes: string | null
  // Set while payments a Claude session recorded, changed or removed are not confirmed in Mado.
  mcp_payments_at?: string | null
  clients: EmailClient | null
  document_items: Record<string, unknown>[] | null
  payments: { id: string; date: string; amount: number; kind: string | null; method: string | null }[] | null
}

export async function loadEmailDoc(ctx: ServiceContext, id: string): Promise<EmailDoc> {
  const { data, error } = await ctx.supabase.from('documents').select(EMAIL_DOC_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new McpToolError('not_found', { details: { document_id: id } })
  return data as unknown as EmailDoc
}

export function docTotals(doc: Pick<EmailDoc, 'document_items' | 'payments' | 'discount_type' | 'discount_value' | 'tax_treatment'>, withPayments = true) {
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
  return calcTotals((doc.document_items ?? []) as Parameters<typeof calcTotals>[0], withPayments ? doc.payments ?? [] : [], discount, doc.tax_treatment)
}

// The e-invoice the editor offers for this client: invoices and credit notes in EUR, in the
// format the client asked for.
export function clientEInvoice(doc: Pick<EmailDoc, 'type' | 'currency' | 'clients'>): EInvoiceFormat | null {
  return doc.type !== 'quote' && doc.currency === 'EUR' ? doc.clients?.einvoice_format ?? null : null
}

// The template's text for the document as it will be (number, dates), with {{portal_link}} kept
// for the send step.
export function composeFor(settings: Settings, doc: EmailDoc, at: { number: string; date: string; dueDate: string | null }) {
  return composeDocumentEmail({
    tpl: documentEmailTemplate(settings, doc.type, doc.invoice_kind, doc.language),
    doc: {
      type: doc.type, number: at.number, date: at.date, due_date: at.dueDate, language: templateLang(doc.language), currency: doc.currency,
      skonto_percent: doc.skonto_percent, skonto_days: doc.skonto_days,
    },
    client: doc.clients,
    issuer: settings,
    totals: docTotals(doc),
  })
}

export type EmailInput = {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  attach_einvoice?: EInvoiceFormat | 'none'
}

// Recipients default to the client record (email, CC list); `to` is required when it has none.
export function recipients(ctx: ServiceContext, doc: EmailDoc, input: EmailInput) {
  const to = uniqueAddresses(input.to ?? (doc.clients?.email ? [doc.clients.email] : []))
  if (!to.length) throw refuse(ctx, 'mcp.approve.refusals.noRecipient')
  return {
    to,
    cc: uniqueAddresses(input.cc ?? parseEmailList(doc.clients?.cc_emails ?? []).emails),
    bcc: uniqueAddresses(input.bcc ?? []),
  }
}

export function emailState(doc: EmailDoc, settings: Settings) {
  return {
    client: { email: doc.clients?.email ?? null, cc_emails: doc.clients?.cc_emails ?? [], einvoice_format: doc.clients?.einvoice_format ?? null },
    sender: { email: settings.gmail_email ?? null, connected: !!settings.gmail_refresh_token, drive: !!settings.drive_folder_id },
  }
}

// The e-invoice is built from the client and an invoice's payments as they are when it is sent
// (the buyer block, the UID, the buyer reference, the amount already paid; a credit note's carries
// no refunds), and the approval page shows neither. Like the archive copy (getIssuedPdf), it waits
// while a client Claude created or changed is not saved in Mado and while payments Claude recorded,
// changed or removed on the invoice are not confirmed there: refused when prepared, and again when
// the state is compared before the run.
export function refuseClaudeEInvoice(ctx: ServiceContext, doc: EmailDoc): void {
  refuseClaudeClient(ctx, doc.clients, 'mcp.approve.refusals.clientChangedEInvoice')
  if (doc.type === 'invoice') refuseClaudePayments(ctx, doc, 'mcp.approve.refusals.paymentsChangedEInvoice')
}

// What a document email depends on: where it goes and from where, the document's state, and the
// content the e-invoice is built from when one is attached (with the client as it prints, and
// Claude's marks on what it carries, left out while unset).
function sendState(doc: EmailDoc, settings: Settings, einvoice: boolean) {
  return {
    document: { id: doc.id, type: doc.type, number: doc.number, status: doc.status, currency: doc.currency, issued_total: cents(doc.issued_total), total: docTotals(doc, false).total },
    ...emailState(doc, settings),
    content: einvoice ? {
      date: doc.date, due_date: doc.due_date, tax_treatment: doc.tax_treatment, discount_type: doc.discount_type, discount_value: exact(doc.discount_value),
      service_date: doc.service_date, service_date_end: doc.service_date_end, buyer_reference: doc.buyer_reference, notes: doc.notes,
      items: itemsState(doc.document_items), payments: paymentsState(doc.payments),
      client: printedClient(doc.clients),
      client_written_at: claudeWrittenAt(doc.clients) ?? undefined,
      payments_at: (doc.type === 'invoice' && doc.mcp_payments_at) || undefined,
    } : null,
  }
}

// A failed send as the error Claude and the approval page are told: nothing was sent.
export function emailFailureError(ctx: ServiceContext, failure: EmailFailure): unknown {
  if (failure.stage === 'send') return codedError(failure.failure.code, failure.failure.error)
  if (failure.stage === 'portal_link') return refuse(ctx, 'mcp.approve.result.portalLinkFailed', undefined, 'internal')
  return failure.error
}

export function emailNotices(
  mail: { subject: string; body: string },
  { foreign, unconfirmed }: { foreign: string[]; unconfirmed: string[] },
): Worded[] {
  const out: Worded[] = []
  if (foreign.length) out.push(notice('mcp.approve.notices.foreign', { addresses: { list: foreign } }))
  if (unconfirmed.length) out.push(notice('mcp.approve.notices.unconfirmed', { addresses: { list: unconfirmed } }))
  if (hasPortalLinkToken(mail.subject) || hasPortalLinkToken(mail.body)) out.push(notice('mcp.approve.notices.portalLink'))
  return out
}

const argsSchema = z.object({
  document_id: z.uuid(),
  ...emailArgs,
  einvoice: z.enum(['ebinterface', 'ubl']).nullable(),
  upload_to_drive: z.boolean(),
})
type Args = z.output<typeof argsSchema>

// The tool's input completed from the document and the client record: what the owner approves
// is exactly what is sent.
export async function resolveSendEmail(ctx: ToolContext, input: EmailInput & { document_id: string; upload_to_drive?: boolean }): Promise<Args> {
  const [doc, settings] = await Promise.all([loadEmailDoc(ctx, input.document_id), ctx.settings()])
  if (!doc.number) throw refuse(ctx, 'mcp.approve.refusals.notIssued', undefined, 'invalid_input', { document_id: doc.id })
  const issuedTotal = doc.issued_total == null ? null : Number(doc.issued_total)
  const totalChanged = issuedTotal != null && Math.abs(docTotals(doc).total - issuedTotal) >= 0.005
  const composed = input.subject === undefined || input.body === undefined ? composeFor(settings, doc, { number: doc.number, date: doc.date, dueDate: doc.due_date }) : null
  const offered = clientEInvoice(doc)
  return {
    document_id: doc.id,
    ...recipients(ctx, doc, input),
    subject: input.subject ?? composed!.subject,
    body: input.body ?? composed!.body,
    einvoice: input.attach_einvoice === undefined ? (offered && !totalChanged ? offered : null) : input.attach_einvoice === 'none' ? null : input.attach_einvoice,
    upload_to_drive: input.upload_to_drive ?? (!!settings.drive_folder_id && !!settings.gmail_refresh_token && !doc.drive_file_id),
  }
}

export const sendEmailAction = defineAction<Args>({
  kind: 'send_email',
  argsSchema,
  async prepare(ctx, args) {
    const [doc, settings] = await Promise.all([loadEmailDoc(ctx, args.document_id), ctx.settings()])
    if (!doc.number) throw refuse(ctx, 'mcp.approve.refusals.notIssued', undefined, 'invalid_input', { document_id: doc.id })
    if (!gmailConnected(settings)) throw refuse(ctx, 'mcp.approve.refusals.gmailNotConnected')
    checkAddresses(ctx, args)
    if (args.einvoice) {
      refuseClaudeEInvoice(ctx, doc)
      // Built (not stored, nothing fetched) to learn now whether it can be.
      await exportEInvoice(ctx.supabase, doc.id, args.einvoice, { pdf: false })
    }

    const recipientsCheck = await newRecipients(ctx, [...args.to, ...args.cc, ...args.bcc], doc.clients)
    const total = docTotals(doc).total
    const issuedTotal = doc.issued_total == null ? null : Number(doc.issued_total)
    const notices = emailNotices(args, recipientsCheck)
    if (issuedTotal != null && Math.abs(total - issuedTotal) >= 0.005) {
      notices.push(notice('mcp.approve.notices.totalChanged', { issued: money(issuedTotal, doc.currency), current: money(total, doc.currency) }))
    }
    if (doc.status === 'cancelled') notices.push(notice('mcp.approve.notices.cancelledDocument', { number: doc.number }))
    if (args.upload_to_drive) notices.push(notice('mcp.approve.notices.driveAfterSend'))
    const summary = notice('mcp.approve.labels.sendEmail', { type: { docType: doc.type }, number: doc.number, to: { list: [...args.to, ...args.cc, ...args.bcc] } })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        document: { id: doc.id, type: doc.type, number: doc.number, status: doc.status, client: clip(clientDisplayName(doc.clients)), gross: total, currency: doc.currency ?? 'EUR', app_url: documentUrl(doc.type, doc.id), pdf_url: documentPdfUrl(doc.id) },
        email: {
          from: settings.gmail_email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
          attachments: [pdfFilename(doc.number), ...(args.einvoice ? [einvoiceFilename(doc.number, args.einvoice)] : [])],
          einvoice: args.einvoice, upload_to_drive: args.upload_to_drive, ...recipientsCheck,
        },
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: recipientsCheck.foreign.length + recipientsCheck.unconfirmed.length > 0,
      fingerprint: fingerprintOf(sendState(doc, settings, !!args.einvoice)),
    }
  },
  async fingerprint(ctx, args) {
    const [doc, settings] = await Promise.all([loadEmailDoc(ctx, args.document_id), ctx.settings()])
    if (args.einvoice) refuseClaudeEInvoice(ctx, doc)
    return fingerprintOf(sendState(doc, settings, !!args.einvoice))
  },
  async execute(ctx, args) {
    const settings = await ctx.settings()
    const sent = await sendDocumentEmail(ctx.supabase, settings, {
      documentId: args.document_id, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
      einvoice: args.einvoice, uploadToDrive: args.upload_to_drive, portalOrigin: APP_URL,
    })
    if (!sent.ok) throw emailFailureError(ctx, sent)
    const report: Worded[] = [notice('mcp.approve.result.sent', { to: { list: [...args.to, ...args.cc, ...args.bcc] } })]
    if (sent.drive) report.push(notice('mcp.approve.result.driveArchived'))
    if (sent.driveError) report.push(notice('mcp.approve.result.driveUploadFailed', { error: { error: { code: sent.driveError.code, message: sent.driveError.error } } }))
    return {
      summary: report.map(w => word(ctx.t, 'en', w)).join(' '),
      data: {
        to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, attachments: sent.attachments, einvoice: sent.einvoice,
        drive: sent.drive, drive_error: sent.driveError?.error ?? null, report,
      },
      ...(sent.driveError ? { warnings: [word(ctx.t, 'en', report.at(-1)!)] } : {}),
    }
  },
})
