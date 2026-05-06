# Repository Guidelines

## Project Structure & Module Organization
`apps/` contains deployable surfaces: `app` (product UI, port 3000), `api` (BFF/server, 3002), `web` (marketing, 3001), plus `docs`, `email`, `storybook`, `mcp`, `relay`, and `studio`. Shared code lives in `packages/*` and is imported as `@repo/<name>`; database schema and migrations live in `packages/database`. Repo documentation is in `docs/`, and CI/workflow automation is in `.github/`. `apps/api` is deployed on Vercel serverless functions, so route code must not rely on process-local memory, singleton state, or long-lived in-process caches for correctness. Keep data flow layered: `apps/app` should call `apps/api`, and only the API should touch `@repo/database`.

## Cross-Repo Compatibility Requirements
Changes in this repo must not assume another repo (for example `closedloop-electron`) is upgraded at the same time.

- Treat all cross-repo contracts (desktop gateway payloads, relay events, error reasons, callback semantics) as version-skewed.
- New fields must be additive and optional; missing/unknown values must degrade gracefully to safe defaults.
- For optional cross-repo payload fields, preserve omission when a value is absent. Do not serialize absent optional fields as `null` unless the receiving contract explicitly declares that field nullable and old clients are known to accept it.
- When external payload fields are renamed, keep the previous field accepted as a compatibility alias until a human explicitly approves removing the shim, as long as the server can map it to the new behavior safely.
- Never crash, throw unhandled errors, or block core flows solely because a peer repo is on an older/newer version.
- For behavior/classification changes, include a backward-compatible fallback path (for example, map unknown reasons to generic `launch_failed`).
- Update tests to cover both:
  - new/expected contract shape
  - old or unknown contract shape (graceful fallback)

## Build, Test, and Development Commands
Use Node 20+ with `pnpm`.

