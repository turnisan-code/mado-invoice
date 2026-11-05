import { mcpServiceClient } from '@/lib/mcp/oauth/store'
import { oauthError, readForm, revokeToken } from '@/lib/mcp/oauth/token'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const form = await readForm(req)
  if (!form) return oauthError('invalid_request', 'The body must be application/x-www-form-urlencoded, each parameter once')
  try {
    return await revokeToken(mcpServiceClient(), form)
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    console.error('[oauth/revoke]', e?.code, e?.message)
    return oauthError('server_error', 'The token could not be revoked. Try again.', 503)
  }
}
