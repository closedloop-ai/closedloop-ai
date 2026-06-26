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
