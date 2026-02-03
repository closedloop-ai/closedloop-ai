#!/usr/bin/env node
/**
 * Runs Prisma migrations using IAM authentication.
 * This script generates an IAM token and runs prisma db push with it.
 */

import { execSync } from "node:child_process";
import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { addSchemaToUrl, resolveSchemaName } from "../schema-utils";

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
    execSync("prisma format && prisma db push", {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });
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

    execSync("prisma format && prisma db push", {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });

    console.log("✓ Migrations completed successfully");
  } catch (error) {
    console.error(
      "❌ Migration failed:",
      error instanceof Error ? error.message : error
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
