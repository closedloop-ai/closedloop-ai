# API Contract Package Guidelines

## Scope and Boundaries

- `packages/api` should expose transport contracts and cross-process constants, not database provenance or auth-policy internals.
- Types in `packages/api/src/types/` are shared contract types used by **both** `apps/app` and `apps/api`. Do not put types here that are only used by one side; co-locate those in the relevant app instead.
- This package must stay independent of `@repo/database`. All types mirror the Prisma schema shape without importing from it. This ensures the package is safe to use in both client and server contexts.

## Const-Object Enums

Define exported contract value sets as PascalCase const objects with matching type aliases:

```ts
export const DocumentStatus = {
  Draft: "DRAFT",
  InProgress: "IN_PROGRESS",
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];
```

Biome forbids TypeScript `enum`; use the runtime const reference everywhere instead of duplicating strings. Import with a value import (not `import type`) when the const is used at runtime. Use `import type` only for type-position annotations.

Treat nested structured payload values such as `error.result.subcode` as contract values too. When they cross apps, packages, repos, or processes, define them in the shared API contract package and import the const members everywhere, including fixtures and assertions.

## Wire Contract Constants

For wire contracts crossing apps, packages, repos, or processes, define header names, reason strings, modes, and response-shape constants in one shared module and import them instead of duplicating literals.

## Zod Validators

When input shapes require validation, define Zod schemas co-located with the type in the same file (see `project.ts` for `repositoryOverridesValidator`). Use `z.safeParse()` for non-throwing validation of unknown JSON.

When a Zod schema validates an exported API contract type and multiple packages consume that contract, export the schema from the same `packages/api` type module as the type instead of duplicating equivalent schemas in consumers.

## Result Type

Keep `Result` from `@repo/api/src/types/result` as the shared shape for expected service outcomes such as conflicts, rate limits, or invalid state transitions.

## Re-exports and Barrel Files

`src/types/loop.ts` re-exports from `@closedloop-ai/loops-api` for backwards compatibility. Avoid adding new barrel re-exports — prefer direct subpath imports (`@closedloop-ai/loops-api/commands`). Biome's `noBarrelFile` rule applies.

## Subpath Imports

Callers import directly from `@repo/api/src/types/<file>` rather than a top-level index barrel. No `exports` map is required — pnpm workspace + TypeScript path resolution handles subpath imports.

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
