# @repo/app — Shared App-Core Layer

Surface-agnostic application code shared between the Next.js web shell
(`apps/app`) and the desktop renderer. Implements FEA-1510 / PLN-810.

## Rules

- **No surface bindings.** No `next/*`, no Clerk/`@repo/auth/*`, no
  `server-only`, no `@repo/database`, no `@/*` app alias. Transport, auth, and
  navigation are injected through ports (`shared/api`, `shared/auth`,
  `@repo/navigation`). Enforced by the Biome `noRestrictedImports` guardrail for
  `packages/app/**` — violations fail `pnpm lint` in CI.
- **Feature-sliced.** Code lives in `packages/app/<feature>/{components,hooks,lib}`.
  Organization by file type exists only _inside_ a slice. Genuinely
  cross-feature code lives in `packages/app/shared/` as the exception.
- **No barrel files.** Consumers use subpath imports
  (`@repo/app/shared/lib/format-utils`), per Biome `noBarrelFile`.

## Layout

- `shared/` — cross-feature: `api` (transport port + client), `auth` (auth
  port), `query` (QueryClient factory), `lib` (pure utilities), `hooks` (generic
  UI-state hooks), `components`, `storybook` (story/test harness),
  `observability`.
- `<feature>/` — `tags`, `documents`, `loops`, `projects`, `github`, `chat`, …

## Migration (PLN-810) — files that stay in `apps/app`

The web shell keeps Next-bound and security-critical modules. These are **not**
ported to `@repo/app`:

- `lib/api-origin.ts`, `lib/environment.ts` — read `NEXT_PUBLIC_*` env.
- `lib/og-metadata.ts` — uses the `next` `Metadata` type.
- `lib/app-core-adapters.tsx`, `lib/query-client.tsx` — the shell's own port
  wiring / Next-bound QueryClient provider; they mount `@repo/app`, not vice
  versa.
- `lib/navigation/next-adapter.tsx` — the FEA-1509 navigation adapter (stays by
  design; the shell mounts it).
- `lib/desktop-command-signing/*` — command signing (security-critical,
  local-only); `hooks/queries/use-public-keys.ts` is part of the same flow.
- Compute-target code — `hooks/queries/use-compute-targets`,
  `use-compute-target-status-stream`, `use-agent-onboarding` (consumes targets),
  and `components/compute-target-popover`. Managing compute targets is a
  web-app/control-plane concern: the desktop app *is* a compute target, so it
  never enumerates or selects them. Web-only by nature, not deferred.

### Excluded — removed with the Engineer/Desktop surface

Slated for deletion alongside the Engineer feature, so **not worth porting**.
Per the FEA-1510 directive: do not port anything in (or coupled to) an
`engineer/` tree.

- `lib/engineer/*` — Engineer feature (security-critical, local FS/process).
- `lib/git/*`, `lib/system-check/*` — Engineer-feature subtrees.
- The chat **shell + session machinery** that couples to Engineer: the
  `components/chat/*` UI (drawer, panel, slash commands), `hooks/chat/*` session
  hooks (`use-chat-session` etc. reach into `lib/engineer/*`, route-local
  `comment-context`, and `env`), `lib/chat/{chat-markdown,chat-utils}` (import
  `lib/engineer/*`, `lib/git/*`), and the server-side `lib/chat/runner-token/*`
  (Clerk auth, `next/server`). The surface-agnostic chat **core** — stream/state
  reducers, NDJSON `stream-utils`, context builders, `default-models`,
  `mcp-instructions`, `build-section`, and the leaf presentational components —
  ported to `@repo/app/chat/` (shared with the non-Engineer document-chat path).
- `lib/run-loop-launcher.ts`, `lib/diff-viewer-theme.ts` — Engineer-coupled.
- `lib/markdown.tsx` — imports the excluded `lib/engineer/*`.
- `lib/desktop-installer-script.ts`, `lib/desktop-managed-onboarding.ts`,
  `lib/desktop-provisioning-platform.ts` — surface-agnostic and individually
  portable (each has colocated tests), **but** consumed only by Desktop
  onboarding/provisioning flows that go away with the Desktop surface. Deferred
  as throwaway risk; revisit only if Desktop onboarding outlives the Engineer
  removal.

