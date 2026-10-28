import { z } from "zod";

/**
 * ISS-12048: the production feature-flag snapshot a `$vibe` preview environment
 * pins (ISS-12056 delivers it, the `$vibe` skill takes it).
 *
 * Taken once per session at environment creation by evaluating every flag in
 * PostHog as the person's real account (`distinctId`) and org (`orgId`).
 * `flags` holds PostHog's own values: `true`/`false` for a plain flag, the
 * variant string for a multivariate one (a variant string means enabled, as
 * `isPostHogFlagValueEnabled` reads it).
 *
 * Bounded, because the route that stores it reads a body a GitHub Action
 * sends: a flag key is at most {@link FEATURE_FLAG_SNAPSHOT_MAX_KEY_LENGTH}
 * characters and there are at most {@link FEATURE_FLAG_SNAPSHOT_MAX_FLAGS}
 * of them.
 */
export const FEATURE_FLAG_SNAPSHOT_MAX_FLAGS = 1000;
export const FEATURE_FLAG_SNAPSHOT_MAX_KEY_LENGTH = 200;
const FEATURE_FLAG_SNAPSHOT_MAX_ID_LENGTH = 200;
const FEATURE_FLAG_SNAPSHOT_MAX_VARIANT_LENGTH = 200;

export const featureFlagSnapshotSchema = z.object({
  takenAt: z.iso.datetime(),
  distinctId: z.string().min(1).max(FEATURE_FLAG_SNAPSHOT_MAX_ID_LENGTH),
  orgId: z.string().min(1).max(FEATURE_FLAG_SNAPSHOT_MAX_ID_LENGTH).optional(),
  flags: z
    .record(
      z.string().min(1).max(FEATURE_FLAG_SNAPSHOT_MAX_KEY_LENGTH),
      z.union([
        z.boolean(),
        z.string().max(FEATURE_FLAG_SNAPSHOT_MAX_VARIANT_LENGTH),
      ])
    )
    .refine(
      (flags) => Object.keys(flags).length <= FEATURE_FLAG_SNAPSHOT_MAX_FLAGS,
      { message: `At most ${FEATURE_FLAG_SNAPSHOT_MAX_FLAGS} flags` }
    ),
});

export type FeatureFlagSnapshot = z.infer<typeof featureFlagSnapshotSchema>;

/**
 * `POST` path on `apps/api` (stage) that stores a snapshot in a branch's
 * preview schema. Authenticated with a GitHub OIDC token whose audience is
 * {@link FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE}; a repeat `POST` replaces the
 * stored snapshot (the "refresh when the person asks" case).
 */
export const FEATURE_FLAG_SNAPSHOT_ROUTE_PATH =
  "/preview-schemas/feature-flag-snapshot" as const;

export const FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE =
  "closedloop-preview-schema-feature-flag-snapshot" as const;

/** The body of a `POST` to {@link FEATURE_FLAG_SNAPSHOT_ROUTE_PATH}. */
export const featureFlagSnapshotRequestSchema = z.object({
  /** The git branch whose preview schema receives the snapshot. */
  branch: z.string().min(1),
  snapshot: featureFlagSnapshotSchema,
});

export type FeatureFlagSnapshotRequest = z.infer<
  typeof featureFlagSnapshotRequestSchema
>;

/**
 * ISS-12048: `GET` path on `apps/api` returning the snapshot this API pins, for
 * the web shell's server render to pin the browser's flags to the same values.
 * Authenticated like any product read; answers `{ snapshot: null }` everywhere
 * except a preview environment that stores a snapshot.
 */
export const PINNED_FEATURE_FLAGS_ROUTE_PATH = "/feature-flags/pinned" as const;

export const pinnedFeatureFlagsResponseSchema = z.object({
  snapshot: featureFlagSnapshotSchema
    .pick({ takenAt: true, flags: true })
    .nullable(),
});

export type PinnedFeatureFlagsResponse = z.infer<
  typeof pinnedFeatureFlagsResponseSchema
>;
