// A Storno: the issued invoice is cancelled with a credit note numbered at once, which is applied
// to what is still open on it.
import { z } from 'zod'
import { createCreditNote } from '@/lib/services/credit-notes'
import { expectedNumbers, numberingOf } from '@/lib/services/issue'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals, roundCents, settlesBalance, today } from '@/lib/utils/document'
import { documentPdfUrl, documentUrl } from '../config'
import { McpToolError } from '../errors'
import { exact, fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext } from '../types'
import { claudeWrittenAt, codedError, itemsState, notice, paymentsState, printedClient, refuseClaudeClient } from './common'
import { clip, entries, money, word, type Worded } from './words'

const INVOICE_COLUMNS = [
  'id', 'type', 'number', 'status', 'date', 'currency', 'tax_treatment', 'discount_type', 'discount_value', 'invoice_kind', 'final_invoice_id',
  // The whole row: the Storno credit note is numbered and archived with the client as it prints,
  // and Claude's mark is read without naming the column (claudeWrittenAt).
  'clients(*)',
  'document_items(id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate, discount_type, discount_value, service_date, service_date_end, catalogue_item_id)',
  'payments(id, date, amount, kind, method)',
].join(', ')

type Invoice = {
  id: string
  type: string
  number: string | null
  status: string
  date: string
  currency: string | null
  tax_treatment: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  invoice_kind: string | null
  final_invoice_id: string | null
  clients: { id: string; name: string; company: string | null } | null
  document_items: Record<string, unknown>[] | null
  payments: { id: string; date: string; amount: number; kind: string | null; method: string | null }[] | null
}

async function count(ctx: ServiceContext, table: string, column: string, id: string): Promise<number> {
  const { data, error } = await ctx.supabase.from(table).select('id').eq(column, id)
  if (error) throw error
  return data?.length ?? 0
}

// The invoice and what its Storno would do, refused as create_credit_note refuses it.
async function loadStorno(ctx: ServiceContext, invoiceId: string) {
  const [{ data, error }, settings] = await Promise.all([
    ctx.supabase.from('documents').select(INVOICE_COLUMNS).eq('id', invoiceId).maybeSingle(),
    ctx.settings(),
  ])
  if (error) throw error
  const invoice = data as unknown as Invoice | null
  if (!invoice || invoice.type !== 'invoice') throw new McpToolError('not_found', { details: { invoice_id: invoiceId } })
  if (!invoice.number) throw codedError('MI018')
  if (invoice.status === 'cancelled') throw codedError('MI017')
  type Final = { number: string | null; status: string }
  let final: Final | null = null
  if (invoice.final_invoice_id) {
    const { data: f, error: fErr } = await ctx.supabase.from('documents').select('number, status').eq('id', invoice.final_invoice_id).maybeSingle()
    if (fErr) throw fErr
    final = f as Final | null
    if (final?.number && final.status !== 'cancelled') throw codedError('MI020')
  }
  // The credit note's archive copy keeps the recipient block and UID for good.
  refuseClaudeClient(ctx, invoice.clients, 'mcp.approve.refusals.clientChangedStorno')
  const day = today()
  const discount = invoice.discount_type && invoice.discount_value ? { type: invoice.discount_type, value: invoice.discount_value } : null
  const total = calcTotals((invoice.document_items ?? []) as Parameters<typeof calcTotals>[0], [], discount, invoice.tax_treatment).total
  const settled = roundCents((invoice.payments ?? []).filter(settlesBalance).reduce((s, p) => s + Number(p.amount), 0))
  const released = {
    time: await count(ctx, 'time_entries', 'invoiced_document_id', invoice.id),
    expenses: await count(ctx, 'project_expenses', 'invoiced_document_id', invoice.id),
    deposits: invoice.invoice_kind === 'final' ? await count(ctx, 'documents', 'final_invoice_id', invoice.id) : 0,
  }
  const fingerprint = fingerprintOf({
    today: day,
    invoice: {
      id: invoice.id, number: invoice.number, status: invoice.status, invoice_kind: invoice.invoice_kind, final_invoice_id: invoice.final_invoice_id,
      final, tax_treatment: invoice.tax_treatment, discount_type: invoice.discount_type, discount_value: exact(invoice.discount_value),
      items: itemsState(invoice.document_items), payments: paymentsState(invoice.payments),
    },
    // As the credit note prints it, and Claude's mark (a write after prepare is a change).
    client: { ...printedClient(invoice.clients), mcp_written_at: claudeWrittenAt(invoice.clients) },
    numbering: numberingOf(settings, 'credit_note'),
    released,
  })
  return { invoice, settings, today: day, total, settled, released, fingerprint }
}