### Deferred — portable, but each needs a deliberate decision (tackle last)

- `lib/datadog-rum/*` — couples to `@/env` + `@/lib/environment`; needs an env
  port/seam in `shared/` before it can move.

### Org-slug routing seam — a navigation port, NOT an auth-adapter gap

The injected auth adapter (`shared/auth`) exposes only identity: `userId`,
`orgId`, `getToken`. Hooks that need identity are unblocked today (e.g.
`agents/hooks/use-bootstrap-agents` reads `orgId` for a storage-key namespace).

Building `/${orgSlug}/…` hrefs is a *routing* concern, not auth — so it lives in
the navigation port, not the auth snapshot. `@repo/navigation/use-org-path`
returns an `OrgPathBuilder` (`(orgRelativePath) => href`); the web adapter
(`apps/app/lib/navigation/next-adapter.tsx`) implements it via the app-owned
`useOrgSlug()` (route param + Clerk fallback, which correctly stays in
`apps/app`). Shared components call `useOrgPath()` and never interpolate a raw
slug — the builder also guards the empty-slug (hydrating) case so it never emits
a protocol-relative `//…`. Do NOT thread the slug through `AuthSnapshot` (that
leaks web routing into the auth contract).

**Scope / desktop caveat.** `useOrgPath` is a *path-string* abstraction: it
covers the org prefix for surfaces whose router consumes path hrefs (the web
shell + the in-memory test/story adapter). It does **not** by itself make a
consumer desktop-ready — the caller still encodes a web path shape
(`/users/:id`), and the desktop renderer is routerless, view-state navigation
(FEA-1497: nav-stack over react-router) that consumes no path hrefs and mounts
no `NavigationProvider`. So the components migrated here
(`shared/components/{user-link,assignee-avatar}`,
`documents/components/generation-status-indicator`) are unblocked for the **web
shell**; making them function on desktop needs the semantic/named-route
view-state seam (FEA-1518), where the caller names a destination and each
surface maps it (web → href, desktop → a `navId`/drill-down).

Note: `use-loops` is **not** an auth-seam item — its blocker is the
`run-loop-launcher` + `lib/desktop-command-signing` + `lib/engineer` coupling
(see Excluded), not `useUser`.

## React Native adapter contract (FEA-3872 / FEA-3811 Phase 6 / PLN-1458)

`@repo/app` is the shared app core for the Next.js web shell (`apps/app`) and
the desktop renderer, plus — the reason this contract exists — a future React
Native shell. (There is no `apps/mobile` today; the earlier one was deleted in
ISS-5284. This contract is a seam in `@repo/app`, not a live third surface.) The responsive chain (FEA-3811 Phases
2–5) already reshaped each dense table and the document feed rail so they adapt
to a narrow surface; Phase 6 (this doc) names the seam so RN reuses the feature
slices instead of forking them. **Web and desktop behavior is unchanged** — the
RN adapter is additive.

### What RN reuses vs. what it injects

A feature slice (`agents/`, `branches/`, `documents/`, `insights/`, …) already
separates surface-agnostic logic from surface-bound chrome. RN reuses the first
and injects the second.

**RN-portable (reuse as-is):**

- **Row/card data mappers** — the pure `…-row-adapter.ts` / row-type helpers
  that turn an API record into a display-ready row (`SessionTableRow`,
  `BranchRow`, `AgentComponent`, `DocumentRowData`). No DOM, no `next/*`.
- **`<Feature>Card` renderers** — each table exports a companion card that lays
  one row out as a stacked card: `SessionCard` (`agents/components/sessions/
  sessions-table`), `BranchCard` (`branches/components/branches-table`),
  `AgentCard` (`agents/components/workspace/agents-table`), `DocumentCard`
  (`documents/components/table/document-row`). These are what RN renders per row
  in a native list — RN never mounts the CSS-grid path.
- **Query hooks** — the `use-*` data hooks, which already consume the injected
  API/query ports rather than talking to a transport directly.
