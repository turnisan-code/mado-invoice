// The browser half of the API error contract (apiError in src/lib/auth.ts): a route's `error` is
// English for logs, its `code` is worded here in the UI language. Pure, so node can check it.
import type { DictKey, TFn } from '@/lib/i18n'
import type { ApiErrorCode, IssueProblem } from '@/types'
import { lifecycleErrorMessage } from '@/lib/status'
import { issueProblemMessage } from '@/lib/utils/issue-checks'
import { GOOGLE_REAUTH_CODE, googleErrorText } from '@/lib/google/reauth'

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'unauthorized', 'invalid_json', 'invalid_request', 'not_found', 'settings_missing', 'database',
  'incomplete', 'issue_failed', 'not_issued', 'archive_failed', 'pdf_failed',
  'google_reauth', 'google_failed', 'drive_not_configured', 'folder_not_found', 'not_a_folder', 'invalid_state',
  'invalid_address', 'no_email', 'nothing_outstanding', 'not_remindable', 'no_share_link',
  'invalid_status', 'payment_date_invalid', 'too_many_rows', 'nothing_to_apply', 'apply_failed',
  'inactive', 'template_cancelled', 'generate_failed', 'link_expired', 'expired', 'answered',
  'too_many_files', 'nothing_to_export',
]

type Payload = { error?: unknown; code?: unknown; details?: unknown; problems?: unknown }

function isProblemList(value: unknown): value is IssueProblem[] {
  return Array.isArray(value) && value.length > 0 && value.every(p => !!p && typeof p === 'object' && typeof (p as { code?: unknown }).code === 'string')
}

// The answer's wording, or null when it carries no code this module knows.
export function knownApiError(t: TFn, payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Payload
  if (isProblemList(p.problems)) return p.problems.map(problem => issueProblemMessage(problem, t)).join(' ')
  const code = typeof p.code === 'string' ? p.code : null
  if (!code) return null
  if (/^MI0\d\d$/.test(code)) {
    return lifecycleErrorMessage({ code, message: '', details: typeof p.details === 'string' ? p.details : null }, t)
  }
  if (code === GOOGLE_REAUTH_CODE) {
    // Expired, missing the Drive permission or never connected: the message tells them apart.
    const raw = typeof p.error === 'string' ? p.error : ''
    const worded = googleErrorText(t, raw)
    return worded !== raw ? worded : t('messages.api.google_reauth')
  }
  if (code === 'stored_unreadable') return t('archive.errors.stored_unreadable')
  const known = API_ERROR_CODES.find(c => c === code)
  return known ? t(`messages.api.${known}` as DictKey) : null
}

// Never the raw server text: an unknown answer gets the caller's fallback (or the generic one).
export function apiErrorMessage(t: TFn, payload: unknown, fallback?: string): string {
  return knownApiError(t, payload) ?? fallback ?? t('messages.generic')
}

// A thrown fetch (offline, DNS, CORS) or a body that is not JSON.
export function requestErrorMessage(t: TFn, err: unknown): string {
  return err instanceof TypeError ? t('messages.network') : t('messages.generic')
}
