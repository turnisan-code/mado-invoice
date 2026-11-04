import { metadataOptions, metadataResponse, protectedResourceMetadata } from '@/lib/mcp/oauth/metadata'

// Root fallback for clients that do not probe the path-suffixed document first.
export function GET() {
  return metadataResponse(protectedResourceMetadata())
}

export function OPTIONS() {
  return metadataOptions()
}
