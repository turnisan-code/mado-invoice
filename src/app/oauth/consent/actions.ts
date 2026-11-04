'use server'

import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { MCP_SCOPES, type McpScope } from '@/lib/mcp/config'
import { createGrantSession } from '@/lib/mcp/oauth/grant-session'
import { consentOwner } from '@/lib/mcp/oauth/owner'
import { authorizeErrorUrl, authorizeSuccessUrl, readAuthRequest } from '@/lib/mcp/oauth/request'
import {
  createGrant, endSupabaseSession, issueCode, mcpServiceClient, pruneExpired, revokeGrants,
} from '@/lib/mcp/oauth/store'

export type ConsentState = { error: 'code' | 'expired' | 'owner' | 'failed' } | null

// Reading is always granted; the others only when Claude asked for them and the owner kept them ticked.
function grantedScopes(requested: readonly McpScope[], ticked: FormDataEntryValue[]): McpScope[] {
  return MCP_SCOPES.filter(s => requested.includes(s) && (s === 'mado:read' || ticked.includes(s)))
}

// The signed request is read again here (no hidden field is trusted). Approving lifts a new
// Supabase session to aal2 with the code just typed, stores it encrypted on a new grant, ends the
// client's older grants and sends Claude a single-use code. Denying returns access_denied.
export async function answerConsent(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const request = readAuthRequest(String(formData.get('r') ?? ''))
  if (!request) return { error: 'expired' }
  if (formData.get('decision') !== 'approve') redirect(authorizeErrorUrl(request.redirectUri, 'access_denied', request.state))

  const code = String(formData.get('code') ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) return { error: 'code' }
  const owner = await consentOwner(await createClient())
  if (owner.status !== 'ok') return { error: 'owner' }

  const scopes = grantedScopes(request.scopes, formData.getAll('scope'))
  const service = mcpServiceClient()
  let target: string
  try {
    const session = await createGrantSession(service, owner, code)
    if (!session.ok) return { error: session.reason === 'code' ? 'code' : 'failed' }
    try {
      const grantId = await createGrant(service, {
        userId: owner.userId,
        clientId: request.clientId,
        clientName: request.clientName,
        clientKind: request.clientKind,
        redirectUri: request.redirectUri,
        scopes,
        session: session.session,
      })
      await revokeGrants(service, { userId: owner.userId, clientId: request.clientId, exceptId: grantId }, 'reconnected')
      const authCode = await issueCode(service, {
        grantId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scopes,
      })
      target = authorizeSuccessUrl(request.redirectUri, authCode, request.state)
    } catch (err) {
      await endSupabaseSession(service, session.session.sessionId)
      throw err
    }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    console.error('[oauth/consent]', e?.code, e?.message)
    return { error: 'failed' }
  }
  after(() => pruneExpired(service).catch(err => console.error('[oauth/consent] prune failed:', err?.code, err?.message)))
  redirect(target)
}
