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
    const isNew = await ensureSchemaExists(databaseUrl, resolvedSchema);
    await upsertSchemaRegistry(
      databaseUrl,
      resolvedSchema,
      VERCEL_GIT_COMMIT_REF
    );
    execSync("prisma migrate deploy", {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });
    if (isNew && resolvedSchema) {
      await cloneDataFromPublic(databaseUrl, resolvedSchema);
    }
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
    const isNew = await ensureSchemaExists(databaseUrl, resolvedSchema);
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

    if (isNew && resolvedSchema) {
      await cloneDataFromPublic(databaseUrl, resolvedSchema);
    }

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

async function ensureSchemaExists(
  databaseUrl: string,
  schema: string | null
): Promise<boolean> {
  if (!schema) {
    return false;
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const quoted = quoteIdentifier(schema);
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [schema]
    );
    const existed = rows.length > 0;
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    return !existed;
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

const CLONE_SKIP_TABLES = new Set(["_prisma_migrations", "preview_schemas"]);

/**
 * Returns table names from `public` in topological order (parents before children)
 * so that inserts respect FK constraints without needing superuser privileges.
 */
async function getTablesInFkOrder(client: pg.Client): Promise<string[]> {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );

  const allTables: string[] = tables
    .map((r: { table_name: string }) => r.table_name)
    .filter((name: string) => !CLONE_SKIP_TABLES.has(name));

  // Build dependency graph: child -> set of parent tables
  const { rows: fks } = await client.query(
    `SELECT
       tc.table_name AS child,
       ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
       AND tc.constraint_schema = ccu.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'`
  );

  const deps = new Map<string, Set<string>>();
  for (const table of allTables) {
    deps.set(table, new Set());
  }
  for (const { child, parent } of fks as { child: string; parent: string }[]) {
    if (child !== parent && deps.has(child) && deps.has(parent)) {
      deps.get(child)!.add(parent);
    }
  }

  // Topological sort (Kahn's algorithm)
  const ordered: string[] = [];
  const remaining = new Map(deps);
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => [...parents].every((p) => !remaining.has(p)))
      .map(([name]) => name);

    if (ready.length === 0) {
      // Circular dependency — append whatever is left
      ordered.push(...remaining.keys());
      break;
    }
    ready.sort();
    for (const name of ready) {
      remaining.delete(name);
      ordered.push(name);
    }
  }

  return ordered;
}

async function cloneDataFromPublic(databaseUrl: string, schema: string) {
  console.log(`↪ Cloning data from public schema into ${schema}...`);
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const tableNames = await getTablesInFkOrder(client);

    if (tableNames.length === 0) {
      console.log("  No tables to clone.");
      return;
    }

    const quoted = quoteIdentifier(schema);

    for (const table of tableNames) {
      const quotedTable = quoteIdentifier(table);
      // Query column names and types to handle enum casts between schemas
      const { rows: cols } = await client.query(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table]
      );
      type ColInfo = {
        column_name: string;
        data_type: string;
        udt_name: string;
      };
      const insertCols = cols
        .map((c: ColInfo) => quoteIdentifier(c.column_name))
        .join(", ");
      // For USER-DEFINED types (enums), cast through text to bridge schema-scoped types
      const selectCols = cols
        .map((c: ColInfo) => {
          const col = quoteIdentifier(c.column_name);
          if (c.data_type === "USER-DEFINED") {
            return `${col}::text::${quoted}.${quoteIdentifier(c.udt_name)}`;
          }
          return col;
        })
        .join(", ");
      const { rowCount } = await client.query(
        `INSERT INTO ${quoted}.${quotedTable} (${insertCols}) SELECT ${selectCols} FROM "public".${quotedTable}`
      );
      console.log(`  ${table}: ${rowCount ?? 0} rows`);
    }

    console.log(`✓ Cloned ${tableNames.length} tables into ${schema}`);
  } catch (error) {
    console.error(
      "⚠️  Data clone failed (schema will start empty):",
      error instanceof Error ? error.message : String(error)
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
