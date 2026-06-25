# Prisma Database Workflow

This project uses **explicit migration files** for all schema changes. Never use `prisma db push` for changes that will go to production.

## Daily Development Workflow

### Applying Existing Migrations

When pulling new code that includes migrations:

```bash
# From the repo root
pnpm migrate
```

This applies all pending migrations and regenerates the Prisma client.

### Creating New Migrations

When you modify `packages/database/prisma/schema.prisma`:

```bash
# Create and apply a new migration
just db-migrate <descriptive_name>
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
cd packages/database
pnpm exec prisma migrate dev --create-only --name <descriptive_name>

# Edit the generated .sql file in prisma/migrations/
# Then apply it:
cd ../..
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
| `pnpm migrate` from repo root | Apply pending migrations and regenerate the Prisma client |
| `pnpm migrate:status` from repo root | Check which migrations are pending |
| `just db-migrate <name>` from repo root | Create and apply a new migration |
| `pnpm exec prisma migrate dev --name <name> --create-only` from `packages/database` | Create migration file without applying it |
| `pnpm prisma migrate resolve --applied <name>` from `packages/database` | Mark migration as applied without running it (baselining) |
| `pnpm prisma migrate deploy` from `packages/database` | Apply migrations in production (CI/CD) |
| `pnpm prisma generate` from `packages/database` | Regenerate Prisma client after schema changes |
| `pnpm prisma studio` from `packages/database` | Open GUI to browse/edit data |

## Troubleshooting

Root `pnpm migrate` runs Prisma's standard local `migrate dev` workflow.

If `pnpm migrate` fails after switching branches or pulling main:

1. Run `pnpm migrate:status` from the repo root to inspect pending or failed migrations.
2. Preserve the failing output; do not wrap the command in a shell fallback that exits successfully.
3. If the local database is disposable, run `cd packages/database && pnpm prisma migrate reset` to rebuild it from migration history. This drops local data.
4. If the local data must be preserved, reconcile the reported failed migration or checksum intentionally instead of resetting.

If deploy output includes `P0001`, a user-defined migration invariant raised an
exception from Postgres. The deploy runner intentionally fails fast for this
case: it does not mark the migration rolled back, does not retry deploy, and
does not reset or re-register preview schemas. Preserve the failing output,
avoid sharing credential-bearing connection strings or IAM token material, fix
the data or migration invariant, then rerun migrations.

The existing recovery paths still apply to non-`P0001` Prisma wrappers such as
`P3005`, `P3009`, and `P3018` according to the deploy runner's preview and
non-preview safeguards.

If non-preview deploy recovery first resolves a failed migration as rolled back
and the retry then reports PostgreSQL SQLSTATE `42P07` (relation already
exists), `42701` (column already exists), or `42710` (object already exists,
e.g. a constraint, type/enum, or trigger), the runner diagnoses a
`partial_committed_ddl_artifact` and stops. It does not reset schemas, retry
again, or mark the migration applied automatically. Preserve the original
deploy output for investigation, verify that the existing database objects
match the intended migration, then choose one of the safe operator actions:
run `prisma migrate resolve --applied <migration>` after verification, or
create a corrective forward-only migration.


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

## Database Seeding

After signing in locally (so Clerk has created a user and organization row), populate the database with synthetic data. Invoke the script from `packages/database` (or from anywhere with `pnpm --filter`):

```bash
# From packages/database
pnpm seed

# From the repo root
pnpm --filter=@repo/database seed
```

**Prerequisite:** `DATABASE_URL` must point to a Postgres database. The seed script will exit with an error if the variable is unset.

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"
pnpm --filter=@repo/database seed
```

**Profiles and deterministic RNG.** The shared seed CLI accepts `--profile minimal|local|ci-preview|perf`, `--scale-multiplier <number>`, and `--rng-seed <seed>`. The default profile is `local`. The `perf` profile requires `STAGE_PGHOST` and refuses the configured shared-stage host unless `--allow-shared-stage` is passed.

