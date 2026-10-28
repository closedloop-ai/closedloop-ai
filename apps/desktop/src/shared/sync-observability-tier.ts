import {
  type SyncObservabilityTier,
  syncTierAllowsTranscripts,
} from "./contracts.js";

/**
 * The closed set of session-observability sync tiers (PRD-532 M4), in exact
 * parity with the shared `SyncTier` type in
 * `packages/app/onboarding/components/sync-consent.tsx`.
 */
export const SYNC_OBSERVABILITY_TIERS = [
  "full",
  "metadata",
  "local",
] as const satisfies readonly SyncObservabilityTier[];

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

/**
 * ISS-7516 — has the DEVICE'S OWN consent tier already settled that no
 * transcript will ever leave this machine?
 *
 * The negation of {@link syncTierAllowsTranscripts} is deliberately NOT the
 * same predicate, and the difference is the whole point. `syncTierAllowsTranscripts`
 * answers "may the lane drain right now", so it fails closed on a
 * not-yet-consented `null` tier. That is right for egress and wrong for COPY: a
 * user who has not answered the consent question yet has no settled level, and
 * telling them their level is the reason their transcript is missing would be a
 * verdict nobody has reached. Only an EXPLICIT tier that excludes transcripts
 * counts here.
 *
 * This is the display twin of `transcriptEgressGate`'s tier arm, expressed over
 * the tier alone: it deliberately does NOT fold in the org policy, because a
 * policy denial is a different fact with a different remedy and must not be
 * reported to a user as their own setting.
 *
 * Lives here rather than beside `syncTierAllowsTranscripts` in `contracts.ts`
 * only because that file is over the file-size ceiling and shrink-only; it is
 * defined in terms of that predicate so the two can never disagree about which
 * tiers carry transcripts.
 */
export function syncTierExcludesTranscripts(
  tier: SyncObservabilityTier | null
): boolean {
  return tier !== null && !syncTierAllowsTranscripts(tier);
}
