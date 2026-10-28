import type { S3KeyspacePrefixResolver } from "@repo/aws/s3-keyspace-prefix";
import { Prisma, withDb } from "@repo/database";
import { resolveSchemaName } from "@repo/database/schema-utils";
import { isPreviewSchema } from "@repo/database/scripts/preview-schema";
import {
  parseVibeEnvironmentMarker,
  vibeEnvironmentKeyPrefix,
} from "@repo/database/scripts/vibe-environment";
import { VIBE_BRANCH_PREFIX } from "@/app/preview-schemas/constants";

/**
 * ISS-12056: which S3 keyspace this API runtime writes to. A vibe environment
 * (a preview schema carrying the vibe marker) gets
 * `vibe-environments/<schema>/`; every other runtime gets no prefix, and only a
 * preview runtime ever asks the database. Normal previews keep stage's
 * unprefixed keys because their rows are cloned from stage and point at them.
 */

/**
 * How long one marker read is reused. The marker only changes when the vibe
 * workflow rebuilds the schema, so a short reuse costs nothing in correctness
 * and keeps the catalog read off every S3 call.
 */
export const KEYSPACE_PREFIX_CACHE_TTL_MS = 60_000;

/** The preview schema this runtime's queries target, or `null` for any other. */
export function runtimePreviewSchema(
  env: RuntimeSchemaEnv = process.env
): string | null {
  const schema = resolveSchemaName({
    pgSchema: env.PGSCHEMA,
    vercelEnv: env.VERCEL_ENV,
    vercelGitCommitRef: env.VERCEL_GIT_COMMIT_REF,
  });
  return schema !== null && isPreviewSchema(schema) ? schema : null;
}

/** A vibe branch must never use stage's unprefixed keyspace while being built. */
export function runtimeRequiresVibeMarker(
  env: RuntimeSchemaEnv = process.env
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF?.startsWith(VIBE_BRANCH_PREFIX) === true
  );
}

/**
 * The resolver for a preview runtime. Concurrent callers share one in-flight
 * read; an answer is reused for {@link KEYSPACE_PREFIX_CACHE_TTL_MS}.
 *
 * A failed read rejects, and nothing is cached, so the S3 call it gates fails
 * instead of falling back to no prefix: an unprefixed write from a vibe
 * environment would land in stage's keyspace and outlive the schema.
 */
export function createVibeKeyspacePrefixResolver(
  schema: string,
  readSchemaComment: (schema: string) => Promise<string | null>,
  requireVibeMarker = false
): S3KeyspacePrefixResolver {
  let cached: { prefix: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const read = async (): Promise<string> => {
    const marker = parseVibeEnvironmentMarker(await readSchemaComment(schema));
    if (marker === null && requireVibeMarker) {
      throw new Error(`Vibe environment schema ${schema} has no valid marker`);
    }
    const prefix = marker === null ? "" : vibeEnvironmentKeyPrefix(schema);
    cached = { prefix, expiresAt: Date.now() + KEYSPACE_PREFIX_CACHE_TTL_MS };
    return prefix;
  };

  return () => {
    if (cached !== null && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.prefix);
    }
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** The comment on `schema`, read through the runtime's own connection. */
export async function readRuntimeSchemaComment(
  schema: string
): Promise<string | null> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ comment: string | null }[]>(Prisma.sql`
      SELECT obj_description(oid, 'pg_namespace') AS comment
      FROM pg_catalog.pg_namespace
      WHERE nspname = ${schema}
    `)
  );
  return rows[0]?.comment ?? null;
}

type RuntimeSchemaEnv = Readonly<Record<string, string | undefined>>;
