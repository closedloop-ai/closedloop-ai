#!/usr/bin/env node
/**
 * Cleanup stale preview schemas based on per-schema preview_schemas registry.
 *
 * - Connects to the stage RDS database using IAM auth (AWS OIDC).
 * - Reads preview schemas from each schema's preview_schemas table (updated by preview builds).
 * - Drops any preview schema whose last_seen_at is older than the TTL window.
 *
 * Intended for GitHub Actions (AWS OIDC) and stage database only.
 */

import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";

const {
  AWS_REGION,
  PGHOST,
  PGUSER,
  PGDATABASE,
  PGPORT = "5432",
  PREVIEW_SCHEMA_TTL_DAYS = "14",
} = process.env;

if (!(AWS_REGION && PGHOST && PGUSER && PGDATABASE)) {
  console.error(
    "Missing required env vars: AWS_REGION, PGHOST, PGUSER, PGDATABASE"
  );
  process.exit(1);
}

const ttlDays = Number(PREVIEW_SCHEMA_TTL_DAYS);
if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
  console.error("PREVIEW_SCHEMA_TTL_DAYS must be a positive number");
  process.exit(1);
}

const credentials = getAwsCredentials();
if (!credentials) {
  console.error(
    "AWS credentials not found in env (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)"
  );
  process.exit(1);
}

const signer = new Signer({
  hostname: PGHOST,
  port: Number(PGPORT),
  username: PGUSER,
  region: AWS_REGION,
  credentials,
});

const token = await signer.getAuthToken();
const databaseUrl = `postgresql://${PGUSER}:${encodeURIComponent(token)}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require`;

const client = createSslClient(databaseUrl);
await client.connect();

try {
  const { rows: schemas } = await client.query(
    `SELECT nspname AS schema_name
     FROM pg_namespace
     WHERE nspname LIKE 'preview_%'
     ORDER BY nspname`
  );

  if (schemas.length === 0) {
    console.log("No preview schemas found.");
    process.exit(0);
  }

  const staleSchemas = [];
  for (const { schema_name } of schemas) {
    const quotedSchema = quoteIdentifier(schema_name);
    try {
      const { rows } = await client.query(
        `SELECT last_seen_at
         FROM ${quotedSchema}.preview_schemas
         WHERE schema_name = $1
         ORDER BY last_seen_at DESC
         LIMIT 1`,
        [schema_name]
      );

      if (rows.length === 0) {
        continue;
      }

      const lastSeenAt = new Date(rows[0].last_seen_at);
      const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
      if (lastSeenAt < cutoff) {
        staleSchemas.push(schema_name);
      }
    } catch (error) {
      console.warn(
        `Skipping schema ${schema_name}: unable to read preview_schemas (${error.message})`
      );
    }
  }

  if (staleSchemas.length === 0) {
    console.log("No stale preview schemas to delete.");
    process.exit(0);
  }

  for (const schemaName of staleSchemas) {
    const quoted = quoteIdentifier(schemaName);
    console.log(`Dropping schema ${schemaName}...`);
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  }

  console.log(`Deleted ${staleSchemas.length} preview schema(s).`);
} finally {
  await client.end();
}

function getAwsCredentials() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } =
    process.env;
  if (!(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)) {
    return null;
  }
  return {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    sessionToken: AWS_SESSION_TOKEN,
  };
}

function createSslClient(databaseUrl) {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  });
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
