// The discovery documents Claude reads before it signs in: the protected-resource metadata
// (RFC 9728) for /api/mcp and the authorization server metadata (RFC 8414). Constant, public,
// built from the configured app URL only.
import {
  AUTHORIZE_URL, ISSUER, MCP_SCOPES, OFFLINE_ACCESS, RESOURCE, REVOCATION_URL, TOKEN_URL,
} from '../config'

export function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Mado Invoice',
  }
}

// client_id_metadata_document_supported with 'none' is what makes Claude use its published
// client documents instead of dynamic registration.
export function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    revocation_endpoint: REVOCATION_URL,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES, OFFLINE_ACCESS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'mcp-protocol-version',
}

export function metadataResponse(body: Record<string, unknown>): Response {
  return Response.json(body, { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } })
}

export function metadataOptions(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
}
