# Prisma Database Workflow

This project uses **explicit migration files** for all schema changes. Never use `prisma db push` for changes that will go to production.

## Daily Development Workflow

### Applying Existing Migrations

When pulling new code that includes migrations:

```bash
pnpm migrate
```

This applies all pending migrations and regenerates the Prisma client.

### Creating New Migrations

When you modify `packages/database/prisma/schema.prisma`:

```bash
# Create and apply a new migration
pnpm migrate --name <descriptive_name>
```

**Migration naming conventions:**
- `add_user_preferences_table`
- `add_index_on_artifact_status`
- `rename_foo_to_bar`

This command:
1. Detects schema changes
2. Generates a SQL migration file in `prisma/migrations/`
3. Applies it to your local database
4. Automatically runs `prisma generate` to update TypeScript types

**Always commit both the schema change AND the generated migration files.**

### Creating Migrations with Custom SQL

If you need to add custom SQL (indexes, constraints, data migrations):

```bash
# Generate migration without applying it
pnpm migrate --create-only --name <descriptive_name>

# Edit the generated .sql file in prisma/migrations/
# Then apply it:
pnpm migrate
```

## First-Time Setup (Existing Database)

If you have an existing local database that was created with `db push`, you need to baseline it:

```bash
cd packages/database

# Check which migrations are pending
pnpm prisma migrate status

# Mark existing migrations as already applied (without running them)
pnpm prisma migrate resolve --applied <migration_name>
```

## Quick Reference

| Command | Use Case |
|---------|----------|
| `pnpm migrate` | Apply pending migrations (daily workflow) |
| `pnpm migrate:status` | Check which migrations are pending |
| `pnpm migrate --name <name>` | Create and apply a new migration |
| `pnpm migrate --create-only --name <name>` | Create migration file without applying (for custom SQL) |
| `pnpm prisma migrate resolve --applied <name>` | Mark migration as applied without running it (baselining) |
| `pnpm prisma migrate deploy` | Apply migrations in production (CI/CD) |
| `pnpm prisma generate` | Regenerate Prisma client after schema changes |
| `pnpm prisma studio` | Open GUI to browse/edit data |

## Production Deployment

Migrations are applied in CI/CD using:

```bash
cd packages/database && pnpm prisma migrate deploy
```

This applies all pending migrations without prompting for input.

## Important Notes

- **Never use `prisma db push` for production changes** - it doesn't create migration files and causes environment drift
- **Always run migrations before modifying data** - the migration history ensures all environments stay in sync
- **Commit migration files to git** - they are the source of truth for schema evolution
- The generated Prisma client lives in `packages/database/generated/` (configured in `prisma.config.ts`)
- After any schema change, `prisma generate` must run to update TypeScript types
- **relationMode = "prisma"** - The schema uses Prisma-managed relations; there are no DB-level foreign key constraints. Cascade deletes only run through the Prisma client. Direct SQL deletes (e.g. of parent rows) can leave orphaned child rows; document this in migrations that drop FKs.

## Learned Patterns

- **[mistake]**: When `pnpm typecheck` fails with "Property does not exist on type" for Prisma model fields or `TransactionClient`, do NOT dismiss these as "pre-existing" without checking. Run: (1) `pnpm install`, (2) `just db-generate` or `cd packages/database && pnpm prisma generate`. Verify fields exist in `schema.prisma` first — if they do, the generated client is just stale. (context: prisma|typecheck|generated-client|stale-types)
- **[convention]**: When using Prisma enums, always verify valid values in `packages/database/prisma/schema.prisma` - don't assume names (e.g., GitHubActionStatus uses `SUCCESS` not `COMPLETED`). (context: prisma|enums|schema)
- **[pattern]**: To filter Prisma `Json` fields by nested property, use `{ path: ['key'], equals: value }` syntax - not dot notation or direct equality. (context: prisma|json-filter)
- **[pattern]**: When filtering Prisma `Json` fields, always scope through indexed fields first (e.g., workstreamId + status) before applying JSON path filters. JSON path filters cause sequential scans without index narrowing. (context: prisma|json-filter|performance|indexes)
- **[pattern]**: When adding a taxonomy layer to an existing enum (e.g., type/subtype), prefer adding a new category field with a default value rather than renaming - avoids touching every reference site. (context: prisma|schema-design|enum-evolution)
- **[convention]**: `Artifact.subtype` is non-nullable in both the DB schema and API type. All creation paths require a subtype — don't make it nullable for speculative forward-compatibility. (context: prisma|schema-design|api-contract|artifact)
- **[pattern]**: When renaming Prisma enums, `@repo/database` re-exports Prisma-generated types via `export *` in `packages/database/index.ts`. Files importing from `@repo/database` (like `artifact-utils.ts`) need separate treatment from files importing from `@repo/api/src/types/`. Both sources must be updated in sync. (context: prisma|enum|rename|database-reexport)
- **[pattern]**: `validateOwnerInOrg` uses `withDb` (non-transactional) but is called from inside `withDb.tx` callbacks. The `withDb.tx` implementation does NOT store the transaction in AsyncLocalStorage, so nested `withDb` calls open separate connections instead of reusing the transaction. (context: database|transactions|withDb|connection-pool)
- **[pattern]**: In this project's multi-org architecture (one User record per Clerk user per org), service methods that update profile data (name, avatar, email) should use `updateMany({ where: { clerkId } })` to sync across all organizations. (context: multi-org|prisma|service-layer|user-profile)
