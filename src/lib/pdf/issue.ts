import type { SupabaseClient } from '@supabase/supabase-js'
import { isUiLang, makeT } from '@/lib/i18n'
import { calcTotals, orderItems } from '@/lib/utils/document'
import { ISSUER_SETTINGS_COLUMNS, IssueCheckError, issueProblems, type IssueCheckInput } from '@/lib/utils/issue-checks'
import { clearGoogleTokens, googleErrorMessage, isGoogleAuthError, isGoogleScopeError } from '@/lib/google/client'
import { GOOGLE_REAUTH_CODE, GOOGLE_REAUTH_MESSAGE, GOOGLE_SCOPE_MESSAGE } from '@/lib/google/reauth'
import { logEvent } from '@/lib/events'
import { ArchiveError, getIssuedPdf, type ArchiveErrorCode } from './snapshot'
import { archiveToDrive, type DriveArchive } from './drive'
import { applyCreditNote } from '@/lib/credits'
import { loadDepositCheck } from '@/lib/deposits'
import type { IssueProblem } from '@/types'

export type IssueOutcome = {
  number: string
  pdfPath: string | null
  snapshotError: string | null
  // Why no archive copy was made, where the app words it (e.g. 'client_changed').
  snapshotCode: ArchiveErrorCode | null
  drive: DriveArchive | null
  driveError: { error: string; code?: string } | null
}

type IssueCheck = { problems: IssueProblem[]; uiLanguage: unknown }

async function loadIssueCheck(supabase: SupabaseClient, documentId: string): Promise<IssueCheck> {
  const [{ data: doc, error }, { data: settings, error: settingsErr }] = await Promise.all([
    supabase.from('documents')
      .select('id, type, client_id, language, invoice_kind, converted_from_id, discount_type, discount_value, currency, tax_treatment, service_date, service_date_end, cancels_document_id, clients(uid_number, country), document_items(*)')
      .eq('id', documentId)
      .maybeSingle(),
    supabase.from('settings').select(`${ISSUER_SETTINGS_COLUMNS}, ui_language`).maybeSingle(),
  ])
  if (error) throw new Error(error.message)
  if (settingsErr) throw new Error(settingsErr.message)
  if (!doc) throw new Error('Document not found')
  const problems = issueProblems({
    type: doc.type,
    currency: doc.currency,
    taxTreatment: doc.tax_treatment,
    serviceDate: doc.service_date,
    serviceDateEnd: doc.service_date_end,
    isStorno: !!doc.cancels_document_id,
    // Many-to-one: PostgREST returns the client as an object, the untyped client infers an array.
    client: doc.clients as unknown as IssueCheckInput['client'],
    items: orderItems(doc.document_items ?? []),
    settings,
    deposit: await loadDepositCheck(supabase, doc),
  })
  return { problems, uiLanguage: settings?.ui_language }
}

// The checks the builder shows inline, run on the stored document: what stands between it and a
// number (empty when it may be issued). Throws only when the document or settings cannot be read.
export async function checkIssuable(supabase: SupabaseClient, documentId: string): Promise<IssueProblem[]> {
  return (await loadIssueCheck(supabase, documentId)).problems
}

// Run before a number is taken, so every issuance path refuses an incomplete document with
// readable reasons (IssueCheckError).
async function assertIssuable(supabase: SupabaseClient, documentId: string): Promise<void> {
  const { problems, uiLanguage } = await loadIssueCheck(supabase, documentId)
  if (problems.length) throw new IssueCheckError(problems, makeT(isUiLang(uiLanguage) ? uiLanguage : 'en'))
}

// The total the frozen PDF prints (before payments), kept so a later edit that changes the amount
// can be flagged. Written once, before the first frozen copy exists; a failure is only logged.
async function recordIssuedTotal(supabase: SupabaseClient, documentId: string): Promise<void> {
  const { data: doc, error } = await supabase.from('documents')
    .select('discount_type, discount_value, tax_treatment, issued_total, pdf_path, document_items(*)')
    .eq('id', documentId)
    .maybeSingle()
  if (error || !doc) {
    console.error(`[issue] issued total of ${documentId} not read:`, error?.message ?? 'not found')
    return
  }
  if (doc.issued_total != null || doc.pdf_path) return
  const discount = doc.discount_type && doc.discount_value ? { type: doc.discount_type, value: doc.discount_value } : null
  const { total } = calcTotals(doc.document_items ?? [], [], discount, doc.tax_treatment)
  const { error: writeErr } = await supabase.from('documents').update({ issued_total: total }).eq('id', documentId).is('issued_total', null)
  if (writeErr) console.error(`[issue] issued total of ${documentId} not recorded:`, writeErr.message)
}

