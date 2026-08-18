# Product App Guidelines

Authenticated Next.js app (App Router). Port 3000. For Server Component vs Client Component vs Server Action mental model, see `SERVER_CLIENT.md`.

End-user-perceivable UI changes must ship behind a flag, default off — see root AGENTS.md + the `ui-feature-flag-attestation` gate.

## File Organization

```
hooks/
├── queries/
│   ├── use-loops.ts        # loopKeys + useRunLoop, etc.
│   └── use-*.ts            # remaining query hooks not yet migrated
├── use-api-client.ts       # deprecated re-export of the @repo/app transport port
└── use-*.ts                # Other non-query hooks
```

**Query hooks (PLN-810 Phase 3).** Surface-agnostic query hooks go in `@repo/app/<feature>/hooks/` (e.g. `@repo/app/projects/hooks/use-projects`); only hooks importing `@repo/auth`, crypto, or the engineer/run-loop-launcher seam stay in `apps/app/hooks/queries/`.

**Storybook does not scan `apps/app/**`** (four globs, see root `AGENTS.md`). A component earning an isolated story belongs in `packages/app/<feature>/components/` (domain-shared) or `packages/design-system/components/` (generic); only the story file goes under `apps/storybook/stories/`, never the production component.

Route-level rules for the authenticated product surface (widget loading/unavailable/
zero semantics, derived-arithmetic reconciliation, sort coverage) live in
[`app/(authenticated)/AGENTS.md`](<app/(authenticated)/AGENTS.md>).

## Data Access

- Do not import `@repo/database` in `apps/app`; frontend code must go through `apps/api` routes and shared API types.
- Server-side `apps/app` API calls must resolve the BFF origin through `resolveApiOrigin` instead of reading `NEXT_PUBLIC_API_URL` directly. Browser code uses the public localhost/preview origin, but app-server code inside Docker must honor `SERVER_API_URL` (for example `http://api:3002`) so containerized E2E and SSR routes do not call the app container's own localhost.

## TanStack Query Conventions

All data fetching in `hooks/queries/use-*.ts`:
- Export `<entity>Keys` factory (e.g., `documentKeys`, `projectKeys`): `.all`, `.lists()`, `.list(filters)`, `.detail(id)`
- Query hooks: `queryKey` + `queryFn` + `enabled` + `...options` spread
- Mutations: invalidate relevant caches in `onSuccess`
- Prefer `mutate` over `mutateAsync`. `mutateAsync` can throw and thus requires try/catch, which is overly verbose.
- `useApiClient()` provides the HTTP client (throws `ApiError`)
- Only `staleTime` acceptable as default; omit gcTime, refetchOnMount, refetchOnWindowFocus
- Use `refetchInterval` for polling (e.g., generation status)

### TanStack Query Rules

