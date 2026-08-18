# Loops API Package Guidelines

## Session status vocabulary — MOVED

ISS-5592 relocated `session-status.ts` out of this package. The vocabularies now
live in `@repo/api`:

- `packages/api/src/types/session-status.ts` — the values, folds, and normalizers.
- `packages/api/src/types/session-status-display.ts` — the labels and the
  unknown/stale sentences.

The contract is documented in `packages/api/AGENTS.md`; the three-value lifecycle
rule that binds every surface stays in the root `AGENTS.md` ("Session State").
Nothing in this package imports the vocabulary — do not re-add a copy here.

## Contract values

- Define exported loop contract value sets as PascalCase const objects with matching type aliases. Biome forbids TypeScript `enum`; use runtime const references everywhere instead of duplicating strings.
- Keep loop command, artifact, document, and status contract values available as shared constants for production code and tests. Do not add raw fixture strings such as `"EVALUATE_CODE"`, `"EVALUATE_PRD"`, `"PRD"`, `"FEATURE"`, or `"IMPLEMENTATION_PLAN"` when constants such as `LoopCommand`, `LoopArtifactType`, and `DocumentType` are available.

## Credential-shape vocabulary (ISS-6233)

This package owns the **telemetry** credential-shape vocabulary: `src/secret-value-pattern.ts` is the single declaration of what a leaked token looks like for `@repo/observability/redact` (the Datadog intake and the log-drain JSON line) and `apps/desktop/src/shared/exception-sanitizer` (the desktop exception path). It had been hand-copied byte-for-byte into both; never re-declare the alternation in a consumer, derive from `SECRET_VALUE_FAMILY_SOURCE`. The fixture table in `src/secret-value-pattern.test.ts` is typed `Record<SecretValueFamily, string>`, so a family added without a fixture fails `pnpm -C packages/loops-api typecheck` (not the test run — vitest transpiles without typechecking).

It lives at the package root, not under `src/observability/`, because `exception-sanitizer` sits inside the desktop OTel-runtime egress boundary and `app-otel-runtime-no-egress` (`apps/desktop/scripts/dependency-cruiser.config.cjs`) forbids that boundary from reaching any module path containing "observability". Moving it reintroduces that error. It also stays import-free on purpose — `redact.ts` is reachable from client components, so a module pulling in zod here would land in those bundles.

**A second, deliberately separate vocabulary exists.** `packages/lib/security/redact-secrets.ts` owns the **session-transcript** one — different sink, different `[REDACTED:<label>]` markers, and a genuinely different family set in both directions. The two are not reconciled and nothing enforces agreement between them; the divergence is enumerated in `src/secret-value-pattern.ts`'s header, which is prose, not a guard. Never assume a family covered by one is covered by the other.
