// Permanent deletes: a draft (with its lines, payments, history, reminders and a recurring
// schedule it is the template of), a client without documents or projects, a project without
// billed entries (with its unbilled ones). The template of a schedule that issues automatically
// is deleted only with the owner's approval in Mado: a Claude session cannot delete it (MI045).
import { z } from 'zod'
import { deleteClient, deleteDraft, deleteProject } from '@/lib/services/lifecycle'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals } from '@/lib/utils/document'
import type { DocumentType } from '@/types'
import { clientUrl, documentUrl, projectUrl } from '../config'
import { McpToolError } from '../errors'
import { cents, fingerprintOf } from '../fingerprint'
import { issueSchedules } from '../recurring'
import { defineAction, type ServiceContext } from '../types'
import { codedError, ITEMS_STATE_EMBED, itemsState, notice } from './common'
import { clip, entries, money, word, type Worded } from './words'

type Named = { name: string; company: string | null } | null

async function idsWhere(ctx: ServiceContext, table: string, eq: Record<string, string>, opts: { billed?: boolean; limit?: number } = {}): Promise<string[]> {
  let query = ctx.supabase.from(table).select('id')
  for (const [column, value] of Object.entries(eq)) query = query.eq(column, value)
  if (opts.billed) query = query.not('invoiced_document_id', 'is', null)
  if (opts.limit) query = query.limit(opts.limit)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map(r => r.id as string).sort()
}

async function loadTarget(ctx: ServiceContext, kind: 'draft' | 'client' | 'project', id: string) {
  if (kind === 'draft') {
    const { data, error } = await ctx.supabase.from('documents')
      .select(`id, type, number, status, client_id, currency, tax_treatment, discount_type, discount_value, clients(name, company), ${ITEMS_STATE_EMBED}, payments(id)`)
      .eq('id', id).maybeSingle()
    if (error) throw error
    const doc = data as unknown as {
      id: string; type: DocumentType; number: string | null; status: string; client_id: string | null; currency: string | null; tax_treatment: string | null
      discount_type: 'percent' | 'fixed' | null; discount_value: number | null; clients: Named
      document_items: (Parameters<typeof calcTotals>[0][number] & Record<string, unknown>)[] | null; payments: { id: string }[] | null
    } | null
    if (!doc) throw new McpToolError('not_found', { details: { id } })
    if (doc.number) throw codedError('MI015')
    const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
    const cascades = {
      payments: (doc.payments ?? []).map(p => p.id).sort(),
      schedules: await idsWhere(ctx, 'recurring_schedules', { source_document_id: id }),
      time: await idsWhere(ctx, 'time_entries', { invoiced_document_id: id }),
      expenses: await idsWhere(ctx, 'project_expenses', { invoiced_document_id: id }),
      deposits: await idsWhere(ctx, 'documents', { final_invoice_id: id }),
    }
    // A schedule that issues automatically numbers what it copies from this draft: only the owner
    // deletes it, in Mado.
    const issueTemplate = (await issueSchedules(ctx.supabase, [id])).map(s => s.id)
    const client = clip(clientDisplayName(doc.clients))
    const gross = calcTotals(doc.document_items ?? [], [], discount, doc.tax_treatment).total
    const notices: Worded[] = [notice('mcp.approve.notices.deleteDraft')]
    if (cascades.payments.length) notices.push(notice(cascades.payments.length === 1 ? 'mcp.approve.notices.deletePaymentsOne' : 'mcp.approve.notices.deletePayments', { count: cascades.payments.length }))
    if (cascades.schedules.length) notices.push(notice('mcp.approve.notices.deleteSchedule'))
    if (cascades.time.length || cascades.expenses.length) notices.push(notice('mcp.approve.notices.releasesEntries', { entries: entries(cascades.time.length, cascades.expenses.length) }))
    if (cascades.deposits.length) notices.push(notice(cascades.deposits.length === 1 ? 'mcp.approve.notices.releasesDepositsOne' : 'mcp.approve.notices.releasesDeposits', { count: cascades.deposits.length }))
    return {
      summary: notice('mcp.approve.labels.deleteDraft', { type: { docType: doc.type }, client, gross: money(gross, doc.currency) }),
      notices,
      target: { kind, id, type: doc.type, status: doc.status, client, gross, currency: doc.currency ?? 'EUR', app_url: documentUrl(doc.type, id) },
      // What the label shows (client and gross) and what it is computed from.
      state: {
        number: doc.number, status: doc.status, type: doc.type, client_id: doc.client_id, client, currency: doc.currency ?? 'EUR',
        tax_treatment: doc.tax_treatment, discount: { type: doc.discount_type, value: cents(doc.discount_value) },
        items: itemsState(doc.document_items), gross: cents(gross), cascades, issue_template: issueTemplate,
      },
      forceApp: issueTemplate.length > 0,
    }
  }

  if (kind === 'client') {
    const { data, error } = await ctx.supabase.from('clients').select('id, name, company, client_number').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) throw new McpToolError('not_found', { details: { id } })
    const documents = await idsWhere(ctx, 'documents', { client_id: id }, { limit: 1 })
    const projects = await idsWhere(ctx, 'projects', { client_id: id }, { limit: 1 })
    if (documents.length || projects.length) throw new McpToolError('client_in_use', { details: { in_use: documents.length ? 'documents' : 'projects' } })
    const client = clip(clientDisplayName(data as Named))
    return {
      summary: notice('mcp.approve.labels.deleteClient', { client }),
      notices: [notice('mcp.approve.notices.deleteClient')],
      target: { kind, id, client, client_number: data.client_number ?? null, app_url: clientUrl(id) },
      state: { exists: true, documents, projects },
    }
  }

  const { data, error } = await ctx.supabase.from('projects').select('id, name, client_id, clients(name, company)').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new McpToolError('not_found', { details: { id } })
  const billedTime = await idsWhere(ctx, 'time_entries', { project_id: id }, { billed: true, limit: 1 })
  const billedExpenses = await idsWhere(ctx, 'project_expenses', { project_id: id }, { billed: true, limit: 1 })
  if (billedTime.length || billedExpenses.length) throw codedError('MI033')
  const time = await idsWhere(ctx, 'time_entries', { project_id: id })
  const expenses = await idsWhere(ctx, 'project_expenses', { project_id: id })
  const project = clip(data.name as string)
  const client = clip(clientDisplayName((data as unknown as { clients: Named }).clients))
  const notices: Worded[] = [notice('mcp.approve.notices.deleteProject')]
  if (time.length || expenses.length) notices.push(notice('mcp.approve.notices.deleteProjectEntries', { entries: entries(time.length, expenses.length) }))
  return {
    summary: notice('mcp.approve.labels.deleteProject', { project, client }),
    notices,
    target: { kind, id, project, client, app_url: projectUrl(id) },
    state: { exists: true, time, expenses },
  }
}

