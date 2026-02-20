# MCP Server

## Run

- Dev: `pnpm --filter @repo/mcp dev`
- Typecheck: `pnpm --filter @repo/mcp typecheck`
- Test: `pnpm --filter @repo/mcp test`

## Required Environment Variables

- `INTERNAL_API_SECRET`
  - Used to sign and verify MCP OAuth access tokens.

## OAuth Configuration

- `MCP_OAUTH_CLIENT_ID` (optional)
  - Defaults to `closedloop-mcp`.
- `MCP_OAUTH_TOKEN_TTL_SECONDS` (optional)
  - Defaults to `3600`.
- `MCP_OAUTH_AUTH_CODE_TTL_SECONDS` (optional)
  - Defaults to `600`.
- `MCP_OAUTH_REDIRECT_URIS` (comma-separated, exact-match allowlist)
  - Example: `https://app.example.com/oauth/callback,https://admin.example.com/oauth/callback`
- `MCP_OAUTH_RATE_LIMIT_WINDOW_MS` (optional)
  - Defaults to `60000`.
- `MCP_OAUTH_RATE_LIMIT_AUTHORIZE_MAX` (optional)
  - Defaults to `120` requests per window per client IP.
- `MCP_OAUTH_RATE_LIMIT_TOKEN_MAX` (optional)
  - Defaults to `60` requests per window per client IP.
- `MCP_INTERNAL_ALLOWED_IPS` (comma-separated, exact-match allowlist)
  - Required in stage/prod.
  - Example: `10.0.0.10,10.0.0.11`

## Redirect URI Policy

- Local/dev behavior:
  - If `MCP_OAUTH_REDIRECT_URIS` is unset, localhost loopback redirects are allowed (`localhost`, `127.0.0.1`, `[::1]`).
- Stage/prod behavior:
  - `MCP_OAUTH_REDIRECT_URIS` is required.
  - Startup will fail if it is missing or empty.
  - Authorization requests must use an exact URI from the allowlist.

## Environment Detection For Policy

Non-local policy is enforced when either of these is true:

- `NODE_ENV=production`
- `WEBAPP_ENV=stage` or `WEBAPP_ENV=prod`

For internal endpoints, non-local environments must also set:

- `MCP_INTERNAL_ALLOWED_IPS`

## Internal Security Endpoints

These endpoints require `X-Internal-Secret: <INTERNAL_API_SECRET>`.
They are also IP-filtered by `MCP_INTERNAL_ALLOWED_IPS` in non-local environments.

- `POST /internal/oauth/introspect`
  - JSON body: `{ "token": "mcp_at_..." }`
  - Returns token activity/status metadata.
- `POST /internal/oauth/revoke`
  - JSON body: `{ "token": "mcp_at_..." }`
  - Revokes an issued MCP OAuth access token until its expiry.

## Persistence

- OAuth token revocations are persisted in DB table `oauth_revoked_tokens`.
- OAuth rate-limit counters are persisted in DB table `oauth_rate_limits`.

### cURL Examples

Revoke token:

```bash
curl -sS -X POST "http://localhost:3010/internal/oauth/revoke" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
  -d '{"token":"mcp_at_..."}'
```

Introspect token:

```bash
curl -sS -X POST "http://localhost:3010/internal/oauth/introspect" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
  -d '{"token":"mcp_at_..."}'
```
