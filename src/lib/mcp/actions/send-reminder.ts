// A payment reminder for an overdue invoice: sent from Gmail with the Mahnung and the frozen
// invoice, or only recorded (sent another way). Either way the invoice moves up a level for good.
import { z } from 'zod'
import { pdfFilename, type PdfDocument } from '@/lib/pdf/render'
import { invoiceTotals, reminderFilename } from '@/lib/pdf/reminder'
import { composeReminder, loadReminderInvoice, reminderLevel, sendReminder, type LoadedReminder } from '@/lib/services/reminders'
import { parseEmailList, templateLang } from '@/lib/templates'
import { clientDisplayName } from '@/lib/utils/clients'
import { cents, fingerprintOf } from '../fingerprint'
import { reminderFigures } from '@/lib/utils/reminder-templates'
import { today } from '@/lib/utils/document'
import type { Settings } from '@/types'
import { APP_URL, documentUrl } from '../config'
import { McpToolError } from '../errors'
import { defineAction, type ServiceContext, type ToolContext } from '../types'
import {
  addressList, checkAddresses, claudeWrittenAt, codedError, emailArgs, gmailConnected, itemsState, MAX_COPIES, MAX_RECIPIENTS, newRecipients, notice,
  paymentsState, printedClient, refuse, refuseClaudeClient, uniqueAddresses,
} from './common'
import { emailNotices } from './send-email'
import { clip, money, word, type Worded } from './words'

// A reminder sent from Gmail carries the Mahnung, which prints the client as it is when it is sent:
// not for a client Claude created or changed and the owner has not saved in Mado since (as the
// reminder cron skips it). One only recorded as sent another way prints nothing.
async function loadInvoice(ctx: ServiceContext, id: string, mode: 'gmail' | 'manual'): Promise<LoadedReminder> {
  const loaded = await loadReminderInvoice(ctx.supabase, id)
  if (loaded.ok) {
    if (mode === 'gmail') refuseClaudeClient(ctx, loaded.invoice.clients, 'mcp.approve.refusals.clientChangedReminder')
    return loaded
  }
  if (loaded.reason === 'settings' || loaded.reason === 'database') throw loaded.error ?? new McpToolError('internal')
  if (loaded.reason === 'not_found') throw new McpToolError('not_found', { details: { invoice_id: id } })
  // nothing_outstanding, not_remindable: worded as the reminder dialog words them.
  throw codedError(loaded.reason, loaded.reason)
}

function reminderState({ invoice, settings }: LoadedReminder) {
  return {
    today: today(),
    invoice: {
      id: invoice.id, number: invoice.number, status: invoice.status, due_date: invoice.due_date, reminder_level: invoice.reminder_level ?? 0,
      language: invoice.language, currency: invoice.currency, tax_treatment: invoice.tax_treatment, discount_type: invoice.discount_type,
      discount_value: cents(invoice.discount_value), items: itemsState(invoice.document_items as unknown as Record<string, unknown>[]),
      payments: paymentsState(invoice.payments as unknown as Record<string, unknown>[]),
    },
    // As the Mahnung prints it, the copies, and Claude's mark (a write after prepare is a change).
    client: { ...printedClient(invoice.clients), cc_emails: invoice.clients?.cc_emails ?? [], mcp_written_at: claudeWrittenAt(invoice.clients) },
    settings: {
      max_level: settings.reminder_max_level ?? null, fee: cents(settings.reminder_fee), interest: cents(settings.reminder_interest_rate),
      grace_days: settings.reminder_grace_days ?? null, sender: settings.gmail_email ?? null, connected: !!settings.gmail_refresh_token,
    },
  }
}

function figuresOf(invoice: PdfDocument, settings: Settings, level: number) {
  return reminderFigures({ dueDate: invoice.due_date, balance: invoiceTotals(invoice).balance_due, issuer: settings, level, lang: templateLang(invoice.language) })
}

const argsSchema = z.object({
  invoice_id: z.uuid(),
  mode: z.enum(['gmail', 'manual']),
  to: addressList(MAX_RECIPIENTS),
  cc: addressList(MAX_COPIES),
  bcc: addressList(MAX_COPIES),
  subject: emailArgs.subject,
  body: emailArgs.body,
})
type Args = z.output<typeof argsSchema>

export type ReminderInput = { invoice_id: string; mode: 'gmail' | 'manual'; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string }

