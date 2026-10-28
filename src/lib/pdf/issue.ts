import type { SupabaseClient } from '@supabase/supabase-js'
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

// Every issuance path goes through here: issue_document assigns the number atomically, then the
// PDF is frozen in the private bucket and archived to Drive when a folder is configured. Only a
// failed number assignment throws; archive failures are returned so the caller can report them
// while the document stays issued (a missing copy is flagged on its page and can be created later).
export async function issueDocument(supabase: SupabaseClient, documentId: string): Promise<IssueOutcome> {
  const { data: before, error: lookupErr } = await supabase.from('documents').select('number').eq('id', documentId).maybeSingle()
  if (lookupErr) throw new Error(lookupErr.message)
  if (!before) throw new Error('Document not found')

  const { data: number, error } = await supabase.rpc('issue_document', { p_document_id: documentId })
  // The code (MI001–MI003, MI010–MI018) lets callers word the failure in the UI language.
  if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details })
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
