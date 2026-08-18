# Prototypes

In-repo prototype sandbox. Full design doc: [docs/design/prototype-sandbox.md](../../docs/design/prototype-sandbox.md).

Prototypes are presentational, mock-data-only references built from
`@repo/design-system` components. They merge to `main`, deploy behind Vercel
Authentication for the team, and are never reachable by end users.

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
2. Use only design-system components listed in
   `packages/design-system/storybook/component-catalog.ts` (skip entries marked
   `internal`).
3. Run `pnpm --filter prototypes generate:registry` and commit the updated
   `lib/registry.generated.ts`.
4. Validate: `pnpm --filter prototypes typecheck && pnpm --filter prototypes test`.
   The `test` script is the catalog-import gate. CI runs it on every PR (the
   pr-test.yml test job includes `--filter=prototypes`), so a non-catalog
   component import fails CI. Deploy builds stay test-free per FEA-1523, so
   the gate is enforced in CI rather than at build time.

## Rules

- No `@repo/database`, `@repo/api`, `@repo/auth`, `@repo/collaboration`, or
  `server-only` imports. The packages are not installed and a Biome
  `noRestrictedImports` boundary rejects them.
- No fetch, env reads, or persistence. Mock data lives next to the page.
- Keep each prototype self-contained in its `app/p/<slug>/` folder.
