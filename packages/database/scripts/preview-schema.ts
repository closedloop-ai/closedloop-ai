import { createSslClient, quoteIdentifier } from "./db-utils";
import { formatIncompletePreviewBuild } from "./preview-build-state";
import {
  formatVibeEnvironmentMarker,
  parseVibeEnvironmentMarker,
  readSchemaComment,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  writeSchemaComment,
} from "./vibe-environment";
import { isVibeEnvironmentSchema } from "./vibe-environment-retention";

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
    if (!existed && isVibeEnvironmentSchema(schema, undefined)) {
      // ISS-12135: a crash must not leave an unmarked partial clone trusted by a later build.
      await client.query("BEGIN");
      try {
        await client.query(`CREATE SCHEMA ${quoted}`);
        await writeSchemaComment(
          client,
          schema,
          formatIncompletePreviewBuild()
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } else {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    }
    return !existed;
  } finally {
    await client.end();
  }
}

/**
 * Drops and recreates a preview schema so migrations can run from scratch.
 * Only callable for preview_ schemas as a safety guard.
 *
 * ISS-12056: carry the vibe marker across the recreate so a later deploy
 * cannot clone stage `public`. A reset removes seeded rows, so a seeded marker
 * must become pending before the next environment dispatch.
 */
export async function resetSchema(databaseUrl: string, schema: string | null) {
  if (!(schema && isPreviewSchema(schema))) {
    throw new Error(`resetSchema refused: ${schema} is not a preview schema`);
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const quoted = quoteIdentifier(schema);
    let comment = await readSchemaComment(client, schema);
    const marker = parseVibeEnvironmentMarker(comment);
    if (marker?.mode === VibeEnvironmentMode.Seeded) {
      comment = formatVibeEnvironmentMarker({
        ...marker,
        state: VibeEnvironmentState.Pending,
      });
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoted}`);
    if (comment !== null) {
      await writeSchemaComment(client, schema, comment);
    }
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

/**
 * Drops a preview schema without recreating it, so the next deploy creates it
 * anew and rebuilds it on a fresh clone (ISS-11785). Preview-only, like
 * `resetSchema`.
 */
export async function dropSchema(databaseUrl: string, schema: string | null) {
  if (!(schema && isPreviewSchema(schema))) {
    throw new Error(`dropSchema refused: ${schema} is not a preview schema`);
  }
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    await client.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`
    );
  } finally {
    await client.end();
  }
}
