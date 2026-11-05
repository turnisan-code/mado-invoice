// Which OAuth clients may connect and where they may send the owner back to. Claude identifies
// itself with a client ID metadata document (CIMD) on claude.ai or claude.com; the static client
// covers claude.ai's "Use your own OAuth client". A redirect must be listed by the client AND be
// one of Claude's callbacks or a loopback /callback on any port (Claude Code).
import {
  CIMD_CACHE_TTL, CIMD_FETCH_TIMEOUT_MS, CIMD_HOSTS, CIMD_MAX_BYTES, CLAUDE_REDIRECT_URIS, KNOWN_CIMD_URLS,
  LOOPBACK_CALLBACK_PATH, LOOPBACK_HOSTS, STATIC_CLIENT_ID,
} from '../config'
import type { McpClientKind } from '@/types'

export interface OAuthClient {
  clientId: string
  name: string
  redirectUris: readonly string[]
  isStatic: boolean
}

const LOOPBACK_URIS = LOOPBACK_HOSTS.map(host => `http://${host}${LOOPBACK_CALLBACK_PATH}`)

const STATIC_CLIENT: OAuthClient = {
  clientId: STATIC_CLIENT_ID,
  name: 'Claude',
  redirectUris: [...CLAUDE_REDIRECT_URIS, ...LOOPBACK_URIS],
  isStatic: true,
}

// Used when claude.ai cannot be reached; the documents as published on 2026-11-04.
const PINNED: Record<string, { client_name: string; redirect_uris: string[] }> = {
  'https://claude.ai/oauth/claude-code-client-metadata': { client_name: 'Claude Code', redirect_uris: LOOPBACK_URIS },
  'https://claude.ai/oauth/mcp-oauth-client-metadata': { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// Port-agnostic loopback per RFC 8252: http only, the literal hosts, exactly /callback, nothing else.
export function isLoopbackRedirect(uri: string): boolean {
  const u = parseUrl(uri)
  return !!u && u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname) && u.pathname === LOOPBACK_CALLBACK_PATH
    && !u.username && !u.password && !u.search && !u.hash && !uri.includes('#') && /^http:\/\/[^/@]+\/callback$/.test(uri)
}

export function isAllowedRedirect(uri: string): boolean {
  return CLAUDE_REDIRECT_URIS.includes(uri) || isLoopbackRedirect(uri)
}

// The listed URI matches exactly, or both are loopback with the same host whatever the ports.
function sameRedirect(listed: string, uri: string): boolean {
  if (listed === uri) return true
  if (!isLoopbackRedirect(uri)) return false
  const a = parseUrl(listed)
  const b = parseUrl(uri)
  return !!a && !!b && a.protocol === 'http:' && a.hostname === b.hostname && a.pathname === b.pathname && !a.search && !a.hash
}

export function clientAllowsRedirect(client: OAuthClient, uri: string): boolean {
  return isAllowedRedirect(uri) && client.redirectUris.some(listed => sameRedirect(listed, uri))
}

export function clientKindFor(client: OAuthClient, redirectUri: string): McpClientKind {
  if (client.isStatic) return 'static'
  return isLoopbackRedirect(redirectUri) ? 'claude_code' : 'claude_ai'
}

// An https URL on Claude's hosts, nothing that could point the fetch elsewhere.
export function isCimdUrl(clientId: string): boolean {
  const u = parseUrl(clientId)
  return !!u && u.protocol === 'https:' && CIMD_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password
    && !u.hash && !u.search && u.pathname.length > 1 && u.href === clientId
}

type CimdDocument = { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown }

function toClient(url: string, doc: CimdDocument): OAuthClient | null {
  if (doc.client_id !== url) return null
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') return null
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(u => typeof u === 'string')) return null
  const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 80) : 'Claude'
  return { clientId: url, name, redirectUris: doc.redirect_uris as string[], isStatic: false }
}

class CimdUnreachable extends Error {}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > CIMD_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('Client metadata document too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchCimd(url: string): Promise<CimdDocument> {
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
  } catch {
    throw new CimdUnreachable()
  }
  if (res.status >= 500) throw new CimdUnreachable()
  if (!res.ok) throw new Error(`Client metadata document answered ${res.status}`)
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(res.headers.get('content-type') ?? '')) throw new Error('Client metadata document is not JSON')
  const parsed: unknown = JSON.parse(await readCapped(res))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Client metadata document is not an object')
  return parsed as CimdDocument
}

const cache = new Map<string, { client: OAuthClient; until: number }>()

// The client behind a client_id, or null when it is unknown or its document is not acceptable.
// A document that could not be fetched falls back to the pinned copy of a known URL.
export async function resolveClient(clientId: string, now = Date.now()): Promise<OAuthClient | null> {
  if (clientId === STATIC_CLIENT_ID) return STATIC_CLIENT
  if (!isCimdUrl(clientId)) return null
  const hit = cache.get(clientId)
  if (hit && hit.until > now) return hit.client
  let client: OAuthClient | null
  try {
    client = toClient(clientId, await fetchCimd(clientId))
  } catch (err) {
    const pinned = KNOWN_CIMD_URLS.includes(clientId) ? PINNED[clientId] : undefined
    if (!(err instanceof CimdUnreachable) || !pinned) {
      if (!(err instanceof CimdUnreachable)) console.error('[mcp] client metadata refused:', clientId, err instanceof Error ? err.message : typeof err)
      return null
    }
    return toClient(clientId, { client_id: clientId, ...pinned })
  }
  if (client) cache.set(clientId, { client, until: now + CIMD_CACHE_TTL * 1000 })
  return client
}