// Gmail: recipients from the client record and the template's text unless given (an empty
// subject or text counts as not given, so the template's text is what the owner approves).
// Manual: only what is recorded (who it went to, the subject), nothing is sent.
export async function resolveSendReminder(ctx: ToolContext, input: ReminderInput): Promise<Args> {
  const loaded = await loadInvoice(ctx, input.invoice_id, input.mode)
  const { invoice, settings } = loaded
  if (input.mode === 'manual') {
    return { invoice_id: invoice.id, mode: 'manual', to: uniqueAddresses(input.to ?? []), cc: uniqueAddresses(input.cc ?? []), bcc: uniqueAddresses(input.bcc ?? []), subject: input.subject ?? '', body: '' }
  }
  const to = uniqueAddresses(input.to ?? (invoice.clients?.email ? [invoice.clients.email] : []))
  if (!to.length) throw refuse(ctx, 'mcp.approve.refusals.noRecipient')
  const subject = input.subject?.trim() ? input.subject : undefined
  const body = input.body?.trim() ? input.body : undefined
  const composed = subject === undefined || body === undefined
    ? await composeReminder(ctx.supabase, invoice, settings, reminderLevel(invoice, settings), { portalOrigin: null })
    : null
  return {
    invoice_id: invoice.id,
    mode: 'gmail',
    to,
    cc: uniqueAddresses(input.cc ?? parseEmailList(invoice.clients?.cc_emails ?? []).emails),
    bcc: uniqueAddresses(input.bcc ?? []),
    subject: subject ?? composed!.subject,
    body: body ?? composed!.body,
  }
}

export const sendReminderAction = defineAction<Args>({
  kind: 'send_reminder',
  argsSchema,
  async prepare(ctx, args) {
    const loaded = await loadInvoice(ctx, args.invoice_id, args.mode)
    const { invoice, settings } = loaded
    const number = invoice.number!
    const level = reminderLevel(invoice, settings)
    const figures = figuresOf(invoice, settings, level)
    const gmail = args.mode === 'gmail'
    if (gmail) {
      if (!gmailConnected(settings)) throw refuse(ctx, 'mcp.approve.refusals.gmailNotConnected')
      if (!args.to.length) throw refuse(ctx, 'mcp.approve.refusals.noRecipient')
      // sendReminder fills an empty subject or text from the template: never what was approved.
      if (!args.subject.trim() || !args.body.trim()) throw refuse(ctx, 'mcp.approve.refusals.emptyText')
    }
    checkAddresses(ctx, args)

    const all = [...args.to, ...args.cc, ...args.bcc]
    const recipientsCheck = gmail ? await newRecipients(ctx, all, invoice.clients) : { foreign: [], unconfirmed: [] }
    const notices: Worded[] = gmail ? emailNotices(args, recipientsCheck) : [notice('mcp.approve.notices.manualReminder', { level })]
    if (level === (invoice.reminder_level ?? 0)) notices.push(notice('mcp.approve.notices.repeatLevel', { level }))
    const amount = money(figures.balance, invoice.currency)
    const summary = gmail
      ? notice('mcp.approve.labels.sendReminder', { level, number, to: { list: all }, amount })
      : notice('mcp.approve.labels.recordReminder', { level, number, amount })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        invoice: { id: invoice.id, number, client: clip(clientDisplayName(invoice.clients)), due_date: invoice.due_date, currency: invoice.currency ?? 'EUR', app_url: documentUrl('invoice', invoice.id) },
        mode: args.mode,
        level,
        title: figures.title,
        figures: {
          balance: figures.balance, fee: figures.fee, interest: figures.interest, total_due: figures.totalDue,
          days_overdue: figures.daysOverdue, new_deadline: figures.newDeadline,
        },
        email: gmail
          ? { from: settings.gmail_email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body, attachments: [reminderFilename(figures.title, number), pdfFilename(number)], ...recipientsCheck }
          : { to: args.to, subject: args.subject },
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: recipientsCheck.foreign.length + recipientsCheck.unconfirmed.length > 0,
      fingerprint: fingerprintOf(reminderState(loaded)),
    }
  },
  async fingerprint(ctx, args) {
    return fingerprintOf(reminderState(await loadInvoice(ctx, args.invoice_id, args.mode)))
  },
  async execute(ctx, args) {
    const loaded = await loadInvoice(ctx, args.invoice_id, args.mode)
    const sent = await sendReminder(ctx.supabase, loaded, {
      mode: args.mode, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
      portalOrigin: APP_URL, fillPortalLink: true,
    })
    if (!sent.ok) {
      if (sent.stage === 'google_not_connected') throw refuse(ctx, 'mcp.approve.refusals.gmailNotConnected')
      if (sent.stage === 'no_email') throw refuse(ctx, 'mcp.approve.refusals.noRecipient')
      if (sent.stage === 'send') throw codedError(sent.failure.code, sent.failure.error)
      if (sent.stage === 'portal_link') throw refuse(ctx, 'mcp.approve.result.portalLinkFailed', undefined, 'internal')
      throw sent.error
    }
    const report = [args.mode === 'gmail'
      ? notice('mcp.approve.result.reminderSent', { level: sent.level, to: { list: [...args.to, ...args.cc, ...args.bcc] } })
      : notice('mcp.approve.result.reminderRecorded', { level: sent.level })]
    return {
      summary: report.map(w => word(ctx.t, 'en', w)).join(' '),
      data: { invoice_id: args.invoice_id, mode: args.mode, level: sent.level, sent_at: sent.sentAt, to: sent.to, attachments: sent.attachments, report },
    }
  },
})
