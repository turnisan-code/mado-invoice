// Issuing one draft and emailing it with a single approval. Issuing comes first; the email goes
// out with the frozen PDF of the number that was approved. When sending fails after the number was
// taken, the document stays issued and the result says so.
import { z } from 'zod'
import { pdfFilename } from '@/lib/pdf/render'
import { einvoiceFilename } from '@/lib/einvoice/common'
import { sendDocumentEmail } from '@/lib/services/email'
import { clientDisplayName } from '@/lib/utils/clients'
import type { EInvoiceFormat } from '@/types'
import { APP_URL } from '../config'
import { McpToolError } from '../errors'
import { fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext, type ToolContext } from '../types'
import { checkAddresses, emailArgs, gmailConnected, mayOutlastClient, newRecipients, notice, refuse, storedError } from './common'
import { issueNotices, issueOutcome, loadIssueState, previewIssue, runIssue, withLinks } from './issue'
import {
  clientEInvoice, composeFor, emailFailureError, emailNotices, emailState, loadEmailDoc, recipients, type EmailInput,
} from './send-email'
import { clip, money, word, type StoredError, type Worded } from './words'

const argsSchema = z.object({
  document_id: z.uuid(),
  redate_to_today: z.boolean(),
  // The number the preview announced; the email text may name it.
  expected_number: z.string().min(1).max(40),
  ...emailArgs,
  einvoice: z.enum(['ebinterface', 'ubl']).nullable(),
})
type Args = z.output<typeof argsSchema>

async function loadState(ctx: ServiceContext, args: Pick<Args, 'document_id' | 'redate_to_today'>) {
  const [issue, doc] = await Promise.all([loadIssueState(ctx, [args.document_id], args.redate_to_today), loadEmailDoc(ctx, args.document_id)])
  return { issue, doc, fingerprint: fingerprintOf({ issue: issue.fingerprint, email: emailState(doc, issue.settings) }) }
}

export async function resolveIssueAndSend(ctx: ToolContext, input: EmailInput & { document_id: string; redate_to_today?: boolean }): Promise<Args> {
  const redate = input.redate_to_today ?? true
  const { issue, doc } = await loadState(ctx, { document_id: input.document_id, redate_to_today: redate })
  const [planned] = (await previewIssue(ctx, issue, redate)).documents
  const composed = input.subject === undefined || input.body === undefined
    ? composeFor(issue.settings, doc, { number: planned.expected_number, date: planned.issue_date, dueDate: planned.due_date })
    : null
  return {
    document_id: doc.id,
    redate_to_today: redate,
    expected_number: planned.expected_number,
    ...recipients(ctx, doc, input),
    subject: input.subject ?? composed!.subject,
    body: input.body ?? composed!.body,
    einvoice: input.attach_einvoice === undefined ? clientEInvoice(doc) : input.attach_einvoice === 'none' ? null : input.attach_einvoice as EInvoiceFormat,
  }
}

export const issueAndSendAction = defineAction<Args>({
  kind: 'issue_and_send',
  argsSchema,
  async prepare(ctx, args) {
    const { issue, doc, fingerprint } = await loadState(ctx, args)
    const preview = await previewIssue(ctx, issue, args.redate_to_today)
    const [planned] = preview.documents
    if (planned.expected_number !== args.expected_number) throw new McpToolError('state_changed')
    if (!gmailConnected(issue.settings)) throw refuse(ctx, 'mcp.approve.refusals.gmailNotConnected')
    checkAddresses(ctx, args)
    if (args.einvoice && doc.type === 'quote') throw refuse(ctx, 'mcp.approve.refusals.einvoiceQuote')

    const all = [...args.to, ...args.cc, ...args.bcc]
    const recipientsCheck = await newRecipients(ctx, all, doc.clients)
    const notices: Worded[] = [...issueNotices(preview), ...emailNotices(args, recipientsCheck)]
    if (args.einvoice) notices.push(notice('mcp.approve.notices.einvoiceAfterIssue'))
    const summary = notice('mcp.approve.labels.issueAndSend', {
      type: { docType: planned.type }, client: clip(planned.client?.name ?? clientDisplayName(doc.clients)), number: planned.expected_number,
      gross: money(planned.gross, planned.currency), to: { list: all },
    })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        documents: withLinks(preview),
        redate: preview.redate,
        drive: preview.drive,
        email: {
          from: issue.settings.gmail_email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
          attachments: [pdfFilename(planned.expected_number), ...(args.einvoice ? [einvoiceFilename(planned.expected_number, args.einvoice)] : [])],
          einvoice: args.einvoice, upload_to_drive: false, ...recipientsCheck,
        },
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: recipientsCheck.foreign.length + recipientsCheck.unconfirmed.length > 0 || mayOutlastClient(ctx, { documents: 1 }),
      fingerprint,
    }
  },
  async fingerprint(ctx, args) {
    return (await loadState(ctx, args)).fingerprint
  },
  async execute(ctx, args) {
    const { run, drafts } = await runIssue(ctx, [args.document_id], args.redate_to_today)
    const issued = issueOutcome(ctx, run, drafts)
    const number = run.notes[0].number
    const all = [...args.to, ...args.cc, ...args.bcc]

    let email: Record<string, unknown> | null = null
    let emailError: StoredError | null = null
    if (number !== args.expected_number) {
      const changed = notice('mcp.approve.result.numberChanged', { number, expected: args.expected_number })
      emailError = { code: 'number_changed', message: word(ctx.t, 'en', changed), worded: changed }
    } else {
      const sent = await sendDocumentEmail(ctx.supabase, await ctx.settings(), {
        documentId: args.document_id, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
        einvoice: args.einvoice, portalOrigin: APP_URL,
      })
      if (sent.ok) email = { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, attachments: sent.attachments, einvoice: sent.einvoice }
      else emailError = storedError(emailFailureError(ctx, sent), ctx.t)
    }

    const report: Worded[] = [...issued.report]
    if (email) report.push(notice('mcp.approve.result.sent', { to: { list: all } }))
    else if (emailError) report.push(notice('mcp.approve.result.notSent', { number, error: { error: emailError } }))
    const warnings = [...(issued.warnings ?? []), ...(emailError ? [word(ctx.t, 'en', report.at(-1)!)] : [])]
    return {
      summary: report.map(w => word(ctx.t, 'en', w)).join(' '),
      data: { ...issued.data, email, email_error: emailError, report },
      ...(warnings.length ? { warnings } : {}),
    }
  },
})
