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
 */

import { spawnSync } from "node:child_process";
import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { addSchemaToUrl, resolveSchemaName } from "../schema-utils";
import { cloneDataFromPublic } from "./clone-schema";
import { recoverMigrateDeployFailure } from "./migrate-deploy-recovery";
import {
  isTransientConnectionError,
  isTransientMigrateDeployError,
  MIGRATE_DEPLOY_RETRY,
  withRetry,
} from "./migrate-retry";
import { withMigrationSerializeLock } from "./migration-lock";
import {
  ensureSchemaExists,
  resetSchema,
  upsertSchemaRegistry,
} from "./preview-schema";
import { runPreviewSeed } from "./preview-seed";

function runMigrateDeploy(databaseUrl: string): Promise<void> {
  const result = spawnSync("prisma", ["migrate", "deploy"], {
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error || result.status !== 0) {
    const error =
      result.error ??
      new Error(
        `prisma migrate deploy failed with exit code ${result.status ?? "unknown"}`
      );
    (error as Error & { stdout?: string; stderr?: string }).stdout =
      result.stdout ?? "";
    (error as Error & { stdout?: string; stderr?: string }).stderr =
      result.stderr ?? "";
    throw error;
  }

  return Promise.resolve();
}

/**
 * Marks a failed migration as rolled-back using `prisma migrate resolve`.
 * This is the normal Prisma recovery path for failed migrations. A later
 * deploy retry may still surface committed DDL artifacts, which recovery
 * classifies separately before stopping automation.
 */
function resolveFailedMigration(
  databaseUrl: string,
  migrationName: string
): Promise<void> {
  console.log(`↪ Marking migration ${migrationName} as rolled-back...`);
  const result = spawnSync(
    "prisma",
    ["migrate", "resolve", "--rolled-back", migrationName],
    {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    }
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error || result.status !== 0) {
    throw new Error(
      `prisma migrate resolve --rolled-back ${migrationName} failed: ${result.stderr || result.error?.message}`
    );
  }

  return Promise.resolve();
}

/**
 * Attempts to run prisma migrate deploy with automatic recovery:
 *
 * - Preview schemas: P3005/P3009/P3018 → drop and recreate schema, then retry.
 *   Reset is always safe for ephemeral preview schemas, and covers cases like a
 *   migration directory being renamed/regenerated after it was already applied,
 *   which leaves the schema state mismatched with `_prisma_migrations`.
 * - Non-preview schemas: P3009/P3018 (failed migration) → mark as rolled-back
 *   so the next deploy can re-apply. If that retry reports committed DDL
 *   artifacts, emit a bounded diagnostic and leave the next action to an
 *   operator.
 */
async function runMigrateWithRetry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
): Promise<boolean> {
  try {
    // Retry a transient connectivity blip (Prisma P1001 "can't reach database
    // server", or a dropped pg connection) OR migration advisory-lock contention
    // (P1002 "Timed out trying to acquire a postgres advisory lock" when a peer
    // migrate deploy on the same physical database holds the lock — FEA-3062)
    // before the build fails. Migration-state failures (P3005/P3009/P3018/P0001)
    // are not transient: withRetry rethrows them on the first attempt, so they
    // fall through to recoverMigrateDeployFailure below exactly as before.
    // MIGRATE_DEPLOY_RETRY's wider, jittered budget stays well under the 15-min
    // RDS IAM token validity window (retries reuse the same IAM-signed URL).
    await withRetry(
      () => runMigrateDeploy(databaseUrl),
      isTransientMigrateDeployError,
      MIGRATE_DEPLOY_RETRY
    );
    return false;
  } catch (error) {
    return await recoverMigrateDeployFailure(
      {
        databaseUrl,
        schema,
        branch,
        error,
      },
      {
        runMigrateDeploy,
        resolveFailedMigration,
        resetSchema,
        upsertSchemaRegistry,
      }
    );
  }
}

/**
 * Shared migration pipeline: ensure schema → register → migrate → clone.
 * Used by both DATABASE_URL (password) and IAM auth paths.
 */