- `pnpm install` installs workspace dependencies and generates the Prisma client.
- `docker compose up -d` starts local PostgreSQL; `just db-start` is the lightweight alternative.
- `pnpm dev` runs the Turborepo dev graph; `just dev` starts the main local stack (`app`, `api`, `mcp`).
- `pnpm turbo dev --filter=app --filter=api` focuses on the primary product surfaces.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` run workspace-wide checks.
- `pnpm migrate` or `just db-migrate name=my_change` creates/applies Prisma migrations.
- For Prisma schema changes, generate migrations with `prisma migrate dev` or `prisma migrate dev --create-only`; only hand-edit the generated SQL for constructs Prisma cannot express, such as partial unique indexes.
- For pre-commit validation, prefer `just build` plus `git diff --check` when the change is ready for final verification. Do not also run separate workspace/app test, typecheck, or lint commands unless you are isolating a specific failure, need a faster focused loop while debugging, or the user explicitly requests those commands.

## Dockerized Workspace Apps
Some apps, including `apps/mcp` and `apps/relay`, build from narrow Docker contexts instead of the full monorepo. When adding or changing any `@repo/*` import or `workspace:*` dependency in a Dockerized app, update that app's Dockerfile in the same change.

- Copy every required workspace package into the builder stage before `pnpm install`, including transitive workspace dependencies needed by that package.
- Copy package manifests for those workspace packages into the runtime stage before `pnpm install --prod`.
- If runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copy the needed `src/` or built `dist/` output into the runtime image so module resolution works after deploy.
- Validate both the builder target and full image for the changed app, for example `docker buildx build --file apps/relay/Dockerfile --target builder .` and `docker buildx build --file apps/relay/Dockerfile .`. A local `pnpm build` or `pnpm typecheck` is not enough for these Dockerized apps because it does not prove the container has the same workspace package files.

## Coding Style & Naming Conventions
TypeScript and ESM are standard across the repo. Formatting and linting are enforced by Biome with Ultracite presets; run `pnpm lint:fix` before opening a PR. Follow the existing 2-space indentation, prefer `type` aliases when practical, and keep `@repo/*` imports ahead of local alias imports. File names are typically kebab-case (`pull-request-status-badge.tsx`), while exported React components and types use PascalCase. In `apps/api`, keep route handlers thin and move business logic into nearby `service.ts` modules.

For API routes with fixed request/response/error contracts, wrap auth/session and other precondition helpers that can throw so the route still returns the declared contract shape instead of leaking a generic 500.
- Do not import `@repo/database` in `apps/app`; frontend code must go through `apps/api` routes and shared API types.
- Prefer generated Prisma enums from `@repo/database` over duplicated string literals when a model field already has an enum type.
- Use shared constants, generated enums, or exported enum-like objects for statuses, reasons, protocol modes, channel names, storage keys, and other contract values. Do not duplicate hardcoded strings when a constant or enum exists.
- For status/state values shared between hooks, components, tests, or transport code, export a const object plus matching type alias and compare against the const members instead of repeating string literals or bare string unions.
- Biome forbids TypeScript `enum`. In `packages/api/src/types`, define exported API contract value sets as PascalCase const objects with matching type aliases, such as `export const Foo = { Bar: "bar" } as const; export type Foo = (typeof Foo)[keyof typeof Foo];`. Use the runtime const reference everywhere instead of duplicating strings.
- When multiple desktop route files share the same wire-contract types, define those types in `apps/api/app/desktop/contract.ts` instead of duplicating route-local copies.
- Keep backend-only API metadata types in `apps/api`; `packages/api` should expose transport contracts and cross-process constants, not database provenance or auth-policy internals.
- Keep PostHog/analytics runtime selection and feature-flag client compatibility inside `@repo/analytics`; app, auth, route, and service modules should consume analytics package APIs instead of switching between analytics runtimes directly.
- For wire contracts crossing apps, packages, repos, or processes, define header names, reason strings, modes, and response-shape constants in one shared module and import them instead of duplicating literals.
- When the same helper logic, object shape, or protocol type appears in multiple files, extract it into the nearest shared module owned by that surface instead of committing parallel copies.
- When route handlers, middleware, or internal routes enforce the same policy, extract a shared helper or add focused parity tests so their behavior cannot drift silently.
- Keep route handlers thin: parse/auth at the boundary is fine, but multi-step business workflows, persistence orchestration, and cross-service validation should live in service/helper modules that the route delegates to.
- For expected service outcomes such as conflicts, rate limits, or invalid state transitions, return `Result` from `@repo/api/src/types/result` instead of throwing custom Error classes or creating one-off discriminated result shapes. Reserve thrown errors for unexpected failures.
- Avoid `instanceof` and `in` checks for routine error/result handling when a typed result discriminant or shared error code can express the branch more clearly. Reserve thrown errors and exception-style narrowing for unexpected failures or third-party APIs that require it.
- Avoid unnecessary TypeScript casts. Prefer importing concrete shared types, narrowing with type guards, or shaping helper return types so call sites do not need `as` to satisfy the compiler.
- Prefer built-in Zod validators such as `z.uuid()` over custom refinements unless the route contract explicitly requires a narrower UUID version or format.
- Prefer Zod schemas for object-shape validation and JSON boundary narrowing instead of ad hoc `Record<string, unknown>` casts or manual `typeof value === "object"` guards. Reuse or colocate schemas in validator modules when the shape is shared.
- Use `apps/api/lib/json-schema.ts` for JSON-compatible object/value parsing instead of defining local `z.record(z.string(), z.unknown())` schemas or hand-written JSON guards.
- Use `apps/api/lib/db-utils.ts#getPrismaErrorCode` for Prisma error-code checks instead of local casts, `in` checks, or duplicate helper functions.
- In `apps/api` serverless routes, do not fire-and-forget promises for response-path side effects. Await the work, pass the promise to `waitUntil`, or persist it for later processing.
- For TTL-backed state machines, check expiry at every non-terminal branch that can remain in progress, including after claim/consume transitions. A consumed, claimed, or in-progress record must not remain pollable forever after its TTL unless readiness has already been proven.
- Define regex literals as module-level constants instead of inline inside functions or tests so Ultracite's `useTopLevelRegex` rule stays satisfied.
- For generated shell commands or installer scripts, do not execute unchecked network downloads through command substitution. Download to a temporary file or otherwise make the download a checked step before executing the result, and preserve the nonzero exit status on network failure.
- When form/input values are trimmed, parsed, normalized, or otherwise transformed before command generation or mutation submission, run validation against the exact transformed value that will be submitted. Add a test for harmless trim-only input and a test where invalid content remains after transformation.
- React hooks, components, and utilities that schedule timers must clear superseded timers and clean them up on unmount or disposal.
- Tests that mutate `process.env` must restore the exact previous state. If a variable was originally unset, remove the property, for example with `Reflect.deleteProperty(process.env, "KEY")`; assigning `undefined` creates the string value `"undefined"` in Node.
- Tests that mutate browser globals or readonly-ish global properties such as `navigator.platform` must restore the original property descriptor in `afterEach`, or use test helpers that automatically unstub globals.
- Installer-script tests that assert a prerequisite is missing, installed, or added to `PATH` must stub that prerequisite in the test `PATH`. Do not let the test fall through to host tools such as `/usr/bin/python3` when the assertion depends on the tool being absent or unusable.
- Test helpers that wrap `child_process.spawn` must handle the child's `error` event so spawn failures resolve or reject with a clear test failure instead of hanging.
- Timing-sensitive integration tests must pass an explicit test timeout and make fallback behavior deterministic; do not rely on the test runner's default timeout to catch hangs.
- In Playwright tests, keep route handlers side-effect-only when practical: capture request details, fulfill or continue the route, then assert from the test body after an awaited UI or network state proves the handler ran.
- Avoid fixed sleeps to prove that something did not happen. Prefer asserting a stable blocking state, captured call count, or a bounded event/response wait with an explicit timeout.
- Tests for ignored, optional, or compatibility-only request fields must assert the downstream call shape, not only that the downstream dependency was called.
- Tests for feature-gated defaults must set mocks so the opposite/default branch would fail the assertion; avoid tests that pass only because the feature gate is disabled or unavailable.
- When rendering nullable values behind a boolean flag, guard the actual render branch with the nullable values too, or encode the props as a discriminated union so the compiler enforces the required values.
- In `apps/app`, use TanStack Query hooks for server state and server mutations instead of component-level `useEffect` plus raw `fetch`, unless the fetch is not cacheable server state and the exception is documented.
- For `apps/app` client-only state that must survive component remounts, route transitions, or browser back/forward within the same tab, create a small dedicated store module using the existing `useSyncExternalStore` pattern (see `apps/app/lib/engineer/routing-store.ts` and `apps/app/lib/engineer/electron-detection.ts`). Do not hide this state in component module-local `Set`/`Map`/`let` values, ad hoc `window` globals, or a new state library unless the user explicitly asks for that migration. Keep persistence explicit: no storage for refresh/new-tab reset semantics, `localStorage` only when cross-refresh persistence is intended.
- For `apps/app` command gates, conflict replays, confirmation callbacks, and retry paths, route replayed commands through the same gate or policy as the initial command unless the exception is explicitly documented and tested. Preserve sentinel semantics such as omitted/`undefined` versus explicit `null`; tests must assert the downstream call shape for both.
- For owner-keyed pending state in `apps/app` hooks/components, do not use a global pending/checking flag to disable or label unrelated surfaces. Compare the pending owner, command, document id, target id, or attempt id to the current surface and add a regression test for an unrelated pending owner.
- Before adding mount-time data fetching in `apps/app`, especially on editor or project pages, confirm the data is required for the initial render. Prefer deferring optional or rarely used backend reads until the user action, visible panel, route state, or workflow step that actually needs the data, so page mount does not accumulate many small requests.
- When an `apps/app` TanStack query key or request parameter depends on another async query, gate the dependent query with `enabled` until the prerequisite query has settled or explicitly document why an initial placeholder-value fetch is intentional. Do not let a cold prerequisite cache cause one request with `null`/placeholder params and a second request with the resolved value.
- In `apps/app` query hooks, use `useApiClient` for authenticated API requests instead of manually calling `fetch`, `getToken`, and `resolveApiUrl`. If a route intentionally does not use the standard `ApiResult` envelope, use `getRaw`/`postRaw` on `useApiClient` so auth, API-origin behavior, JSON parsing, and raw error fallback stay centralized.
- Polling query hooks must stop polling on every terminal status for the workflow, including failure or expiry states, not only the success state. Derive the terminal-status set from the service state machine or contract; do not stop polling on transient statuses such as claimed/processing states that can still advance. Polling hooks must also stop or deliberately back off when `query.state.status === "error"` so missing resources or server errors do not create infinite retry loops.
- Fetch helpers that read structured error bodies must tolerate non-JSON responses with `response.json().catch(() => null)` before branching on `response.ok`.
- Do not add local `.catch()` error toasts around `mutateAsync`; the global `QueryClient` mutation error handler owns default error toasts. Catch only to suppress unhandled rejections or update local state.
- Use `globalThis` instead of `window` when reading browser globals in shared/client code, and keep SSR guards explicit.
- Do not initialize render-affecting React state from browser-only globals such as `navigator`, `location`, `localStorage`, or `matchMedia` during server-rendered component render. Use an SSR-stable default and apply client-derived values after mount, or gate the surface until mounted.
- Use `next/link` `<Link href="...">` for in-app navigation instead of button `onClick` handlers that call `router.push`, so browser navigation affordances keep working.
- Never use inline imports. Imports belong at the top of the file; use direct subpath imports instead of adding barrel re-exports.
- Do not remove the `/api/gateway/*` proxy guard or reimplement gateway operations in `apps/app` or `apps/api`; gateway operations require local filesystem/process access and belong in `closedloop-electron`.
- Tests for expiry, freshness, timeout, or clock-boundary behavior must pin time with fake timers and `setSystemTime` instead of relying on the real wall clock.
- When mapping Prisma P2002 unique-constraint errors to domain results, handle both `meta.target` constraint-name strings and field/column arrays that Prisma adapters may report, and add tests for each expected shape on every service path that performs the mapping.
- For Prisma schema changes, add indexes only for a concrete current access path: query filters, sort order, uniqueness, rate limiting, cleanup, or ownership checks. Do not add indexes for write-only metadata or speculative future queries; prefer composite indexes that match the full predicate when the current code filters on multiple columns.
- When adding a unique index or constraint to an existing table, the migration must handle or explicitly preflight existing rows that already violate the new invariant before creating the constraint. Do not assume old app-level validation made invalid persisted states impossible, especially when the new constraint closes a race. If cleanup changes persisted identity fields, also account for adjacent unique constraints and the first normal write path that will reconcile the cleaned rows.
- Prisma migrations should be generated from `schema.prisma` with Prisma tooling (`prisma migrate dev`, or `prisma migrate diff` when regenerating an existing branch migration from a known baseline). Do not hand-write migration SQL unless the Prisma CLI cannot express the required operation; if manual SQL is required, document why in the migration or PR.

## GitHub Review Replies
When replying to existing GitHub PR review comments, use the review-comment REST reply endpoint (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies`) with the original review comment database ID. Do not use GraphQL `addPullRequestReviewThreadReply` unless you have verified in the GitHub UI or REST response model that it renders as a normal inline reply. After posting, verify the new comment has `in_reply_to_id` set to the original comment ID.

## Compatibility Guardrail
Compatibility shims and backward-compatibility code paths (for example legacy namespace adapters, re-export shims, or migration fallbacks) must not be removed without explicit human approval in the current task. If there is no explicit approval, preserve the compatibility layer and raise the cleanup as a separate follow-up.

## Testing Guidelines
Vitest is the default test runner across `apps/api`, `apps/app`, `apps/mcp`, `apps/relay`, and several packages. Name tests `*.test.ts` or `*.test.tsx`; place them beside the source or under `__tests__/`. No global coverage percentage is enforced, but new services, parsers, and utilities are expected to ship with focused tests. Use `pnpm test` before pushing, or a package-local command such as `pnpm -C apps/api test` while iterating.

## Commit & Pull Request Guidelines
Recent commits use ticket-prefixed, imperative subjects such as `FEAT-55: Add client-side auth bridge`. The repository’s `.gitmessage` template expects a short subject, bullet summary, and explicit `Testing:` and `Risks:` sections. Prefer branch names like `feat/*`, `fix/*`, `docs/*`, and `refactor/*`. PRs should follow `.github/pull_request_template.md`: summarize the change, link the related issue, confirm self-review and local test coverage, and attach screenshots for UI changes. Avoid force-pushing after review starts.
