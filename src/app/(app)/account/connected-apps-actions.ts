'use server'

import { createClient } from '@/lib/supabase/server'
import { appOwner } from '@/lib/mcp/oauth/owner'
import { mcpServiceClient, revokeGrant, revokeGrants } from '@/lib/mcp/oauth/store'
import { ACTION_KINDS } from '@/lib/mcp/types'
import type { McpConfirmPolicy } from '@/types'

type Result = { ok: true } | { ok: false }

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

// A Claude session can never get here (it has no cookies), and the database refuses it anyway (MI040).
export async function saveApprovalSettings(policy: Record<string, string>, approvalCode: boolean): Promise<Result> {
  const clean: McpConfirmPolicy = {}
  for (const kind of ACTION_KINDS) clean[kind] = policy[kind] === 'chat' ? 'chat' : 'app'
  if (typeof approvalCode !== 'boolean') return { ok: false }
  const supabase = await createClient()
  if (!(await appOwner(supabase))) return { ok: false }
  const { data: settings, error: readError } = await supabase.from('settings').select('id').maybeSingle()
  if (readError || !settings) return { ok: false }
  const { error } = await supabase.from('settings').update({ mcp_confirm_policy: clean, mcp_approval_totp: approvalCode }).eq('id', settings.id)
  if (error) {
    logFailure('policy', error)
    return { ok: false }
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