async function runMigrationPipeline(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
) {
  console.log("↪ Ensuring schema exists...");
  const isNew = await ensureSchemaExists(databaseUrl, schema);
  /**
   * Ordering invariant: ensureSchemaExists → upsertSchemaRegistry → runMigrateWithRetry → cloneDataFromPublic.
   * ensureSchemaExists must run first so the schema row exists before we write the registry entry.
   * upsertSchemaRegistry must complete before runMigrateWithRetry so that any mid-migration failure
   * leaves a registered (reapable) orphan rather than a silent unregistered one.
   * If all retries are exhausted, runMigrationPipeline throws, the deploy fails loudly, and the
   * schema created by ensureSchemaExists is left unregistered — the FEA-1082 orphan reaper will
   * clean it up on its next run.
   * IAM token note: retries reuse the original IAM-signed databaseUrl; the 15-minute RDS token
   * validity is the implicit upper bound on total retry time (irrelevant at zero-delay/3 attempts,
   * but relevant if delay or attempt count is increased in future).
   */
  await withRetry(
    () => upsertSchemaRegistry(databaseUrl, schema, branch),
    isTransientConnectionError,
    { attempts: 3 }
  );

  // FEA-3065: serialize the migrate against concurrent api deploys on the same
  // database through our own advisory lock, so Prisma's per-DB migration lock
  // (72707369) is uncontended. Wraps ONLY the lock-taking migrate step (schema
  // ensure/registry ran above; clone/seed run below, all outside the gate).
  // Fails open to runMigrateWithRetry (FEA-3062 retry) on any gate error.
  const didReset = await withMigrationSerializeLock({ databaseUrl }, () =>
    runMigrateWithRetry(databaseUrl, schema, branch)
  );

  if ((isNew || didReset) && schema) {
    await cloneDataFromPublic(databaseUrl, schema);
  }

  // Seed preview schemas with synthetic data (FEA-1715). Intentionally OUTSIDE
  // the (isNew || didReset) gate above: the seed is idempotent and non-blocking,
  // so running it after every successful migration makes a prior non-blocking
  // seed failure recoverable on the next deploy (review: shafty023). No-op for
  // non-preview schemas.
  runPreviewSeed(databaseUrl, schema);
}

async function main() {
  const {
    AWS_ROLE_ARN,
    AWS_REGION,
    PGHOST,
    PGUSER,
    PGDATABASE,
    PGPORT = "5432",
    DATABASE_URL,
    PGSCHEMA,
    VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF,
  } = process.env;

  const resolvedSchema = resolveSchemaName({
    pgSchema: PGSCHEMA,
    vercelEnv: VERCEL_ENV,
    vercelGitCommitRef: VERCEL_GIT_COMMIT_REF,
  });

  // If DATABASE_URL is set (e.g., local dev with password), use it directly
  if (DATABASE_URL) {
    console.log(
      "✓ DATABASE_URL found, running migrations with password auth..."
    );
    const databaseUrl = addSchemaToUrl(DATABASE_URL, resolvedSchema);
    try {
      await runMigrationPipeline(
        databaseUrl,
        resolvedSchema,
        VERCEL_GIT_COMMIT_REF
      );
      console.log("✓ Migrations completed successfully");
      return;
    } catch (error) {
      console.error(
        "❌ Migration failed:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  }

  // Otherwise, use IAM authentication
  if (!(AWS_ROLE_ARN && AWS_REGION && PGHOST && PGUSER && PGDATABASE)) {
    console.log("⚠️  Database credentials not configured - skipping migrations");
    console.log("   Required: DATABASE_URL (with password) OR");
    console.log(
      "   AWS_ROLE_ARN, AWS_REGION, PGHOST, PGUSER, PGDATABASE (for IAM auth)"
    );
    process.exit(0);
  }

  console.log("🔐 Generating IAM authentication token...");

  try {
    const signer = new Signer({
      hostname: PGHOST,
      port: Number(PGPORT),
      username: PGUSER,
      region: AWS_REGION,
      credentials: awsCredentialsProvider({
        roleArn: AWS_ROLE_ARN,
        clientConfig: { region: AWS_REGION },
      }),
    });

    const token = await signer.getAuthToken();

    // Construct DATABASE_URL with IAM token
    const rawUrl = `postgresql://${PGUSER}:${encodeURIComponent(token)}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require`;
    const databaseUrl = addSchemaToUrl(rawUrl, resolvedSchema);

    console.log("✓ Token generated, running migrations...");

    await runMigrationPipeline(
      databaseUrl,
      resolvedSchema,
      VERCEL_GIT_COMMIT_REF
    );

    console.log("✓ Migrations completed successfully");
  } catch (error) {
    console.error(
      "❌ Migration failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();
