'use server'

import { createClient } from '@/lib/supabase/server'
import { appOwner, consentOwner } from '@/lib/mcp/oauth/owner'
import { mcpServiceClient, revokeGrant, revokeGrants } from '@/lib/mcp/oauth/store'
import { ACTION_KINDS } from '@/lib/mcp/types'
import type { McpConfirmPolicy } from '@/types'

type Result = { ok: true } | { ok: false }

// 'code': the change loosens the approval and the code was missing or wrong. 'no_factor': it
// loosens it, but there is no authenticator to ask a code of.
export type PolicyResult = { ok: true } | { ok: false; reason: 'code' | 'no_factor' | 'failed' }

function logFailure(where: string, err: unknown) {
  const e = err as { code?: unknown; message?: unknown }
  console.error(`[account/connected-apps] ${where}:`, e?.code, e?.message)
}

// The grant must be visible to this session under RLS (the owner at aal2); its secrets and the
// revocation itself are the service role's.
export async function disconnectApp(grantId: string): Promise<Result> {
  const supabase = await createClient()
  if (!(await appOwner(supabase))) return { ok: false }
  const { data, error } = await supabase.from('mcp_grants').select('id').eq('id', grantId).maybeSingle()
  if (error || !data) return { ok: false }
  try {
    await revokeGrant(mcpServiceClient(), grantId, 'owner')
    return { ok: true }
  } catch (err) {
    logFailure('disconnect', err)
    return { ok: false }
  }
}

// True when `next` lets anything through more easily than what is stored: a kind moved from Mado
// to Claude, or the approval code switched off. Moving the other way never is.
function loosens(stored: { mcp_confirm_policy: McpConfirmPolicy | null; mcp_approval_totp: boolean | null }, next: McpConfirmPolicy, approvalCode: boolean): boolean {
  const policy = stored.mcp_confirm_policy ?? {}
  return ACTION_KINDS.some(kind => next[kind] === 'chat' && policy[kind] !== 'chat')
    || (!approvalCode && stored.mcp_approval_totp !== false)
}

// A Claude session can never get here (it has no cookies), and the database refuses it anyway
// (MI040). The owner's cookie session alone may tighten the policy; loosening it needs a current
// authenticator code, checked on this session as approving in Mado does, so a browser agent
// driving the signed-in session cannot switch the approval off first.
export async function saveApprovalSettings(policy: Record<string, string>, approvalCode: boolean, code?: string): Promise<PolicyResult> {
  const clean: McpConfirmPolicy = {}
  for (const kind of ACTION_KINDS) clean[kind] = policy[kind] === 'chat' ? 'chat' : 'app'
  if (typeof approvalCode !== 'boolean') return { ok: false, reason: 'failed' }
  const supabase = await createClient()
  if (!(await appOwner(supabase))) return { ok: false, reason: 'failed' }
  const { data: settings, error: readError } = await supabase.from('settings').select('id, mcp_confirm_policy, mcp_approval_totp').maybeSingle()
  if (readError || !settings) return { ok: false, reason: 'failed' }

  if (loosens(settings, clean, approvalCode)) {
    const owner = await consentOwner(supabase)
    if (owner.status === 'no_factor') return { ok: false, reason: 'no_factor' }
    if (owner.status !== 'ok') return { ok: false, reason: 'failed' }
    const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : ''
    if (!/^\d{6}$/.test(digits)) return { ok: false, reason: 'code' }
    const { error: mfaError } = await supabase.auth.mfa.challengeAndVerify({ factorId: owner.factorId, code: digits })
    if (mfaError) {
      if (mfaError.code !== 'mfa_verification_failed' && mfaError.code !== 'mfa_challenge_expired' && mfaError.code !== 'invalid_credentials') {
        logFailure('policy code', mfaError)
      }
      return { ok: false, reason: 'code' }
    }
  }

  const { error } = await supabase.from('settings').update({ mcp_confirm_policy: clean, mcp_approval_totp: approvalCode }).eq('id', settings.id)
  if (error) {
    logFailure('policy', error)
    return { ok: false, reason: 'failed' }
  }
  return { ok: true }
}

// Every connection ends before the sessions do; the browser then signs out with scope 'global'.
export async function disconnectAllApps(): Promise<Result> {
  const supabase = await createClient()
  const userId = await appOwner(supabase)
  if (!userId) return { ok: false }
  try {
    await revokeGrants(mcpServiceClient(), { userId }, 'sign_out_everywhere')
    return { ok: true }
  } catch (err) {
    logFailure('disconnect all', err)
    return { ok: false }
  }
}
