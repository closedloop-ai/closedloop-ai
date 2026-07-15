# API App Guidelines

## Serverless Routes and State
`apps/api` is deployed on Vercel serverless functions, so route code must not rely on process-local memory, singleton state, or long-lived in-process caches for correctness.

- Process-local maps used only for best-effort abuse control or caching, such as rate limiters, must use stable principal/resource keys rather than ephemeral connection IDs and must include TTL eviction or a hard maximum size.
- For API routes with fixed request/response/error contracts, wrap auth/session and other precondition helpers that can throw so the route still returns the declared contract shape instead of leaking a generic 500.
- API routes consumed by relay clients must preserve their declared JSON error envelope for non-SSE responses. If the same authorization branch feeds SSE, translate the structured denial into an SSE error event explicitly instead of changing the non-stream response to plain text.
- Keep route handlers thin: parse/auth at the boundary is fine, but multi-step business workflows, persistence orchestration, and cross-service validation should live in service/helper modules that the route delegates to.
- In `apps/api` serverless routes, do not fire-and-forget promises for response-path side effects. Await the work, pass the promise to `waitUntil`, or persist it for later processing.
- In multi-step sync flows, treat cache/materialization failures or throttles as scoped outcomes when the remaining steps can still update authoritative remote data. Log or return the partial failure or throttle, but continue independent PR, review, comment, or metadata sync work and cover that partial-outcome path in tests.
- In multi-step sync flows, helpers that settle only a scoped sub-step must not overwrite a caller-owned branch-wide attempt token such as `lastSyncStartedAt`. Write attempt tokens in the same branch that owns the matching branch-wide status/error settlement, and cover caller-owned-token paths in tests.
- When persisting provider rate-limit or throttle outcomes that influence later retry gates, preserve or derive a durable retry window from stored state. Cover the reload or other-client boundary so retries cannot fall back to a shorter process-local or dedupe-only window.
- In repair or relink flows that return aggregate outcomes for multiple records, do not reject a single requested record solely because the aggregate outcome is partial, skipped, or collision-blocked elsewhere. Reload the requested record from its authoritative persisted state after any non-hard repair attempt and let that per-record state decide whether the request can proceed.
- Read-path repair or self-healing helpers must fail open. Catch provider, refresh, and context-reload failures, log enough context to diagnose the failed repair, and return the original read context or last-known data instead of turning the read into a generic 500.
- When returning an HTTP throttle or rate-limit response and the service exposes a retry delay, include a `Retry-After` header and assert both the body metadata and header.
- For hot read or reconciliation endpoints that clients poll, keep routine success diagnostics at debug level or aggregate them outside the request path. Reserve info/warn/error logging for lifecycle transitions, partial failures, rejected scopes, and other events that need operator attention, and do not log public key material, tokens, signatures, or raw secrets.

## Architecture: Routes vs Services

**Routes are thin. Services contain the business logic.**

