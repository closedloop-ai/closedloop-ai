# Database Package Guidelines

Explicit migration files for all schema changes. **Never use `prisma db push` for production.**

> ⚠️ **Applying a migration mutates the shared local database — get explicit user permission first.** The rows marked *"Create + apply"* below, plus `pnpm migrate` and `just db-migrate`, **apply** the migration as they create it, and the local Postgres is one instance shared by every git worktree. Default to `--create-only` (writes the migration file, applies nothing) and run an applying command only with the user's explicit go-ahead. To clear drift from an already-applied migration, surgically drop the object and `DELETE` its `_prisma_migrations` row — **never accept Prisma's offer to reset the schema**.

## Migration Rules

- For Prisma schema changes, generate migrations with `prisma migrate dev` or `prisma migrate dev --create-only`; only hand-edit the generated SQL for constructs Prisma cannot express, such as partial unique indexes.
- Do not edit a migration that has already landed on `main`. If a shipped migration needs follow-up behavior, add a new migration or document the local-only repair separately instead of changing historical SQL. Deleting a landed migration's file falls under the same rule rather than around it: ISS-4565 (#4080) did it once, with human approval and behind a CI allowlist, because removing the statement from the tree was the only way to stop a write-blocking `CREATE INDEX` from reaching prod. Before reverting a landed migration, read `docs/runbooks/prisma-local-migration-revert-recovery.md` — the deletion is what strands every local database that already applied it.
- Do not dual-write the same data or entity to both an old table and its replacement table. It is acceptable to create a future replacement table while writes continue only to the existing table, provided the replacement table is not also on the write path for that data. When cutting over to the replacement table, migrate existing data, update readers and writers to the replacement schema, and remove the old table in the same migration/change. If that one-step cutover is not feasible, stop and get explicit human approval for a staged migration strategy before coding it.
- When fixing Prisma drift, checksum, or `pnpm migrate` failures, first repair the invalid schema or migration-history state so Prisma's standard workflow keeps working. Do not replace `pnpm migrate`, `just db-migrate`, or `prisma migrate dev` behavior with custom wrappers, shadow-database emulation, or alternate migration pipelines unless a human explicitly approves changing the command contract after the standard Prisma repair path has been proven insufficient.
- After adding or hand-editing a Prisma migration, especially one with manual SQL for foreign keys, indexes, partial indexes, triggers, or constraints, verify the Prisma dev workflow in addition to deploy/build. Apply the tracked migrations to a throwaway database, then run `prisma migrate dev` or `just db-migrate` and confirm it reports no schema changes and creates no migration directory.
- For Prisma-managed constraints, keep migration SQL names aligned with `schema.prisma`: use Prisma-generated constraint names, or add explicit `map:` names in the Prisma schema where supported. Do not invent manual foreign-key or index names that are functionally valid in Postgres but differ from Prisma's expected schema.
- `prisma migrate deploy`, staging deploys, and generic build checks are not sufficient Prisma drift checks because they apply SQL but do not prove Prisma's dev shadow-database comparison is clean.
- For Prisma schema changes, add indexes only for a concrete current access path: query filters, sort order, uniqueness, rate limiting, cleanup, or ownership checks. Do not add indexes for write-only metadata or speculative future queries; prefer composite indexes that match the full predicate when the current code filters on multiple columns.
- When adding a unique index or constraint to an existing table, the migration must handle or explicitly preflight existing rows that already violate the new invariant before creating the constraint. Do not assume old app-level validation made invalid persisted states impossible, especially when the new constraint closes a race. If cleanup changes persisted identity fields, also account for adjacent unique constraints and the first normal write path that will reconcile the cleaned rows.
- Partial unique indexes that scope uniqueness through nullable columns must include non-null predicates for every nullable scope column required for the identity, unless duplicate rows after nulling that scope are intentional and documented in the migration or PR.
- Destructive cutover migrations that drop or replace a legacy table must make fail-closed guards classify every legacy row family and terminal/deleted state that can still exist in production. Add focused migration coverage for each source kind and tombstoned/soft-deleted projection that should satisfy the cutover guard.
- When backfilling newly required discriminator or source-kind columns during destructive cutovers, derive the value from the authoritative legacy row or fail closed on NULL or ambiguous values. Do not use a blanket enum default that can reclassify legacy row families.
- Prisma migrations should be generated from `schema.prisma` with Prisma tooling, using `prisma migrate dev` or `prisma migrate diff` when regenerating an existing branch migration from a known baseline. Do not hand-write migration SQL unless the Prisma CLI cannot express the required operation; if manual SQL is required, document why in the migration or PR.
- `CREATE INDEX CONCURRENTLY … IF NOT EXISTS` **no-ops over an INVALID index** left behind by a cancelled concurrent build, and the existing P3018 recovery then records the migration as applied — a green deploy with an unusable index. Since ISS-4601 the deploy sweeps the target schema for `indisvalid = false` after `migrate deploy` (`scripts/invalid-index-sweep.ts`): it names each index plus its `DROP INDEX CONCURRENTLY` + direct-rebuild recovery, qualifies the migrate step's completion line, and carries `invalid_index_count` on the `migrate_deploy` telemetry event. It **warns, never fails** — the condition is sticky, so failing closed would block every later deploy including the fix. Do not add an in-file `DO`-block guard to a migration to catch this: it forces Prisma's whole-file transaction wrap and the migration then fails unconditionally with SQLSTATE 25001.
- A dedupe migration must not pick a survivor by `created_at` alone and cascade the rest. A duplicate may have been returned to users and edited after the race, so the oldest row is not necessarily the canonical content. Preflight, reconcile explicitly onto the selected canonical version, or block for manual cleanup before adding the constraint.
- **An index's stated rationale must match the query that will actually use it.** Pin the EXPLAIN to the real access path from the query builder (the actual date field and default sort), not an adjacent column — otherwise the "index is used" claim is unproven even when the index is helpful.
- Adding an enum value to `schema.prisma` is not additive on its own: every lifecycle classifier that switches on it (`statusOptionsForSubtype`, `isTerminalStatusForSubtype`, terminal/blocker checks) must classify the new value in the same change through the lifecycle SSOT, or a stored row silently follows the wrong lifecycle. Cover the stored-new-value case for single and batch status writes.
- Preview/skip registrations for heavy migrations must work on a **brand-new** preview. A prestamp path that only copies an already-finished row from `public._prisma_migrations` cannot skip a migration that has never landed there, so the first preview runs the expensive build anyway.
- Every new migration that adds an index, constraint, enum value, or foreign key must ship with a focused DDL or behavior test for that migration. Apply this rule prospectively; do not backfill tests for historical migrations. When a test inspects migration SQL, it must assert required clauses against the **specific DDL statement** under test; a migration-wide substring match must not satisfy a per-object assertion.

