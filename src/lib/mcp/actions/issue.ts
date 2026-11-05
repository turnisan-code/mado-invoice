// Issuing 1–10 drafts: gapless numbers, the frozen PDF, the Drive copy, a credit note applied.
import { z } from 'zod'
import { today } from '@/lib/utils/document'
import {
  IssueRefusal, issueMany, issuePreview, latestIssuedOf, loadIssueDrafts, numberingOf, startIssueBatches,
  type IssueDraftRow, type IssuePreview, type IssueRun,
} from '@/lib/services/issue'
import type { MovedDates } from '@/lib/pdf/bulk'
import type { DocumentType } from '@/types'
import { documentPdfUrl, documentUrl } from '../config'
import { McpToolError } from '../errors'
import { canonicalJson, exact, fingerprintOf } from '../fingerprint'
import { defineAction, type ActionOutcome, type ServiceContext, type ToolContext } from '../types'
import { itemsState, mayOutlastClient, notice, paymentsState, printedClient, refuse, storedError } from './common'
import { clip, entries, money, word, type Worded } from './words'

export const MAX_ISSUE_DOCUMENTS = 10

function draftState(d: IssueDraftRow) {
  return {
    id: d.id, type: d.type, number: d.number, status: d.status, date: d.date, due_date: d.due_date, client_id: d.client_id,
    language: d.language, currency: d.currency, tax_treatment: d.tax_treatment, service_date: d.service_date,
    service_date_end: d.service_date_end, notes: d.notes, discount_type: d.discount_type, discount_value: exact(d.discount_value),
    skonto_percent: exact(d.skonto_percent), skonto_days: d.skonto_days, invoice_kind: d.invoice_kind, buyer_reference: d.buyer_reference,
    converted_from_id: d.converted_from_id, cancels_document_id: d.cancels_document_id, recurring_schedule_id: d.recurring_schedule_id,
    // The client's terms and what prints of it, as before the whole row was read (Claude's mark is
    // shown, not compared: what prints is).
    client: d.clients ? { id: d.clients.id, payment_days: d.clients.payment_days, ...printedClient(d.clients) } : null,
    items: itemsState(d.document_items), payments: paymentsState(d.payments),
  }
}

// The drafts, the numbering and the newest issued documents, read once: the preview and the
// fingerprint come from the same read. Today counts too: it decides the dates and the year.
export async function loadIssueState(ctx: ServiceContext, ids: readonly string[], redate: boolean) {
  const [drafts, settings] = await Promise.all([loadIssueDrafts(ctx.supabase, ids), ctx.settings()])
  const missing = ids.find(id => !drafts.some(d => d.id === id))
  if (missing) throw new McpToolError('not_found', { details: { document_id: missing } })
  const types = [...new Set(drafts.map(d => d.type))].sort() as DocumentType[]
  const latest = new Map(await Promise.all(types.map(async type => [type, await latestIssuedOf(ctx.supabase, type)] as const)))
  const day = today()
  const fingerprint = fingerprintOf({
    today: day,
    redate,
    drafts: drafts.map(draftState),
    numbering: types.map(type => ({ type, ...numberingOf(settings, type) })),
    terms: { payment_days: settings.default_payment_days ?? null, validity_days: settings.default_quote_validity_days ?? null },
    // Only the date (it decides the order warning): a document issued meanwhile moves the counter.
    latest: types.map(type => latest.get(type)?.date ?? null),
  })
  return { drafts, settings, latest, today: day, fingerprint }
}

export async function previewIssue(ctx: ServiceContext, state: Awaited<ReturnType<typeof loadIssueState>>, redate: boolean): Promise<IssuePreview> {
  try {
    return await issuePreview(ctx.supabase, state.settings, state.drafts, { redate, today: state.today, latestIssued: state.latest })
  } catch (err) {
    if (!(err instanceof IssueRefusal)) throw err
    if (err.reason === 'already_issued') throw refuse(ctx, 'mcp.approve.refusals.alreadyIssued', { number: err.number ?? '' }, 'draft_only', { document_id: err.documentId })
    throw refuse(ctx, 'mcp.approve.refusals.cancelledDraft', undefined, 'invalid_input', { document_id: err.documentId })
  }
}

