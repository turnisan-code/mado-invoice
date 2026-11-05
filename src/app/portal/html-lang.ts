// Only the root layout renders <html>, and it cannot see the route: the proxy passes a portal
// page's token on in this request header, so <html lang> is the shared document's language.
export const PORTAL_TOKEN_HEADER = 'x-mado-portal-token'

// Share tokens are UUIDs.
const SHARE_TOKEN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PAGE_PATH = new RegExp(`^/portal/(${SHARE_TOKEN})/?$`, 'i')
const TOKEN = new RegExp(`^${SHARE_TOKEN}$`, 'i')

// The token of a portal page (/portal/<token>), not of its PDF.
export function portalPageToken(pathname: string): string | null {
  return PAGE_PATH.exec(pathname)?.[1] ?? null
}

// The header as the root layout reads it. The proxy does not run for static-file paths (see its
// matcher), so there the header may be the visitor's own: only a well-formed token is looked up.
export function portalTokenHeader(value: string | null): string | null {
  return value && TOKEN.test(value) ? value : null
}
