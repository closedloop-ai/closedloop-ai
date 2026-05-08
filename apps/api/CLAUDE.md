# apps/api — BFF API Server

Handles all database operations and external service integrations. Port 3002.

## Architecture: Routes vs Services

**Routes are thin. Services contain the business logic.**

- **Routes** (`app/*/route.ts`): auth via `withAnyAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Services** (`app/*/service.ts`): business logic, `@repo/database` imports, `withDb()` queries, external APIs, transactions

No database operations in routes — delegate to services. No type definitions or pure helper functions in route files — extract to co-located helpers (e.g., `relay-result-helpers.ts`) or `@/lib/`.

## Service Conventions (FEA-680)

All services follow these rules. New services MUST conform; relocated services convert as part of the move.

**Location.** Services live next to their routes: `app/<resource>/service.ts`. When a resource has multiple responsibilities, split into sibling files. The module that owns the entity's general/CRUD surface is named after the entity (`<entity>-service.ts`); responsibility-specific siblings are named after the responsibility (`<responsibility>-service.ts`).

The `app/documents/` tree is the canonical example of a multi-responsibility split:
- `document-service.ts` (general CRUD)
- `generation-service.ts` (PRD/plan generation, regeneration, change requests)
- `execution-service.ts` (plan execution, backend resolution, plan-loop launch)
- `merge-service.ts` (LLM-driven document merge)
- `evaluation-service.ts` (ratings + judge feedback)
- `performance-service.ts` (perf summaries + execution-log download)
- Private helpers shared across these modules live in co-located files (`document-utils.ts`, `generation-status-helpers.ts`).

**Never use `crud-service.ts`** — name the file after the entity instead. Do not place services under `apps/api/lib/services/` (that location has been phased out).

**Named export.** Each service file exports a single named object, e.g. `export const artifactService = { ... }` or `export const documentGenerationService = { ... }`. No default exports, no facades that re-export across modules, no barrel `index.ts` files. Callers import the specific service object they need. When a sibling service needs a helper, export it as a named function from the appropriate service file (e.g. `getCommitterInfo` from `document-service.ts`) — sibling-to-sibling imports are fine; cross-module facades that aggregate everything under one umbrella name are not.

**Errors as values.** Service methods do not throw to communicate errors. Fallible writes return `Result<T>` (`@repo/api/src/types/result`). Reads that may return "not found" use a nullable return (`Promise<T | null>`). Routes translate `Status.NotFound` → 404, `Status.BadRequest` → 400, `Status.Forbidden` → 403, etc. via `route-utils` helpers. Internal invariants ("argument must be non-empty", programming errors) may still throw — but anything a route would map to a non-500 HTTP status is a `Result.err`, not a throw.

**Org scoping.** Every read and write that touches per-tenant data takes `organizationId` as a parameter and includes it in the Prisma `where` clause. No "trust the caller" patterns.

**Transactions.** Just call `withDb(fn)` for reads or `withDb.tx(fn)` for atomic writes — do not thread a `tx?: TransactionClient` parameter through service signatures. Both helpers check `AsyncLocalStorage` first: if the caller is already inside a `withDb.tx`, the inner call participates in that outer transaction automatically. If not, `withDb` opens a connection and `withDb.tx` opens a new transaction. This means a service method can be called standalone or from inside a webhook handler's `withDb.tx` without changing its signature. The `tx?` parameter pattern from earlier services is vestigial and should not be propagated to new code.

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
