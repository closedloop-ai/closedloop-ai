# Prototypes

In-repo prototype sandbox. Full design doc: [docs/design/prototype-sandbox.md](../../docs/design/prototype-sandbox.md).

Prototypes are presentational, mock-data-only references. Every prototype is
treated as a real feature and componentized from the first build: its
prop-driven domain surface lives in `packages/app`, while the sandbox supplies
fixtures through an exact preview adapter listed in
`scripts/check-catalog-imports.mjs`. Product hooks and data adapters remain
forbidden. Prototypes merge to `main` and deploy
to <https://prototypes.preview.stage.example> — its own Vercel project, with
**no authentication** (operator ruling 2026-09-08). Anyone with the URL can open
them. What keeps them out of the product is separation, not a gate: no shared
auth, session, or cookies with prod, never linked from the prod app nav, mock data
only. Do not put anything in a prototype you would not publish. Full posture:
[prototype-sandbox.md §5](../../docs/design/prototype-sandbox.md).

Vercel builds this project only for `green`, `production`, `prototype/**`,
`vibe/**` and `functional-prototype/**` (ISS-12353, PRD-791 ruling
2026-10-09). Any other branch, an ordinary PR branch or a merge-queue ref
included, gets no prototype or Storybook preview. The list lives in
`vercel.json` (`git.deploymentEnabled`) and again in `scripts/skip-ci.js`, the
ignore command, which also skips a push that changes nothing this deployment is
built from (a `vibe/` branch always builds).

## Run it

```bash
pnpm --filter prototypes dev
```

Then open <http://localhost:3030>. The index lists every prototype; each one
lives at `/p/<slug>`.

## Add a prototype

Use the `/prototype` skill from Claude Code, or by hand:

1. Create `app/p/<slug>/` with `prototype.meta.ts` (see `lib/registry.ts` for
   the shape), `mock.ts`, and `page.tsx`.
2. Use `/componentize-prototype` in inception mode so the route mounts a
   shared `packages/app` surface from its first render. Anything not covered
   by that surface comes from design-system components listed in
   `packages/design-system/storybook/component-catalog.ts` (skip entries
   marked `internal`).
3. Run `pnpm --filter prototypes generate:registry` and commit the updated
   `lib/registry.generated.ts`.
4. Validate: `pnpm --filter prototypes typecheck && pnpm --filter prototypes test`.
   The `test` script is the catalog-import gate. CI runs it on every PR (the
   pr-test.yml `test-shard` job includes `--filter=prototypes`), so a non-catalog
   component import fails CI. Deploy builds stay test-free per FEA-1523, so
   the gate is enforced in CI rather than at build time.

## Rules

- No `@repo/database`, `@repo/api`, `@repo/auth`, `@repo/collaboration`, or
  `server-only` imports. A Biome `noRestrictedImports` boundary rejects them.
- `@repo/app` imports are denied unless their exact mock-only preview adapter is
  recorded in `portableSurfaceAllowlist` as part of an approved
  production-bound componentization plan.
- No fetch, env reads, or persistence. Mock data lives next to the page.
- Keep fixtures, metadata, and routing self-contained in `app/p/<slug>/`. A
  production-bound surface and its stories/tests live in the owning
  `packages/app` feature slice.
