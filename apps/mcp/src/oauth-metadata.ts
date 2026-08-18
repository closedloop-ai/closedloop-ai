/**
 * Discovery payloads this server publishes: the two OAuth 2.1 well-known
 * documents and the MCP server card.
 *
 * They are pure functions of the server URL (plus the registered tool names),
 * so they belong beside the other OAuth modules rather than inline in the route
 * table — `index.ts` is on the shrink-only grandfather list, and this is the
 * cohesive piece the ISS-4905 work sits next to. `scopes_supported` reads the
 * shared `@repo/api` vocabulary, so the advertised list cannot drift from what
 * the fail-closed resolver actually recognizes.
 */

import { API_KEY_SCOPES } from "@repo/api/src/types/api-key.js";

export function protectedResourceMetadata(serverUrl: string) {
  return {
    resource: serverUrl,
    authorization_servers: [serverUrl],
    scopes_supported: [...API_KEY_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.closedloop.ai/mcp",
  };
}

export function authorizationServerMetadata(serverUrl: string) {
  return {
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/oauth/authorize`,
    token_endpoint: `${serverUrl}/oauth/token`,
    registration_endpoint: `${serverUrl}/oauth/register`,
    introspection_endpoint: `${serverUrl}/internal/oauth/introspect`,
    revocation_endpoint: `${serverUrl}/internal/oauth/revoke`,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    grant_types_supported: [
      "authorization_code",
      "client_credentials",
      "refresh_token",
    ],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...API_KEY_SCOPES],
  };
}

export function mcpServerCard(
  serverUrl: string,
  protocolVersions: readonly string[],
  toolNames: readonly string[]
) {
  return {
    name: "closedloop",
    version: "0.0.1",
    description:
      "Closedloop AI software delivery platform — project management, document tracking, and work execution monitoring for AI-driven development workflows.",
    url: `${serverUrl}/mcp`,
    transport: { type: "streamable-http" },
    authentication: { type: "bearer", format: "sk_live_*" },
    // Advertise exactly the versions the SDK negotiates so the card stays a
    // single source of truth and cannot silently drift from the transport.
    protocol_versions: [...protocolVersions],
    capabilities: { tools: true },
    tools: toolNames,
  };
}
