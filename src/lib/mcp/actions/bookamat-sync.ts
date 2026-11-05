// Booking an issued document's money in Bookamat, one booking per calendar year, with the frozen
// PDF attached.
import { z } from 'zod'
import { BookamatError, vatAccounts, type BookamatSettings } from '@/lib/bookamat'
import { bookamatPreview, syncBookamatWithAdopt } from '@/lib/services/bookamat-sync'
import { clip, money, word, type Worded } from './words'
import { documentUrl } from '../config'
import { McpToolError } from '../errors'
import { cents, fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext } from '../types'
import { mayOutlastClient, notice, paymentsState, refuse, refuseClaudeClient } from './common'

const ACCOUNT_KEYS = [
  'bookamat_username', 'bookamat_country', 'bookamat_bank_account_id', 'bookamat_cash_account_id', 'bookamat_cost_account_id',
  'bookamat_vat_account_0', 'bookamat_vat_account_rc', 'bookamat_vat_account_non_eu', 'bookamat_vat_account_10',
  'bookamat_vat_account_13', 'bookamat_vat_account_20', 'bookamat_accounts_year',
] as const

async function load(ctx: ServiceContext, documentId: string) {
  const settings = await ctx.settings() as unknown as BookamatSettings
  const preview = await bookamatPreview(ctx.supabase, settings, documentId)
  const d = preview.document
  // The bookings carry the client's name and UID, as the automatic sync's hold says.
  refuseClaudeClient(ctx, d.clientBooked, 'mcp.approve.refusals.clientChangedBookamat')
  const fingerprint = fingerprintOf({
    document: { id: d.id, type: d.type, number: d.number, status: d.status, total: cents(d.total) },
    // As the bookings carry it, and Claude's mark (a write after prepare is a change).
    client: d.clientBooked,
    payments: paymentsState(d.payments as unknown as Record<string, unknown>[]),
    recorded: [...d.recorded].map(r => ({ year: r.year, booking_id: String(r.booking_id), amount: cents(r.amount), kind: r.kind })).sort((a, b) => a.year - b.year || a.kind.localeCompare(b.kind)),
    pending: d.pending ?? null,
    accounts: Object.fromEntries(ACCOUNT_KEYS.map(k => [k, settings[k] ?? null])),
  })
  return { settings, preview, fingerprint }
}

// null: not set in Settings (the sync refuses); `cash` only when money came in cash.
function bookingAccounts(settings: BookamatSettings, preview: Awaited<ReturnType<typeof bookamatPreview>>) {
  const vat = vatAccounts(settings, preview.taxTreatment)
  return {
    bank: settings.bookamat_bank_account_id ?? null,
    ...(preview.bookings.some(b => b.cash > 0) ? { cash: settings.bookamat_cash_account_id ?? null } : {}),
    income: settings.bookamat_cost_account_id ?? null,
    vat: [...new Set(preview.rates)].sort((a, b) => a - b).map(rate => ({ rate, account: vat[rate] ?? null })),
  }
}

const argsSchema = z.object({ document_id: z.uuid() })
type Args = z.output<typeof argsSchema>
// The payments' mark as the state compared before the run read it (null: none).
type Approved = { paymentsAt: string | null }

export const bookamatSyncAction = defineAction<Args, Approved>({
  kind: 'bookamat_sync',
  argsSchema,
  async prepare(ctx, args) {
    const { settings, preview, fingerprint } = await load(ctx, args.document_id)
    const d = preview.document
    if (!preview.bookings.length && !preview.unsettled) throw refuse(ctx, 'mcp.approve.refusals.alreadyBooked', { number: d.number })
    const amount = preview.bookings.reduce((s, b) => s + (b.kind === 'refund' ? -b.amount : b.amount), 0)
    const notices: Worded[] = [notice('mcp.approve.notices.bookamatPdf')]
    if (preview.unsettled) notices.push(notice('mcp.approve.notices.bookamatUnsettled'))
    if (preview.fees > 0) notices.push(notice('mcp.approve.notices.bookamatFees', { amount: money(preview.fees) }))
    if (d.recorded.length) notices.push(notice(d.recorded.length === 1 ? 'mcp.approve.notices.bookamatRecordedOne' : 'mcp.approve.notices.bookamatRecorded', { count: d.recorded.length }))
    const summary = notice('mcp.approve.labels.bookamat', { number: d.number, count: preview.bookings.length, amount: money(Math.round(amount * 100) / 100) })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        document: { id: d.id, type: d.type, number: d.number, client: clip(d.client), total: d.total, app_url: documentUrl(d.type, d.id) },
        bookings: preview.bookings,
        // The Bookamat account ids from Settings each booking posts to (for another year, the
        // account of the same name in that year).
        accounts: bookingAccounts(settings, preview),
        recorded: d.recorded,
        fees: preview.fees,
      },
      warnings: notices.map(n => word(ctx.t, 'en', n)),
      forceApp: mayOutlastClient(ctx, { bookamat: true }),
      fingerprint,
    }
  },
  async fingerprint(ctx, args) {
    return (await load(ctx, args.document_id)).fingerprint
  },
  async approvedState(ctx, args) {
    const { preview, fingerprint } = await load(ctx, args.document_id)
    return { fingerprint, state: { paymentsAt: preview.document.paymentsAt } }
  },
  // A run confirmed in the chat runs on Claude's session, where nothing holds the client or the
  // payments: a change Claude makes to either after the state was compared (a parallel call) stops
  // the sync before it books (claudeHold, syncBookamatDocument), worded like the refusal.
  async execute(ctx, args, approved) {
    if (!approved) throw new McpToolError('internal')
    const settings = await ctx.settings() as unknown as BookamatSettings
    const result = await syncBookamatWithAdopt(ctx.supabase, settings, args.document_id, { deadline: ctx.deadline ?? undefined, claudeHold: approved })
    if (!result.ok && result.code === 'held') {
      const key = result.detail?.hold === 'payments' ? 'mcp.approve.refusals.paymentsChangedBookamat' : 'mcp.approve.refusals.clientChangedBookamat'
      throw refuse(ctx, key, undefined, 'invalid_input', { document_id: args.document_id })
    }
    if (!result.ok) throw new BookamatError(result.code, result.error, result.status, result.detail ?? {})
    const report: Worded[] = [result.created.length
      ? notice('mcp.approve.result.booked', { bookings: { list: result.created.map(c => `#${c.bookingId} (${c.year})`) } })
      : notice('mcp.approve.result.nothingBooked')]
    if (result.pdf.error) report.push(notice('mcp.approve.result.bookamatPdfFailed'))
    return {
      summary: report.map(w => word(ctx.t, 'en', w)).join(' '),
      data: { created: result.created, bookings: result.bookings, fees: result.fees, pdf_attached: result.pdf.attached, pdf_error: result.pdf.error, report },
      ...(result.pdf.error ? { warnings: [word(ctx.t, 'en', report[1])] } : {}),
    }
  },
})
