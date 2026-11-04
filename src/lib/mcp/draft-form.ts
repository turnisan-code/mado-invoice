// How the connector's draft tools turn Claude's arguments into the editor's form (the same
// FormState the builder saves through saveDraft) and how a stored draft is described back: its
// lines, totals, the problems that would stop issuing it and the number it would get.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  blankLine, blankSpecial, clientChangeTerms, clientTerms, expectedNumber, UNITS,
  type FormState, type LineItem,
} from '@/components/forms/builder/model'
import { loadDepositCheck, discountOf } from '@/lib/deposits'
import type { TFn } from '@/lib/i18n'
import type { PublicSettings } from '@/lib/public-settings'
import { cataloguePrice, catalogueLineText, rateMap } from '@/lib/utils/catalogue'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals, formatMoney, lineAmount, orderItems } from '@/lib/utils/document'
import { issueProblemMessage, issueProblems, type IssueCheckInput } from '@/lib/utils/issue-checks'
import type { CatalogueItem, Client, DocumentType, Settings, Unit, VatRate } from '@/types'
import { documentUrl } from './config'
import { McpToolError } from './errors'

export const MAX_LINES = 200

export const isoDate = z.iso.date()
export const id = z.guid()

const VAT = z.union([z.literal(0), z.literal(10), z.literal(13), z.literal(20)])

// One line of a draft. 'deduction' lines (a final invoice's) are never written by Claude.
export const lineInput = z.object({
  id: id.optional().describe('Only in update_document: an existing line of this draft to keep (its billed time and expenses stay linked).'),
  line_type: z.enum(['item', 'heading', 'text', 'separator', 'subtotal', 'page_break']).optional().describe("Default 'item'. 'subtotal' closes a section and may carry the section's discount."),
  description: z.string().max(5000).optional(),
  quantity: z.number().min(-1_000_000).max(1_000_000).optional(),
  unit: z.enum(UNITS as [Unit, ...Unit[]]).optional(),
  unit_price: z.number().min(-1_000_000_000).max(1_000_000_000).optional().describe('Net, EUR.'),
  vat_rate: VAT.optional(),
  service_date: isoDate.nullable().optional(),
  service_date_end: isoDate.nullable().optional(),
  discount_type: z.enum(['percent', 'fixed']).nullable().optional(),
  discount_value: z.number().min(0).max(1_000_000_000).optional(),
  catalogue_item_id: id.nullable().optional().describe('Fills description, unit, VAT and the client\'s price from the catalogue unless given.'),
})
export type LineInput = z.output<typeof lineInput>

export const headerInput = {
  date: isoDate.optional().describe('Document date; default today (Vienna).'),
  due_date: isoDate.nullable().optional().describe("Due date (a quote's validity); default from the client's terms."),
  service_date: isoDate.nullable().optional(),
  service_date_end: isoDate.nullable().optional(),
  language: z.enum(['de', 'en']).optional(),
  tax_treatment: z.enum(['at_vat', 'eu_reverse_charge', 'non_eu']).optional(),
  notes: z.string().max(10_000).nullable().optional().describe('Printed on the document.'),
  notes_internal: z.string().max(10_000).nullable().optional().describe('Never printed.'),
  discount: z.object({ type: z.enum(['percent', 'fixed']), value: z.number().min(0).max(1_000_000_000) }).nullable().optional()
    .describe('Discount on the whole document; null removes it.'),
  skonto_percent: z.number().min(0).max(100).nullable().optional().describe('Invoices only.'),
  skonto_days: z.number().int().min(0).max(365).nullable().optional().describe('Invoices only.'),
  buyer_reference: z.string().max(200).nullable().optional(),
}
export type HeaderInput = z.output<z.ZodObject<typeof headerInput>>

const invalid = (message: string, details?: Record<string, unknown>) => new McpToolError('invalid_input', { message, details })

type Terms = Pick<Settings, 'default_quote_validity_days' | 'default_payment_days' | 'default_skonto_percent' | 'default_skonto_days'>

