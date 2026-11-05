import { authorizationServerMetadata, metadataOptions, metadataResponse } from '@/lib/mcp/oauth/metadata'

export function GET() {
  return metadataResponse(authorizationServerMetadata())
}

export function OPTIONS() {
  return metadataOptions()
}
