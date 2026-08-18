#!/usr/bin/env node
/**
 * Runs Prisma migrations using IAM authentication.
 * This script generates an IAM token and runs prisma migrate deploy.
 *
 * For preview schemas (prefixed with "preview_"), if migrate deploy fails
 * with P3005 (non-empty schema without migration history), P3009 (failed
 * migration blocking deploys), or P3018 (migration failed to apply), the
 * schema is dropped and recreated, then migrations are retried. This is safe
 * because preview schemas are ephemeral.
 *
 * For non-preview schemas (production/staging), P3009/P3018 is recovered by
 * marking the failed migration as rolled-back, then retrying. If the retry
 * reports committed DDL artifacts such as already-existing relations or
 * columns, automation stops and emits operator guidance instead of marking
 * the migration applied.
 *
 * P0001 user-defined migration invariant failures fail fast before either
 * recovery path because the invariant must be fixed before retrying deploy.
 *
 * ISS-4601: after the pipeline, the target schema is swept for INVALID indexes
 * (see `invalid-index-sweep.ts`) and the completion line below is qualified
 * accordingly — a cancelled `CREATE INDEX CONCURRENTLY` otherwise leaves an
 * unusable index behind that the P3018 retry no-ops over, so the deploy would
 * report plain success. The sweep warns, it never fails the deploy.
 */

import { addSchemaToUrl, resolveSchemaName } from "../schema-utils";
import {
  formatBuildMigrateSkipLine,
  isBuildMigrateEnabled,
} from "./build-migrate-flag";
import { createSchemaUrlMinter, readIamAuthConfig } from "./iam-database-url";
import { formatMigrateCompletionLine } from "./invalid-index-sweep";
import {
  buildPreviewMigratorDeps,
  isPreviewMigratorEnabled,
  migrateAllPreviewSchemas,
} from "./migrate-all-previews";
import { flushMigrateTelemetry } from "./migrate-telemetry";
import { runMigrationPipeline } from "./migration-pipeline";
import { isPreviewSchema } from "./preview-schema";