// Every issuance path goes through here: issue_document assigns the number atomically, then the
// PDF is frozen in the private bucket and archived to Drive when a folder is configured. Only a
// failed number assignment throws; archive failures are returned so the caller can report them
// while the document stays issued (a missing copy is flagged on its page and can be created later).
// `unattended` (the recurring generator): nothing is numbered for a client a Claude session changed
// and the owner has not saved in Mado since (clients.mcp_written_at): refused with code
// 'client_changed' just before the number is taken, and should Claude change the client after
// that, no archive copy is made from it (getIssuedPdf), the invoice stays without one until the
// owner saves the client (snapshotCode 'client_changed'). The owner's own issuing is not held.
export async function issueDocument(supabase: SupabaseClient, documentId: string, opts: { unattended?: boolean } = {}): Promise<IssueOutcome> {
  // The whole client row: a database without clients.mcp_written_at has nothing from Claude.
  const { data: before, error: lookupErr } = await supabase.from('documents').select(opts.unattended ? 'number, type, clients(*)' : 'number, type').eq('id', documentId).maybeSingle()
  if (lookupErr) throw new Error(lookupErr.message)
  if (!before) throw new Error('Document not found')
  const row = before as unknown as { number: string | null; type: string; clients?: { mcp_written_at?: string | null } | null }
  if (opts.unattended && !row.number && row.clients?.mcp_written_at) {
    throw Object.assign(new Error('The client was changed from a Claude connection and not saved in Mado since; the invoice stays a draft'), { code: 'client_changed' })
  }
  if (!row.number) await assertIssuable(supabase, documentId)

  const { data: number, error } = await supabase.rpc('issue_document', { p_document_id: documentId })
  // With its code and detail (MI001–MI004 say why), so every caller can word the refusal.
  if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details })
  if (!row.number) await logEvent(supabase, documentId, 'issued', { number })
  await recordIssuedTotal(supabase, documentId)
  // An issued credit note takes its amount off the open balance of the invoice it corrects; a
  // failure leaves it unapplied, and its page offers to apply it.
  if (!row.number && row.type === 'credit_note') {
    await applyCreditNote(supabase, documentId).catch(err => console.error(`[issue] credit note ${number} not applied:`, err))
  }

  const outcome: IssueOutcome = { number: number as string, pdfPath: null, snapshotError: null, snapshotCode: null, drive: null, driveError: null }

  let issued: Awaited<ReturnType<typeof getIssuedPdf>>
  try {
    issued = await getIssuedPdf(supabase, documentId, 'issue', { unattended: opts.unattended })
    outcome.pdfPath = issued.path
  } catch (err) {
    console.error(`[issue] archive copy failed for ${number}:`, err)
    outcome.snapshotError = err instanceof Error ? err.message : String(err)
    outcome.snapshotCode = err instanceof ArchiveError ? err.code : null
    return outcome
  }

  const { settings, doc } = issued
  if (!settings.drive_folder_id || !settings.gmail_refresh_token) return outcome
  try {
    outcome.drive = await archiveToDrive(supabase, settings, { id: doc.id, number: outcome.number, drive_file_id: doc.drive_file_id }, issued)
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearGoogleTokens(supabase, settings.id)
      outcome.driveError = { error: GOOGLE_REAUTH_MESSAGE, code: GOOGLE_REAUTH_CODE }
    } else if (isGoogleScopeError(err)) {
      outcome.driveError = { error: GOOGLE_SCOPE_MESSAGE, code: GOOGLE_REAUTH_CODE }
    } else {
      console.error(`[issue] Drive archive failed for ${number}:`, err)
      outcome.driveError = { error: googleErrorMessage(err), code: 'google_failed' }
    }
  }
  return outcome
}