// The header arguments over the form. A new date moves nothing else (as in the editor); a new
// document's due date follows its date (`followDate`) unless one is given.
export function applyHeader(type: DocumentType, f: FormState, h: HeaderInput, opts: { settings: Terms; client?: Client | null; followDate?: boolean }): FormState {
  const next: FormState = { ...f }
  if (h.date !== undefined) next.date = h.date
  if (h.date !== undefined && opts.followDate && opts.client && h.due_date === undefined) {
    next.dueDate = clientTerms(type, opts.settings, opts.client, h.date).dueDate
  }
  if (h.due_date !== undefined) next.dueDate = h.due_date ?? ''
  if (h.service_date !== undefined) next.serviceDate = h.service_date ?? ''
  if (h.service_date_end !== undefined) next.serviceDateEnd = h.service_date_end ?? ''
  if (h.language !== undefined) next.language = h.language
  if (h.tax_treatment !== undefined) next.taxTreatment = h.tax_treatment
  if (h.notes !== undefined) next.notes = h.notes ?? ''
  if (h.notes_internal !== undefined) next.notesInternal = h.notes_internal ?? ''
  if (h.discount !== undefined) {
    if (h.discount?.type === 'percent' && h.discount.value > 100) throw invalid('A percentage discount is at most 100.')
    next.discountType = h.discount?.value ? h.discount.type : null
    next.discountValue = h.discount?.value ?? 0
  }
  if (h.skonto_percent !== undefined) next.skontoPercent = h.skonto_percent ?? ''
  if (h.skonto_days !== undefined) next.skontoDays = h.skonto_days ?? ''
  if (h.buyer_reference !== undefined) next.buyerReference = h.buyer_reference
  return next
}

// What changing the client sets, as the editor's client picker does: its language and tax
// treatment, its due date and (unless set by hand) its Skonto. Arguments given explicitly win.
export function applyClientChange(type: DocumentType, f: FormState, h: HeaderInput, settings: Terms, previous: Client | null, next: Client): FormState {
  const changed: FormState = {
    ...f,
    clientId: next.id,
    ...(next.language ? { language: next.language } : {}),
    taxTreatment: next.tax_treatment,
    ...clientChangeTerms(type, settings, f, previous, next),
  }
  return { ...changed, ...pick(f, h) }
}

// The fields the arguments set explicitly keep their value over what a client change brings.
function pick(f: FormState, h: HeaderInput): Partial<FormState> {
  const out: Partial<FormState> = {}
  if (h.language !== undefined) out.language = f.language
  if (h.tax_treatment !== undefined) out.taxTreatment = f.taxTreatment
  if (h.due_date !== undefined) out.dueDate = f.dueDate
  if (h.skonto_percent !== undefined) out.skontoPercent = f.skontoPercent
  if (h.skonto_days !== undefined) out.skontoDays = f.skontoDays
  return out
}

export type Catalogue = { items: Map<string, CatalogueItem>; rates: Record<string, number> }

export async function loadCatalogue(supabase: SupabaseClient, clientId: string, lines: readonly LineInput[]): Promise<Catalogue> {
  const ids = [...new Set(lines.map(l => l.catalogue_item_id).filter((v): v is string => !!v))]
  if (!ids.length) return { items: new Map(), rates: {} }
  const [{ data: items, error }, { data: rates, error: ratesErr }] = await Promise.all([
    supabase.from('catalogue_items').select('*').in('id', ids),
    supabase.from('client_rates').select('catalogue_item_id, price').eq('client_id', clientId),
  ])
  if (error) throw error
  if (ratesErr) throw ratesErr
  const found = new Map(((items ?? []) as CatalogueItem[]).map(i => [i.id, i]))
  const missing = ids.filter(i => !found.has(i))
  if (missing.length) throw invalid(`Unknown catalogue item: ${missing.join(', ')}. Use list_catalogue for the ids.`)
  return { items: found, rates: rateMap(rates ?? []) }
}

// A line from its arguments over `base` (a blank line, or the stored line it keeps). A catalogue
// item fills what the arguments leave out, as picking it in the editor does.
export function toLine(input: LineInput, base: LineItem, ctx: { language: FormState['language']; catalogue: Catalogue }): LineItem {
  const item = input.catalogue_item_id ? ctx.catalogue.items.get(input.catalogue_item_id) : undefined
  const fromCatalogue: Partial<LineItem> = item
    ? { description: catalogueLineText(item, ctx.language), unit_price: cataloguePrice(item, ctx.catalogue.rates), unit: item.unit, vat_rate: item.vat_rate as VatRate, catalogue_item_id: item.id }
    : {}
  const line: LineItem = { ...base, ...fromCatalogue }
  if (input.line_type !== undefined) line.line_type = input.line_type
  if (input.description !== undefined) line.description = input.description
  if (input.quantity !== undefined) line.quantity = input.quantity
  if (input.unit !== undefined) line.unit = input.unit
  if (input.unit_price !== undefined) line.unit_price = input.unit_price
  if (input.vat_rate !== undefined) line.vat_rate = input.vat_rate
  if (input.service_date !== undefined) line.service_date = input.service_date
  if (input.service_date_end !== undefined) line.service_date_end = input.service_date_end
  if (input.discount_type !== undefined) line.discount_type = input.discount_type
  if (input.discount_value !== undefined) line.discount_value = input.discount_value
  if (input.catalogue_item_id === null) line.catalogue_item_id = null
  if (line.discount_type === 'percent' && line.discount_value > 100) throw invalid('A percentage line discount is at most 100.')
  return line
}

