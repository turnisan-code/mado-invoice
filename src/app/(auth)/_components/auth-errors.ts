import type { AuthError } from '@supabase/supabase-js'
import type { DictKey } from '@/lib/i18n'

// Supabase Auth messages are English-only and sometimes too revealing, so the UI shows its own text.
export function authErrorKey(error: AuthError): DictKey {
  switch (error.code) {
    case 'invalid_credentials': return 'account.invalidCredentials'
    case 'weak_password': return 'account.passwordWeak'
    case 'same_password': return 'account.passwordSame'
    case 'reauthentication_needed': return 'account.reauthNeeded'
    case 'insufficient_aal': return 'account.mfaRequired'
    case 'mfa_verification_failed':
    case 'mfa_challenge_expired': return 'account.invalidCode'
    case 'mfa_factor_name_conflict': return 'account.factorNameTaken'
    case 'mfa_totp_enroll_not_enabled':
    case 'mfa_totp_verify_not_enabled': return 'account.mfaUnavailable'
  }
  return error.status === 429 ? 'account.tooManyRequests' : 'account.genericError'
}
