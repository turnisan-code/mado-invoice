'use server'

import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { MCP_SCOPES, type McpScope } from '@/lib/mcp/config'
import { sha256Hex } from '@/lib/mcp/crypto'
import { createGrantSession } from '@/lib/mcp/oauth/grant-session'
import { consentOwner } from '@/lib/mcp/oauth/owner'
import { authorizeErrorUrl, authorizeSuccessUrl, readAuthRequest } from '@/lib/mcp/oauth/request'
import {
  consentUsed, createGrant, endSupabaseSession, issueCode, mcpServiceClient, pruneExpired, revokeGrants,
} from '@/lib/mcp/oauth/store'

export type ConsentState = { error: 'code' | 'expired' | 'used' | 'owner' | 'failed' } | null

// Reading is always granted, whatever Claude asked for; the others only when Claude asked for them
// and the owner kept them ticked.
function grantedScopes(requested: readonly McpScope[], ticked: FormDataEntryValue[]): McpScope[] {
  return MCP_SCOPES.filter(s => s === 'mado:read' || (requested.includes(s) && ticked.includes(s)))
}

// The signed request is read again here (no hidden field is trusted). Approving lifts a new
// Supabase session to aal2 with the code just typed, stores it encrypted on a new grant, ends the
// client's older grants and sends Claude a single-use code. Denying returns access_denied.
// A signed request is approved once: the grant keeps its hash (unique), so sending the form again
// within the request's ten minutes neither makes a second grant nor revokes the first.
export async function answerConsent(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const blob = String(formData.get('r') ?? '')
  const request = readAuthRequest(blob)
  if (!request) return { error: 'expired' }
  if (formData.get('decision') !== 'approve') redirect(authorizeErrorUrl(request.redirectUri, 'access_denied', request.state))

  const code = String(formData.get('code') ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) return { error: 'code' }
  const owner = await consentOwner(await createClient())
  if (owner.status !== 'ok') return { error: 'owner' }

  const scopes = grantedScopes(request.scopes, formData.getAll('scope'))
  const consentHash = sha256Hex(blob)
  const service = mcpServiceClient()
  let target: string
  try {
    if (await consentUsed(service, consentHash)) return { error: 'used' }
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
        consentHash,
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
    // Two approvals of the same request at once: the other one made the grant.
    if (e?.code === '23505') return { error: 'used' }
    console.error('[oauth/consent]', e?.code, e?.message)
    return { error: 'failed' }
  }
  after(() => pruneExpired(service).catch(err => console.error('[oauth/consent] prune failed:', err?.code, err?.message)))
  redirect(target)
}
