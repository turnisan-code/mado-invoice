// Only the root layout renders <html>, and it cannot see the route: the proxy passes a portal
// page's token on in this request header, so <html lang> is the shared document's language.
export const PORTAL_TOKEN_HEADER = 'x-mado-portal-token'

// The token of a portal page (/portal/<token>), not of its PDF; share tokens are UUIDs.
export function portalPageToken(pathname: string): string | null {
  return /^\/portal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(pathname)?.[1] ?? null
}
