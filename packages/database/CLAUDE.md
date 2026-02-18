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
