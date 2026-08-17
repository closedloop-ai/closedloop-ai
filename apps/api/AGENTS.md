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

`app/documents/` is the canonical example of a multi-responsibility split; private helpers shared across those modules live in co-located files (`document-utils.ts`, `generation-status-helpers.ts`).

The sibling-file split above is for resources with multiple route-facing service surfaces. When a *single* service surface grows so large that its private internals need decomposition (not new sibling services), those internal modules live in a nested directory named after the composition root: `app/<resource>/service.ts` stays the only export consumed by routes, and its helpers move to `app/<resource>/service/<concern>.ts` (with deeper grouping like `service/artifact-links/` when a concern has multiple lanes). `app/agent-sessions/` is the canonical example (PLN-1305). Internal modules must not import the composition root, and no barrel files.

**Never use `crud-service.ts`** — name the file after the entity instead. Do not place services under `apps/api/lib/services/` (that location has been phased out).

**Named export.** Each service file exports a single named object, e.g. `export const artifactService = { ... }` or `export const documentGenerationService = { ... }`. No default exports, no facades that re-export across modules, no barrel `index.ts` files. Callers import the specific service object they need. When a sibling service needs a helper, export it as a named function from the appropriate service file (e.g. `getCommitterInfo` from `document-service.ts`) — sibling-to-sibling imports are fine; cross-module facades that aggregate everything under one umbrella name are not.

**Errors as values.** Service methods do not throw to communicate errors. Fallible writes return `Result<T>` (`@repo/api/src/types/result`). Reads that may return "not found" use a nullable return (`Promise<T | null>`). Routes translate `Status.NotFound` → 404, `Status.BadRequest` → 400, `Status.Forbidden` → 403, etc. via `route-utils` helpers. Do not throw, and avoid `try/catch`, except around a third-party API that can throw; internal invariants ("argument must be non-empty", programming errors) may still throw — but anything a route would map to a non-500 HTTP status is a `Result.err`, not a throw.

**Org scoping.** Every read and write that touches per-tenant data takes `organizationId` as a parameter and includes it in the Prisma `where` clause. No "trust the caller" patterns.

**Transactions.** Just call `withDb(fn)` for reads or `withDb.tx(fn)` for atomic writes — do not thread a `tx?: TransactionClient` parameter through service signatures. Both helpers check `AsyncLocalStorage` first: if the caller is already inside a `withDb.tx`, the inner call participates in that outer transaction automatically. If not, `withDb.tx` opens a new transaction, and `withDb` simply hands you the pooled client — it does **not** hold a connection of its own; each query inside it independently borrows one from the pool (see **Bounded fan-out** below). This means a service method can be called standalone or from inside a webhook handler's `withDb.tx` without changing its signature. The `tx?` parameter pattern from earlier services is vestigial and should not be propagated to new code.

**Bounded fan-out.** Never issue an unbounded number of concurrent DB calls over a variable-length array. Because `withDb` holds no connection, `Promise.all(items.map((i) => db.thing.upsert(i)))` demands **one pooled pg connection per item**. The pool is `max: 20` per instance on the IAM/Vercel path (`packages/database/index.ts`) and pg's default of 10 on the `DATABASE_URL` path, so a single request over a large array starves every other route until it times out. In order of preference:

1. **Collapse it into one query.** `WHERE id IN (...)` for a batch read, `updateMany` or `UPDATE … FROM (VALUES …)` for a batch write, `DISTINCT ON` to pick the latest row per key (`app/judges-analytics/service.ts`, `app/catalog/service.ts`). One query beats N bounded queries. Watch the inverse trap: a `findMany` that pulls every row to reduce in memory can ship far more data than it saves in connections — check the column widths (`@db.Text`?) before batching.
2. **When per-row logic genuinely differs, use `mapWithDbConcurrency`** (`lib/db-fanout.ts`). Wrap the **whole** element body. The pooled work is often several frames down inside a helper, or sits behind an HTTP call in the same task; a limiter around only the visible query misses it. `app/webhooks/github/handlers/installation-repositories-handler.ts` is the worked example — its `.map` body contains no `db.` call at all.
3. **Bounds compose by addition, not by maximum.** Two concurrent fan-outs that each build their own limiter peak at 2×. When sibling fan-outs run concurrently within one request, build one limiter with `createDbFanoutLimiter()` and pass it to both (`lib/loops/loop-context-pack.ts`).