async function main() {
  // ISS-4392: telemetry buffered during the pipeline/walk is flushed in the
  // `finally` below, so it lands on BOTH the success and the failure path. The
  // migrate outcome is carried on `process.exitCode` (NOT an inline
  // `process.exit`, which would skip the flush); the runner at the bottom forces
  // the process to exit AFTER the flush completes.
  try {
    const { DATABASE_URL, PGSCHEMA, VERCEL_ENV, VERCEL_GIT_COMMIT_REF } =
      process.env;

    const resolvedSchema = resolveSchemaName({
      pgSchema: PGSCHEMA,
      vercelEnv: VERCEL_ENV,
      vercelGitCommitRef: VERCEL_GIT_COMMIT_REF,
    });

    // ISS-4489: the kill-switch is checked HERE — after the (pure, env-only)
    // schema resolution so the skip line can name the schema, but before either
    // auth path, so a disabled build opens no connection and mints no IAM token.
    // That "no `:5432` traffic from the build" property is the whole point: it is
    // what lets api-stage detach its builds from Secure Compute.
    if (!isBuildMigrateEnabled()) {
      console.log(formatBuildMigrateSkipLine({ schema: resolvedSchema }));
      return;
    }

    // If DATABASE_URL is set (e.g., local dev with password), use it directly
    if (DATABASE_URL) {
      console.log(
        "✓ DATABASE_URL found, running migrations with password auth..."
      );
      const databaseUrl = addSchemaToUrl(DATABASE_URL, resolvedSchema);
      try {
        const { invalidIndexes } = await runMigrationPipeline(
          databaseUrl,
          resolvedSchema,
          VERCEL_GIT_COMMIT_REF
        );
        console.log(formatMigrateCompletionLine(invalidIndexes));
        return;
      } catch (error) {
        console.error(
          "❌ Migration failed:",
          error instanceof Error ? error.message : String(error)
        );
        process.exitCode = 1;
        return;
      }
    }

    // Otherwise, use IAM authentication
    const iamAuthConfig = readIamAuthConfig(process.env);
    if (!iamAuthConfig) {
      console.log(
        "⚠️  Database credentials not configured - skipping migrations"
      );
      console.log("   Required: DATABASE_URL (with password) OR");
      console.log(
        "   AWS_ROLE_ARN, AWS_REGION, PGHOST, PGUSER, PGDATABASE (for IAM auth)"
      );
      return;
    }

    console.log("🔐 Generating IAM authentication token...");

    try {
      // Mints a connection URL for `schema` with a FRESHLY-signed IAM token.
      // One helper for three consumers: the ISS-5285 post-clone re-mint just
      // below, the FEA-3071 preview-migrator walk further down, and (ISS-5983)
      // the `apps/api` runtime ensure route, which is why it lives in its own
      // module rather than as a closure here.
      const mintSchemaUrl = createSchemaUrlMinter(iamAuthConfig);

      const databaseUrl = await mintSchemaUrl(resolvedSchema);

      console.log("✓ Token generated, running migrations...");

      // ISS-5285: `refreshDatabaseUrl` re-mints the 15-minute IAM token for the
      // steps that run AFTER the data clone — the one unbounded step, and so the
      // one that can outlive the token. Optional by design: the DATABASE_URL
      // password path above passes nothing and is unchanged.
      const { invalidIndexes } = await runMigrationPipeline(
        databaseUrl,
        resolvedSchema,
        VERCEL_GIT_COMMIT_REF,
        { refreshDatabaseUrl: () => mintSchemaUrl(resolvedSchema) }
      );

      console.log(formatMigrateCompletionLine(invalidIndexes));

      // FEA-3071 Slice 2: after the single stage `public` deploy has migrated
      // `public`, bring every preview schema to head serially (the merge-triggered
      // migrator) so the post-migration preview redeploy wave hits the Slice-1
      // at-head probe and takes 0 acquisitions of Prisma's lock (72707369). Gated
      // to the stage api env (`PREVIEW_MIGRATOR_ENABLED`, the explicit stage guard)
      // and the non-preview deploy only (`!isPreviewSchema`) — it never runs on a
      // preview deploy or (kill-switch off) on prod. Own inner try/catch: the walk
      // is best-effort and must NEVER fail the `public` deploy (`databaseUrl` here
      // is the public base URL; `mintSchemaUrl` re-signs a fresh IAM token per
      // schema, reusing this one Signer, staying under the 15-min token window).
      if (isPreviewMigratorEnabled() && !isPreviewSchema(resolvedSchema)) {
        try {
          await migrateAllPreviewSchemas(
            databaseUrl,
            mintSchemaUrl,
            buildPreviewMigratorDeps()
          );
        } catch (walkError) {
          // Defensive: migrateAllPreviewSchemas is best-effort and does not throw,
          // but a walk failure must never fail the public deploy that hosts it.
          console.warn(
            `⚠️ Preview migrator crashed (non-blocking): ${
              walkError instanceof Error ? walkError.message : String(walkError)
            }`
          );
        }
      }
    } catch (error) {
      console.error(
        "❌ Migration failed:",
        error instanceof Error ? error.message : String(error)
      );
      process.exitCode = 1;
      return;
    }
  } finally {
    // Flush buffered migrate telemetry before the short build process exits (no
    // beforeExit/waitUntil guarantee in a standalone script). Best-effort +
    // deadline-bounded; never throws, never hangs the deploy.
    await flushMigrateTelemetry();
  }
}

// Force the process to exit AFTER `main` (and its telemetry flush) settle. The
// AWS SDK / OIDC provider can leave open handles that would otherwise keep the
// build hanging, so a natural exit is not safe — but the exit must not preempt
// the flush, hence it runs off `main`'s resolution, carrying its `exitCode`.
// `flushMigrateTelemetry` drains buffered stdout before returning, so this forced
// exit cannot truncate the last structured line on Vercel's async stdout pipe.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(
      "❌ Migration failed (unexpected):",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  });
