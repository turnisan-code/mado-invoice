// Irreversible work (scope mado:irreversible): the prepare_* tools, confirm_action and
// get_action_status, in the order tools/list shows them; plus create_credit_note (mado:write),
// which belongs with the Storno it is the gentle form of.
import { z } from 'zod'
import { ACTION_KINDS, defineTool, type AnyToolDef, type ToolHints } from '../types'
import { ACTION_HANDLE_PREFIX, documentUrl } from '../config'
import { actionStatus, confirmAction, MAX_LABEL_CHARS, prepareAction } from '../confirm'
import { McpToolError } from '../errors'
import { MAX_ISSUE_DOCUMENTS } from '../actions/issue'
import { resolveIssueAndSend } from '../actions/issue-and-send'
import { resolveSendEmail } from '../actions/send-email'
import { resolveSendReminder } from '../actions/send-reminder'
import { MAX_BODY, MAX_COPIES, MAX_RECIPIENTS, MAX_SUBJECT } from '../actions/common'
import { createCreditNote } from '@/lib/services/credit-notes'

// prepare_* only store an expiring row in mcp_actions; no business data changes.
const PREPARE: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }

const handle = z.string().startsWith(ACTION_HANDLE_PREFIX).max(64).describe('The confirmation_id a prepare_* tool returned.')
const addresses = (max: number, what: string) => z.array(z.string().max(254)).max(max).optional().describe(what)
const einvoice = z.enum(['ebinterface', 'ubl', 'none']).optional()
  .describe("Attach the client's e-invoice: ebInterface or Peppol UBL. Default: the format set on the client, unless the total changed since issuing; 'none' attaches none.")
const subject = z.string().max(MAX_SUBJECT).optional().describe('Default: the email template filled in for this document.')
const body = z.string().max(MAX_BODY).optional().describe('Default: the email template filled in for this document. {{portal_link}} becomes the client-portal link when it is sent.')

const APPROVAL = "Nothing changes yet: it returns a confirmation_id, the label and, unless the owner allowed confirming this kind in chat, an approve_url. Show the owner the label and approve_url verbatim; they approve in Mado. Then read the outcome with get_action_status. If approval is 'chat' instead, ask the owner, then call confirm_action with the same confirmation_id, action and label. While an action approved in Mado runs, the documents it names, the invoice a credit note among them corrects, their lines and payments, the advance and partial invoices a final invoice among them deducts (linking, unlinking, payments) and their clients cannot be changed from Claude (MI046), and a draft or client that changed after the approval stops the run: wait until get_action_status says it finished. One action runs at a time, approved in Mado or confirmed in chat: while one runs, confirm_action does not start another and the owner cannot approve another (MI047; it stays pending)."

