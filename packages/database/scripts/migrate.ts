#!/usr/bin/env node
/**
 * Runs Prisma migrations using IAM authentication.
 * This script generates an IAM token and runs prisma migrate deploy.
 *
 * For preview schemas (prefixed with "preview_"), if migrate deploy fails
 * with P3005 (non-empty schema without migration history) or P3009 (failed
 * migration blocking deploys), the schema is dropped and recreated, then
 * migrations are retried. This is safe because preview schemas are ephemeral.
 *
 * For non-preview schemas (production/staging), P3009 is recovered by marking
 * the failed migration as rolled-back, then retrying. This is safe because
 * PostgreSQL DDL is transactional — a failed migration is fully rolled back.
 */

import { spawnSync } from "node:child_process";
import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { addSchemaToUrl, resolveSchemaName } from "../schema-utils";
import { cloneDataFromPublic } from "./clone-schema";
import {
  ensureSchemaExists,
  isPreviewSchema,
  resetSchema,
  upsertSchemaRegistry,
} from "./preview-schema";

const P3005_PATTERN = /\bP3005\b/;
const P3009_PATTERN = /\bP3009\b/;
const P3018_PATTERN = /\bP3018\b/;
const MIGRATION_NAME_PATTERN = /Migration name: (\S+)/;

function runMigrateDeploy(databaseUrl: string) {
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
}

function isP3005Output(message: string): boolean {
  return P3005_PATTERN.test(message);
}

function isP3009Output(message: string): boolean {
  return P3009_PATTERN.test(message);
}

function isP3018Output(message: string): boolean {
  return P3018_PATTERN.test(message);
}

function parseFailedMigrationName(message: string): string | null {
  const match = MIGRATION_NAME_PATTERN.exec(message);
  return match?.[1] ?? null;
}

/**
 * Marks a failed migration as rolled-back using `prisma migrate resolve`.
 * Safe for PostgreSQL because DDL is transactional — a failed migration
 * leaves the database in its pre-migration state.
 */
function resolveFailedMigration(
  databaseUrl: string,
  migrationName: string
): void {
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
}

/**
 * Attempts to run prisma migrate deploy with automatic recovery:
 *
 * - Preview schemas: P3005/P3009 → drop and recreate schema, then retry.
 * - Non-preview schemas: P3009/P3018 (failed migration) → mark as rolled-back,
 *   then retry. Safe because PostgreSQL DDL is transactional.
 */
async function runMigrateWithRetry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
): Promise<boolean> {
  try {
    runMigrateDeploy(databaseUrl);
    return false;
  } catch (error) {
    // runMigrateDeploy attaches stdout/stderr to the error object
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String(error.stdout)
        : "";
    const combined = `${stderr}\n${stdout}`;

    const isPreviewRecoverable =
      isP3005Output(combined) || isP3009Output(combined);

    if (isPreviewRecoverable && isPreviewSchema(schema)) {
      const code = isP3009Output(combined) ? "P3009" : "P3005";
      console.log(`↪ Preview schema ${schema} hit ${code}, resetting...`);
      await resetSchema(databaseUrl, schema);
      runMigrateDeploy(databaseUrl);
      // Re-register so cleanup tracking still works after schema drop
      await upsertSchemaRegistry(databaseUrl, schema, branch);
      return true;
    }

    // For non-preview schemas, recover from a previously failed migration
    // by marking it as rolled-back (PostgreSQL DDL is transactional).
    const hasFailedMigration =
      isP3009Output(combined) || isP3018Output(combined);
    const migrationName = parseFailedMigrationName(combined);

    if (hasFailedMigration && migrationName && !isPreviewSchema(schema)) {
      console.log(
        `↪ Failed migration detected: ${migrationName}, resolving...`
      );
      resolveFailedMigration(databaseUrl, migrationName);
      runMigrateDeploy(databaseUrl);
      return false;
    }

    throw error;
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
  await upsertSchemaRegistry(databaseUrl, schema, branch);

  const didReset = await runMigrateWithRetry(databaseUrl, schema, branch);

  if ((isNew || didReset) && schema) {
    await cloneDataFromPublic(databaseUrl, schema);
  }
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