const argsSchema = z.object({
  invoice_id: z.uuid(),
  reason: z.string().trim().max(500).transform(r => r || null).nullable().default(null),
})
type Args = z.output<typeof argsSchema>

export const stornoAction = defineAction<Args>({
  kind: 'storno',
  argsSchema,
  async prepare(ctx, args) {
    const s = await loadStorno(ctx, args.invoice_id)
    const number = s.invoice.number!
    const [creditNote] = await expectedNumbers(ctx.supabase, s.settings, 'credit_note', [s.today])
    const open = Math.max(0, roundCents(s.total - s.settled))
    const applied = Math.min(s.total, open)
    const refund = roundCents(s.total - applied)
    const currency = s.invoice.currency
    const notices: Worded[] = [notice('mcp.approve.notices.stornoCancels', { number })]
    if (applied > 0) notices.push(notice('mcp.approve.notices.stornoApplied', { amount: money(applied, currency) }))
    if (refund > 0.005) notices.push(notice('mcp.approve.notices.stornoRefund', { amount: money(refund, currency) }))
    if (s.released.time || s.released.expenses) notices.push(notice('mcp.approve.notices.stornoReleases', { entries: entries(s.released.time, s.released.expenses) }))
    if (s.released.deposits) notices.push(notice(s.released.deposits === 1 ? 'mcp.approve.notices.stornoDepositsOne' : 'mcp.approve.notices.stornoDeposits', { count: s.released.deposits }))
    if (s.settings.drive_folder_id && s.settings.gmail_refresh_token) notices.push(notice('mcp.approve.notices.drive'))
    const summary = notice('mcp.approve.labels.storno', { number, creditNote, amount: money(s.total, currency) })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        invoice: { id: s.invoice.id, number, status: s.invoice.status, client: clip(clientDisplayName(s.invoice.clients)), total: s.total, open, currency: currency ?? 'EUR', app_url: documentUrl('invoice', s.invoice.id) },
        credit_note: { expected_number: creditNote, date: s.today, amount: s.total, applied, refund },
        reason: args.reason,
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: false,
      fingerprint: s.fingerprint,
    }
  },
  async fingerprint(ctx, args) {
    return (await loadStorno(ctx, args.invoice_id)).fingerprint
  },
  async execute(ctx, args) {
    const { data, error } = await createCreditNote(ctx.supabase, args.invoice_id, { cancel: true, reason: args.reason ?? undefined })
    if (error) throw error
    if (!data) throw new McpToolError('not_found', { details: { invoice_id: args.invoice_id } })
    const report: Worded[] = [notice('mcp.approve.result.storno', { number: data.number ?? '' })]
    if (data.snapshotError) report.push(notice('mcp.approve.result.archiveFailed', { number: data.number ?? '' }))
    if (data.driveError) report.push(notice('mcp.approve.result.driveFailed', { number: data.number ?? '' }))
    const warnings = report.slice(1).map(w => word(ctx.t, 'en', w))
    return {
      summary: report.map(w => word(ctx.t, 'en', w)).join(' '),
      data: {
        credit_note_id: data.creditNoteId, number: data.number, invoice_id: args.invoice_id,
        app_url: documentUrl('credit_note', data.creditNoteId), ...(data.snapshotError ? {} : { pdf_url: documentPdfUrl(data.creditNoteId) }),
        archive_failed: !!data.snapshotError, drive_error: data.driveError?.error ?? null, report,
      },
      ...(warnings.length ? { warnings } : {}),
    }
  },
})
