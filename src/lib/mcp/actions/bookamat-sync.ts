// Booking an issued document's money in Bookamat, one booking per calendar year, with the frozen
// PDF attached.
import { z } from 'zod'
import { BookamatError, type BookamatSettings } from '@/lib/bookamat'
import { bookamatPreview, syncBookamatWithAdopt } from '@/lib/services/bookamat-sync'
import { clip, money, word, type Worded } from './words'
import { documentUrl } from '../config'
import { cents, fingerprintOf } from '../fingerprint'
import { defineAction, type ServiceContext } from '../types'
import { mayOutlastClient, notice, paymentsState, refuse } from './common'

const ACCOUNT_KEYS = [
  'bookamat_username', 'bookamat_country', 'bookamat_bank_account_id', 'bookamat_cash_account_id', 'bookamat_cost_account_id',
  'bookamat_vat_account_0', 'bookamat_vat_account_rc', 'bookamat_vat_account_non_eu', 'bookamat_vat_account_10',
  'bookamat_vat_account_13', 'bookamat_vat_account_20', 'bookamat_accounts_year',
] as const

async function load(ctx: ServiceContext, documentId: string) {
  const settings = await ctx.settings() as unknown as BookamatSettings
  const preview = await bookamatPreview(ctx.supabase, settings, documentId)
  const d = preview.document
  const fingerprint = fingerprintOf({
    document: { id: d.id, type: d.type, number: d.number, status: d.status, total: cents(d.total) },
    payments: paymentsState(d.payments as unknown as Record<string, unknown>[]),
    recorded: [...d.recorded].map(r => ({ year: r.year, booking_id: String(r.booking_id), amount: cents(r.amount), kind: r.kind })).sort((a, b) => a.year - b.year || a.kind.localeCompare(b.kind)),
    pending: d.pending ?? null,
    accounts: Object.fromEntries(ACCOUNT_KEYS.map(k => [k, settings[k] ?? null])),
  })
  return { settings, preview, fingerprint }
}

const argsSchema = z.object({ document_id: z.uuid() })
type Args = z.output<typeof argsSchema>

export const bookamatSyncAction = defineAction<Args>({
  kind: 'bookamat_sync',
  argsSchema,
  async prepare(ctx, args) {
    const { preview, fingerprint } = await load(ctx, args.document_id)
    const d = preview.document
    if (!preview.bookings.length && !preview.unsettled) throw refuse(ctx, 'mcp.approve.refusals.alreadyBooked', { number: d.number })
    const amount = preview.bookings.reduce((s, b) => s + (b.kind === 'refund' ? -b.amount : b.amount), 0)
    const notices: Worded[] = [notice('mcp.approve.notices.bookamatPdf')]
    if (preview.unsettled) notices.push(notice('mcp.approve.notices.bookamatUnsettled'))
    if (preview.fees > 0) notices.push(notice('mcp.approve.notices.bookamatFees', { amount: money(preview.fees) }))
    if (d.recorded.length) notices.push(notice('mcp.approve.notices.bookamatRecorded', { count: d.recorded.length }))
    const summary = notice('mcp.approve.labels.bookamat', { number: d.number, count: preview.bookings.length, amount: money(Math.round(amount * 100) / 100) })
    return {
      label: word(ctx.t, 'en', summary),
      preview: {
        summary,
        notices,
        document: { id: d.id, type: d.type, number: d.number, client: clip(d.client), total: d.total, app_url: documentUrl(d.type, d.id) },
        bookings: preview.bookings,
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
  async execute(ctx, args) {
    const settings = await ctx.settings() as unknown as BookamatSettings
    const result = await syncBookamatWithAdopt(ctx.supabase, settings, args.document_id, { deadline: ctx.deadline ?? undefined })
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
