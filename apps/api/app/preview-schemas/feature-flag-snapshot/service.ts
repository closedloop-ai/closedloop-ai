import type { FeatureFlagSnapshot } from "@repo/api/src/types/feature-flag-snapshot";
import { validateHost } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { quoteIdentifier } from "@repo/database/scripts/db-utils";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { isPreviewSchema } from "@repo/database/scripts/preview-schema";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { FEATURE_FLAG_SNAPSHOT_ROW_ID } from "@/lib/feature-flags/feature-flag-snapshot";
import { withMigratorClient } from "../service/migrator-connection";
import { FeatureFlagSnapshotFailureReason } from "./constants";

/**
 * ISS-12048: stores the production flag snapshot in ONE branch preview schema,
 * replacing any snapshot it held.
 *
 * Preview schemas only, behind the same fail-closed host invariant as the seed
 * (`validateHost`): this writes into whatever RDS `PGHOST` names, and the
 * snapshot must never reach `public`, where stage and production read.
 */

const HOST_REFUSED_MESSAGE =
  "Refusing to store a flag snapshot: this deployment is not wired to the allowlisted non-production database host";

export type StoreFeatureFlagSnapshotResult =
  | {
      ok: true;
      branch: string;
      schema: string;
      takenAt: string;
      flagCount: number;
    }
  | { ok: false; reason: FeatureFlagSnapshotFailureReason; message: string };

export async function storeFeatureFlagSnapshot(
  branch: string,
  schema: string,
  snapshot: FeatureFlagSnapshot
): Promise<StoreFeatureFlagSnapshotResult> {
  const hostError = validateHost({
    pgHost: process.env.PGHOST,
    stagePgHost: process.env.STAGE_PGHOST,
  });
  if (hostError) {
    log.error(
      "[preview-schema-flag-snapshot] Refusing: host is not allowlisted",
      {
        branch,
        schema,
        hostError,
      }
    );
    return {
      ok: false,
      reason: FeatureFlagSnapshotFailureReason.HostNotAllowed,
      message: HOST_REFUSED_MESSAGE,
    };
  }
  if (!isPreviewSchema(schema)) {
    return {
      ok: false,
      reason: FeatureFlagSnapshotFailureReason.NotAPreviewSchema,
      message: `Refusing to store a flag snapshot in "${schema}": only preview schemas pin flags`,
    };
  }

  try {
    await withMigratorClient((client) =>
      client.query(
        `INSERT INTO ${quoteIdentifier(schema)}."feature_flag_snapshots"
           ("id", "distinct_id", "org_id", "taken_at", "flags", "updated_at")
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT ("id") DO UPDATE SET
           "distinct_id" = EXCLUDED."distinct_id",
           "org_id" = EXCLUDED."org_id",
           "taken_at" = EXCLUDED."taken_at",
           "flags" = EXCLUDED."flags",
           "updated_at" = NOW()`,
        [
          FEATURE_FLAG_SNAPSHOT_ROW_ID,
          snapshot.distinctId,
          snapshot.orgId ?? null,
          new Date(snapshot.takenAt),
          JSON.stringify(snapshot.flags),
        ]
      )
    );
  } catch (error) {
    // The pg error can quote the IAM URL it was handed, and the workflow step
    // prints this body: same sanitizer as the seed.
    const message = sanitizeOperatorMessageFragment(parseError(error));
    log.error("[preview-schema-flag-snapshot] Store failed", {
      branch,
      schema,
      error: message,
    });
    return {
      ok: false,
      reason: FeatureFlagSnapshotFailureReason.Failed,
      message: `Failed to store a flag snapshot in "${schema}": ${message}`,
    };
  }

  const flagCount = Object.keys(snapshot.flags).length;
  log.info("[preview-schema-flag-snapshot] Flag snapshot stored", {
    branch,
    schema,
    flagCount,
  });
  return {
    ok: true,
    branch,
    schema,
    takenAt: snapshot.takenAt,
    flagCount,
  };
}
