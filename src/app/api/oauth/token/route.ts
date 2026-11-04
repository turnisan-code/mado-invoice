import { after } from 'next/server'
import { mcpServiceClient, pruneExpired } from '@/lib/mcp/oauth/store'
import { exchangeCode, oauthError, readForm, refreshTokens } from '@/lib/mcp/oauth/token'

export const dynamic = 'force-dynamic'

// Claude's token endpoint (form-encoded, public clients, PKCE). Housekeeping runs after the answer.
export async function POST(req: Request) {
  const form = await readForm(req)
  if (!form) return oauthError('invalid_request', 'The body must be application/x-www-form-urlencoded, each parameter once')
  const service = mcpServiceClient()
  after(() => pruneExpired(service).catch(err => console.error('[oauth/token] prune failed:', err?.code, err?.message)))
  try {
    switch (form.get('grant_type')) {
      case 'authorization_code': return await exchangeCode(service, form)
      case 'refresh_token': return await refreshTokens(service, form)
      default: return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
    }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    console.error('[oauth/token]', e?.code, e?.message)
    return oauthError('server_error', 'The token could not be issued. Try again.', 500)
  }
}