export const IRREVERSIBLE_TOOLS: readonly AnyToolDef[] = [
  defineTool({
    name: 'prepare_issue',
    title: 'Prepare: issue documents',
    description: `Prepare issuing 1 to ${MAX_ISSUE_DOCUMENTS} drafts (invoices, quotes, credit notes). Issuing assigns the next gapless legal numbers, freezes the PDF, archives it to Drive and applies a credit note to its invoice (the result warns when that failed). The preview lists per draft the expected number, issue date, due date, client and gross total, with warnings (numbers out of date order, zero total, lost project links). An incomplete draft is refused with its problems. A draft for a client Claude created or changed and the owner has not saved in Mado since is not refused: the preview shows the recipient block and VAT ID it is numbered and archived with, and the buyer reference the PDF prints from the client (a credit note: its invoice's first) when the draft has none of its own. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      document_ids: z.array(z.uuid()).min(1).max(MAX_ISSUE_DOCUMENTS).describe('Draft ids, each once.'),
      redate_to_today: z.boolean().optional().describe("Issue drafts dated before today with today's date (and due dates from the client's terms). Default true, as in the app."),
    }),
    hints: PREPARE,
    run: (args, ctx) => prepareAction(ctx, 'issue', { document_ids: args.document_ids, redate_to_today: args.redate_to_today ?? true }),
  }),
  defineTool({
    name: 'prepare_issue_and_send',
    title: 'Prepare: issue and email a draft',
    description: `Prepare issuing one draft and emailing it from the connected Gmail account, with a single approval. The preview shows the expected number, recipients, subject, text and attachments (the frozen PDF, optionally the e-invoice). It issues first, then sends; if sending fails, the document stays issued and the result says why. Recipients default to the client record; an address not on it, or never emailed from Mado for this client, is always approved in Mado. A draft for a client Claude created or changed and the owner has not saved in Mado since is not refused: the preview shows the recipient block and VAT ID it is numbered and archived with, and the buyer reference the PDF prints from the client (a credit note: its invoice's first) when the draft has none of its own. An e-invoice is refused for such a client: it is built from the client as it is when sent; attach_einvoice 'none' sends the PDF alone. Should Claude change the client or the invoice's payments while it runs, the e-invoice is not built and the email not sent (the document stays issued). ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      document_id: z.uuid().describe('The draft.'),
      redate_to_today: z.boolean().optional().describe("Issue a draft dated before today with today's date. Default true."),
      to: addresses(MAX_RECIPIENTS, "Default: the client's email."),
      cc: addresses(MAX_COPIES, "Default: the client's CC list."),
      bcc: addresses(MAX_COPIES, 'Default: none.'),
      subject,
      body,
      attach_einvoice: einvoice,
    }),
    hints: PREPARE,
    run: async (args, ctx) => prepareAction(ctx, 'issue_and_send', await resolveIssueAndSend(ctx, args)),
  }),
  defineTool({
    name: 'prepare_send_email',
    title: 'Prepare: email a document',
    description: `Prepare emailing an ISSUED document from the connected Gmail account: sender, recipients, subject, text, attachments (the frozen PDF, with a cancelled stamp over it when the document is cancelled, and optionally the e-invoice) and a warning if the total changed since issuing. For a draft use prepare_issue_and_send. Recipients default to the client record; an address not on it, or never emailed from Mado for this client, is always approved in Mado. An e-invoice is refused while the client was created or changed from Claude and not saved in Mado since, or while payments Claude recorded, changed or removed on the invoice are not confirmed there: it is built from both as they are when sent; attach_einvoice 'none' sends the frozen PDF alone. Should Claude change either while it runs, nothing is sent. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      document_id: z.uuid(),
      to: addresses(MAX_RECIPIENTS, "Default: the client's email."),
      cc: addresses(MAX_COPIES, "Default: the client's CC list."),
      bcc: addresses(MAX_COPIES, 'Default: none.'),
      subject,
      body,
      attach_einvoice: einvoice,
      upload_to_drive: z.boolean().optional().describe('Also archive the PDF to the Drive folder after sending. Default: when Drive is set up and the document is not archived there yet.'),
    }),
    hints: PREPARE,
    run: async (args, ctx) => prepareAction(ctx, 'send_email', await resolveSendEmail(ctx, args)),
  }),
  defineTool({
    name: 'prepare_send_reminder',
    title: 'Prepare: payment reminder',
    description: `Prepare a payment reminder for an overdue issued invoice with an open balance: the next level, the amounts (the balance, plus the fee and interest from level 2, the 1. Mahnung, on: a level-1 Zahlungserinnerung charges neither), recipients, text and attachments (the reminder PDF and the frozen invoice). mode 'manual' sends nothing and only records a reminder sent another way; either way the invoice's reminder level rises for good (it starts over at level 1 only when the owner extends the due date to today or later, and the level reached comes back when the due date returns to the past before another reminder). Recipients (gmail) default to the client record; an address not on it, or never emailed from Mado for this client, is always approved in Mado. A gmail reminder is refused while the client was created or changed from Claude and not saved in Mado since: the Mahnung prints it. A manual one prints nothing of the client, so a change to the client after preparing it does not stop it. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      invoice_id: z.uuid(),
      mode: z.enum(['gmail', 'manual']).describe("'gmail' sends it from the connected account; 'manual' only records it."),
      to: addresses(MAX_RECIPIENTS, "Default (gmail): the client's email."),
      cc: addresses(MAX_COPIES, "Default (gmail): the client's CC list."),
      bcc: addresses(MAX_COPIES, 'Default: none.'),
      subject: z.string().max(MAX_SUBJECT).optional().describe('Default (gmail), also when empty: the reminder template for this level.'),
      body: z.string().max(MAX_BODY).optional().describe('Gmail only. Default, also when empty: the reminder template for this level.'),
    }),
    hints: PREPARE,
    run: async (args, ctx) => prepareAction(ctx, 'send_reminder', await resolveSendReminder(ctx, args)),
  }),
  defineTool({
    name: 'prepare_storno',
    title: 'Prepare: Storno',
    description: `Prepare cancelling an issued invoice with a Storno credit note: the expected credit-note number, the amount and the consequences (the invoice becomes cancelled and its PDF is shown and sent with a cancelled stamp from then on, its project entries and deducted invoices are freed, the credit is applied, money received has to be paid back). For a partial correction use create_credit_note instead. Refused while the invoice's client was created or changed from Claude and not saved in Mado since: the credit note is archived with it for good; should Claude change the client while it runs, the credit note stays without an archive copy until the owner saves the client (the result says so). ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      invoice_id: z.uuid(),
      reason: z.string().max(500).optional().describe('Kept in the history of both documents.'),
    }),
    hints: PREPARE,
    run: (args, ctx) => prepareAction(ctx, 'storno', { invoice_id: args.invoice_id, ...(args.reason !== undefined ? { reason: args.reason } : {}) }),
  }),
  defineTool({
    name: 'prepare_cancel',
    title: 'Prepare: cancel a document',
    description: `Prepare cancelling a draft of any type, or an issued quote. Cancelled is final; an issued quote's PDF is shown and sent with a cancelled stamp from then on. An issued invoice is cancelled with prepare_storno; an issued credit note can never be cancelled. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({ document_id: z.uuid() }),
    hints: PREPARE,
    run: (args, ctx) => prepareAction(ctx, 'cancel', args),
  }),
  defineTool({
    name: 'prepare_delete',
    title: 'Prepare: delete',
    description: `Prepare a permanent delete. A draft goes with its lines, payments, history and reminders, and a recurring schedule it is the template of; its project entries and deducted invoices are freed. A client can only be deleted without documents or projects (set it inactive instead), a project only without billed entries (archive it instead). Issued documents are never deleted. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({
      kind: z.enum(['draft', 'client', 'project']),
      id: z.uuid(),
    }),
    hints: PREPARE,
    run: (args, ctx) => prepareAction(ctx, 'delete', args),
  }),
  defineTool({
    name: 'prepare_bookamat_sync',
    title: 'Prepare: Bookamat sync',
    description: `Prepare booking an issued document's money in Bookamat (cash basis): a paid invoice's payments or a settled credit note's refunds, one booking per calendar year, with accounts and amounts, the frozen PDF attached. Refused while the document's client was created or changed from Claude and not saved in Mado since: the bookings carry its name and VAT ID. Should Claude change the client or the payments while it runs, it stops before booking. ${APPROVAL}`,
    scope: 'mado:irreversible',
    inputSchema: z.object({ document_id: z.uuid() }),
    hints: PREPARE,
    run: (args, ctx) => prepareAction(ctx, 'bookamat_sync', args),
  }),
  defineTool({
    name: 'confirm_action',
    title: 'Confirm prepared action',
    description: "Run a prepared action the owner allowed to be confirmed in chat (approval 'chat'). Pass the confirmation_id, the action and the label exactly as prepare returned them. The server checks that the action belongs to this connection, is unchanged, pending and not expired, then runs it once; a repeated call returns the stored result. An action with approval 'app' is never run here: the answer is its status and approve_url. One action runs at a time: while another runs (approved in Mado or confirmed in chat), this one does not start (MI047) and stays pending: call again once that one has finished (get_action_status; ten minutes at most if it stopped unexpectedly).",
    scope: 'mado:irreversible',
    inputSchema: z.object({
      confirmation_id: handle,
      action: z.enum(ACTION_KINDS as [string, ...string[]]),
      label: z.string().max(MAX_LABEL_CHARS).describe('Exactly as prepare returned it.'),
    }),
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    meta: { 'anthropic/requiresUserInteraction': true },
    run: (args, ctx) => confirmAction(ctx, { confirmation_id: args.confirmation_id, action: args.action as typeof ACTION_KINDS[number], label: args.label }),
  }),
  defineTool({
    name: 'get_action_status',
    title: 'Action status',
    description: 'The state of a prepared action: pending (with approve_url), running, done (with the result), failed (with the error), rejected or expired.',
    scope: 'mado:irreversible',
    inputSchema: z.object({ confirmation_id: handle }),
    hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => actionStatus(ctx, args.confirmation_id),
  }),
  defineTool({
    name: 'create_credit_note',
    title: 'Create credit-note draft',
    description: 'Create a credit-note DRAFT from an issued invoice (a partial correction; it does not cancel the invoice). Edit it with update_document and issue it with prepare_issue, which applies it to the invoice. To cancel the whole invoice use prepare_storno.',
    scope: 'mado:write',
    inputSchema: z.object({ invoice_id: z.uuid() }),
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, ctx) {
      const { data, error } = await createCreditNote(ctx.supabase, args.invoice_id, { cancel: false })
      if (error) throw error
      if (!data) throw new McpToolError('not_found', { details: { invoice_id: args.invoice_id } })
      const appUrl = documentUrl('credit_note', data.creditNoteId)
      return {
        summary: ctx.t('mcp.approve.result.creditNoteDraft', { url: appUrl }),
        data: { credit_note_id: data.creditNoteId, status: 'draft', invoice_id: args.invoice_id, app_url: appUrl },
      }
    },
  }),
]