const argsSchema = z.object({ kind: z.enum(['draft', 'client', 'project']), id: z.uuid() })
type Args = z.output<typeof argsSchema>

export const deleteAction = defineAction<Args>({
  kind: 'delete',
  argsSchema,
  async prepare(ctx, args) {
    const t = await loadTarget(ctx, args.kind, args.id)
    return {
      label: word(ctx.t, 'en', t.summary),
      preview: { summary: t.summary, notices: t.notices, target: t.target },
      warnings: t.notices.map(n => word(ctx.t, 'en', n)),
      forceApp: t.forceApp ?? false,
      fingerprint: fingerprintOf({ kind: args.kind, id: args.id, ...t.state }),
    }
  },
  async fingerprint(ctx, args) {
    const t = await loadTarget(ctx, args.kind, args.id)
    return fingerprintOf({ kind: args.kind, id: args.id, ...t.state })
  },
  async execute(ctx, args) {
    if (args.kind === 'draft') {
      const { deleted, error } = await deleteDraft(ctx.supabase, args.id)
      if (error) throw error
      if (!deleted) throw codedError('MI015')
    } else if (args.kind === 'client') {
      const { error, inUse } = await deleteClient(ctx.supabase, args.id)
      if (inUse) throw new McpToolError('client_in_use', { details: { in_use: inUse } })
      if (error) throw error
    } else {
      const { error } = await deleteProject(ctx.supabase, args.id)
      if (error) throw error
    }
    const report = [notice('mcp.approve.result.deleted')]
    return { summary: word(ctx.t, 'en', report[0]), data: { kind: args.kind, id: args.id, report } }
  },
})
