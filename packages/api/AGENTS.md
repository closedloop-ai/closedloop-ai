# API Contract Package Guidelines

## Scope and Boundaries

- `packages/api` should expose transport contracts and cross-process constants, not database provenance or auth-policy internals.
- Types in `packages/api/src/types/` are shared contract types used by **both** `apps/app` and `apps/api`. Do not put types here that are only used by one side; co-locate those in the relevant app instead.
- **Cache/persistence policy is not a transport contract.** A TTL, a health-state union mirroring a database column, or a retention rule belongs with the owning implementation (e.g. `apps/api/lib/<domain>/`) even when a denial *contract* derived from it is legitimately shared. Keep the cross-surface contract here; keep the policy that produces it there.
- **A response discriminator must not live on a filter-options type.** Putting an envelope selector (`includeTotal`) on the options type makes a legacy hook that promises an array typecheck while the server returns a page envelope, so an ordinary consumer fails on `.map`. Separate filter options from the wire discriminator, or exclude the discriminator from the legacy surface.
- **Do not accept a filter the route cannot honor.** If a shared client type carries dimensions a route has not implemented, the route's query schema rejects them with validation rather than accepting and dropping them; add a route/service test for the rejected unsupported filter.
- **A cap in a shared type must be reconciled with the product invariant it bounds.** Silently stopping at a provider limit (e.g. 25 labels) while the owning product surface has no matching cap means the set never converges. Enforce the cap at the owning boundary or reconcile the full set with bounded pagination, and cover limit+1.
- This package must stay independent of `@repo/database`. All types mirror the Prisma schema shape without importing from it. This ensures the package is safe to use in both client and server contexts.
- `src/types/loop.ts` re-exports from `@closedloop-ai/loops-api` for backwards compatibility — keep the shim; new consumers import `@closedloop-ai/loops-api/<module>` directly.

## Session status vocabulary (IMPORTANT — read before touching any session status code)

Owned here since ISS-5592, in two sibling modules: `src/types/session-status.ts`
(values, folds, normalizers) and `src/types/session-status-display.ts` (labels,
the unknown/stale sentences). The split is so a bundle-sensitive `"use client"`
surface can import a label without pulling in the folds — keep copy out of the
values module. The three-value lifecycle rule itself is in the root `AGENTS.md`
("Session State") because it binds every surface.

**Pick the vocabulary by what the value is FOR, not by which one compiles.** ISS-5592 split them so the choice is a type error rather than a judgment call:

- **`SESSION_STATUS` / `SessionStatus`** — the LIFECYCLE set, `active` / `inactive` / `error`. The whole set a row may STORE. A value headed for a column is typed `SessionStatus`; a fourth member here is a value a producer can write, so there is no fourth member.
- **`DISPLAYED_SESSION_STATUS` / `DisplayedSessionStatus`** — what a RENDER or a FILTER FACET speaks: the lifecycle set (spread in, so the shared values cannot drift) plus three words no producer originates and no new code writes.
  - `waiting` — the awaiting-input sub-state, projected per read from the `session_detail.awaitingInputSince` timestamp. The signal is the timestamp; the word is only how it renders and how the Status facet asks for it. **No CLOUD write path can store it** (ISS-5981): the main ingest and the reopen arm both fold an incoming `waiting` to `active`, each preserving the anchor so the fold loses nothing. The desktop's own SQLite is a separate store and is NOT covered by that — see below. Rows written before that landed were not backfilled and can still carry it, which is why reads stay tolerant.
  - `unknown`, `stale` — derivations computed per render by `resolveDisplayedSessionStatus`. Current and load-bearing, NOT legacy: they stop an unparseable or reaper-silent run from badging "Running". Never fold them into `active` on a display surface.

`completed` and `abandoned` are RETIRED (ISS-4654) and belong to NEITHER set. **ISS-5592 removed the last of their tolerance**, which WAS a compatibility break and was taken deliberately (Chris, 2026-08-14) on two pieces of evidence: no row stores either spelling (`SELECT count(*) FROM artifacts WHERE type='SESSION' AND status IN ('completed','abandoned')` returned 0), and the total ingest fold makes the value unwritable going forward. Do not re-add them to the fold to "restore tolerance" — that decision has been made. For what the fold does with them *now*, read `normalizeSessionStatus`; this file deliberately no longer says, because saying it here is what let the two disagree (ISS-6581). ISS-5592 then removed the last aliases (`running`, `failed`), authorized separately by Chris on 2026-08-15 ("there are no records that say `running`") and on DIFFERENT evidence, because the count above does not reach them: it queries the cloud `artifacts` table, while the `running` arm lived in the desktop SQLite store on user machines, which no production query covers. What retired it there is repository history — no commit has ever written the value, and across every historical `INSERT INTO sessions` in all five files that have carried one (the retired PGlite-era module included) not one omits `status`, so the `DEFAULT 'running'` has never fired. Do not cite the artifacts count as evidence for these two.

