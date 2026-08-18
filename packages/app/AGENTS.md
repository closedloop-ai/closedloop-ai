# @repo/app Package Guidelines

This package contains surface-agnostic application code shared by the Next.js web
shell (`apps/app`) and the desktop renderer. FEA-1510 / PLN-810. See
`README.md` for the human-facing overview and the full list of files that stay
in `apps/app`. Web and desktop shells inject platform-specific ports for auth, navigation,
feature flags, API access, and query behavior.

End-user-perceivable UI changes must ship behind a flag, default off — see root AGENTS.md + the `ui-feature-flag-attestation` gate. Because this package renders on both web and desktop, gate the change on both surfaces (PostHog on web, a Labs toggle on desktop) when it ships to both.

## Hard Import Rules (CI-enforced)

Do not import any of the following in `packages/app/**`. Use the injected port instead:

| Forbidden | Use instead |
|-----------|-------------|
| `next/*` (link, navigation, image, headers, server, font, cache, …) | `@repo/navigation` for Link and hooks; keep image/fonts/server APIs in `apps/app` |
| `@clerk/*`, `@repo/auth/*` | `shared/auth` — `useAuthSnapshot()` via the injected auth adapter |
| `server-only` | nothing — this code runs in browser/renderer only |
| `@repo/database` (incl. `/generated`) | data access goes through `apps/api` via `shared/api` `useApiClient()` |
| `@repo/analytics` (incl. `/client`) | `shared/feature-flags` — `useFeatureFlagEnabled()` via the injected adapter |
| `@/*` (an app's path alias) | a sibling slice (`@repo/app/<feature>/…`) or `shared/` |

If you reach for one of these, the module likely belongs in `apps/app`, not here.

## Dependency Direction

- `apps/app` → `@repo/app` only. `@repo/app` must never import from `apps/app`.
- Feature slices may import `shared/*` and other feature slices when intentional and explicit — add a comment naming why at the import site, and depend on the narrowest stable surface.
- `shared/*` must never import a feature slice. When a shared default needs domain behavior, inject it via a callback or override, do not import the slice into `shared/`.

## File Organization

- **Feature-sliced layout:** `packages/app/<feature>/{components,hooks,lib}`. New code goes in the owning feature slice.
- **Domain-specific shared UI lives here, not in the design system.** `@repo/design-system` accepts only generic, project-agnostic primitives (`GridTable`, `Chip`, `TableFilterMenu`, …). A component that knows about Closedloop domain concepts (branches, sessions, documents, …) goes in its feature slice here and composes those primitives — e.g. `branches/components/branches-table.tsx` wraps the generic `GridTable`. Both the web shell and the desktop renderer consume this package, so a component does not need to move to the design system to be shared across surfaces.
- **`shared/` for cross-feature code only:** `api`, `auth`, `feature-flags`, `query`, `lib` (pure utils), `hooks`, `components`, `storybook`, `observability`.
- **No barrel files** (Biome `noBarrelFile`). Consumers use subpath imports: `@repo/app/shared/lib/format-utils`, `@repo/app/tags/hooks/use-tags`. Do not create `index.ts` re-export hubs.
- New functions, types, and constants go at the bottom of the file.

## Client vs Server

All modules in this package run in client/renderer contexts. Components, hooks, and providers need `"use client"`. Pure utilities in `shared/lib/*` do not. Do not add debug logging (`log.info`/`log.warn`/`log.error` or `console.*`) in any module here — it bundles to the browser. Product telemetry stays in `apps/app`; package code consumes injected feature-flag, auth, navigation, API, and query ports.

When moving web-owned form, link, or input chrome into shared package components, preserve native browser semantics through adapter-owned props instead of baking route logic into the shared component. For forms, keep progressive-enhancement attributes such as `action`, `method`, and input `name` available to the web adapter and cover the rendered native attributes in tests.

When an entity-detail component owns local UI state such as draft comments, selected anchors, or transient highlights, scope that state to the stable entity identity (`session.id`, `branch.id`, or equivalent trace identity). Reset or key the state when that identity changes, and cover same-component navigation in tests so stale anchors cannot carry across entities.

## TanStack Query

The shared `QueryClient` factory in `shared/query/query-client.ts` owns the default `mutations.onError` toast for both the web shell and the desktop renderer.

- Do not add local `.catch()` error toasts around `mutateAsync`; the shared `QueryClient` (`shared/query/query-client.ts`) has a default `mutations.onError` handler that owns default error toasts, and honors the `suppressDefaultErrorToast` mutation-meta flag. Catch only to suppress unhandled rejections or reset local state.
- Avoid reflexive on-mount data fetching. A single `useQuery` is cheap, but the shells mount many portable hooks and components at once — editor and project surfaces can balloon to 10-20 parallel requests on first paint. Before adding a query that runs on mount, confirm the data is required for the initial render; if it is only needed when the user opens a panel/tab/menu/dialog, gate it (`enabled: isOpen`, fetch in an event handler, or lazy-load the component). Reserve on-mount fetches for data the surface cannot render without.

## Loading ≠ unavailable ≠ not-applicable ≠ real zero

Applies to every feature slice here — spend, duration, and counts are frequently *not computed* rather than zero. Conflating the four makes the UI lie.

- An unavailable series must never render as flat/empty — that reads as a good week, not a failed load.
- `$0.00` must never mean "not computed". Dash and real `$0.00` must be visibly distinct. Never emit a plausible-but-wrong number.
- `null` and `unavailable` are different claims. `owner: null` renders as "nobody owns this"; carry "evidence not held locally" through to the render.
- Decide availability once. A producer mapping zero→`unavailable` while a client re-projection over visible rows returns `available(0)` flips the same card between states.
- When fallback text intentionally differs from the canonical label map, derive status and label from one helper so parallel switches cannot drift.

## Derived arithmetic must self-reconcile

Failure mode is silent: no crash, just an estimate that misstates itself.

- Segments must sum to the total the bar claims. Round-then-reconcile (largest-remainder), and render it in a story — the property must be visible, not inferred from a DOM assertion.
- Never silently swap a denominator (class total → on-screen row sum on a missing rollup); that changes what every percentage means. Say it changed, or mark unavailable.
- A count derived by subtraction must not mix outcomes — `attempted - failed` is not "committed" when `failed` includes a failure that did not roll back.
- Pin degenerate cases of clamped derivations: zero-width band, bucket absent from the response, the unavailable case that must never fall back to `$0`.

## Cross-surface parity

- The same record must not tell two stories per surface. When changing a projection, diff it against its siblings: `apps/desktop/src/main/**` (local) and `apps/api/app/{agent-sessions,branches}/` (cloud).
- Resolve a display label once. Two resolutions on one screen (`displayName ?? login` vs `displayUserName`) put the same human under two names.
- A perceivable UI change needs a gate on each platform that mounts the surface: PostHog on `apps/app`, the Labs toggle on `apps/desktop`. Because most surfaces here are mounted by both shells, that usually means both — but gate only the platforms that actually mount it.

## Data Visualization / Insights Widgets (design principle)

Every dashboard widget — an insights section, a chart, **any data-based visualization** — must **fire and load independently**: it owns its own query/loading/empty/error state so one slow or failing widget never blocks or blanks the others. A dashboard is a *set* of widgets that may grow or shrink, so it has to **scale horizontally**: adding widgets must not multiply the cost of loading the page.

Because those independent fetches ultimately hit a shared, capacity-bounded backend (the desktop's single db-host SQLite worker; a connection-pooled API), **fan the reads out through a bounded concurrency cap, not all-at-once**. Peak load must stay flat as widgets are added/removed — extra widgets queue and resolve as slots free, they never multiply the backend's peak. A heavy read that ignores this (e.g. an unbounded `json_each` scan over every session's metadata, run once per widget concurrently) can exhaust the worker's heap and crash-loop it, blanking the whole dashboard (see FEA-3056; on desktop the cap is the db-host `InsightsResultCache` in `apps/desktop/src/main/database/db-host/insights-cache.ts`, whose `DEFAULT_MAX_CONCURRENCY` is 1). Start the cap strict (1) and only raise it if a single read's peak is comfortably under the ceiling; prefer precomputed rollups over re-scanning raw data on every load.

## Testing

- Tests are colocated in `__tests__/` next to the code.
- Run with `pnpm --filter @repo/app test`.
- Use `shared/storybook/decorators.tsx` (`AppCoreStoryProviders`) to mount ports without Next/Clerk/a live API; mutations resolve through `createFixtureFetch`.
- Assert on observable behavior, never on logging or timing.
- Test the production wiring, not only the unit: a helper's caller must be asserted, and a fixture that returns the same result regardless of the params under test proves nothing about the filter it claims to cover.

### Co-located stories

A promoted prop-driven component with a state matrix ships a `*.stories.tsx` under `<feature>/components/` in the same change — promotion is the trigger, because a private helper's states stop being covered by the parent's single-shape fixture once it becomes an exported module. A story beside `<feature>/lib/*` is never scanned. Tests pin strings and arithmetic; stories pin geometry, tone pairing, and narrow-width crowding — not substitutes.

### E2E Coverage for UI Surfaces (MANDATORY)

New UI surface ⇒ e2e spec driving its primary flow; UI bug fix ⇒ regression e2e that would fail without the fix (assert the corrected rendered state when the bug was visual). Cover each shell that actually mounts the surface — web Playwright specs in `e2e/`, desktop Electron specs in `apps/desktop/test/e2e/` — not both by default; some components here are web-only (the README tracks those). CI gates them as the required `e2e` and `desktop-e2e` checks.

## Local Gotchas

- **Missing `@closedloop-ai/loops-api` export:** `@closedloop-ai/loops-api` is consumed from source (its `exports` resolve to `./src/*.ts`), so a `tsc` error about a missing exported member means the source module itself lacks that export — add it there; there is no `dist` to rebuild.
- **Stale `apps/app/.next/types`:** A `tsc` error about a missing `…/page.js` for a route you did not touch is a stale generated artifact. Run `rm -rf apps/app/.next/types` and re-typecheck.

## Related

- `packages/app/README.md` — migration context, the module-migration procedure, and package overview
- `apps/app/AGENTS.md` — Next.js shell context
