import type pg from "pg";
import { z } from "zod";
import { createSslClient, quoteIdentifier } from "./db-utils";
import { isPreviewSchema } from "./preview-schema";

/**
 * ISS-12056: a vibe environment is a branch preview schema that the vibe
 * environment workflow (`.github/workflows/vibe-environment.yml`) built EMPTY
 * and then either seeded with the vibe seed or left blank. It must never be
 * cloned from stage `public`.
 *
 * The marker that says so is a comment on the schema itself, so it lives and
 * dies with the schema: dropping the schema drops the marker, and nothing in
 * `public` has to be written or reaped for it. No branch name or prefix decides
 * it; only the workflow's dispatch writes it.
 */

export const VibeEnvironmentMode = {
  Seeded: "seeded",
  Blank: "blank",
} as const;
export type VibeEnvironmentMode =
  (typeof VibeEnvironmentMode)[keyof typeof VibeEnvironmentMode];

/**
 * `pending`: the schema is built and migrated but its seed has not landed yet,
 * so the next dispatch rebuilds it rather than trusting a partial seed.
 * `ready`: nothing left to do; a repeat dispatch for the same mode keeps it.
 */
export const VibeEnvironmentState = {
  Pending: "pending",
  Ready: "ready",
} as const;
export type VibeEnvironmentState =
  (typeof VibeEnvironmentState)[keyof typeof VibeEnvironmentState];

export type VibeEnvironmentMarker = {
  mode: VibeEnvironmentMode;
  state: VibeEnvironmentState;
};

const vibeEnvironmentMarkerSchema = z.object({
  closedloopVibeEnvironment: z.object({
    mode: z.enum([VibeEnvironmentMode.Seeded, VibeEnvironmentMode.Blank]),
    state: z.enum([VibeEnvironmentState.Pending, VibeEnvironmentState.Ready]),
  }),
});

/** Every S3 key a vibe environment writes sits under this, per schema. */
export const VIBE_ENVIRONMENT_KEY_ROOT = "vibe-environments/";

/** `null` for a schema with no comment, or with a comment that is not ours. */
export function parseVibeEnvironmentMarker(
  comment: string | null | undefined
): VibeEnvironmentMarker | null {
  if (!comment) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment);
  } catch {
    return null;
  }
  const result = vibeEnvironmentMarkerSchema.safeParse(parsed);
  return result.success ? result.data.closedloopVibeEnvironment : null;
}

export function formatVibeEnvironmentMarker(
  marker: VibeEnvironmentMarker
): string {
  return JSON.stringify({
    closedloopVibeEnvironment: { mode: marker.mode, state: marker.state },
  });
}

/**
 * Whether a dispatch asking for `requested` must drop and rebuild the schema.
 * Anything but a ready schema of the same mode is rebuilt: an unmarked schema
 * may hold a clone of stage `public`, and a pending one a partial seed.
 */
export function vibeEnvironmentNeedsRebuild(
  current: VibeEnvironmentMarker | null,
  requested: VibeEnvironmentMode
): boolean {
  return !(
    current !== null &&
    current.mode === requested &&
    current.state === VibeEnvironmentState.Ready
  );
}

/** The marker a freshly built schema starts with. Blank has nothing to seed. */
export function initialVibeEnvironmentMarker(
  mode: VibeEnvironmentMode
): VibeEnvironmentMarker {
  return {
    mode,
    state:
      mode === VibeEnvironmentMode.Blank
        ? VibeEnvironmentState.Ready
        : VibeEnvironmentState.Pending,
  };
}

/**
 * The S3 key prefix that keeps one vibe environment's objects apart from
 * stage's and from every other session's in the shared buckets, and that the
 * schema's teardown deletes. Preview schemas only.
 */
export function vibeEnvironmentKeyPrefix(schema: string): string {
  if (!isPreviewSchema(schema)) {
    throw new Error(
      `vibeEnvironmentKeyPrefix refused: ${schema} is not a preview schema`
    );
  }
  return `${VIBE_ENVIRONMENT_KEY_ROOT}${schema}/`;
}

/**
 * The schema a `vibe-environments/<schema>/...` key belongs to, or `null` for
 * any other key. The daily sweep uses it to find prefixes whose schema is gone.
 */
export function schemaOfVibeEnvironmentKey(key: string): string | null {
  if (!key.startsWith(VIBE_ENVIRONMENT_KEY_ROOT)) {
    return null;
  }
  const rest = key.slice(VIBE_ENVIRONMENT_KEY_ROOT.length);
  const slash = rest.indexOf("/");
  const schema = slash === -1 ? rest : rest.slice(0, slash);
  return isPreviewSchema(schema) ? schema : null;
}

export const READ_SCHEMA_COMMENT_SQL =
  "SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_catalog.pg_namespace WHERE nspname = $1";

type QueryClient = Pick<pg.Client, "query">;

export async function readSchemaComment(
  client: QueryClient,
  schema: string
): Promise<string | null> {
  const { rows } = await client.query<{ comment: string | null }>(
    READ_SCHEMA_COMMENT_SQL,
    [schema]
  );
  return rows[0]?.comment ?? null;
}

/**
 * `COMMENT ON SCHEMA` takes no bind parameters, so the literal is quoted here.
 * The text is either our own JSON or a comment read back from the catalog.
 */
export async function writeSchemaComment(
  client: QueryClient,
  schema: string,
  comment: string | null
): Promise<void> {
  const literal =
    comment === null ? "NULL" : `'${comment.replace(/'/g, "''")}'`;
  await client.query(
    `COMMENT ON SCHEMA ${quoteIdentifier(schema)} IS ${literal}`
  );
}

export type VibeEnvironmentDbDeps = {
  createClient?: (databaseUrl: string) => pg.Client;
};

export async function readVibeEnvironmentMarker(
  databaseUrl: string,
  schema: string | null,
  deps: VibeEnvironmentDbDeps = {}
): Promise<VibeEnvironmentMarker | null> {
  if (!(schema && isPreviewSchema(schema))) {
    return null;
  }
  const client = (deps.createClient ?? createSslClient)(databaseUrl);
  await client.connect();
  try {
    return parseVibeEnvironmentMarker(await readSchemaComment(client, schema));
  } finally {
    await client.end();
  }
}

export async function writeVibeEnvironmentMarker(
  databaseUrl: string,
  schema: string,
  marker: VibeEnvironmentMarker,
  deps: VibeEnvironmentDbDeps = {}
): Promise<void> {
  if (!isPreviewSchema(schema)) {
    throw new Error(
      `writeVibeEnvironmentMarker refused: ${schema} is not a preview schema`
    );
  }
  const client = (deps.createClient ?? createSslClient)(databaseUrl);
  await client.connect();
  try {
    await writeSchemaComment(
      client,
      schema,
      formatVibeEnvironmentMarker(marker)
    );
  } finally {
    await client.end();
  }
}