- **The adaptation contract type** — `shared/lib/adaptive-props.ts` exports
  `AdaptiveProps<T>` (`mode` / `density` / `wrapBelow` / `alwaysShowActions` /
  `cardRender`) and `AdaptiveFeedRailProps` (the feed rail's `mode` +
  density/always-show). It is built from the primitives that own each knob
  (`GridTableMode`, `FeedRailMode`, the `GridTable` `cardRender` signature) so
  the contract can't drift from the components. `resolveAlwaysShowActions`
  centralizes the always-show decision every action-cell shares.

**Injected by the RN shell (ports, not reuse):**

- **Navigation** — the same seam the web/desktop split already uses: `<Feature>`
  cards take a `renderName` / `getComponentHref` / `renderBranchLink` callback so
  the host supplies its own navigation element (web `<Link>`, desktop view-state
  push, RN `Pressable` → native navigation). RN never imports `@repo/navigation`
  Link; it injects a pressable. Named-route destinations still need FEA-1518 (see
  the org-slug section above) — a web path string is not yet RN-portable.
- **Overlay / modal chrome** — `useResponsiveModal` swaps a centered Dialog for a
  bottom Sheet by viewport on web; RN injects its own bottom-sheet/modal port.
  The `FeedRail` `mode` (`inline` → `overlay` → `sheet`) is the same idea for the
  document feed.
- **List virtualization** — the grid measures its own container width on web;
  RN provides a `FlatList`/`SectionList` and pins the card layout
  (`mode: "compact"`), so no CSS grid ever renders.

### How the seams map to `AdaptiveProps`

| Prop | Web / desktop default | RN adapter |
| --- | --- | --- |
| `mode` | `auto` — cards below `md`, grid at `md+` | `compact` (no CSS grid) |
| `density` | `compact` (mouse rhythm) | `comfortable` (WCAG/iOS tap targets) |
| `wrapBelow` | `md` (768px), measured internally | pins the native breakpoint |
| `alwaysShowActions` | undefined → pointer-aware `touch:` reveal | `true` (no hover exists) |
| `cardRender` | the feature's exported `<Feature>Card` | same card, RN-native ports |

`alwaysShowActions` is wired today on the one action-cell that hover-reveals
(the Agents table's row-actions kebab). Branches/Documents row-actions are
already always-visible triggers, so they satisfy the "always reachable on
touch" requirement without a flag; the prop exists so a hover-less surface can
force the reveal off wherever the `touch:` variant would otherwise gate it.

### Adding a new feature to the React Native surface

1. Keep the row/card data mapper pure (no `next/*`, no DOM) — it already is if it
   lives in `<feature>/lib/*-row-adapter.ts`.
2. Export the feature's `<Feature>Card` (a named export, built on the shared
   `GridTableCard`) so RN can render one row without the grid path.
3. Accept `AdaptiveProps<Row>` on the table so the host pins `mode`/`density`/
   `alwaysShowActions` per surface.
4. Take navigation and overlay chrome as injected callbacks/ports — never import
   a surface's Link/router/modal directly.
5. Confirm the slice imports nothing from the forbidden table in `AGENTS.md`.

## Migrating a Module into This Package

1. `git mv` the module (and its colocated `__tests__`) into the owning feature slice's `lib/`/`hooks/`/`components/`; fix relative imports.
2. Rewrite every importer: `@/lib/X` → `@repo/app/<feature>/lib/X`.
3. Leave no re-export shims behind — each PR fully migrates its importers. (Only the two deprecated FEA-1510 seam files are permitted exceptions.)
4. Confirm the moved module imports nothing from the forbidden table in `AGENTS.md`. If it does, it is not portable yet; defer it and document why here.
5. Gate each PR: `pnpm turbo typecheck --filter=...@repo/app` (the LEADING dots pull in the dependents — `apps/desktop` consumes this package too, and a trailing-dot filter silently skips it), then the focused tests for both consuming surfaces (`--filter=app --filter=desktop --filter=@repo/app`), plus Biome, plus a Storybook build when stories change.
