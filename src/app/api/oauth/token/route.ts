import { after } from 'next/server'
import { mcpServiceClient, pruneExpired, type ServiceClient } from '@/lib/mcp/oauth/store'
import { exchangeCode, oauthError, readForm, refreshTokens } from '@/lib/mcp/oauth/token'

export const dynamic = 'force-dynamic'

// Housekeeping runs after a successful exchange or refresh, at most once a minute per instance,
// so refused or junk requests never cost a prune.
const PRUNE_INTERVAL_MS = 60_000
let lastPrune = 0

function schedulePrune(service: ServiceClient) {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  after(() => pruneExpired(service).catch(err => console.error('[oauth/token] prune failed:', err?.code, err?.message)))
}

async function answer(service: ServiceClient, form: URLSearchParams): Promise<Response> {
  switch (form.get('grant_type')) {
    case 'authorization_code': return await exchangeCode(service, form)
    case 'refresh_token': return await refreshTokens(service, form)
    default: return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  }
}

// Claude's token endpoint (form-encoded, public clients, PKCE).
export async function POST(req: Request) {
  const form = await readForm(req)
  if (!form) return oauthError('invalid_request', 'The body must be application/x-www-form-urlencoded, each parameter once')
  const service = mcpServiceClient()
  try {
    const res = await answer(service, form)
    if (res.ok) schedulePrune(service)
    return res
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    console.error('[oauth/token]', e?.code, e?.message)
    return oauthError('server_error', 'The token could not be issued. Try again.', 500)
  }
}
