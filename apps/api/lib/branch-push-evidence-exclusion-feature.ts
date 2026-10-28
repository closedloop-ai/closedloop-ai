import "server-only";

import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { BRANCH_PUSH_EVIDENCE_EXCLUSION_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * ISS-8148 (PRD-683 Ruling 2 / Decision 7): gates the READ-side half of
 * push-gated branch association — excluding branches with no evidence they ever
 * reached a remote from the agent-component detail attribution reads. The
 * Delivery branch-population donuts no longer read it: since ISS-11915 they
 * count the Branches list population, which always requires verified
 * publication.
 *
 * App-owned, not `packages/api/src/types/`: that package is for contracts BOTH
 * apps consume, and this key is read only here. The gate is server-side because
 * the exclusion is a query predicate rather than a render. Default OFF.
 *
 * The write-side gate in the session ingest lane is NOT flagged — it only stops
 * new rows being created, and a deferral is self-healing.
 */
export const BRANCH_PUSH_EVIDENCE_EXCLUSION_FLAG_KEY =
  BRANCH_PUSH_EVIDENCE_EXCLUSION_SERVER_FLAG.key;

/** Structured-log event emitted only when flag evaluation throws. */
export const BRANCH_PUSH_EVIDENCE_EXCLUSION_FLAG_UNAVAILABLE_LOG_KEY =
  "branch_push_evidence_exclusion_flag_unavailable" as const;

/**
 * Fail-closed: an unavailable PostHog answer keeps the pre-ISS-8148
 * populations, so a flag outage can never silently shrink a breakdown under a
 * reader.
 */
export function isBranchPushEvidenceExclusionEnabled(
  identity: FeatureFlagIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    BRANCH_PUSH_EVIDENCE_EXCLUSION_SERVER_FLAG,
    identity,
    BRANCH_PUSH_EVIDENCE_EXCLUSION_FLAG_UNAVAILABLE_LOG_KEY
  );
}