- Use TanStack Query hooks for server state and server mutations instead of component-level `useEffect` plus raw `fetch`, unless the fetch is not cacheable server state and the exception is documented.
- In query hooks, use `useApiClient` for authenticated API requests instead of manually calling `fetch`, `getToken`, and `resolveApiUrl`. If a route intentionally does not use the standard `ApiResult` envelope, use `getRaw`/`postRaw` on `useApiClient` so auth, API-origin behavior, JSON parsing, and raw error fallback stay centralized.
- Before adding mount-time data fetching, especially on editor or project pages, confirm the data is required for the initial render. Prefer deferring optional or rarely used backend reads until the user action, visible panel, route state, or workflow step that actually needs the data.
- Relationship selectors and duplicate filters must compare against the canonical identity or URL for the same entity being filtered. For GitHub pull requests, use the PR identity or `htmlUrl`; do not substitute related branch, tree, head, or display URLs when deciding whether a PR is already linked.
- When a TanStack query key or request parameter depends on another async query, gate the dependent query with `enabled` until the prerequisite query has settled or explicitly document why an initial placeholder-value fetch is intentional. Do not let a cold prerequisite cache cause one request with `null`/placeholder params and a second request with the resolved value.
- TanStack Query's `enabled` option does not narrow nullable values for `queryFn`. When a query function needs nullable props, params, or context, either guard inside `queryFn` or shape the hook input so the query function only closes over non-null values; do not use non-null assertions to bridge the gap.
- Polling query hooks must stop polling on every terminal status for the workflow, including failure or expiry states, not only the success state. Derive the terminal-status set from the service state machine or contract; do not stop polling on transient statuses such as claimed/processing states that can still advance. Polling hooks must also stop or deliberately back off when `query.state.status === "error"` so missing resources or server errors do not create infinite retry loops.
- When polling a route that performs nontrivial API or database work, choose a conservative seconds-scale interval or documented backoff based on expected completion time and backend cost. Do not default to one-second polling for heavyweight reads unless the UX need is explicit and the server load is acceptable.
- Fetch helpers that read structured error bodies must tolerate non-JSON responses with `response.json().catch(() => null)` before branching on `response.ok`. Optional malformed metadata fields must not collapse the whole parsed body or discard valid `error`, `code`, or timestamp fields, and response bodies should be parsed once and reused for both message selection and metadata.
- Fetch helpers that return typed success data from unknown response bodies must validate the success body with a shared or colocated schema before returning it. Do not bridge an untrusted JSON boundary with `as SomeResponseType` casts.
- Do not add local `.catch()` error toasts around `mutateAsync`; the global `QueryClient` in `lib/query-client.tsx` has a default `mutations.onError` handler that owns default error toasts. Catch only to suppress unhandled rejections or reset local state.
- When setting `suppressDefaultErrorToast` on a mutation, cover every reachable non-recoverable error path with explicit user feedback, a recoverable return state for the caller, or a documented requirement that all callers provide `onError`. Add focused coverage for specialized preflight, conflict-replay, or retry errors.
- Do not narrow existing TanStack mutation meta flags such as `suppressDefaultErrorToast` for a specialized error family. Add a separate, named meta flag for the specialized local handler and cover both generic callers and non-target errors in tests.
- Do not await a secondary `mutateAsync` call inside another mutation's `onSuccess` when the primary mutation's cache cleanup must still finish if the secondary mutation fails. Use `mutate` with explicit callbacks or rely on the secondary hook's own `onSuccess` invalidation.
- Routes that relay HTTP-like Desktop responses must share the relay-envelope parser and preserve missing-envelope failures as non-2xx responses. Malformed client JSON at the route boundary should return 400 before the relay command is created.
- Desktop release download data is sanitized at the `useLatestElectronRelease` query-hook boundary. Downstream components should consume the hook's nullable contract instead of re-sanitizing the same release object at every render site.

## When NOT to use useEffect

Most `useEffect` here is a bug. Derive values during render (`useMemo` only if measurably expensive); reset state with `<Component key={propValue} />`, not an Effect that calls `setState`; fire side effects (POST, navigation, notifications, parent callbacks) in the event handler, never via a state trigger flag; compute chained `setState` cascades together in the originating handler; run one-time init at module scope guarded by `typeof window !== "undefined"`, not a root-component Effect with `[]` deps; invert child→parent data flow; fetch via a TanStack Query hook under `hooks/queries/`, never raw `useEffect` + `fetch`.

Legitimate: subscriptions (prefer `useSyncExternalStore`), post-render DOM measurement, non-React libs. https://react.dev/learn/you-might-not-need-an-effect

## Client State and Workflow Controls

- For client-only state that must survive component remounts, route transitions, or browser back/forward within the same tab, create a small dedicated store module using the existing `useSyncExternalStore` pattern, such as `apps/app/lib/engineer/routing-store.ts` and `apps/app/lib/engineer/electron-detection.ts`. Do not hide this state in component module-local `Set`/`Map`/`let` values, ad hoc `window` globals, or a new state library unless the user explicitly asks for that migration. Keep persistence explicit: no storage for refresh/new-tab reset semantics, `localStorage` only when cross-refresh persistence is intended.
- For command gates, conflict replays, confirmation callbacks, and retry paths, route replayed commands through the same gate or policy as the initial command unless the exception is explicitly documented and tested. Preserve sentinel semantics such as omitted/`undefined` versus explicit `null`; tests must assert the downstream call shape for both.
- For owner-keyed pending state in hooks/components, do not use a global pending/checking flag to disable or label unrelated surfaces. Compare the pending owner, command, document id, target id, or attempt id to the current surface and add a regression test for an unrelated pending owner.

## Generated Commands and UI Inputs

