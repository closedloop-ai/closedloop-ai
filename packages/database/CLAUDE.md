# Prisma Database Workflow

Explicit migration files for all schema changes. **Never use `prisma db push` for production.**

## Quick Reference

Commands below use `pnpm exec` to pass flags directly to Prisma. From repo root, prefix with `pnpm --filter database`.

| Command (from `packages/database`) | Use Case |
|---------|----------|
| `pnpm migrate` | Apply pending migrations + regenerate client |
| `pnpm migrate:status` | Check pending migrations |
| `pnpm exec prisma migrate dev --name <name>` | Create + apply new migration |
| `pnpm exec prisma migrate dev --name <name> --create-only` | Create migration file only (for custom SQL edits) |
| `pnpm prisma migrate resolve --applied <name>` | Mark as applied without running (baselining) |
| `pnpm prisma migrate deploy` | Production (CI/CD) — applies pending without prompts |
| `pnpm prisma generate` | Regenerate client after schema changes |
| `pnpm prisma studio` | GUI for browsing/editing data |

**From repo root:** `pnpm --filter database exec prisma migrate dev --name <name> [--create-only]`

**Migration naming:** `add_user_preferences_table`, `add_index_on_artifact_status`, `rename_foo_to_bar`

## Important Notes
- Commit both schema changes AND generated migration files
- Generated client: `packages/database/generated/` (configured in `prisma.config.ts`)
- `prisma generate` must run after any schema change to update TypeScript types
- **Never hand-write migration SQL files** — always let `prisma migrate dev` generate them. Hand-written migrations miss Prisma's drift detection, FK cleanup, and standard formatting. First update the schema, then run the migrate command and let Prisma diff the schema against the database. Hand-written migration files cause schema drift.
- **Foreign key mode** — DB-level FK constraints enforce referential integrity. Cascade deletes work both through Prisma client and direct SQL.

## Learned Patterns
- **[mistake]**: Typecheck "Property does not exist" on Prisma fields: run `pnpm install` + `just db-generate`. Verify fields exist in schema first — generated client may be stale.
- **[convention]**: Verify Prisma enum values in `schema.prisma` — don't assume (e.g., `SUCCESS` not `COMPLETED`).
- **[pattern]**: Filter Json fields: `{ path: ['key'], equals: value }` syntax, not dot notation.
- **[pattern]**: Json field filters: scope through indexed fields first (workstreamId + status) before JSON path. JSON path = sequential scan.
- **[pattern]**: Adding taxonomy to enum: prefer new category field with default over renaming existing enum.
- **[convention]**: `Artifact.subtype` is non-nullable in DB and API. All creation paths require subtype.
- **[pattern]**: Renaming Prisma enums: `@repo/database` re-exports via `export *`. Both `@repo/database` and `@repo/api/src/types/` imports must update in sync.
- **[resolved]**: `validateOwnerInOrg` uses `withDb` (non-tx) but called from `withDb.tx`. Nested `withDb` now participates in the parent transaction via AsyncLocalStorage propagation — resolved by AsyncLocalStorage implementation.
- **[pattern]**: Multi-org user profile updates: `updateMany({ where: { clerkId } })` to sync across all organizations.
- **[pattern]**: To test AsyncLocalStorage propagation in withDb/withDb.tx without mocking ALS itself, inject a mock PrismaClient via the globalForPrisma global cache in beforeEach and clear it in afterEach — this lets real ALS run while avoiding real DB connections. (context: database|AsyncLocalStorage|testing|withDb)
