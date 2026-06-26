# Prisma Database Workflow

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

Explicit migration files for all schema changes. **Never use `prisma db push` for production.**

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

## Important Notes
- Commit both schema changes AND generated migration files
- Generated client: `packages/database/generated/` (configured in `prisma.config.ts`)
- `prisma generate` must run after any schema change to update TypeScript types
- **Never hand-write migration SQL files** — let `prisma migrate dev` generate the schema DDL. Hand-write only the data migration, drift repair, or Prisma-inexpressible SQL that Prisma cannot generate, and include comments explaining why manual SQL is required. Validate the repair against a throwaway database.
- **Foreign key mode** — DB-level FK constraints enforce referential integrity. Cascade deletes work both through Prisma client and direct SQL.
- **After every migration, verify seed compatibility** — run `pnpm seed` (or `pnpm exec ts-node scripts/seed.ts`) against the updated schema and confirm it completes without errors. The seed exercises model shapes at runtime; a breaking schema change that the seed doesn't account for will surface here before it reaches CI.