- For generated shell commands or installer scripts, do not execute unchecked network downloads through command substitution. Download to a temporary file or otherwise make the download a checked step before executing the result, and preserve the nonzero exit status on network failure.
- When form/input values are trimmed, parsed, normalized, or otherwise transformed before command generation or mutation submission, run validation against the exact transformed value that will be submitted. Add a test for harmless trim-only input and a test where invalid content remains after transformation.
- Installer-script tests that assert a prerequisite is missing, installed, or added to `PATH` must stub that prerequisite in the test `PATH`. Do not let the test fall through to host tools such as `/usr/bin/python3` when the assertion depends on the tool being absent or unusable.

## Rendering and Navigation

- When rendering nullable values behind a boolean flag, guard the actual render branch with the nullable values too, or encode the props as a discriminated union so the compiler enforces the required values.
- Prefer render-time derived values over `useEffect` state resets when state is only invalid under a prop, feature-flag, or routeability condition. Keep the stored state stable and gate the rendered branch.
- When URL search params drive paginated API offsets, clamp or repair stale page params after a total-bearing response before rendering an empty state or leaving pagination hidden. Add coverage for a bookmarked out-of-range page.
- Coalesce high-frequency browser-state writes from scroll, resize, pointermove, and similar event streams with `requestAnimationFrame` or an explicit debounce before writing `history`, storage, or layout-affecting state.
- When grouping Branch View comments or replies in UI code, prefer stable unified `threadId`/`commentId` values or thread-local provider identity. Do not require optional provider `source` to match between parent and reply comments; older or partial contracts may omit it.
- Use `globalThis` instead of `window` when reading browser globals in shared/client code, and keep SSR guards explicit.
- Do not initialize render-affecting React state from browser-only globals such as `navigator`, `location`, `localStorage`, or `matchMedia` during server-rendered component render. Use an SSR-stable default and apply client-derived values after mount, or gate the surface until mounted.
- Use `Link` from `@repo/navigation/link` for in-app navigation — never a raw internal `<a href="/…">` or a navigation-only `onClick` (`next/link` is banned here by `biome.jsonc`). Enforced by `pnpm check:source-gates`.
- Do not remove the `/api/gateway/*` proxy guard or reimplement gateway operations in `apps/app`; gateway operations require local filesystem/process access and belong in `apps/desktop`.

## E2E Coverage for UI Surfaces (MANDATORY)

E2E coverage for user-facing surfaces is part of "done" here, the same way the Parker Protocol design pass is — not a soft suggestion. This extends the repo-wide Test Practices in the root `AGENTS.md`; it does not replace the unit/render coverage those rules already require.

- **New UI surface ⇒ new e2e spec.** Any NEW user-facing surface you add to `apps/app` — a screen, route, drawer, dialog, panel, tab, or otherwise significant component — ships in the same change with a Playwright web-e2e spec that exercises its primary flow (navigate to it, drive its main interaction, assert the observable result), not just a mounted-in-isolation render test.
- **UI bug fix ⇒ regression e2e.** Any UI BUG FIX adds an e2e test that reproduces the bug through the real surface and would fail without your fix, guarding the regression. Cover the aesthetic/visual dimension too when the bug was visual — assert the corrected rendered state (visible text, layout, empty/error/loading state), and add or update a visual-regression assertion where the surface already has one (see `e2e/VISUAL-REGRESSION.md`).
- **Where the tests live and how to run them.** Playwright, `testDir: "e2e"` (`playwright.config.ts`); specs are `e2e/<surface>.spec.ts`, fixtures in `e2e/test.ts` and `e2e/helpers/`. Run `pnpm test:e2e`; the containerized stack runs via `e2e/run-containerized.sh` (see `e2e/CONTAINERIZED.md`) or `dagger call e-2-e`. This `e2e` suite is a required PR check that gates merge.
- **Cross-surface work covers both adapters.** When the surface, workflow, hook, or component is shared through `packages/app` and reused across web and desktop, add coverage on BOTH adapters — the web `e2e/` Playwright spec here AND the desktop Electron-e2e spec described in `apps/desktop/AGENTS.md` — because behavior can diverge by adapter (routing, feature flags, API origin, Electron runtime). This is the same both-surfaces expectation stated in the root `AGENTS.md` cross-surface guidance.

## Learned Patterns

