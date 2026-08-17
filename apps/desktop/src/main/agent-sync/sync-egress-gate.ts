import {
  type OrgSessionSyncPolicyState,
  OrgSessionSyncPolicyUnresolved,
  orgPolicyAllowsSessionSync,
  type SyncObservabilityTier,
  syncTierAllowsSessionMetadata,
  syncTierAllowsTranscripts,
} from "../../shared/contracts.js";
import { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";

/**
 * ISS-4623 — the desktop session-data egress gate, extracted from `app.ts` so
 * the two-layer decision is unit-testable in isolation (and so the grandfathered
 * `app.ts` sheds a responsibility rather than carrying it inline; wongk review).
 *
 * Two layers, ANDed so the gate can only suppress, never widen:
 * 1. OUTER server-owned ORG POLICY ({@link orgPolicyAllowsSessionSync}) — fails
 *    CLOSED while `"unknown"` (still loading / failed fetch), degrades to device
 *    consent while `"unsupported"` (old server, version skew).
 * 2. INNER per-device consent tier ({@link syncTierAllowsSessionMetadata} /
 *    {@link syncTierAllowsTranscripts}) — an explicit non-`null` tier is
 *    authoritative; a not-yet-consented `null` tier suppresses the lane.
 */
export type SyncEgressGateInputs = {
  /** The cached org-policy state (outer gate). */
  policyState: OrgSessionSyncPolicyState;
  /** The user's chosen sync-observability tier, or `null` when not yet consented. */
  tier: SyncObservabilityTier | null;
};

/**
 * Does the org policy permit ANY session-data egress? Pure over the cached
 * state; the caller is responsible for kicking a self-heal refresh when the
 * state is still unresolved (the store owns that loop).
 */
export function orgPolicyGateAllows(
  policyState: OrgSessionSyncPolicyState
): boolean {
  return orgPolicyAllowsSessionSync(policyState);
}

/** Metadata lane: org policy AND the metadata-or-fuller tier both permit egress. */
export function sessionMetadataEgressAllowed(
  inputs: SyncEgressGateInputs
): boolean {
  return (
    orgPolicyGateAllows(inputs.policyState) &&
    inputs.tier !== null &&
    syncTierAllowsSessionMetadata(inputs.tier)
  );
}

/**
 * Transcript lane: org policy AND the `full` tier both permit egress.
 *
 * Defined in terms of {@link transcriptEgressGate} so the boolean the lane
 * drains on and the tri-state the UI renders can never drift apart. Behavior is
 * unchanged: an unresolved policy is not `Allowed`, so egress still fails
 * closed exactly as before.
 */
export function transcriptEgressAllowed(inputs: SyncEgressGateInputs): boolean {
  return transcriptEgressGate(inputs) === TranscriptEgressGate.Allowed;
}

/**
 * ISS-4623 (shafty023 review) — why the component-sync lane re-reads this gate
 * IMMEDIATELY before every send, rather than trusting the freshness guard it
 * captured at the top of the drain.
 *
 * `AgentSessionSyncService` guards its post-await writes with a
 * generation-plus-`started` check, which catches a stop and an identity change
 * (`resetSourceState` bumps the generation). It does NOT catch either of these:
 *
 * 1. A bare ORG-POLICY CLOSE (`true` → `false`, or a resolved value dropping back
 *    to the fail-closed `"unknown"`). Nothing about that transition touches the
 *    source-state generation, so a stale-but-"current" run would sail past the
 *    guard.
 * 2. A COMPUTE-TARGET SWITCH that reconnects to a new id mid-drain.
 *
 * The cursor read, row load, and DB reads between the guard capture and the POST
 * are all async, so either event can land inside that window. Re-reading the LIVE
 * gate and confirming the online compute target still equals the one the run began
 * against is what stops the batch (and the dead-letter batch) from egressing under
 * a just-closed gate or to the previous account's target. Aborting is safe and
 * lossless: the cursor is not advanced, so the next drain re-reads the same batch
 * once the gate reopens for the current target. This mirrors the
 * component-invocation lane's `canStillSend`.
 */

/**
 * ISS-5348 (review) — the transcript gate as THREE states, for consumers that
 * DISPLAY it rather than drain on it.
 *
 * The boolean above cannot distinguish "your org denies this" from "we have not
 * heard back yet": `OrgSyncPolicyStore` is born `Unknown` and the outer gate
 * fails closed on it, so both arrive as `false`. Failing closed is right for
 * egress and wrong for copy — the import splash renders at boot, exactly when
 * the unresolved window is open, so it stated a denial that had not been made
 * and then flipped a poll later.
 *
 * Precedence is deliberate: a SETTLED tier verdict outranks an unresolved
 * policy. The tier is a local, synchronously-readable user choice, so when it
 * already forbids transcripts there is nothing to wait for and `Denied` is the
 * honest answer even while the policy is still in flight. Only `Unknown`
 * produces `Unresolved`; `"unsupported"` is a terminal old-server verdict that
 * degrades to allow, and treating it as pending would spin forever.
 */
export function transcriptEgressGate(
  inputs: SyncEgressGateInputs
): TranscriptEgressGate {
  if (inputs.tier === null || !syncTierAllowsTranscripts(inputs.tier)) {
    return TranscriptEgressGate.Denied;
  }
  if (inputs.policyState === OrgSessionSyncPolicyUnresolved.Unknown) {
    return TranscriptEgressGate.Unresolved;
  }
  return orgPolicyGateAllows(inputs.policyState)
    ? TranscriptEgressGate.Allowed
    : TranscriptEgressGate.Denied;
}
