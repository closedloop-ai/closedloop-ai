import { createSslClient, quoteIdentifier } from "./db-utils";

export function isPreviewSchema(schema: string | null): boolean {
  return schema?.startsWith("preview_") ?? false;
}

export async function ensureSchemaExists(
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
export async function resetSchema(databaseUrl: string, schema: string | null) {
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

export async function upsertSchemaRegistry(
  databaseUrl: string,
  schema: string | null,
  branch: string | undefined
) {
  if (!isPreviewSchema(schema)) {
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
