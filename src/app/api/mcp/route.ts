import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import { authenticateRequest, type McpAuth } from '@/lib/mcp/auth'
import { ALLOWED_ORIGINS, APP_HOST, MAX_REQUEST_BYTES, RESOURCE } from '@/lib/mcp/config'
import { buildServer } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Stateless: one server per request, no sessions, no listen streams (they hang on Vercel).
const handler = createMcpHandler(
  ({ authInfo }) => {
    const auth = authInfo?.extra?.mcp as McpAuth | undefined
    if (!auth) throw new Error('MCP request without authentication')
    return buildServer(auth)
  },
  { legacy: 'stateless', responseMode: 'json', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BYTES },
)

function refuse(status: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

// Claude calls from Anthropic's servers with a bearer token; cookies are never read, so there is
// no CORS. The Host check stops DNS rebinding; an Origin, when sent, must be ours or Claude's.
async function handle(req: Request): Promise<Response> {
  if (req.headers.get('host') !== APP_HOST) return refuse(403, 'Forbidden host')
  const origin = req.headers.get('origin')
  if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) return refuse(403, 'Forbidden origin')
  let outcome
  try {
    outcome = await authenticateRequest(req)
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    console.error('[mcp] authentication failed:', e?.code, e?.message)
    return refuse(503, 'Temporarily unavailable')
  }
  if (!outcome.ok) return outcome.response
  const { auth } = outcome
  const authInfo: AuthInfo = {
    token: '',
    clientId: auth.grant.clientId,
    scopes: [...auth.grant.scopes],
    expiresAt: auth.tokenExpiresAt,
    resource: new URL(RESOURCE),
    extra: { mcp: auth },
  }
  return handler.fetch(req, { authInfo })
}

export const GET = handle
export const POST = handle
export const DELETE = handle
