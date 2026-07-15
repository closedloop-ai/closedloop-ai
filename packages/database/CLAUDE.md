# Prisma Database Workflow

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

Explicit migration files for all schema changes. **Never use `prisma db push` for production.**

> ⚠️ **Applying a migration mutates the shared local database — get explicit user permission first.** The rows below marked *"Create + apply"*, plus `pnpm migrate` and `just db-migrate`, **apply** the migration as they create it. The local Postgres is **one instance shared by every git worktree**, so applying from a feature branch writes into the shared migration history and makes every other worktree (e.g. `main`) report drift — Prisma then offers to **reset the schema, wiping all local data**. Default to `--create-only` (generates the migration file, applies nothing) and run an applying command only with the user's explicit go-ahead. To clear drift from an already-applied migration, surgically drop the object and `DELETE` its `_prisma_migrations` row — never accept the reset.

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

If non-preview deploy recovery first resolves a failed migration as rolled back
and the retry then reports PostgreSQL SQLSTATE `42P07` (relation already
exists), `42701` (column already exists), or `42710` (object already exists,
e.g. a constraint, type/enum, or trigger), the runner diagnoses a
`partial_committed_ddl_artifact` and stops. It does not reset schemas, retry
again, or mark the migration applied automatically. Preserve the original
deploy output, verify that existing database objects match the migration, then
either run `prisma migrate resolve --applied <migration>` after verification or
create a corrective forward-only migration.

**Migration naming:** `add_user_preferences_table`, `add_index_on_artifact_status`, `rename_foo_to_bar`

## Deploy-time migration concurrency (FEA-3062 / FEA-3065)

Every `apps/api` Vercel deploy runs `prisma migrate deploy` (via `@repo/database`'s
`prebuild` → `scripts/migrate.ts`). Prisma serializes all deploys on ONE hardcoded,
per-database advisory lock (`pg_advisory_lock(72707369)`, fixed 10s acquire timeout),
so concurrent deploys on the same physical DB (an api-stage `public` deploy plus a
burst of `preview_*` deploys on the shared stage instance) can collide → **P1002**
"Timed out trying to acquire a postgres advisory lock".

Two composed defenses live in `scripts/`:
- **Primary — serialization gate** (`migration-lock.ts`, `withMigrationSerializeLock`):
  wraps the migrate step in our OWN bounded blocking advisory lock
  (`pg_advisory_lock(30650000)` under `statement_timeout`), so only one process runs
  `prisma migrate deploy` at a time and Prisma's lock stays uncontended.
- **Backstop — retry** (`migrate-retry.ts`, `MIGRATE_DEPLOY_RETRY`): if the gate
  fails open (any acquire error, incl. budget timeout), the P1002 advisory-lock retry
  still re-attempts the migrate.

The gate budget (`MIGRATION_SERIALIZE_LOCK_BUDGET_MS`, 300 s) has a ceiling: it holds
≈ **10 stacked ~30 s migrates**. Past that a waiter's `statement_timeout` cancels the
acquire (SQLSTATE 57014), it fails open, and those deploys are back to colliding on
Prisma's lock + the FEA-3062 retry — i.e. the gate's protection **weakens as preview
deploy fanout grows**. Safe (fail-open never fails a would-succeed migrate), but if
concurrent preview volume climbs well past ~10, revisit: raise the budget, or move
migrate out of the per-preview build (see FEA-3071 / the "single migrator" option).

Do NOT set `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` — it removes the serialization that
protects `_prisma_migrations` when two deploys hit the same schema.

## Important Notes
- Commit both schema changes AND generated migration files
- Generated client: `packages/database/generated/` (configured in `prisma.config.ts`)
- `prisma generate` must run after any schema change to update TypeScript types
- **Never hand-write migration SQL files** — let `prisma migrate dev` generate the schema DDL. Hand-write only the data migration, drift repair, or Prisma-inexpressible SQL that Prisma cannot generate, and include comments explaining why manual SQL is required. Validate the repair against a throwaway database.
- **Foreign key mode** — DB-level FK constraints enforce referential integrity. Cascade deletes work both through Prisma client and direct SQL.
- **After every migration, verify seed compatibility** — run `pnpm seed` (or `pnpm exec ts-node scripts/seed.ts`) against the updated schema and confirm it completes without errors. The seed exercises model shapes at runtime; a breaking schema change that the seed doesn't account for will surface here before it reaches CI.
