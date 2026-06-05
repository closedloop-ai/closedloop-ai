# apps/api — BFF API Server

Handles all database operations and external service integrations. Port 3002.

## Architecture: Routes vs Services

**Routes are thin. Services contain the business logic.**

- **Routes** (`app/*/route.ts`): auth via `withAnyAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Services** (`app/*/service.ts`): business logic, `@repo/database` imports, `withDb()` queries, external APIs, transactions

No database operations in routes — delegate to services. No type definitions or pure helper functions in route files — extract to co-located helpers (e.g., `relay-result-helpers.ts`) or `@/lib/`.

## Auth Wrappers

| Wrapper | Import | When to use |
|---------|--------|-------------|
| `withAnyAuth` | `@/lib/auth/with-any-auth` | **Default.** Accepts API key (`sk_live_*`) or Clerk session |
| `withAuth` | `@/lib/auth/with-auth` | Clerk session only — use sparingly for browser-only routes |
| `withApiKeyAuth` | `@/lib/auth/with-api-key-auth` | API key only (`sk_live_*`) |

**Prefer `withAnyAuth`** for all new routes. This supports both programmatic clients (MCP, CLI) and browser clients.

## Error Handling
- DO NOT throw unless there is a compelling reason to.
- Avoid try/catch unless using a 3rd party API that can throw.
- Use the `Result` type/const (`@lib/result`) to report success and failure to callers.

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
- **[convention]**: No Cache-Control headers in API routes. Frontend: TanStack Query. Server: service layer caching.
- **[convention]**: Prisma-to-API type conversions: centralized mapping function (e.g., `toArtifact()`) that validates. No scattered `as Type`.
- **[convention]**: Webhook expected errors: catch specific error code (e.g., Prisma P2025), re-throw everything else.
- **[pattern]**: Routes must transform service Result types to API contract flat types.
- **[mistake]**: OAuth connect routes: verify service method signature before copying parameter destructuring.
