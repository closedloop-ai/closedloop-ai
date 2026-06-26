# @repo/app Package Guidelines

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

## Testing

- Tests are colocated in `__tests__/` next to the code.
- Run with `pnpm --filter @repo/app test`.
- Use `shared/storybook/decorators.tsx` (`AppCoreStoryProviders`) to mount ports without Next/Clerk/a live API; mutations resolve through `createFixtureFetch`.
- Assert on observable behavior, never on logging or timing.

## Migrating a Module into This Package

1. `git mv` the module (and its colocated `__tests__`) into the owning feature slice's `lib/`/`hooks/`/`components/`; fix relative imports.
2. Rewrite every importer: `@/lib/X` → `@repo/app/<feature>/lib/X`.
3. Leave no re-export shims behind — each PR fully migrates its importers. (Only the two deprecated FEA-1510 seam files are permitted exceptions.)
4. Confirm the moved module imports nothing from the forbidden table above. If it does, it is not portable yet; defer it and document why in `README.md`.
5. Gate each PR: `pnpm turbo typecheck test --filter=app --filter=@repo/app` plus Biome, plus a Storybook build when stories change.

## Local Gotchas

- **Stale `@closedloop-ai/loops-api` dist:** After pulling changes that touch it, a `tsc` error about a missing exported member means the dist is stale — rebuild with `pnpm turbo build --filter=@closedloop-ai/loops-api`.
- **Stale `apps/app/.next/types`:** A `tsc` error about a missing `…/page.js` for a route you did not touch is a stale generated artifact. Run `rm -rf apps/app/.next/types` and re-typecheck.
