// Share links (documents.share_token) work for SHARE_LINK_DAYS from creation, extension or
// rotation. NULL share_expires_at never expires (links created before expiry existed).
export const SHARE_LINK_DAYS = 90

export function shareExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + SHARE_LINK_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export function isShareExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= now.getTime()
}