## Quick Reference

Commands below are explicit about their working directory. Use root commands for daily local setup and direct Prisma commands when authoring migrations.

| Command | Use Case |
|---------|----------|
| `pnpm migrate` or `just migrate` from repo root | Apply pending migrations + regenerate client |
| `pnpm migrate:status` from repo root | Check pending migrations |
| `just db-migrate <name>` from repo root | Create + apply new migration |
| `pnpm exec prisma migrate dev --name <name>` from `packages/database` | Create + apply new migration |
| `pnpm exec prisma migrate dev --name <name> --create-only` from `packages/database` | Create migration file only (for custom SQL edits) |
| `pnpm prisma migrate resolve --applied <name>` from `packages/database` | Mark as applied without running (baselining) |
| `pnpm prisma migrate deploy` from `packages/database` | Production (CI/CD) — applies pending without prompts |
| `pnpm prisma generate` from `packages/database` | Regenerate client after schema changes |
| `pnpm prisma studio` from `packages/database` | GUI for browsing/editing data |

Root `pnpm migrate` runs Prisma's standard local `migrate dev` workflow.

Reverted migration stranded your local DB? **Never accept Prisma's reset** — see
`docs/runbooks/prisma-local-migration-revert-recovery.md`.

A deploy retry reporting SQLSTATE `42P07` / `42701` / `42710` after a rolled-back resolve is a
`partial_committed_ddl_artifact` — see `docs/runbooks/prisma-deploy-migration-recovery.md`.

**Migration naming:** `add_user_preferences_table`, `add_index_on_artifact_status`, `rename_foo_to_bar`

## Deploy-time migration concurrency

Deploys serialize `prisma migrate deploy` (`@repo/database`'s `prebuild` → `scripts/migrate.ts`) through `scripts/migration-lock.ts` (`withMigrationSerializeLock`), with the `scripts/migrate-retry.ts` P1002 advisory-lock retry as backstop. Do NOT set `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` — it removes the serialization that protects `_prisma_migrations` when two deploys hit the same schema.

## Runtime pool

- **Read `pool.options.max`; never hardcode 20 as the pool ceiling.** Size fan-outs against `DB_POOL_MAX_DATABASE_URL_DEFAULT` (the smaller, `DATABASE_URL` branch), as `apps/api/lib/db-fanout.ts` does, not against the IAM ceiling.
- **Never raise `max` as a remedy for pool pressure.** Instances × pool size marches toward the server's `max_connections` and converts an app-level failure into SQLSTATE 53300; PRD-528 non-goals resizing.
- `pool-telemetry.ts` has **no `@repo/*` imports by design** — `apps/mcp` packages `@repo/database` through a narrow Docker context, so the emitter is injected via `setPoolTelemetrySink()` (wired in `apps/api/instrumentation.ts`). **Do not import `@repo/observability` here** — it would build green locally and break the mcp image at runtime.

## Important Notes
- Commit both schema changes AND generated migration files
- Generated client: `packages/database/generated/` (configured in `prisma.config.ts`)
- `prisma generate` must run after any schema change to update TypeScript types
- **Never hand-write migration SQL files** — let `prisma migrate dev` generate the schema DDL. Hand-write only the data migration, drift repair, or Prisma-inexpressible SQL that Prisma cannot generate, and include comments explaining why manual SQL is required. Validate the repair against a throwaway database.
- **Foreign key mode** — DB-level FK constraints enforce referential integrity. Cascade deletes work both through Prisma client and direct SQL.
- **After every migration, verify seed compatibility** — run `pnpm -C packages/database seed` against the updated schema and confirm it completes without errors. The seed exercises model shapes at runtime; a breaking schema change that the seed doesn't account for will surface here before it reaches CI.
- **Verify enum values against `schema.prisma`; don't assume** (e.g. `SUCCESS`, not `COMPLETED`). `Document.type` is non-nullable in DB and API — every creation path must supply it.
- **Renaming a Prisma enum:** `@repo/database` re-exports via `export *`, so `@repo/database` and `@repo/api/src/types/` imports must be updated in sync. When adding taxonomy, prefer a new category field with a default over renaming an existing enum.
- **Json field filters:** use `{ path: ['key'], equals: value }`, not dot notation, and scope through indexed columns first (e.g. `workstreamId` + `status`) — a JSON path alone is a sequential scan.
- **Multi-org user profile updates:** `updateMany({ where: { clerkId } })` to sync across every organization.
- **Testing `withDb` / `withDb.tx` AsyncLocalStorage propagation:** inject a mock `PrismaClient` through the `globalForPrisma` global cache in `beforeEach` and clear it in `afterEach` — real ALS runs, no real DB connection, and ALS itself is never mocked.
