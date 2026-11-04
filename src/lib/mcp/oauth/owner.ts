// Who may approve a Claude connection or manage the connections: the app's owner (app_users),
// signed in at aal2 when an authenticator is set up. Approving a connection also needs that
// authenticator, because the connection's own session is lifted to aal2 with a fresh code.
import type { SupabaseClient, User } from '@supabase/supabase-js'

export type ConsentOwner =
  | { status: 'ok'; userId: string; email: string; factorId: string }
  | { status: 'no_factor' }
  | { status: 'denied' }

async function ownerUser(supabase: SupabaseClient): Promise<User | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  if (user.factors?.some(f => f.status === 'verified')) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel !== 'aal2') return null
  }
  const { data: isOwner, error } = await supabase.rpc('is_app_user')
  return !error && isOwner === true ? user : null
}

// The owner's user id, or null for anyone else (or the owner before the second factor).
export async function appOwner(supabase: SupabaseClient): Promise<string | null> {
  return (await ownerUser(supabase))?.id ?? null
}

export async function consentOwner(supabase: SupabaseClient): Promise<ConsentOwner> {
  const user = await ownerUser(supabase)
  if (!user?.email) return { status: 'denied' }
  const factor = user.factors?.find(f => f.factor_type === 'totp' && f.status === 'verified')
  if (!factor) return { status: 'no_factor' }
  return { status: 'ok', userId: user.id, email: user.email, factorId: factor.id }
}
