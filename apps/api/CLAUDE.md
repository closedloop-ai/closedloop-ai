# apps/api — BFF API Server

Handles all database operations and external service integrations. Port 3002.

## Architecture: Routes vs Services

**Routes are thin. Services do the work.**

- **Routes** (`app/*/route.ts`): auth via `withAnyAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Services** (`app/*/service.ts`): business logic, `@repo/database` imports, `withDb()` queries, external APIs, transactions

No database operations in routes — delegate to services.

## Auth Wrappers

| Wrapper | Import | When to use |
|---------|--------|-------------|
| `withAnyAuth` | `@/lib/auth/with-any-auth` | **Default.** Accepts API key (`sk_live_*`) or Clerk session |
| `withAuth` | `@/lib/auth/with-auth` | Clerk session only — use sparingly for browser-only routes |
| `withApiKeyAuth` | `@/lib/auth/with-api-key-auth` | API key only (`sk_live_*`) |

**Prefer `withAnyAuth`** for all new routes. This supports both programmatic clients (MCP, CLI) and browser clients.

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
- **[convention]**: `lib/` utilities must not import from `app/` domain modules. When a pure function in `app/` is needed by `lib/`, extract it to `lib/` first so both layers can share from a neutral location. (context: architecture|layering)
- **[convention]**: `TransactionClient` is re-exported from `@repo/database` top-level — import it as `import type { TransactionClient } from '@repo/database'`, not from the generated subpath. (context: typescript|import|database)
- **[pattern]**: When adding fan-out writes after an evaluation upsert, both operations must be in the same `withDb.tx()` block for atomicity. A bare `withDb()` call followed by a separate fan-out is a plan defect. (context: database|transaction)
