#!/usr/bin/env node
/**
 * Runs Prisma migrations using IAM authentication.
 * This script generates an IAM token and runs prisma migrate deploy.
 *
 * For preview schemas (prefixed with "preview_"), if migrate deploy fails
 * with P3005 (non-empty schema without migration history), the schema is
 * dropped and recreated, then migrations are retried. This is safe because
 * preview schemas are ephemeral. Production/staging schemas are never
 * affected by this behavior.
 */

import { execSync } from "node:child_process";
import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { addSchemaToUrl, resolveSchemaName } from "../schema-utils";

function isPreviewSchema(schema: string | null): boolean {
  return schema?.startsWith("preview_") ?? false;
}

function runMigrateDeploy(databaseUrl: string) {
  execSync("prisma migrate deploy", {
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });
}

/**
 * Attempts to run prisma migrate deploy. If it fails with P3005 (non-empty
 * schema) on a preview schema, drops and recreates the schema, then retries.
 * After a successful retry, re-registers the schema so cleanup tracking works.
 */
async function runMigrateWithRetry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
) {
  try {
    runMigrateDeploy(databaseUrl);
  } catch (error) {
    // execSync with stdio:"pipe" includes stdout/stderr on the error object
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String(error.stdout)
        : "";
    const combined = `${stderr}\n${stdout}`;

    // Print captured output so it still appears in CI logs
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }

    if (combined.includes("P3005") && isPreviewSchema(schema)) {
      console.log(
        `↪ Preview schema ${schema} has stale data (P3005), resetting...`
      );
      await resetSchema(databaseUrl, schema);
      runMigrateDeploy(databaseUrl);
      // Re-register so cleanup tracking still works after schema drop
      await upsertSchemaRegistry(databaseUrl, schema, branch);
      return;
    }

    throw error;
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
    console.log("↪ Ensuring schema exists...");
    await ensureSchemaExists(databaseUrl, resolvedSchema);
    await upsertSchemaRegistry(
      databaseUrl,
      resolvedSchema,
      VERCEL_GIT_COMMIT_REF
    );
    await runMigrateWithRetry(
      databaseUrl,
      resolvedSchema,
      VERCEL_GIT_COMMIT_REF
    );
    return;
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

    console.log("↪ Ensuring schema exists...");
    await ensureSchemaExists(databaseUrl, resolvedSchema);
    await upsertSchemaRegistry(
      databaseUrl,
      resolvedSchema,
      VERCEL_GIT_COMMIT_REF
    );

    await runMigrateWithRetry(
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

async function ensureSchemaExists(databaseUrl: string, schema: string | null) {
  if (!schema) {
    return;
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const quoted = quoteIdentifier(schema);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
  } finally {
    await client.end();
  }
}

/**
 * Drops and recreates a preview schema so migrations can run from scratch.
 * Only callable for preview_ schemas as a safety guard.
 */
async function resetSchema(databaseUrl: string, schema: string | null) {
  if (!(schema && isPreviewSchema(schema))) {
    throw new Error(`resetSchema refused: ${schema} is not a preview schema`);
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const quoted = quoteIdentifier(schema);
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoted}`);
    console.log(`✓ Preview schema ${schema} reset successfully`);
  } finally {
    await client.end();
  }
}

async function upsertSchemaRegistry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
) {
  if (!schema?.startsWith("preview_")) {
    return;
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS preview_schemas (
        schema_name text PRIMARY KEY,
        branch text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )`
    );
    await client.query(
      `INSERT INTO preview_schemas (schema_name, branch)
       VALUES ($1, $2)
       ON CONFLICT (schema_name)
       DO UPDATE SET branch = EXCLUDED.branch, last_seen_at = now()`,
      [schema, branch ?? null]
    );
  } finally {
    await client.end();
  }
}

function createSslClient(databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  });
}

function quoteIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
