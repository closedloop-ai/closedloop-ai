/**
 * ISS-12048: why storing a flag snapshot refused or failed, for the route to
 * pick a status from. Same posture as `SeedFailureReason`: not a wire value.
 */
export const FeatureFlagSnapshotFailureReason = {
  HostNotAllowed: "host_not_allowed",
  NotAPreviewSchema: "not_a_preview_schema",
  Failed: "failed",
} as const;

export type FeatureFlagSnapshotFailureReason =
  (typeof FeatureFlagSnapshotFailureReason)[keyof typeof FeatureFlagSnapshotFailureReason];

/**
 * The body cap for this route. A snapshot carries every flag key with its
 * value (bounded by `FEATURE_FLAG_SNAPSHOT_MAX_FLAGS`), so the 2 KiB cap the
 * branch-only preview-schemas routes use cannot hold it.
 */
export const FEATURE_FLAG_SNAPSHOT_REQUEST_MAX_BYTES = 64 * 1024;
