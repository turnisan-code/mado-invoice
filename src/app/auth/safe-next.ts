const BASE = 'http://same-origin.invalid'

// Turns a ?next= value into a path on this site. Anything that would leave the origin
// ("//evil.com", "/\evil.com", "https://…", tab/newline tricks) or loop back into the
// sign-in flow falls back to the dashboard.
export function safeNextPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/')) return fallback
  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    return fallback
  }
  // "/..//evil.com" resolves to the path "//evil.com", which a browser reads as another host.
  if (url.origin !== BASE || url.pathname.startsWith('//')) return fallback
  if (url.pathname === '/login' || url.pathname.startsWith('/auth/')) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
