import type { SyncObservabilityTier } from "./contracts.js";

/**
 * The closed set of session-observability sync tiers (PRD-532 M4), in exact
 * parity with the shared `SyncTier` type in
 * `packages/app/onboarding/components/sync-consent.tsx`.
 */
export const SYNC_OBSERVABILITY_TIERS: readonly SyncObservabilityTier[] = [
  "full",
  "metadata",
  "local",
];

/**
 * Validate a renderer-supplied sync-observability tier server-side (PRD-532
 * M4). Defense-in-depth on top of the trusted-sender boundary: a compromised or
 * partial renderer must not be able to persist an out-of-contract tier value.
 * Throws on anything other than the three literals. Lives in `shared/` (no
 * `electron` import) so the main-process IPC handler and node:test can both use
 * it.
 */
export function normalizeSyncObservabilityTier(
  value: unknown
): SyncObservabilityTier {
  if (
    typeof value === "string" &&
    (SYNC_OBSERVABILITY_TIERS as readonly string[]).includes(value)
  ) {
    return value as SyncObservabilityTier;
  }
  throw new Error(
    `Invalid sync observability tier: expected one of ${SYNC_OBSERVABILITY_TIERS.join(", ")}`
  );
}