**A payload cap is not a resource cap.** `z.array().max(n)` bounds the request, not the pool: any `n` above the pool size bounds nothing. `app/documents/[id]/context-attachments/gdrive/route.ts` caps at 100 and is safe only because of its limiter. A few sites still call `pLimit` directly with their own local constant (`lib/pr-read-repair.ts`, `lib/loops/ingest-repo-execution-results.ts`) — correct, but vestigial: migrate one when you touch it, and do not copy the shape into new code.

**Inside a transaction the calculus inverts.** `withDb.tx` pins one connection and every `tx.*` call (and any nested `withDb`) queues on it, so a fan-out there costs **1** connection regardless of width — pool-safe. But it serializes that work inside Prisma's default **5s** interactive-transaction timeout, risking a P2028 rollback of everything. Bounded fan-out is for pooled work; inside a transaction, prefer a set-based statement and keep the transaction narrow.

Regression tests assert peak in-flight concurrency — see `app/desktop/components/sync/service.test.ts` and `lib/db-fanout.test.ts`. **The test payload must exceed the bound**, or the assertion passes against an unbounded fan-out too.

## Test-Support Placement

Harnesses, mocks, fixtures, and doubles follow ONE rule: **test support lives under `__tests__/`, never beside the source it supports.** Tests themselves may co-locate (most already do); their *support* may not.

1. **Module-scoped support** mirrors its module path under `__tests__/support/`. `app/agent-sessions/service.test-harness.ts` became `__tests__/support/agent-sessions/service.test-harness.ts`; `app/branches/branch-read-service.test-helpers.ts` became `__tests__/support/branches/branch-read-service.test-helpers.ts`. Mirroring keeps the module association legible without putting the file in the source tree.
2. **App-wide infrastructure** stays flat in `__tests__/utils/`. The bar is consumption by tests of **3+ distinct modules**, or being wired globally into `vitest.config.mts` (as `__tests__/utils/server-only-mock.ts` is, via the `server-only` alias). `db-helpers.ts` (15 modules) and `auth-helpers.ts` (10) clear it outright; a helper serving one module belongs in `support/`, not here.

Consumers import support through the `@/` alias (`@/__tests__/support/agent-sessions/service.test-harness`), not a relative path. The alias is depth-independent, so moving a test between directories never rewrites its support imports — and it keeps `vi.mock` factory bodies, which reference support via `await import(...)`, working unchanged.

**Why `__tests__/` and not co-location.** `__tests__/**` and `*.test.ts` are already excluded from coverage by `scripts/coverage/aggregate-lib.mjs` (`TEST_DIR_PATTERN` and `TEST_FILE_PATTERN`, applied as `isSourceFile`), with no per-file naming discipline to remember and no change to the shared aggregator. Support co-located in `app/**` is *in* the denominator until something excludes it by name, so that rule fails open: a support file named without the expected infix silently counts as shipped code.

Keep the `.test-<kind>.ts` suffix (`.test-harness`, `.test-mocks`, `.test-fixtures`, `.test-helpers`, `.test-db`). It no longer carries the exclusion — the directory does — but it still marks the file as scaffolding at a glance and keeps `git grep` for support files honest.

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
- Permanently disabled legacy API routes should return HTTP 410, preferably through `goneResponse`, so clients receive a non-retryable deprecation signal. Reserve HTTP 501 for capabilities that the server genuinely has not implemented yet and may later support at the same route contract.

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
- **Bound every predicate, not just the one you chunked.** PostgreSQL's bind-parameter limit is 65,535; chunking an `INSERT` while `in`/`notIn` still receives the full ID set rolls the transaction back on large tenants. Where the upstream fetch has no cap, use a bounded array/set representation for those predicates too, and cover the path above the limit.
- **Do not materialize a platform-wide workload to emit a bounded top-N.** A `groupBy` over every org, a full-ID `IN`, then an in-memory copy-sort-slice is unbounded DB and memory work regardless of the emission cap. Page/batch the IDs and keep exact counters plus a bounded top-N, or do the aggregation and top-N in bounded SQL, with a large-cardinality regression.
- **A page and its total read in two statements are not one snapshot.** A mutation between them returns 50 items with `total: 49`, or `hasMore: false` when another matching row existed — an internally contradictory envelope. Read page and count from one consistent snapshot/query and cover mutation between the reads.
- **Optional enrichment must not sit on a fatal path.** A timeout in a best-effort analytics scan must not reject a list read that already succeeded. Keep enrichment in its own failure domain: return the rows and omit the field or mark analytics unavailable.
- When consuming a paginated upstream that returns `hasMore`/`nextCursor`, either expose that metadata in your own contract or follow the pages internally — never collapse it into an array that silently truncates at the server default.
- API query schemas must only accept filters that are implemented by the route's downstream predicates or service. If a shared client type contains dimensions a route cannot honor yet, reject those query params with validation instead of accepting and dropping them; add a route or service test for the rejected unsupported filter.

