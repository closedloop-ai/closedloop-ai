import {
  type FeatureFlagSnapshot,
  featureFlagSnapshotSchema,
} from "@repo/api/src/types/feature-flag-snapshot";
import { withDb } from "@repo/database";
import { keys as databaseKeys } from "@repo/database/keys";
import { resolveSchemaName } from "@repo/database/schema-utils";
import { isPreviewSchema } from "@repo/database/scripts/preview-schema";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/** ISS-12048: the one row a preview schema's snapshot table holds. */
export const FEATURE_FLAG_SNAPSHOT_ROW_ID = "current";

/**
 * ISS-12048: the production flag snapshot this `apps/api` runtime pins, or
 * `null`.
 *
 * Active only when BOTH hold: this runtime's own database schema is a
 * `preview_*` schema (the one `@repo/database` resolves for its client), and
 * that schema stores a snapshot. Production and normal stage run on `public`,
 * so they never read the table, whatever it holds.
 *
 * Cached per instance for {@link SNAPSHOT_CACHE_TTL_MS}, one entry, so a
 * request does not pay a query per flag read. A refreshed snapshot reaches
 * every instance within that window.
 */
export async function readActiveFeatureFlagSnapshot(
  now: number = Date.now()
): Promise<FeatureFlagSnapshot | null> {
  if (!isPreviewRuntime()) {
    return null;
  }
  if (cache && now < cache.expiresAt) {
    return cache.snapshot;
  }
  const snapshot = await loadStoredSnapshot();
  cache = { snapshot, expiresAt: now + SNAPSHOT_CACHE_TTL_MS };
  return snapshot;
}

/** Exposed so tests start from a cold instance; production must not call it. */
export function clearFeatureFlagSnapshotCache(): void {
  cache = null;
}

/** Whether this runtime's database schema is a preview schema. */
export function isPreviewRuntime(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isPreviewSchema(
    resolveSchemaName({
      pgSchema: databaseKeys().PGSCHEMA,
      vercelEnv: env.VERCEL_ENV,
      vercelGitCommitRef: env.VERCEL_GIT_COMMIT_REF,
    })
  );
}

const SNAPSHOT_CACHE_TTL_MS = 30_000;

let cache: { snapshot: FeatureFlagSnapshot | null; expiresAt: number } | null =
  null;

/**
 * The stored row, validated. A row that fails validation pins nothing and is
 * logged, rather than pinning a half-read snapshot.
 */
async function loadStoredSnapshot(): Promise<FeatureFlagSnapshot | null> {
  try {
    const row = await withDb((db) =>
      db.featureFlagSnapshot.findUnique({
        where: { id: FEATURE_FLAG_SNAPSHOT_ROW_ID },
      })
    );
    if (!row) {
      return null;
    }
    const parsed = featureFlagSnapshotSchema.safeParse({
      takenAt: row.takenAt.toISOString(),
      distinctId: row.distinctId,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      flags: row.flags,
    });
    if (!parsed.success) {
      log.warn("feature_flag_snapshot.invalid_row", {
        issues: parsed.error.issues.length,
      });
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.warn("feature_flag_snapshot.read_failed", { error: parseError(error) });
    return null;
  }
}
