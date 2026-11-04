// Who may approve a Claude connection: the app's owner (app_users), signed in at aal2, with a
// verified authenticator, because the connection's own session is lifted to aal2 with a fresh code.
import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentOwner =
  | { status: 'ok'; userId: string; email: string; factorId: string }
  | { status: 'no_factor' }
  | { status: 'denied' }

export async function consentOwner(supabase: SupabaseClient): Promise<ConsentOwner> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { status: 'denied' }
  const factor = user.factors?.find(f => f.factor_type === 'totp' && f.status === 'verified')
  if (!factor) return { status: 'no_factor' }
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aal?.currentLevel !== 'aal2') return { status: 'denied' }
  const { data: isOwner, error } = await supabase.rpc('is_app_user')
  if (error || isOwner !== true) return { status: 'denied' }
  return { status: 'ok', userId: user.id, email: user.email, factorId: factor.id }
}
