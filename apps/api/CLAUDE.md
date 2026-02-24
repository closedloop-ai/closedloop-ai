# apps/api — BFF API Server

Handles all database operations and external service integrations. Port 3002.

## Architecture: Routes vs Services

**Routes are thin. Services do the work.**

- **Routes** (`app/*/route.ts`): auth via `withAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Services** (`app/*/service.ts`): business logic, `@repo/database` imports, `withDb()` queries, external APIs, transactions

No database operations in routes — delegate to services.

## Auth Wrappers (`@/lib/auth/`)

| Wrapper | When to use |
|---------|-------------|
| `withAuth` | Clerk session only (browser clients) |
| `withApiKeyAuth` | API key only (`sk_live_*`) |
| `withAnyAuth` | Both — tries API key first, falls back to Clerk |

Use `withAnyAuth` for routes accepting both programmatic (MCP, CLI) and browser clients.

## Response Helpers
- Success: `NextResponse.json(success(data))` — import `success` from `@repo/api/src/types/common`
- Not found: `notFoundResponse("Entity")` — from `@/lib/route-utils`
- Error: `errorResponse("message", error)` — from `@/lib/route-utils`
- Request parsing: `parseBody(request, validator)` — from `@/lib/route-utils`
- Transactions: `withDb.tx(async (tx) => { ... })`
- Shared API types live in `packages/api/src/types/` — ensures frontend/backend share definitions

## Learned Patterns
- **[insight]**: API errors return generic messages to clients, log real errors server-side. Debug 500s in API terminal (:3002), not browser DevTools.
- **[pattern]**: Artifact routes: `findById(artifactId, user.organizationId)` not `validateOwnerInOrg()` — org-scoped query handles auth.
- **[pattern]**: Service functions > ~30 lines: extract to `apps/api/lib/{feature}-parser.ts`. Service orchestrates, parser implements.
- **[convention]**: No Cache-Control headers in API routes. Frontend: TanStack Query. Server: service layer caching.
- **[convention]**: Prisma-to-API type conversions: centralized mapping function (e.g., `toArtifact()`) that validates + throws on contract violations. No scattered `as Type`.
- **[convention]**: Webhook expected errors: catch specific error code (e.g., Prisma P2025), re-throw everything else.
- **[mistake]**: Liveblocks auth with global tokens: must pass organizationId as tenantId for inbox notifications.
- **[pattern]**: Liveblocks tenant ID from room ID: `extractTenantId(roomId) ?? organizationId` fallback chain.
- **[mistake]**: `artifactsService.create` signature: `create(organizationId, userId, input)` — orgId and userId before input.
- **[pattern]**: Routes must transform service Result types to API contract flat types.
- **[mistake]**: OAuth connect routes: verify service method signature before copying parameter destructuring.
- **[mistake]**: Throttling via localStorage: write timestamp AFTER operation succeeds (in `.then()`), not before.