// What the owner should know before approving, per document.
export function issueNotices(preview: IssuePreview): Worded[] {
  const out: Worded[] = []
  for (const d of preview.documents) {
    const number = d.expected_number
    if (d.issue_date !== d.date) out.push(notice('mcp.approve.notices.redated', { number, date: { date: d.date } }))
    if (d.date_kept) out.push(notice('mcp.approve.notices.dateKept', { number, date: { date: d.date } }))
    if (d.before_latest) out.push(notice('mcp.approve.notices.beforeLatest', { number, date: { date: d.issue_date }, latest: d.before_latest.number, latestDate: { date: d.before_latest.date } }))
    if (d.zero_total) out.push(notice('mcp.approve.notices.zeroTotal', { number }))
    if (d.unlinked) out.push(notice('mcp.approve.notices.unlinked', { number, entries: entries(d.unlinked.time, d.unlinked.expenses) }))
    if (d.credits) out.push(notice('mcp.approve.notices.creditApplied', { number, invoice: d.credits.number ?? '' }))
    // Not refused (issuing for a client Claude just created is the usual way), but the owner sees
    // what is numbered and archived for good: the recipient block, the UID and a buyer reference
    // that comes from the client (or a credit note's invoice), not from the draft.
    if (d.claude_client && d.claude_buyer_reference) {
      out.push(notice('mcp.approve.notices.clientChangedReference', { number, details: clip(d.claude_client, 240), reference: clip(d.claude_buyer_reference, 120) }))
    } else if (d.claude_client) {
      out.push(notice('mcp.approve.notices.clientChanged', { number, details: clip(d.claude_client, 240) }))
    }
  }
  if (preview.drive) out.push(notice('mcp.approve.notices.drive'))
  return out
}

export function issueSummary(preview: IssuePreview): Worded {
  const [first] = preview.documents
  if (preview.documents.length === 1) {
    return notice('mcp.approve.labels.issueOne', { type: { docType: first.type }, client: clip(first.client?.name), number: first.expected_number, gross: money(first.gross, first.currency) })
  }
  return notice('mcp.approve.labels.issueMany', { count: preview.documents.length, numbers: { list: preview.documents.map(d => d.expected_number) }, gross: money(preview.total_gross) })
}

export function withLinks(preview: IssuePreview) {
  return preview.documents.map(d => ({ ...d, app_url: documentUrl(d.type, d.id) }))
}

// What came of a run, for Claude (English) and the approval page (data.report, in the owner's
// language). Nothing issued: the first failure is thrown as the action's error.
export function issueOutcome<D extends IssueDraftRow>(ctx: ServiceContext, run: IssueRun<D>, drafts: readonly D[]): Omit<ActionOutcome, 'summary'> & { report: Worded[] } {
  if (!run.notes.length) throw run.failed ? run.failed.error : new McpToolError('deadline')
  const report: Worded[] = [notice('mcp.approve.result.issued', { numbers: { list: run.notes.map(n => n.number) } })]
  const warnings: Worded[] = []
  for (const n of run.notes) {
    if (n.movedFrom) report.push(notice('mcp.approve.result.moved', { number: n.number, date: { date: n.movedFrom } }))
    if (n.dateKept) warnings.push(notice('mcp.approve.notices.dateKept', { number: n.number, date: { date: drafts.find(d => d.id === n.id)?.date ?? '' } }))
    if (n.beforeLatest) warnings.push(notice('mcp.approve.result.beforeLatest', { number: n.number, latest: n.beforeLatest.number }))
    if (n.snapshotFailed) warnings.push(notice('mcp.approve.result.archiveFailed', { number: n.number }))
    if (n.driveError) warnings.push(notice('mcp.approve.result.driveFailed', { number: n.number }))
    if (n.unlinked) warnings.push(notice('mcp.approve.notices.unlinked', { number: n.number, entries: entries(n.unlinked.time, n.unlinked.expenses) }))
  }
  const failed = run.failed ? { document_id: run.failed.draft.id, error: storedError(run.failed.error, ctx.t) } : null
  const notIssued = drafts.length - run.notes.length
  const issuedIds = new Set(run.notes.map(n => n.id))
  if (failed) {
    warnings.push(notice(notIssued === 1 ? 'mcp.approve.result.issueFailedOne' : 'mcp.approve.result.issueFailed', { count: notIssued, error: { error: failed.error } }))
  } else if (run.stopped.length) {
    warnings.push(notice(run.stopped.length === 1 ? 'mcp.approve.result.notReachedOne' : 'mcp.approve.result.notReached', { count: run.stopped.length }))
  }
  return {
    report: [...report, ...warnings],
    warnings: warnings.map(w => word(ctx.t, 'en', w)),
    data: {
      issued: run.notes.map(n => {
        const type = drafts.find(d => d.id === n.id)?.type ?? 'invoice'
        return {
          id: n.id, type, number: n.number, moved_from: n.movedFrom, date_kept: n.dateKept, before_latest: n.beforeLatest,
          archive_failed: n.snapshotFailed, drive_error: n.driveError?.error ?? null, unlinked: n.unlinked,
          app_url: documentUrl(type, n.id), ...(n.snapshotFailed ? {} : { pdf_url: documentPdfUrl(n.id) }),
        }
      }),
      failed,
      // The failed draft first, then the ones after it (never tried) or cut off by the deadline.
      not_issued: [...(failed ? [failed.document_id] : []), ...drafts.filter(d => !issuedIds.has(d.id) && d.id !== failed?.document_id).map(d => d.id)],
    },
  }
}