**Production safety guard.** The CLI fails closed if the hostname matches a known production pattern (`cl-ai-prod`, `.prod.`, `production`, `prod-`) and refuses to connect to any non-localhost hostname unless `SEED_ALLOW_REMOTE=1` is set explicitly. The full production guard (denylist + confirmation flow) is tracked in [FEA-1328](https://app.closedloop.ai/features/FEA-1328) — until that lands, treat the in-CLI check as defense-in-depth, not a security boundary.

**Empty-org precondition.** The seed assumes a near-empty organization (one `Organization` row, one `User` row, nothing else). It uses deterministic IDs as the idempotency key, but the underlying schema enforces several global / per-org unique constraints — `GitHubInstallation.installationId`, `LinearIntegration.organizationId`, `SlackIntegration.organizationId`, `(organizationId, slug)` on projects/workstreams, and so on. If the resolved organization already has any of those rows, the seed's `create` block would either fail with a unique-constraint violation or partially mutate real integration metadata (while preserving real secrets). The CLI now refuses to proceed in that case. Set `SEED_FORCE_OVERWRITE=1` to override — only safe on a disposable database (staging restore, preview env) where you accept the risk of clobbering existing data.

**Reset mode.** Use `pnpm seed -- --reset` to delete resettable data owned by the resolved organization and reseed with the selected profile. Reset preserves the `Organization` row and `User` rows, clears organization/user Claude key fields plus `Organization.publicDashboardToken` and `User.preferredComputeTargetId`, deletes org-owned credential/runtime/integration/seed rows, verifies no resettable rows remain, then runs the normal seed flow. Reset does not require `SEED_FORCE_OVERWRITE`.

```bash
# Interactive: type the displayed organization UUID to confirm.
pnpm seed -- --reset --profile minimal

# Non-interactive/CI: still fails on production, remote, shared-stage, or ambiguous targets.
pnpm seed -- --reset --force --organization-id <uuid> --user-id <uuid>
```

When multiple organizations exist, pass `--organization-id`; when the target organization has multiple users, pass `--user-id`. `--force` only skips the prompt after guard and ambiguity checks pass. Reset logs show UUIDs, profile, target source, and model row counts only. They intentionally omit organization names/slugs, full emails, credential values, tokens, and connection strings.

Destructive reset against a non-localhost target requires its own opt-in beyond `SEED_ALLOW_REMOTE`. Set `SEED_RESET_ALLOW_REMOTE=1` (in addition to `SEED_ALLOW_REMOTE=1`) to allow `--reset` against a remote dev or preview host. Without it, `--reset --force` on a non-localhost URL fails with `remote_reset_requires_explicit_opt_in` before any DB write. Production hostnames remain blocked regardless of either flag.

**SSL configuration.** The seed honors `sslmode` in the URL and defaults to TLS with server certificate verification (`rejectUnauthorized: true`) for non-localhost connections. The full policy is:

| URL host | `sslmode` | `ALLOW_INSECURE_SSL` env | Result |
|---|---|---|---|
| `localhost` / `127.0.0.1` / `::1` | any | any | No TLS |
| any non-localhost | `disable` | any | No TLS |
| any non-localhost | (unset or any other) | `1` | TLS, no cert verification (legacy / self-signed RDS) |
| any non-localhost | (unset or any other) | (unset) | TLS with cert verification (safe default) |

`ALLOW_INSECURE_SSL=1` is an escape hatch for talking to self-signed RDS endpoints that lack a trusted chain — do not set it for interactive/manual seed runs (the strict-verification default is correct there). The one intentional exception is the **automated preview seed** (`runPreviewSeed` → `buildPreviewSeedInvocation` in `scripts/preview-seed.ts`), which always sets it so the seed connects to the RDS preview endpoint with the same `rejectUnauthorized: false` posture as the runtime app pool (`index.ts`) and `prisma migrate deploy` — the seed is otherwise the only path that would verify that chain strictly, which broke preview seeding (FEA-1786).

**What it does:**
1. Resolves the target user and organization from the database — run after at least one sign-in so the rows exist. No-reset defaults to the legacy first-user target; reset fails closed on ambiguous targets.
2. Optionally resets org-owned data when `--reset` is passed, preserving identity rows and clearing sensitive/runtime scalars.
3. Seeds core entities (teams, projects, workstreams, artifacts), then execution, integration, evaluation, and customization data in FK-dependency order, using the selected profile.
4. Logs progress per module and prints a row-count summary on success. Stdout includes the resolved org/user UUIDs and a redacted email (`<redacted>@example.com`); it never prints the resolved user's full email or the organization's name/slug, because CI logs and incident artifacts retain stdout.

**Expected output:**

```
[seed] Initializing PrismaClient...
[seed] Resolving user and organization from database...
[seed] Resolved organization: 01933...
[seed] Resolved user: 01934... (<redacted>@example.com)
[seed] Starting seed for organizationId=... userId=...
[seed] Total rows seeded per model:
[seed]   Team:                        2
[seed]   Project:                     5
  ...
[seed] All target models verified: non-zero population confirmed
[seed] Seed complete
```

If any model ends up with zero rows the script throws — the error message names the unpopulated models. Note: the per-model verification runs **after** the seed transaction has committed, so any partial data is left in place. Re-running `pnpm seed` is idempotent (all upserts) and is the recommended path once the underlying cause is fixed; the integration tests' `teardownEphemeralDb` is the only path that wipes a partially-seeded org cleanly.

## Running Tests

```bash
# Unit tests (no database required). `pnpm test` is an alias for this — both
# explicitly exclude `**/integration/**` so they can be safely invoked through
# turbo's workspace test graph (where `api#test` lists `^test` as a dependency).
pnpm test
pnpm test:unit

# Integration tests — require DATABASE_URL pointing to a real Postgres database.
# These connect to the database, exercise the full seed graph, and assert
# against live row counts. They are NOT included in `pnpm test`.
DATABASE_URL="postgresql://..." pnpm test:integration
```

The CI workflow runs `pnpm test:integration` in its own dedicated Postgres service
container (job `database-integration-tests`) so it stays isolated from the unit
test job that exercises `apps/api` against a shared Postgres container.
