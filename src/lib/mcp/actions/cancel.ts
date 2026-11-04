// Cancelling a draft of any type or an issued quote. Cancelled is final; an issued invoice needs
// a Storno and an issued credit note can never be cancelled (documents_status_guard).
import { z } from 'zod'
import { setDocumentStatus } from '@/lib/services/lifecycle'
import { canTransition } from '@/lib/status'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals } from '@/lib/utils/document'
import type { DocumentStatus, DocumentType } from '@/types'
import { documentUrl } from '../config'
import { McpToolError } from '../errors'
import { fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext } from '../types'
import { codedError, notice, refuse } from './common'
import { clip, money, word, type Worded } from './words'

type CancelDoc = {
  id: string
  type: DocumentType
  number: string | null
  status: DocumentStatus
  currency: string | null
  tax_treatment: string | null
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  invoice_kind: string | null
  clients: { name: string; company: string | null } | null
  document_items: Parameters<typeof calcTotals>[0] | null
}

async function ids(ctx: ServiceContext, table: string, column: string, id: string): Promise<string[]> {
  const { data, error } = await ctx.supabase.from(table).select('id').eq(column, id)
  if (error) throw error
  return (data ?? []).map(r => r.id as string).sort()
}

async function loadCancel(ctx: ServiceContext, id: string) {
  const { data, error } = await ctx.supabase.from('documents')
    .select('id, type, number, status, currency, tax_treatment, discount_type, discount_value, invoice_kind, clients(name, company), document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value)')
    .eq('id', id).maybeSingle()
  if (error) throw error
  const doc = data as unknown as CancelDoc | null
  if (!doc) throw new McpToolError('not_found', { details: { document_id: id } })
  if (doc.status === 'cancelled') throw refuse(ctx, 'mcp.approve.refusals.alreadyCancelled', undefined, 'invalid_input', { document_id: id })
  if (doc.number && doc.type === 'invoice') throw codedError('MI012')
  if (doc.number && doc.type === 'credit_note') throw codedError('MI013')
  if (!canTransition(doc.type, doc.status, 'cancelled')) throw codedError('MI010')
  // Cancelling frees the project entries an invoice billed and the invoices a final one deducts.
  const released = doc.type === 'invoice'
    ? { time: await ids(ctx, 'time_entries', 'invoiced_document_id', id), expenses: await ids(ctx, 'project_expenses', 'invoiced_document_id', id), deposits: await ids(ctx, 'documents', 'final_invoice_id', id) }
    : { time: [], expenses: [], deposits: [] }
  return { doc, released, fingerprint: fingerprintOf({ id: doc.id, type: doc.type, number: doc.number, status: doc.status, released }) }
}

const argsSchema = z.object({ document_id: z.uuid() })
type Args = z.output<typeof argsSchema>

export const cancelAction = defineAction<Args>({
  kind: 'cancel',
  argsSchema,
  async prepare(ctx, args) {
    const { doc, released, fingerprint } = await loadCancel(ctx, args.document_id)
    const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
    const gross = calcTotals(doc.document_items ?? [], [], discount, doc.tax_treatment).total
    const client = clip(clientDisplayName(doc.clients))
    const notices: Worded[] = [notice('mcp.approve.notices.cancelFinal')]
    if (released.time.length || released.expenses.length) notices.push(notice('mcp.approve.notices.releasesEntries', { time: released.time.length, expenses: released.expenses.length }))
    if (released.deposits.length) notices.push(notice('mcp.approve.notices.releasesDeposits', { count: released.deposits.length }))
    const summary = doc.number
      ? notice('mcp.approve.labels.cancelIssued', { type: { docType: doc.type }, number: doc.number, client })
      : notice('mcp.approve.labels.cancelDraft', { type: { docType: doc.type }, client, gross: money(gross, doc.currency) })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        document: { id: doc.id, type: doc.type, number: doc.number, status: doc.status, client, gross, currency: doc.currency ?? 'EUR', app_url: documentUrl(doc.type, doc.id) },
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: false,
      fingerprint,
    }
  },
  async fingerprint(ctx, args) {
    return (await loadCancel(ctx, args.document_id)).fingerprint
  },
  async execute(ctx, args) {
    const { error, from } = await setDocumentStatus(ctx.supabase, args.document_id, 'cancelled')
    if (error) throw error
    const report = [notice('mcp.approve.result.cancelled')]
    return { summary: word(ctx.t, 'en', report[0]), data: { document_id: args.document_id, from, report } }
  },
})
