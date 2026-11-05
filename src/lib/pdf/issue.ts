import type { SupabaseClient } from '@supabase/supabase-js'
import { isUiLang, makeT } from '@/lib/i18n'
import { orderItems } from '@/lib/utils/document'
import { ISSUER_SETTINGS_COLUMNS, IssueCheckError, issueProblems, type IssueCheckInput } from '@/lib/utils/issue-checks'
import { clearGoogleTokens, googleErrorMessage, isGoogleAuthError, isGoogleScopeError } from '@/lib/google/client'
import { GOOGLE_REAUTH_CODE, GOOGLE_REAUTH_MESSAGE, GOOGLE_SCOPE_MESSAGE } from '@/lib/google/reauth'
import { logEvent } from '@/lib/events'
import { getIssuedPdf } from './snapshot'
import { archiveToDrive, type DriveArchive } from './drive'

export type IssueOutcome = {
  number: string
  pdfPath: string | null
  snapshotError: string | null
  drive: DriveArchive | null
  driveError: { error: string; code?: string } | null
}

// The checks the builder shows inline, run on the stored document before a number is taken, so
// every issuance path refuses an incomplete document with readable reasons (IssueCheckError).
async function assertIssuable(supabase: SupabaseClient, documentId: string): Promise<void> {
  const [{ data: doc, error }, { data: settings, error: settingsErr }] = await Promise.all([
    supabase.from('documents')
      .select('type, currency, tax_treatment, service_date, service_date_end, cancels_document_id, clients(uid_number, country), document_items(*)')
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
  })
  if (problems.length) throw new IssueCheckError(problems, makeT(isUiLang(settings?.ui_language) ? settings.ui_language : 'en'))
}

// Every issuance path goes through here: issue_document assigns the number atomically, then the
// PDF is frozen in the private bucket and archived to Drive when a folder is configured. Only a
// failed number assignment throws; archive failures are returned so the caller can report them
// while the document stays issued (a missing copy is flagged on its page and can be created later).
export async function issueDocument(supabase: SupabaseClient, documentId: string): Promise<IssueOutcome> {
  const { data: before, error: lookupErr } = await supabase.from('documents').select('number').eq('id', documentId).maybeSingle()
  if (lookupErr) throw new Error(lookupErr.message)
  if (!before) throw new Error('Document not found')
  if (!before.number) await assertIssuable(supabase, documentId)

  const { data: number, error } = await supabase.rpc('issue_document', { p_document_id: documentId })
  if (error) throw new Error(error.message)
  if (!before.number) await logEvent(supabase, documentId, 'issued', { number })

  const outcome: IssueOutcome = { number: number as string, pdfPath: null, snapshotError: null, drive: null, driveError: null }

  let issued: Awaited<ReturnType<typeof getIssuedPdf>>
  try {
    issued = await getIssuedPdf(supabase, documentId, 'issue')
    outcome.pdfPath = issued.path
  } catch (err) {
    console.error(`[issue] archive copy failed for ${number}:`, err)
    outcome.snapshotError = err instanceof Error ? err.message : String(err)
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
      outcome.driveError = { error: googleErrorMessage(err) }
    }
  }
  return outcome
}