## Concurrency and Freshness
- Prefer atomic upsert / `ON CONFLICT` over findFirst-then-create-or-update. Where a seed or cutover must be idempotent, reacquire the same advisory lock in a fresh transaction before re-checking, and cover the real old-writer/new-writer race — a mocked transaction with a no-op lock proves nothing.
- **Last-write-wins is not freshness-safe.** When a resolver captures `checkedAt` before probing, a slower older probe can overwrite a newer verdict, including via the P2002 fallback path; process-local single-flight does not protect separate serverless instances. Make the write conditional on `stored.checkedAt <= incoming.checkedAt` and cover the older-writer-after-newer-writer case.
- Merge rate-limit/quota observations only for the equal current window; ignore older observations rather than letting a late response rewind an already-reset window.
- In Prisma interactive transactions, never catch a failed write and keep issuing queries in the same transaction. Do best-effort cleanup outside it, or retry after rollback in a fresh transaction.

## Emission and Abuse Control
- A metric or alert emitted per denied lookup, per row, or per request is an amplification vector when an authenticated caller can drive the path. Bound emission per org/reason at the choke point (or require every caller to apply abuse control first) and keep a bounded suppressed count if volume still matters.
- Structured error `details` payloads keep field names aligned with cardinality: plural names for arrays, or convert to a scalar before storing under a singular name. Test the emitted shape when it crosses an API/app/package boundary.

## Relay and Gateway Behavior
- Do not remove the `/api/gateway/*` proxy guard or reimplement gateway operations in `apps/app` or `apps/api`; gateway operations require local filesystem/process access and belong in `apps/desktop`.
- When `apps/api` creates cloud relay commands for Desktop, the command path delivered to Electron must start with `/api/gateway/`. Electron's cloud command parser rejects non-gateway paths before operation handlers run, so do not rewrite cloud command paths to legacy namespaces such as `/api/engineer/` unless the Electron parser compatibility path is changed and tested in the same work.
- For compute-target relay command tests, a normal local run without `RELAY_API_URL` exercises only the in-process relay fallback. When behavior depends on the external relay `/dispatch` shape, also run the focused test with `RELAY_API_URL` and `INTERNAL_API_SECRET` set so assertions cover the wire-envelope branch used by Vercel/stage.

## Learned Patterns
- **[insight]**: API errors return generic messages to clients, log real errors server-side. Debug 500s in API terminal (:3002), not browser DevTools.
- **[pattern]**: Artifact routes: the org-scoped query IS the auth check — `findById(artifactId, user.organizationId)`, not a separate ownership assertion.
- **[convention]**: No Cache-Control headers in API routes. Frontend: TanStack Query. Server: service layer caching.
- **[convention]**: Prisma-to-API type conversions: centralized mapping function (e.g., `toArtifact()`) that validates. No scattered `as Type`.
- **[convention]**: Webhook expected errors: catch specific error code (e.g., Prisma P2025), re-throw everything else.
- **[mistake]**: OAuth connect routes: verify service method signature before copying parameter destructuring.
- **[mistake]**: When adding a WHERE clause or filter on a column, check `schema.prisma` for index coverage — unindexed filters cause sequential scans on growing tables. Add a migration for the index in the same PR if needed. (context: database|index|performance)
- **[mistake]**: Verify query scope matches the UI scope — org-wide queries backing user-scoped views, or unwindowed queries backing windowed views, produce incorrect results. (context: scope|query|filtering)