**The desktop SQLite store reads this module directly.** ISS-5592 step 2 deleted `DESKTOP_SESSION_STATUS` — it had converged on the same three lifecycle values, so it was this value set declared twice, and every migration on the axis had to land in both. There is no longer a second declaration to keep in lockstep. What still holds is the WRITE restriction: the desktop may persist only the three lifecycle values, so `db-constants.ts` imports `SESSION_STATUS` and never `DISPLAYED_SESSION_STATUS` — a display word must never reach SQLite. A desktop row can still STORE a literal `waiting` (migration 0042 collapsed only `completed`/`abandoned`); reads of such a row go through `DISPLAYED_SESSION_STATUS.WAITING` and a raw SQL literal.

**`packages/design-system` keeps its OWN copy and is deliberately NOT in sync** (`components/ui/types.ts`). It is a separate, project-agnostic product and is gated from importing `@repo/api`; Chris decided on 2026-08-14 that the two need not agree. Desktop and web DO stay in sync — both read this module. Never resolve that duplication by importing this set into the design system.

**`AgentSessionState` (`src/types/agent-session.ts`) is a DIFFERENT axis — not this enum under another name.** It carries members the status set has no equivalent for (`PendingApproval`, `Blocked`, `InReview`, `Running`). Keep the two axes separate and never alias one to the other.

Relative imports between these two modules carry explicit `.ts` extensions — see "Relative Imports in Emitted Helpers" below. The reason is the package BUILD (`tsc -p tsconfig.build.json`, guarded by `scripts/smoke-dist-imports.mjs`), which rewrites them to `.js` so `dist` is loadable; it is NOT the desktop runtime, which inlines this package from source via the `resolve.alias` in `apps/desktop/electron.vite.config.ts`. The same extension rule binds any Node-ESM consumer that loads a `@repo/api/src/...` path literally rather than through a bundler — `apps/desktop/test/e2e` Playwright specs are the ones that bite, since this package has no `exports` map to supply the extension for them.

Why the vocabulary is shaped this way, which tickets moved it, and the open defects on it (ISS-5592): `docs/session-status-vocabulary.md`.

## Const-Object Enums

Treat nested structured payload values such as `error.result.subcode` as contract values too. When they cross apps, packages, repos, or processes, define them in this package and import the const members everywhere, including fixtures and assertions.

## Zod Validators

When a Zod schema validates an exported API contract type and multiple packages consume that contract, export the schema from the same `packages/api` type module as the type instead of duplicating equivalent schemas in consumers.

## Result Type

Keep `Result` from `@repo/api/src/types/result` as the shared shape for expected service outcomes such as conflicts, rate limits, or invalid state transitions.

## Relative Imports in Emitted Helpers

Some `packages/api/src` helpers are consumed in two modes: Vercel/Turbopack bundles the TypeScript source through `apps/api`, while desktop loads the emitted ESM from `packages/api/dist`. For relative imports from one source file to another, use explicit `.ts` source extensions and rely on `rewriteRelativeImportExtensions` to emit `.js` paths. Do not point source imports at sibling `.js` files that only exist after build, because the Vercel source bundle cannot resolve them; do not use extensionless relative imports for emitted runtime helpers, because Node ESM will not load them from `dist`.

## Helper Functions

Utility functions that operate on shared types belong here (e.g., `getRoutePrefixForType`, `resolveProjectRepoDefaults`, `isDocumentArtifact`, `isActiveGenerationStatus`). These must be pure — no I/O, no `@repo/database` calls.

Session Trace derivation helpers that collapse repeated source records must preserve cumulative user-visible fields. For repeated phase keys, aggregate duration across every iteration and cover loopback/repeated-key cases in behavior tests instead of letting the last source row overwrite prior iterations.

## Notable Modules

- **Deterministic JSON serialization**: `stableStringify` no longer lives here — it moved to `@closedloop-ai/loops-api/stable-stringify` so the desktop main process can import it at runtime (it cannot load `@repo/api` JS). Import it from there when order-stable output is required for hashing/comparison.
- **`constants.ts`**: Package-level numeric constants (judge thresholds, radar metrics). Add new cross-cutting numeric constants here rather than inline in consuming files.
- **`desktop-api-namespace.ts`**: Path recognition utilities for the current `/api/gateway/` namespace. The stale `/api/engineer/` namespace is intentionally unsupported; do not add fallback rewrites or probes for it.

## Forward Compatibility

Exported contract values that are intentionally reserved for future producers or consumers must include concise JSDoc explaining the forward-compatibility intent; otherwise remove unused values until they are consumed.

When replacing or bundling GitHub REST pull-request data with GraphQL data, preserve REST-compatible identities and lifecycle coverage expected by downstream API contracts. In particular, map GraphQL `databaseId` to persisted/validated PR `githubId` fields that are compared with REST `pull_request.id`, and include `MERGED` when a shared query feeds callers that filter for merged pull requests.

## Domain Glossary

Team, Project, Loop, Workflow, Document, Artifact, Engineer Feature, Desktop Gateway, Relay, MCP — see `docs/domain-glossary.md`.