function blankFor(input: LineInput, settings: Pick<Settings, 'default_unit' | 'default_vat_rate'>): LineItem {
  const type = input.line_type ?? 'item'
  return type === 'item' ? blankLine(settings) : blankSpecial(type)
}

const isDeduction = (l: LineItem) => l.line_type === 'deduction'

function capped(lines: LineItem[]): LineItem[] {
  if (lines.filter(l => !isDeduction(l)).length > MAX_LINES) throw invalid(`A draft has at most ${MAX_LINES} lines.`)
  return lines
}

type LineCtx = { language: FormState['language']; catalogue: Catalogue; settings: Pick<Settings, 'default_unit' | 'default_vat_rate'> }

// A new document's lines.
export function newLines(inputs: readonly LineInput[], ctx: LineCtx): LineItem[] {
  if (inputs.some(l => l.id)) throw invalid('New lines have no id.')
  return capped(inputs.map(l => toLine(l, blankFor(l, ctx.settings), ctx)))
}

// The whole list replaced: a line with the id of one of the draft's lines keeps that line (and
// what is billed on it) with the given fields changed; deduction lines stay below, untouched.
export function replaceLines(current: readonly LineItem[], inputs: readonly LineInput[], ctx: LineCtx): LineItem[] {
  const own = new Map(current.filter(l => !isDeduction(l)).map(l => [l.id, l]))
  const seen = new Set<string>()
  const lines = inputs.map(input => {
    if (!input.id) return toLine(input, blankFor(input, ctx.settings), ctx)
    const base = own.get(input.id)
    if (!base) throw invalid(`Line ${input.id} is not one of this draft's lines (deduction lines cannot be edited).`)
    if (seen.has(input.id)) throw invalid(`Line ${input.id} is listed twice.`)
    seen.add(input.id)
    return toLine(input, base, ctx)
  })
  return capped([...lines, ...current.filter(isDeduction)])
}

export const lineOpsInput = z.object({
  add: z.array(lineInput).max(MAX_LINES).optional().describe('Appended after the last line.'),
  update: z.array(lineInput.extend({ id })).max(MAX_LINES).optional().describe('Changes the given fields of existing lines.'),
  remove: z.array(id).max(MAX_LINES).optional(),
  order: z.array(id).max(MAX_LINES).optional().describe('Every remaining existing line id, in the new order (added lines come after them).'),
})
export type LineOps = z.output<typeof lineOpsInput>

export function applyLineOps(current: readonly LineItem[], ops: LineOps, ctx: LineCtx): LineItem[] {
  const own = current.filter(l => !isDeduction(l))
  const ids = new Set(own.map(l => l.id))
  const known = (lineId: string) => {
    if (!ids.has(lineId)) throw invalid(`Line ${lineId} is not one of this draft's lines (deduction lines cannot be edited).`)
    return lineId
  }
  const updates = new Map((ops.update ?? []).map(u => [known(u.id), u]))
  if (updates.size !== (ops.update ?? []).length) throw invalid('A line is updated twice.')
  const removed = new Set((ops.remove ?? []).map(known))
  let lines = own.filter(l => !removed.has(l.id)).map(l => (updates.has(l.id) ? toLine(updates.get(l.id)!, l, ctx) : l))
  if (ops.order) {
    const order = ops.order.map(known)
    const rest = lines.map(l => l.id)
    if (order.length !== rest.length || new Set(order).size !== order.length || !rest.every(i => order.includes(i))) {
      throw invalid('order must list every remaining line id exactly once.')
    }
    const byId = new Map(lines.map(l => [l.id, l]))
    lines = order.map(i => byId.get(i)!)
  }
  if ((ops.add ?? []).some(l => l.id)) throw invalid('Added lines have no id.')
  const added = (ops.add ?? []).map(l => toLine(l, blankFor(l, ctx.settings), ctx))
  return capped([...lines, ...added, ...current.filter(isDeduction)])
}

// ─── What a draft looks like to Claude ────────────────────────────────────────

const DOC_COLS = '*, document_items(*), clients(id, name, company, client_number, uid_number, country, email)'

type StoredDoc = {
  id: string; type: DocumentType; number: string | null; status: string; client_id: string; date: string; due_date: string | null
  service_date: string | null; service_date_end: string | null; language: string; currency: string; tax_treatment: string
  discount_type: 'percent' | 'fixed' | null; discount_value: number | null; skonto_percent: number | null; skonto_days: number | null
  invoice_kind: string | null; converted_from_id: string | null; cancels_document_id: string | null; buyer_reference: string | null
  notes: string | null; notes_internal: string | null
  document_items: Record<string, unknown>[] | null
  clients: { id: string; name: string; company: string | null; client_number: string | null; uid_number: string | null; country: string | null; email: string | null } | null
}