- **Routes** (`app/*/route.ts`): auth via `withAnyAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Services** (`app/*/service.ts`): business logic, `@repo/database` imports, `withDb()` queries, external APIs, transactions

No database operations in routes — delegate to services. No type definitions or pure helper functions in route files — extract to co-located helpers (e.g., `relay-result-helpers.ts`) or `@/lib/`.

## Service Conventions

All services follow these rules. New services MUST conform; relocated services convert as part of the move.

**Location.** Services live next to their routes: `app/<resource>/service.ts`. When a resource has multiple responsibilities, split into sibling files. The module that owns the entity's general/CRUD surface is named after the entity (`<entity>-service.ts`); responsibility-specific siblings are named after the responsibility (`<responsibility>-service.ts`).

The `app/documents/` tree is the canonical example of a multi-responsibility split:
- `document-service.ts` (general CRUD)
- `generation-service.ts` (PRD/plan generation, regeneration, change requests)
- `execution-service.ts` (plan-loop launch from local)
- `merge-service.ts` (LLM-driven document merge)
- `evaluation-service.ts` (ratings + judge feedback)
- Private helpers shared across these modules live in co-located files (`document-utils.ts`, `generation-status-helpers.ts`).

The sibling-file split above is for resources with multiple route-facing service surfaces. When a *single* service surface grows so large that its private internals need decomposition (not new sibling services), those internal modules live in a nested directory named after the composition root: `app/<resource>/service.ts` stays the only export consumed by routes, and its helpers move to `app/<resource>/service/<concern>.ts` (with deeper grouping like `service/artifact-links/` when a concern has multiple lanes). `app/agent-sessions/` is the canonical example (PLN-1305). Internal modules must not import the composition root, and no barrel files.

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
- Use the `Result` type/const (`@repo/api/src/types/result`) to report success and failure to callers.

## Response Helpers
- Success: `NextResponse.json(success(data))` — import `success` from `@repo/api/src/types/common`
- Not found: `notFoundResponse("Entity")` — from `@/lib/route-utils`
- Error: `errorResponse("message", error)` — from `@/lib/route-utils`
- Request parsing: `parseBody(request, validator)` — from `@/lib/route-utils`
- Transactions: `withDb.tx(async (tx) => { ... })`
- Shared API types live in `packages/api/src/types/` — ensures frontend/backend share definitions

Background work in API routes follows the serverless-route rule above: await response-path side effects, pass them to `waitUntil`, or persist them for later processing.

## API Contracts and Services
- Only the API side should touch `@repo/database`; product UI code must go through API routes and shared API types.
- Use shared API contract constants for response, request, service, MCP, artifact, document, link, status, error, and nested structured payload values. Do not alias generated Prisma enums into API wire contracts when a shared contract const exists.
- Keep backend-only API metadata types in `apps/api`; `packages/api` should expose transport contracts and cross-process constants, not database provenance or auth-policy internals.
- Vercel/Next builds typecheck workspace package source imported through `@repo/*`, not just emitted package output. Keep `apps/api` TypeScript config compatible with package-source imports such as explicit `.ts` relative imports used by `packages/api` helpers that also emit Node ESM for desktop.
- When route handlers, middleware, or internal routes enforce the same policy, extract a shared helper or add focused parity tests so behavior cannot drift silently.
- When adding fields to a shared API response contract used by multiple route variants, update every route variant that claims that contract and add parity coverage for the affected response fields.
- When accepting paired target identity fields such as `computeTargetId` and `gatewayId`, fail closed on partial context if the narrower field would otherwise be ignored or downgraded to an unscoped compatibility response. Add boundary coverage for absent, partial, and complete target context shapes.
- When enforcing byte or item limits for batched desktop, relay, or sync payloads, match the producer's batching and trimming granularity. If the producer trims per record and batches multiple records, validate the same per-record budget on the server or add producer-side chunking that guarantees the server's aggregate budget cannot reject otherwise valid records.
- When webhook or provider-event handlers merge partial payloads into stored state, preserve authoritative stored terminal state unless the incoming event carries the authoritative replacement or clear signal for that field. Optional identifiers such as slugs may be absent; fall back to stable provider keys such as repository plus branch/ref before deciding no update is possible.
- Webhook parsers must preserve nested provider-owned stable identifiers that may be needed for later reconciliation, even when the handler's primary lookup key is present. Use those child identifiers as scoped fallbacks before treating out-of-order projection state as unknown.
- Do not run side-effecting identity, credential, or author-materialization work in webhook action branches that do not consume the result for the mutation or emitted event. Keep branch-specific preparation inside the branch that uses it.
- Webhook duplicate/replay guards must compare against state owned by the same event stream. Do not use adjacent materialized/cache state as duplicate proof when another webhook type can update that state first; cover same-head race ordering when suppressing duplicate lifecycle events.
- When provider status aggregates or read-repair calls return `null` or unavailable data, preserve the last known stored status instead of overwriting it with an unknown/default state unless the provider explicitly reports that replacement state.
- When provider detail data is unavailable but stale detail rows may still exist, clear those rows in the same persistence path or gate the read projection so unavailable-state UI cannot render stale provider details as current.
- Do not add optional guards around required database delegates only to accommodate partial test mocks. Treat missing required delegates as test-mock gaps and update the mocks instead.
- For bounded batch persistence inside a guarded transaction, avoid sequential per-row database writes when a single bulk statement or shorter write boundary can preserve the same correctness invariants.
- Backfill, sync, and cutover-readiness helpers that process bounded database batches must either paginate until the scoped result set is exhausted or return an explicit partial/truncated outcome. Do not report destructive-cutover readiness from a capped first page alone.
- For new API query parameters that accept multiple values, prefer repeated parameters parsed as arrays, for example `targetIds=a&targetIds=b`, instead of comma-separated strings. Only use comma-separated lists for existing public contracts or explicit compatibility requirements; add tests that assert the parsed multi-value shape.
- Route handlers that translate service results into HTTP responses must preserve the service discriminant and expected status family. Do not collapse unrelated service failures into a not-found response unless the service result specifically represents a missing resource.
- When returning structured remediation metadata such as identity blockers or reconnect prompts, gate the metadata by the matching service result code. Do not attach remediation details to unrelated permission, readonly, not-found, or invalid-state denials that the remediation cannot fix.
- Branch View read-recovery contexts that use active-sibling credentials are render/read-only until the branch is relinked to a pinned active repository. Do not expose comment write capabilities, identity prompts, or mutation affordances from those contexts unless the corresponding mutation route can write through the same context.
- When a mutation service performs a read-only permission check with identity status before acquiring a provider write credential, do not repeat the same permission check after credential acquisition unless the second check uses additional authoritative state that can change the result.
- When adding or maintaining privacy/security request-header allowlists or denylists, audit hosting-platform aliases and equivalents for the same semantic data, such as Vercel forwarding headers, and assert the downstream request shape for those exact literals.
- When widening a compute-target action from owner-only to shared-target access, audit adjacent registry, credential, key-discovery, status, and event-read endpoints for the same principal set. Add owner and shared-user coverage so discovery material matches the users allowed to issue commands.
- For expected service outcomes such as conflicts, rate limits, or invalid state transitions, return `Result` from `@repo/api/src/types/result` instead of throwing custom Error classes or creating one-off discriminated result shapes. Reserve thrown errors for unexpected failures.
- Avoid `instanceof` and `in` checks for routine error/result handling when a typed result discriminant or shared error code can express the branch more clearly. Reserve thrown errors and exception-style narrowing for unexpected failures or third-party APIs that require it.

## Provider Projection Persistence
- When materializing provider-owned comment, review, webhook, or artifact projections, do not assume the provider payload arrives parent-first or in creation order. Persist stable remote ids first, then sort, second-pass backfill, or otherwise prove child/parent links survive out-of-order payloads, with focused coverage for the ordering edge case.
- Projection lookups that reuse rows by remote provider identity must scope through the owning organization and provider/source in the query, along with the artifact or parent record that owns the projection. Do not rely on remote ids, branch ids, or PR/detail ids alone to find tenant-owned projection rows.
- When merging or deduplicating GitHub comment projections across issue-comment and review-comment sources, include the provider comment kind/source namespace in the identity key. A raw GitHub comment id is not globally unique across those comment families.
- For upserts of provider-mirrored records, keep create and update branches in parity for provider-owned metadata such as edited, deleted, state, and timestamp fields. Tests for first-sync records should include metadata that differs from creation defaults, not only later update paths.
- During projection or read-path migrations, mutation paths must update whichever materialized model the live read path still uses, or switch the read path in the same change. If that compatibility bridge is intentionally deferred, treat the dependent PR as blocked instead of allowing writes to disappear until a later webhook or migration catches up.
- Exported input fields that are intentionally reserved for a later projection or identity milestone must either be consumed in the current persistence path or documented with a concise JSDoc explaining why the no-op field remains in the contract.

## Validation and Persistence
- Prefer built-in Zod validators such as `z.uuid()` over custom refinements unless the route contract explicitly requires a narrower UUID version or format.
- Prefer Zod schemas for object-shape validation and JSON boundary narrowing instead of ad hoc `Record<string, unknown>` casts or manual `typeof value === "object"` guards. Reuse or colocate schemas in validator modules when the shape is shared.
- Do not define local `isRecord` or plain-object guards in `apps/api`; import `isRecord` from `@/lib/type-guards`, or remove the guard entirely when a Zod/schema parser handles the boundary.
- Use `apps/api/lib/json-schema.ts` for JSON-compatible object/value parsing instead of defining local `z.record(z.string(), z.unknown())` schemas or hand-written JSON guards.
- Use `apps/api/lib/db-utils.ts#getPrismaErrorCode` for Prisma error-code checks instead of local casts, `in` checks, or duplicate helper functions.
- Do not add post-query guards that merely restate a Prisma `where` predicate. Put organization, ownership, type, and link filters in the query itself, and test the query shape or observable result instead of preserving unreachable defensive branches.
- During migration windows, helper types and service projections must continue to match the live database nullability and supported artifact types until the schema invariant is fully enforced. Do not narrow nullable foreign keys or update fields owned by a new artifact type when handling legacy records.
- After mutating relation-owned detail records that are returned to callers, re-read the canonical record or compose the return value from the updated detail source instead of returning stale Prisma include data captured before the write.
- When mapping Prisma P2002 unique-constraint errors to domain results, handle both `meta.target` constraint-name strings and field/column arrays that Prisma adapters may report, and add tests for each expected shape on every service path that performs the mapping.

## Query Shape and Route Gates
- For route gates that only need to prove an artifact/document exists or belongs to the caller, use a minimal select or existing simple lookup helper. Do not fetch heavy include graphs for GET preconditions unless the route actually consumes those joined records.

## Relay and Gateway Behavior
- Do not remove the `/api/gateway/*` proxy guard or reimplement gateway operations in `apps/app` or `apps/api`; gateway operations require local filesystem/process access and belong in `apps/desktop`.
- When `apps/api` creates cloud relay commands for Desktop, the command path delivered to Electron must start with `/api/gateway/`. Electron's cloud command parser rejects non-gateway paths before operation handlers run, so do not rewrite cloud command paths to legacy namespaces such as `/api/engineer/` unless the Electron parser compatibility path is changed and tested in the same work.
- When a shared dispatch or delivery helper normalizes results from multiple transports, preserve explicit not-delivered/no-subscriber outcomes in every transport branch. Do not report success just because the local publish call completed; add focused coverage for the fallback transport branch as well as the configured remote transport branch.
- For compute-target relay command tests, a normal local run without `RELAY_API_URL` exercises only the in-process relay fallback. When behavior depends on the external relay `/dispatch` shape, also run the focused test with `RELAY_API_URL` and `INTERNAL_API_SECRET` set so assertions cover the wire-envelope branch used by Vercel/stage.

## Learned Patterns
- **[insight]**: API errors return generic messages to clients, log real errors server-side. Debug 500s in API terminal (:3002), not browser DevTools.
- **[pattern]**: Artifact routes: `findById(artifactId, user.organizationId)` not `validateOwnerInOrg()` — org-scoped query handles auth.
- **[convention]**: No Cache-Control headers in API routes. Frontend: TanStack Query. Server: service layer caching.
- **[convention]**: Prisma-to-API type conversions: centralized mapping function (e.g., `toArtifact()`) that validates. No scattered `as Type`.
- **[convention]**: Webhook expected errors: catch specific error code (e.g., Prisma P2025), re-throw everything else.
- **[pattern]**: Routes must transform service Result types to API contract flat types.
- **[mistake]**: OAuth connect routes: verify service method signature before copying parameter destructuring.
- **[pattern]**: Keep long-running or bulk work out of a single interactive transaction; page large reads and use short per-record transactions for independent writes. (context: transactions|bulk-work|pagination)
- **[mistake]**: GitHub comment projections must preserve comment kind in IDs, filters, events, deletes, and backfills; raw GitHub comment IDs alone collide across issue and review comments. (context: github-comments|projection|compatibility)
- **[pattern]**: Expected Prisma conflicts and not-found cases belong in service `Result.err` branches, and route status switches must map every service status explicitly. (context: result|prisma|error-handling)
- **[mistake]**: When adding a WHERE clause or filter on a column, check `schema.prisma` for index coverage — unindexed filters cause sequential scans on growing tables. Add a migration for the index in the same PR if needed. (context: database|index|performance)
- **[mistake]**: Verify query scope matches the UI scope — org-wide queries backing user-scoped views, or unwindowed queries backing windowed views, produce incorrect results. (context: scope|query|filtering)
