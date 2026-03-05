# MCP Server

## Run

- Dev: `pnpm --filter @repo/mcp dev`
- Typecheck: `pnpm --filter @repo/mcp typecheck`
- Test: `pnpm --filter @repo/mcp test`

## Claude Code CLI Setup

Use these steps to connect Claude Code CLI to ClosedLoop MCP:

1. Run `/mcp` in Claude Code CLI.
2. Add a server with:
   - Name: `closedloop`
   - URL: `https://mcp.closedloop.ai/mcp`
3. Choose `Authenticate` (or `Re-authenticate`).
4. Complete browser auth and enter your ClosedLoop API key (`sk_live_...`).
5. Confirm `/mcp` shows:
   - `Status: connected`
   - `Auth: authenticated`
6. Test with a prompt like: `list my projects`

### Troubleshooting

- If Claude CLI returns `Please run /login`, run `/login` and retry.
- If connected but tools are missing, run `/mcp` and select `Re-authenticate`.
- For large datasets, use tool pagination params (`limit`, `offset`) to avoid token overflow.
- If it still fails, capture:
  - the exact CLI error text
  - timestamp of the attempt
  - `/mcp` panel output

## Required Environment Variables

- `INTERNAL_API_SECRET`
  - Backward-compat fallback secret.
  - If `MCP_OAUTH_SIGNING_SECRET` or `MCP_INTERNAL_AUTH_SECRET` are not set, they fall back to this value.

## Security Secrets

- `MCP_OAUTH_SIGNING_SECRET` (recommended)
  - Primary secret used to sign/verify MCP OAuth access tokens.
  - If unset, falls back to `INTERNAL_API_SECRET`.
- `MCP_OAUTH_ENCRYPTION_SECRET` (recommended)
  - Secret used to derive the API-key encryption key embedded in OAuth tokens.
  - Keep distinct from signing secret to reduce blast radius.
  - If unset, falls back to `MCP_OAUTH_SIGNING_SECRET`.
- `MCP_OAUTH_SIGNING_SECRETS` (optional, comma-separated)
  - Previous signing secrets accepted for verification during key rotation.
  - Example: `oldsecret1,oldsecret2`.
- `MCP_INTERNAL_AUTH_SECRET` (recommended)
  - Secret required in `X-Internal-Secret` for internal introspection/revocation endpoints.
  - If unset, falls back to `INTERNAL_API_SECRET`.

## OAuth Configuration

- `MCP_OAUTH_CLIENT_ID` (optional)
  - Defaults to `closedloop-mcp`.
- `MCP_OAUTH_TOKEN_TTL_SECONDS` (optional)
  - Defaults to `3600` (1 hour).
  - Values less than `1` are treated as invalid and fallback to default.
- `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` (optional)
  - Defaults to `2592000` (30 days).
  - Values less than `1` are treated as invalid and fallback to default.
- `MCP_OAUTH_AUTH_CODE_TTL_SECONDS` (optional)
  - Defaults to `600`.
  - Values less than `1` are treated as invalid and fallback to default.
- `MCP_OAUTH_REDIRECT_URIS` (comma-separated allowlist, supports exact-match and `*` suffix wildcard)
  - Example: `https://app.example.com/oauth/callback,https://admin.example.com/oauth/callback`
  - For ChatGPT connector support, include:
    - `https://chat.openai.com/aip/mcp/callback`
    - `https://chatgpt.com/aip/mcp/callback`
    - `https://chat.openai.com/connector/oauth/*`
    - `https://chatgpt.com/connector/oauth/*`
- `MCP_OAUTH_RATE_LIMIT_WINDOW_MS` (optional)
  - Defaults to `60000`.
- `MCP_OAUTH_RATE_LIMIT_AUTHORIZE_MAX` (optional)
  - Defaults to `120` requests per window per client IP.
- `MCP_OAUTH_RATE_LIMIT_TOKEN_MAX` (optional)
  - Defaults to `60` requests per window per client IP.
- `MCP_OAUTH_CLEANUP_INTERVAL_MS` (optional)
  - Defaults to `300000` (5 minutes).
  - Controls background cleanup cadence for expired OAuth security records.
- `MCP_INTERNAL_ALLOWED_IPS` (comma-separated, exact-match allowlist)
  - Strongly recommended in stage/prod.
  - Supports exact IPs and IPv4 CIDR ranges.
  - Example: `10.0.0.10,10.0.0.11,10.0.0.0/16`
- `MCP_TRUST_PROXY` (optional)
  - When `true`/`1`/`yes`, trust `X-Forwarded-For` for client IP extraction.
  - Default is `false` (use direct socket remote address).
- `MCP_MAX_REQUEST_BODY_BYTES` (optional)
  - Defaults to `1048576` (1MB).
  - Applied to OAuth/internal endpoints and `/mcp` request buffering.
- `MCP_SERVER_CACHE_TTL_MS` (optional)
  - Defaults to `60000`.
  - Controls how long idle cached MCP server instances are retained.

## Redirect URI Policy

- Local/dev behavior:
  - If `MCP_OAUTH_REDIRECT_URIS` is unset, localhost loopback redirects are allowed (`localhost`, `127.0.0.1`, `[::1]`).
- Stage/prod behavior:
  - Loopback redirects are allowed without an allowlist (`localhost`, `127.0.0.1`, `[::1]`), which supports native/CLI OAuth clients.
  - If `MCP_OAUTH_REDIRECT_URIS` is set, non-loopback redirects must match an allowlist entry.
  - Entries ending with `*` are treated as prefix matches (for example, `https://chatgpt.com/connector/oauth/*`).
  - If `MCP_OAUTH_REDIRECT_URIS` is empty, only loopback redirects are accepted.

## Environment Detection For Policy

Non-local policy is enforced when either of these is true:

- `NODE_ENV=production`
- `WEBAPP_ENV=stage` or `WEBAPP_ENV=prod`

For internal endpoints in non-local environments:

- `MCP_INTERNAL_ALLOWED_IPS`
  - If unset, startup still succeeds, but internal OAuth endpoints reject all requests.

## Internal Security Endpoints

These endpoints require `X-Internal-Secret: <MCP_INTERNAL_AUTH_SECRET>`.
If `MCP_INTERNAL_AUTH_SECRET` is unset, fallback is `INTERNAL_API_SECRET`.
They are also IP-filtered by `MCP_INTERNAL_ALLOWED_IPS` in non-local environments.

- `POST /internal/oauth/introspect`
  - JSON body: `{ "token": "mcp_at_..." }`
  - Returns token activity/status metadata.
- `POST /internal/oauth/revoke`
  - JSON body: `{ "token": "mcp_at_..." }` or `{ "token": "mcp_rt_..." }`
  - Revokes an issued MCP OAuth token (access token, or entire refresh-token family).

## Persistence

- OAuth access token revocations are persisted in DB table `oauth_revoked_tokens`.
- OAuth refresh tokens are persisted in DB table `oauth_refresh_tokens`.
- OAuth rate-limit counters are persisted in DB table `oauth_rate_limits`.
- Refresh token scope narrowing is sticky: if a refresh request asks for a narrower
  scope, subsequent refreshes cannot re-expand beyond that narrowed scope.

### cURL Examples

Revoke token:

```bash
curl -sS -X POST "http://localhost:3010/internal/oauth/revoke" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $MCP_INTERNAL_AUTH_SECRET" \
  -d '{"token":"mcp_at_..."}'
```

Introspect token:

```bash
curl -sS -X POST "http://localhost:3010/internal/oauth/introspect" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $MCP_INTERNAL_AUTH_SECRET" \
  -d '{"token":"mcp_at_..."}'
```
