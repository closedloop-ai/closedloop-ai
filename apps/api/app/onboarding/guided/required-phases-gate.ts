/**
 * @file required-phases-gate.ts
 * @description The per-viewer memo for the ISS-11073 required-phases gate.
 *
 * Its own module rather than a few lines inside `snapshot-service.ts`: that
 * file already owns the whole read fan-out, and a gate is a separate
 * responsibility with its own lifetime and its own test seam.
 *
 * The gate is read ONCE per snapshot composition. Every transition response is
 * composed through the same function, so a viewer whose answer flipped
 * mid-run would otherwise see the fold applied to one response and not the
 * next; the TTL is a page-load's worth for exactly that reason, the same
 * contract `createMemoizedFeatureFlagGate` states.
 *
 * That contract is taken in its CROSS-INSTANCE form (ISS-8126), because this
 * gate decides a BLOCKING sequence rather than a presentation detail. The memo
 * alone is process-local and `apps/api` is serverless, so a reload onto a cold
 * instance during a PostHog outage would fail closed and drop the reader out of
 * the required phases mid-run. The shared decision record is what a cold
 * instance holds in place of a last-known answer.
 */

import { createFeatureFlagDecisionStore } from "@/lib/feature-flag-decision-store";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import { WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { createMemoizedFeatureFlagGate } from "@/lib/memoized-feature-flag-gate";

/** How long one viewer's evaluated required-phases decision is reused. */
export const GUIDED_REQUIRED_PHASES_DECISION_TTL_MS = 30_000;

/** Re-arm window after an unanswered lookup; short, so a recovery is picked up. */
const GUIDED_REQUIRED_PHASES_UNAVAILABLE_BACKOFF_MS = 5000;

/** Per-viewer memo cap. Bounded growth (repo rule: no unbounded cache). */
const GUIDED_REQUIRED_PHASES_MAX_ENTRIES = 5000;

/**
 * How long after its EVALUATION another instance may honor this viewer's
 * decision (ISS-8126).
 *
 * The memo above is process-local, and `apps/api` is serverless, so without
 * this a reader who got an ON snapshot from one instance and then reloaded onto
 * a COLD one during a PostHog outage would have that instance fail closed,
 * accept the legacy wizard marker, and return `Ready` — dropping them out of
 * the required invitation/download sequence mid-run with nothing on screen to
 * say why. A cold instance has no last-known decision to hold; this record is
 * what it holds instead.
 *
 * Fifteen minutes: far longer than {@link GUIDED_REQUIRED_PHASES_DECISION_TTL_MS},
 * which is sized for one page load, and comfortably longer than a first run
 * takes to walk invitations and the download; still bounded, so a viewer taken
 * out of the rollout does not keep the sequence for the length of an outage.
 * PostHog stays authoritative — the record is consulted ONLY when an evaluation
 * could not be made, never when one succeeds.
 */
const GUIDED_REQUIRED_PHASES_SHARED_DECISION_TTL_MS = 900_000;

const guidedRequiredPhasesGate = createMemoizedFeatureFlagGate({
  flag: WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG,
  unavailableLogKey: `${WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG.key}_flag_unavailable`,
  ttlMs: GUIDED_REQUIRED_PHASES_DECISION_TTL_MS,
  unavailableBackoffMs: GUIDED_REQUIRED_PHASES_UNAVAILABLE_BACKOFF_MS,
  maxEntries: GUIDED_REQUIRED_PHASES_MAX_ENTRIES,
  sharedDecisionStore: createFeatureFlagDecisionStore(),
  sharedDecisionTtlMs: GUIDED_REQUIRED_PHASES_SHARED_DECISION_TTL_MS,
});

/**
 * Whether this viewer's guided run must reach its required phases.
 *
 * Fails CLOSED on an unanswered lookup, which is the pre-flag behavior: the
 * legacy marker is honored and the organization step still runs. An outage
 * therefore costs the reconciled sequence, never a takeover nobody asked for.
 */
export function resolveGuidedRequiredPhases(
  identity: FeatureFlagIdentity,
  now: number = Date.now()
): Promise<boolean> {
  return guidedRequiredPhasesGate.resolve(identity, now);
}

/**
 * Test seam: drop every memoized required-phases decision.
 *
 * IN-PROCESS ONLY, per `MemoizedFeatureFlagGate.clear`. It does not reach the
 * shared decision record, so a suite that drives this gate against a real
 * database and needs a genuinely cold start needs `purgeFeatureFlagDecisions`
 * as well.
 */
export function clearGuidedRequiredPhasesDecisions(): void {
  guidedRequiredPhasesGate.clear();
}
