'use server'

import { headers } from 'next/headers'
import { isUuid, requireUser } from '@/lib/auth'
import { makeT } from '@/lib/i18n'
import { APP_URL } from '@/lib/mcp/config'
import { approveAction, rejectAction, type ApproveResult, type CodeCheck } from '@/lib/mcp/confirm'
import type { ServiceContext } from '@/lib/mcp/types'
import type { Settings } from '@/types'

export type ApproveFormResult = { ok: true } | { ok: false; reason: Extract<ApproveResult, { ok: false }>['reason'] | 'origin' | 'unauthorized' | 'error' }

// Next.js already refuses a Server Action whose Origin differs from the Host; this also requires
// the app's own origin, so an approval never runs from another host the app might answer on.
async function fromApp(): Promise<boolean> {
  const origin = (await headers()).get('origin')
  return !!origin && origin === new URL(APP_URL).origin
}

// The owner's cookie session at aal2 (as every route requires), never a Claude grant's: the
// database refuses those approvals anyway (mcp_approve_action).
async function session() {
  const auth = await requireUser()
  if (!auth.ok) return null
  const { supabase, user } = auth
  let settings: Promise<Settings> | null = null
  const ctx: ServiceContext = {
    supabase,
    settings: () => settings ??= Promise.resolve(supabase.from('settings').select('*').single()).then(({ data, error }) => {
      if (error || !data) throw error ?? new Error('Settings not found')
      return data as Settings
    }),
    // What the run stores is read by Claude: English, as in the tools.
    t: makeT('en'),
    deadline: null,
  }
  return { ctx, user }
}

export async function approve(id: string, code: string): Promise<ApproveFormResult> {
  if (!(await fromApp())) return { ok: false, reason: 'origin' }
  if (!isUuid(id)) return { ok: false, reason: 'not_found' }
  const s = await session()
  if (!s) return { ok: false, reason: 'unauthorized' }
  const { ctx, user } = s
  try {
    const settings = await ctx.settings()
    const checkCode = async (): Promise<CodeCheck> => {
      const factor = user.factors?.find(f => f.factor_type === 'totp' && f.status === 'verified')
      if (!factor) return 'no_factor'
      if (!/^\d{6}$/.test(code)) return 'invalid'
      const { error } = await ctx.supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code })
      return error ? 'invalid' : 'ok'
    }
    const result = await approveAction(ctx, id, { requireCode: settings.mcp_approval_totp !== false, checkCode })
    return result.ok ? { ok: true } : result
  } catch (err) {
    console.error('[mcp/approve] approval failed:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'error' }
  }
}

export async function reject(id: string): Promise<ApproveFormResult> {
  if (!(await fromApp())) return { ok: false, reason: 'origin' }
  if (!isUuid(id)) return { ok: false, reason: 'not_found' }
  const s = await session()
  if (!s) return { ok: false, reason: 'unauthorized' }
  try {
    return (await rejectAction(s.ctx.supabase, id)) ? { ok: true } : { ok: false, reason: 'not_pending' }
  } catch (err) {
    console.error('[mcp/approve] rejection failed:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'error' }
  }
}