// The drafts as the check just before the run read them (approvedState: the fingerprint matched),
// by id.
export type ApprovedDrafts = ReadonlyMap<string, IssueDraftRow>

export const approvedDrafts = (drafts: readonly IssueDraftRow[]): ApprovedDrafts => new Map(drafts.map(d => [d.id, d]))

// What issuing changes on the document itself: left out where it is compared after its number
// was taken.
const ISSUING_CHANGES = ['number', 'status', 'date', 'due_date'] as const

// Whether the document, with its client, lines and payments, is still as that check read it.
// `moved`: the dates the run itself just gave it; `issued`: compared after its number was taken.
export async function stillApproved(
  ctx: ServiceContext,
  approved: ApprovedDrafts,
  id: string,
  opts: { moved?: MovedDates | null; issued?: boolean } = {},
): Promise<boolean> {
  const was = approved.get(id)
  const [now] = await loadIssueDrafts(ctx.supabase, [id])
  if (!was || !now) return false
  const state = (d: IssueDraftRow): string => {
    const s: Record<string, unknown> = draftState(d)
    if (opts.issued) for (const key of ISSUING_CHANGES) delete s[key]
    return canonicalJson(s)
  }
  return state(now) === state({ ...was, ...opts.moved })
}

// Issues the drafts as approved. A batch takes seconds per draft (number, PDF, storage, Drive) and
// a draft later in it is still an unnumbered draft meanwhile, so each is compared with the approved
// state once more just before its number is taken; a change stops the run there (state_changed)
// and what was issued before stays issued. While a run approved in Mado lasts, the database also
// refuses Claude's writes to the drafts, the invoices a final draft deducts and their clients
// (MI046); a run Claude confirmed in the chat runs on Claude's own session, so there this check is
// what holds it (a deduction changed meanwhile fails the draft's issue check, deductionsOutdated).
export async function runIssue(ctx: ServiceContext, ids: readonly string[], redate: boolean, approved: ApprovedDrafts | undefined) {
  if (!approved) throw new McpToolError('internal')
  const drafts = ids.map(id => approved.get(id)).filter((d): d is IssueDraftRow => !!d)
  if (drafts.length !== ids.length) throw new McpToolError('state_changed')
  const started = await startIssueBatches(ctx.supabase, drafts.map(d => d.type), redate, today())
  if ('error' in started) throw started.error
  const run = await issueMany(ctx.supabase, started.batches, drafts, {
    deadline: ctx.deadline,
    beforeIssue: async (d, moved) => {
      if (!await stillApproved(ctx, approved, d.id, { moved })) {
        throw refuse(ctx, 'mcp.approve.refusals.changedSinceApproval', undefined, 'state_changed', { document_id: d.id })
      }
    },
  })
  return { run, drafts }
}

const argsSchema = z.object({
  document_ids: z.array(z.uuid()).min(1).max(MAX_ISSUE_DOCUMENTS),
  redate_to_today: z.boolean().default(true),
})
type Args = z.output<typeof argsSchema>

export const issueAction = defineAction<Args, ApprovedDrafts>({
  kind: 'issue',
  argsSchema,
  async prepare(ctx: ToolContext, args) {
    if (new Set(args.document_ids).size !== args.document_ids.length) throw refuse(ctx, 'mcp.approve.refusals.duplicateIds')
    const state = await loadIssueState(ctx, args.document_ids, args.redate_to_today)
    const preview = await previewIssue(ctx, state, args.redate_to_today)
    const notices = issueNotices(preview)
    const summary = issueSummary(preview)
    return {
      label: word(ctx.t, 'en', summary),
      preview: { summary, notices, documents: withLinks(preview), redate: preview.redate, total_gross: preview.total_gross, drive: preview.drive },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: mayOutlastClient(ctx, { documents: args.document_ids.length }),
      fingerprint: state.fingerprint,
    }
  },
  async fingerprint(ctx, args) {
    return (await loadIssueState(ctx, args.document_ids, args.redate_to_today)).fingerprint
  },
  async approvedState(ctx, args) {
    const state = await loadIssueState(ctx, args.document_ids, args.redate_to_today)
    return { fingerprint: state.fingerprint, state: approvedDrafts(state.drafts) }
  },
  async execute(ctx, args, approved) {
    const { run, drafts } = await runIssue(ctx, args.document_ids, args.redate_to_today, approved)
    const outcome = issueOutcome(ctx, run, drafts)
    return { ...outcome, summary: outcome.report.map(w => word(ctx.t, 'en', w)).join(' '), data: { ...outcome.data, report: outcome.report } }
  },
})
