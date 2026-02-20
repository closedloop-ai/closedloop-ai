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
