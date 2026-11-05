import { metadataOptions, metadataResponse, protectedResourceMetadata } from '@/lib/mcp/oauth/metadata'

// The document /api/mcp's 401 points to (RFC 9728, path-suffixed).
export function GET() {
  return metadataResponse(protectedResourceMetadata())
}

export function OPTIONS() {
  return metadataOptions()
}