const money = (amount: number, currency: string) => formatMoney(amount, currency, 'en')

// The stored document as the reply of every draft tool: header, ordered lines with their net,
// totals, what would stop issuing it (worded) and the number issuing would give it today.
export async function describeDocument(
  supabase: SupabaseClient,
  settings: Settings | PublicSettings,
  t: TFn,
  documentId: string,
): Promise<{ data: Record<string, unknown>; line: string }> {
  const { data, error } = await supabase.from('documents').select(DOC_COLS).eq('id', documentId).maybeSingle()
  if (error) throw error
  if (!data) throw new McpToolError('not_found')
  const doc = data as unknown as StoredDoc
  const items = orderItems((doc.document_items ?? []) as unknown as (Parameters<typeof calcTotals>[0][number] & Record<string, unknown>)[])
  const totals = calcTotals(items, [], discountOf(doc), doc.tax_treatment)
  const draft = !doc.number && doc.status === 'draft'
  const problems = draft
    ? issueProblems({
        type: doc.type,
        currency: doc.currency,
        taxTreatment: doc.tax_treatment,
        serviceDate: doc.service_date,
        serviceDateEnd: doc.service_date_end,
        isStorno: !!doc.cancels_document_id,
        client: doc.clients as IssueCheckInput['client'],
        items: items as unknown as IssueCheckInput['items'],
        settings: settings as IssueCheckInput['settings'],
        deposit: await loadDepositCheck(supabase, doc as Parameters<typeof loadDepositCheck>[1]),
      })
    : []
  const expected = draft ? expectedNumber(settings, doc.type, doc.date) || null : null
  const client = doc.clients ? { id: doc.clients.id, name: clientDisplayName(doc.clients), client_number: doc.clients.client_number } : null
  const kind = doc.type === 'invoice' && doc.invoice_kind && doc.invoice_kind !== 'standard' ? `${doc.invoice_kind} invoice` : doc.type.replace('_', ' ')
  const parts = [
    `${draft ? 'Draft' : doc.number ?? 'Document'} ${kind} for ${client?.name ?? 'no client'}, ${money(totals.total, doc.currency)} gross, ${items.filter(i => (i.line_type ?? 'item') === 'item').length} item line(s).`,
    expected ? `Issuing it now would give it ${expected}.` : '',
    problems.length ? `Before it can be issued: ${problems.map(p => issueProblemMessage(p, t)).join(' ')}` : draft ? 'Nothing stops issuing it.' : '',
  ]
  return {
    line: parts.filter(Boolean).join(' '),
    data: {
      id: doc.id,
      type: doc.type,
      ...(doc.type === 'invoice' ? { invoice_kind: doc.invoice_kind ?? 'standard' } : {}),
      number: doc.number,
      status: doc.status,
      client,
      date: doc.date,
      due_date: doc.due_date,
      service_date: doc.service_date,
      service_date_end: doc.service_date_end,
      language: doc.language,
      tax_treatment: doc.tax_treatment,
      currency: doc.currency,
      discount: doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null,
      ...(doc.type === 'invoice' ? { skonto_percent: doc.skonto_percent, skonto_days: doc.skonto_days } : {}),
      buyer_reference: doc.buyer_reference,
      notes: doc.notes,
      notes_internal: doc.notes_internal,
      lines: items.map(i => {
        const it = i as unknown as Record<string, unknown> & { line_type?: string | null }
        const type = it.line_type ?? 'item'
        return {
          id: it.id,
          line_type: type,
          description: it.description,
          ...(type === 'item' || type === 'deduction'
            ? { quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, vat_rate: it.vat_rate, net: lineAmount(i) }
            : {}),
          ...(type === 'item' ? { service_date: it.service_date ?? null, service_date_end: it.service_date_end ?? null, catalogue_item_id: it.catalogue_item_id ?? null } : {}),
          ...((type === 'item' || type === 'subtotal') && it.discount_type ? { discount_type: it.discount_type, discount_value: it.discount_value } : {}),
        }
      }),
      totals: {
        net: totals.subtotal,
        discount: totals.discount_amount,
        vat: totals.vat_groups.map(g => ({ rate: g.rate, base: g.base, amount: g.amount })),
        total_vat: totals.total_vat,
        total: totals.total,
      },
      ...(draft ? { issue_problems: problems.map(p => ({ ...p, message: issueProblemMessage(p, t) })), expected_number: expected } : {}),
      app_url: documentUrl(doc.type, doc.id),
    },
  }
}
