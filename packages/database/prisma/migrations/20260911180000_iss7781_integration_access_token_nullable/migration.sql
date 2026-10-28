-- ISS-7781: let a successful token encryption CLEAR the legacy plaintext column.
--
-- The encrypted-token migration shipped its reader and its backfill but never
-- its write-path leg: every OAuth connect and every token refresh re-populated
-- `access_token`/`refresh_token`, so each backfill run was undone by the next
-- refresh and the migration could never converge. `refresh_token` was already
-- nullable; `access_token` was not, which is what made "write encrypted only"
-- impossible to express.
--
-- WIDENING ONLY — no data is touched and no row is invalidated. An already
-- deployed API that still writes plaintext keeps working against this schema
-- unchanged, so applying this ahead of the code is always safe.
--
-- THE REVERSE ORDER IS NOT SAFE, and it is not guaranteed everywhere. On
-- production `@repo/database`'s `prebuild` runs `scripts/migrate.ts` and
-- `build.dependsOn: ["^build"]` orders it ahead of the `api` build, so the
-- migration lands first. On api-stage it does NOT: `BUILD_MIGRATE_ENABLED=0`
-- makes that prebuild a no-op (ISS-4489, to keep stage builds off Secure
-- Compute), and stage's `public` schema is migrated by the separate
-- `migrate-public` job instead. If `apps/api` reaches stage before that job
-- runs this migration, every OAuth connect and refresh fails on a NOT NULL
-- violation until it does.
--
-- The columns themselves are NOT dropped here: `resolveIntegrationToken` still
-- reads them as the pre-migration fallback, and rows that predate the cutover
-- still hold their only credential there. Dropping them is a later, separately
-- approved step.
ALTER TABLE "linear_integrations" ALTER COLUMN "access_token" DROP NOT NULL;

ALTER TABLE "google_integrations" ALTER COLUMN "access_token" DROP NOT NULL;