### TanStack Query

- **[pattern]**: `queryClient.clear()` for org switching is correct when: (1) routes use withAnyAuth() with orgId from JWT/API key, (2) services filter by organizationId, (3) frontend uses authenticated API client.
- **[pattern]**: `AuthGate` in `layout.tsx` gates all authenticated content on Clerk `isLoaded`. If `useApiClient` is ever used above the gate boundary, add `enabled: isLoaded` in query options to prevent 401 race on first render.

### Org Scope

- **[pattern]**: When you gate a feature, keep every reachable entry point gated consistently — nav destination `featureFlag`, direct URL/route via `<FeatureFlagRouteGate>`, controls, tab states, mutations, analytics. (context: feature-flags|org-scope)
- **[pattern]**: Persisted client state, refs, storage keys, and recovery guards that depend on the active org must include the org key and reset when it changes; `queryClient.clear()` does not remount components. (context: org-scope|localStorage|refs)

### Tables & Sorting

- **[pattern]**: Sort nested object fields via SortConfig accessor function. `sortItems()` handles nulls-last.
- **[pattern]**: Multiple sortable tables on same page: each `useSortParams` needs unique `paramPrefix`.

### React & Components

- **[pattern]**: Clerk client components (UserButton, OrganizationSwitcher) need mounted state hydration guard.
- **[insight]**: Check existing component props before adding new ones — data may already be available.
- **[pattern]**: Radix Dialog `modal={false}` still fires `onInteractOutside` and `onPointerDownOutside`. Non-modal panels: `e.preventDefault()` on both.
- **[pattern]**: Multi-provider AI context injection must be provider-aware. Skip client-side formatting for non-target providers — use server-side.
- **[convention]**: Async cancellation in useEffect: `let cancelled = false` + cleanup return, NOT AbortController/useRef.
- **[mistake]**: This repo does not currently use Zustand in `apps/app`; do not add it just to store small client-only state unless a human explicitly asks for a state-library migration.
- **[mistake]**: Avoid querying all entities (documents, trees, projects) and filtering client-side for unbounded or large datasets — use backend-scoped queries, server-side filtering, or pagination. Client-side filtering is acceptable for small, bounded datasets or when the data is already fetched for another purpose. When filtering client-side, ensure the dataset has a known upper bound and won't grow unbounded as the project scales. (context: performance|overfetch|client-filter)
- **[mistake]**: When a query errors, render a degraded/error state — never leave the UI stuck on a loading skeleton. Catch query errors and show an inline error or fallback, not an infinite spinner. (context: error-state|loading|skeleton)

### UI Patterns

- **[pattern]**: Convert tabs to collapsible: MetadataPanel + space-y-6 + separate useState(bool) per section + Collapsible components.
- **[pattern]**: Document metadata panels (PRD, Issue, Plan) follow identical TabbedMetadataPanel structure in `app/(authenticated)/{document-type}/[slug]/components/`.
- **[pattern]**: Check document type via `document.type === DocumentType.Prd` etc. Import from `@repo/api/src/types/document`.

### Testing

- **[pattern]**: After adding required props, run typecheck to find test files with outdated mock/defaultProps.
- **[mistake]**: Mocking `next/navigation` in Vitest: must provide useRouter, usePathname, AND useSearchParams.
- **[mistake]**: Test mocks must expose the same mutation method the production code calls — if the hook uses `mutateAsync`, the mock must provide `mutateAsync` (not just `mutate`), and vice versa. Grep the source for `.mutate(` vs `.mutateAsync(` before writing mock factories. (context: testing|mock|tanstack-query|mutation)

### CSS & Animations

- **[pattern]**: Animation destinations: use `querySelector` + `getBoundingClientRect()`, never hardcode pixel offsets.

### Liveblocks

- **[mistake]**: Room metadata: read keys must match write keys. Creation stores `documentType` via `packages/collaboration/server/room-management.ts`; the resolver in `room-metadata.ts` reads it and falls back to legacy `artifactType`/`artifactSubtype` for old rooms.

### OAuth Integrations

- **[pattern]**: Three-part architecture: (1) Frontend OAuth routes handle PKCE/state/redirect, (2) Callback validates state + calls API for token storage, (3) TanStack Query hooks for status/disconnect/mutations. Reference: Linear integration.
