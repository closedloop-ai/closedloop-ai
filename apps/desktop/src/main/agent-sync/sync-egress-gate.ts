import {
  type SyncObservabilityTier,
  syncTierAllowsSessionMetadata,
} from "../../shared/contracts.js";
import { syncTierExcludesTranscripts } from "../../shared/sync-observability-tier.js";
import { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";

/**
 * ISS-4623 — the desktop session-data egress gate, extracted from `app.ts` so
 * the decision is unit-testable in isolation (and so the grandfathered `app.ts`
 * sheds a responsibility rather than carrying it inline; whitlockk review).
 *
 * ISS-11449 removed the OUTER layer. There used to be two, ANDed: a server-owned
 * org policy above the per-device consent tier. The org policy is gone —
 * operator ruling, 2026-09-28: what a user elected is what happens, and no
 * org-level control may override it — so this gate is now exactly the per-device
 * consent tier ({@link syncTierAllowsSessionMetadata} /
 * {@link syncTierExcludesTranscripts}). An explicit non-`null` tier is
 * authoritative; a not-yet-consented `null` tier suppresses the lane.
 */
export type SyncEgressGateInputs = {
  /** The user's chosen sync-observability tier, or `null` when not yet consented. */
  tier: SyncObservabilityTier | null;
};

/** Metadata lane: the metadata-or-fuller tier permits egress. */
export function sessionMetadataEgressAllowed(
  inputs: SyncEgressGateInputs
): boolean {
  return inputs.tier !== null && syncTierAllowsSessionMetadata(inputs.tier);
}

/**
 * Transcript lane: the `full` tier permits egress.
 *
 * Defined in terms of {@link transcriptEgressGate} so the boolean the lane
 * drains on and the value the UI renders can never drift apart.
 */
export function transcriptEgressAllowed(inputs: SyncEgressGateInputs): boolean {
  return transcriptEgressGate(inputs) === TranscriptEgressGate.Allowed;
}

/**
 * ISS-4623 (davetho review) — why the component-sync lane re-reads this gate
 * IMMEDIATELY before every send, rather than trusting the freshness guard it
 * captured at the top of the drain.
 *
 * `AgentSessionSyncService` guards its post-await writes with a
 * generation-plus-`started` check, which catches a stop and an identity change
 * (`resetSourceState` bumps the generation). It does NOT catch a COMPUTE-TARGET
 * SWITCH that reconnects to a new id mid-drain. (It also used to miss a bare
 * org-policy close; ISS-11449 retired that transition with the policy itself.)
 *
 * The cursor read, row load, and DB reads between the guard capture and the POST
 * are all async, so the switch can land inside that window. Re-reading the LIVE
 * gate and confirming the online compute target still equals the one the run began
 * against is what stops the batch (and the dead-letter batch) from egressing to
 * the previous account's target. Aborting is safe and lossless: the cursor is not
 * advanced, so the next drain re-reads the same batch once the gate reopens for
 * the current target. This mirrors the component-invocation lane's `canStillSend`.
 */

/**
 * The transcript gate as a named verdict rather than a bare boolean, for
 * consumers that DISPLAY it as well as those that drain on it.
 *
 * ISS-11449 removed its third state. `Unresolved` existed only for the boot
 * window in which the server-owned org policy had not been fetched yet — a
 * denial nobody had made, which the import splash rendered as settled fact
 * (ISS-5348). With the policy gone there is no asynchronous input left: the
 * consent tier is a local, synchronously-readable user choice, so every read
 * has a settled answer and there is nothing to be pending on.
 */
export function transcriptEgressGate(
  inputs: SyncEgressGateInputs
): TranscriptEgressGate {
  // ISS-7516: the `null` arm is spelled out here rather than folded into
  // `syncTierExcludesTranscripts`, because the two callers need OPPOSITE
  // answers for it. Egress must fail closed on a not-yet-consented device; the
  // renderer's copy must NOT claim a settled level the user never chose.
  if (inputs.tier === null || syncTierExcludesTranscripts(inputs.tier)) {
    return TranscriptEgressGate.Denied;
  }
  return TranscriptEgressGate.Allowed;
}
