import type { GoTrueClient, User } from '@supabase/supabase-js'

// The verified TOTP factor this session still has to confirm, or null when no code step is due.
// `user` must come from getUser()/signInWithPassword (the Auth server), not from the session
// cookie, so a factor added on another device counts immediately. Only TOTP is considered
// because that is the only second step the login page can complete: an account without a
// verified TOTP factor is never asked for one.
export async function pendingTotpFactor(auth: Pick<GoTrueClient, 'mfa'>, user: User): Promise<string | null> {
  const factor = user.factors?.find(f => f.factor_type === 'totp' && f.status === 'verified')
  if (!factor) return null
  const { data } = await auth.mfa.getAuthenticatorAssuranceLevel()
  return data?.currentLevel === 'aal2' ? null : factor.id
}
