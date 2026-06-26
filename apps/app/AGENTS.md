# Product App Guidelines

## Data Access

- Do not import `@repo/database` in `apps/app`; frontend code must go through `apps/api` routes and shared API types.

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
- Do not add local `.catch()` error toasts around `mutateAsync`; the global `QueryClient` mutation error handler owns default error toasts. Catch only to suppress unhandled rejections or update local state.
- When setting `suppressDefaultErrorToast` on a mutation, cover every reachable non-recoverable error path with explicit user feedback, a recoverable return state for the caller, or a documented requirement that all callers provide `onError`. Add focused coverage for specialized preflight, conflict-replay, or retry errors.
- Do not narrow existing TanStack mutation meta flags such as `suppressDefaultErrorToast` for a specialized error family. Add a separate, named meta flag for the specialized local handler and cover both generic callers and non-target errors in tests.
- Do not await a secondary `mutateAsync` call inside another mutation's `onSuccess` when the primary mutation's cache cleanup must still finish if the secondary mutation fails. Use `mutate` with explicit callbacks or rely on the secondary hook's own `onSuccess` invalidation.
- Routes that relay HTTP-like Desktop responses must share the relay-envelope parser and preserve missing-envelope failures as non-2xx responses. Malformed client JSON at the route boundary should return 400 before the relay command is created.
- Desktop release download data is sanitized at the `useLatestElectronRelease` query-hook boundary. Downstream components should consume the hook's nullable contract instead of re-sanitizing the same release object at every render site.

## When NOT to use useEffect

Most `useEffect` calls in this codebase are bugs in disguise. Before adding one, rule out:

- **Deriving values from props/state** → calculate during render. Reach for `useMemo` only if measurably expensive.
- **Resetting state when a prop changes** → use `<Component key={propValue} />`, not an Effect that calls `setState`.
- **Side effects triggered by user actions** (POST, navigation, notifications, parent callbacks) → call them in the event handler. Never use state as a trigger flag for an Effect.
- **Chained `setState` cascades** → compute every state update in the originating handler and call all setters together.
- **One-time app initialization** → run at module scope guarded by `typeof window !== "undefined"`, not in a root-component Effect with `[]` deps.
- **Child passing data up to parent** → invert the data flow; parent fetches and passes down.

Legitimate Effect uses in this codebase: subscriptions (prefer `useSyncExternalStore` — see below), post-render DOM measurements, and integrating with non-React libraries. Data fetching belongs in a TanStack Query hook under `hooks/queries/`, never raw `useEffect` + `fetch`.

Reference: https://react.dev/learn/you-might-not-need-an-effect

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
- Use `next/link` `<Link href="...">` for in-app navigation instead of button `onClick` handlers that call `router.push`, so browser navigation affordances keep working.
- Do not remove the `/api/gateway/*` proxy guard or reimplement gateway operations in `apps/app`; gateway operations require local filesystem/process access and belong in `apps/desktop`.

## Learned Patterns

### TanStack Query

- **[pattern]**: `queryClient.clear()` for org switching is correct when: (1) routes use withAnyAuth() with orgId from JWT/API key, (2) services filter by organizationId, (3) frontend uses authenticated API client.
- **[pattern]**: `AuthGate` in `layout.tsx` gates all authenticated content on Clerk `isLoaded`. If `useApiClient` is ever used above the gate boundary, add `enabled: isLoaded` in query options to prevent 401 race on first render.
- **[mistake]**: Do not use `mutateAsync`. This requires wrapping the call in try/catch, and is a code smell. There is generally no reason to do this. Instead, prefer `mutate` with an `onSuccess` handler.

### Feature Flags & Org Scope

- **[pattern]**: Feature flags must gate every reachable entry point: visible controls, direct URL/tab states, mutations, and analytics. (context: feature-flags|routing|analytics)
- **[pattern]**: Persisted client state, refs, storage keys, and recovery guards that depend on the active org must include the org key and reset when it changes; `queryClient.clear()` does not remount components. (context: org-scope|localStorage|refs)

### Tables & Sorting

- **[pattern]**: Sort nested object fields via SortConfig accessor function. `sortItems()` handles nulls-last.
- **[pattern]**: Multiple sortable tables on same page: each `useSortParams` needs unique `paramPrefix`.

### Observability

- **[mistake]**: Do not add debug logging (`log.info`/`log.warn`/`log.error` from `@repo/observability/log`, or `console.*`) in client-side code — anything under `apps/app/`, any `"use client"` file, hook, or React component, including in `packages/*` modules that bundle to the browser. Those logs only reach the user's devtools, not our log aggregator, so they add noise without observability value. Use `@repo/analytics` for client behavior tracking. Logging belongs in server code (`apps/api`, route handlers, services, webhooks). The only acceptable client `log.warn`/`log.error` is in an error boundary or an irrecoverable-failure path where the message will only fire when something is already broken. (context: observability|client|logging)

### React & Components

- **[pattern]**: Clerk client components (UserButton, OrganizationSwitcher) need mounted state hydration guard.
- **[insight]**: Check existing component props before adding new ones — data may already be available.
- **[pattern]**: Radix Dialog `modal={false}` still fires `onInteractOutside` and `onPointerDownOutside`. Non-modal panels: `e.preventDefault()` on both.
- **[pattern]**: Multi-provider AI context injection must be provider-aware. Skip client-side formatting for non-target providers — use server-side.
- **[convention]**: Async cancellation in useEffect: `let cancelled = false` + cleanup return, NOT AbortController/useRef.
- **[pattern]**: Shared client-only UI state that must survive component remounts, route transitions, or browser back/forward should live in a small `useSyncExternalStore` store module, following `lib/engineer/routing-store.ts` and `lib/engineer/electron-detection.ts`. Keep reset semantics explicit: module memory for current-tab only, `localStorage` only when refresh/new-tab persistence is intended.
- **[mistake]**: Do not put navigation-sensitive shared state in component module-local `Set`/`Map`/`let` values or ad hoc `window` globals. This repo does not currently use Zustand in `apps/app`; do not add it just to store small client-only state unless a human explicitly asks for a state-library migration.
- **[mistake]**: Avoid querying all entities (documents, trees, projects) and filtering client-side for unbounded or large datasets — use backend-scoped queries, server-side filtering, or pagination. Client-side filtering is acceptable for small, bounded datasets or when the data is already fetched for another purpose. When filtering client-side, ensure the dataset has a known upper bound and won't grow unbounded as the project scales. (context: performance|overfetch|client-filter)

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

- **[mistake]**: Room metadata: read keys must match write keys. Creation stores `documentType` in room-utils.ts. Legacy rooms may still have `artifactType`/`artifactSubtype` — the resolver reads both.

### OAuth Integrations

- **[pattern]**: Three-part architecture: (1) Frontend OAuth routes handle PKCE/state/redirect, (2) Callback validates state + calls API for token storage, (3) TanStack Query hooks for status/disconnect/mutations. Reference: Linear integration.
