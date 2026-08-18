import type { OrgSessionSyncPolicyState } from "../../shared/contracts.js";
import {
  consentTierForOrg,
  type SyncConsentRecord,
} from "../../shared/sync-consent.js";
import type { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";
import {
  type SyncEgressGateInputs,
  sessionMetadataEgressAllowed,
  transcriptEgressAllowed,
  transcriptEgressGate,
} from "./sync-egress-gate.js";

/**
 * ISS-5348 — the LIVE-STATE adapter over the pure session-data egress gate,
 * extracted from `app.ts` for the same reason `sync-egress-gate.ts` itself was
 * (ISS-4623): the decision is already unit-testable in isolation, so the
 * grandfathered `app.ts` should not keep carrying the store-binding half of the
 * responsibility inline.
 *
 * `sync-egress-gate.ts` owns the pure two-layer decision — server-owned ORG
 * POLICY ANDed above the per-device consent tier, so the gate can only suppress,
 * never widen. This module owns only the binding: reading both inputs LIVE on
 * every evaluation, so a later consent change or policy resolution is picked up
 * on the next `shouldRun()` evaluation rather than being captured once at wiring
 * time.
 */
export type SyncEgressGateAdapterDeps = {
  /**
   * Kick the policy store's throttled self-heal. Called on every read because a
   * lane whose tick timer was torn down stops calling the gate entirely; the
   * store ALSO self-heals on its own timer and notifies subscribers, which
   * re-kick the lanes (see the `wireOrgSyncPolicySubscription` wiring).
   */
  ensureResolved: () => void;
  /** The cached org-policy state (outer gate); `"unknown"` until a fetch lands. */
  getPolicyState: () => OrgSessionSyncPolicyState;
  /**
   * What this device has on disk about the user's consent answer: the tier, and
   * the org it was recorded for.
   *
   * PRD-532 §7: an explicit consent choice is always authoritative — a user who
   * selected `local`/`metadata`/`full` is honored, otherwise a persisted "keep it
   * local" choice could be silently overridden and uploads would resume. A
   * not-yet-consented (`null`) tier suppresses the lane.
   */
  getConsentRecord: () => SyncConsentRecord;
  /**
   * ISS-5489: the org of the CURRENT session, which is what makes the recorded
   * answer applicable or not. A bound answer covers only its own org, so an org
   * switch suppresses the lanes until the takeover is answered again — the modal
   * cannot be the enforcement boundary, because the lanes never consult it.
   */
  getSessionOrganizationId: () => string | null;
};

export type SyncEgressGateAdapter = {
  /** Freshly-read inputs for the gate; also kicks the policy self-heal. */
  readInputs: () => SyncEgressGateInputs;
  /** Metadata lane (counts/aggregates): may it reach the cloud right now? */
  sessionMetadataAllowed: () => boolean;
  /** Transcript lane: may it reach the cloud right now? Fails CLOSED. */
  transcriptAllowed: () => boolean;
  /**
   * The transcript gate as THREE states, for consumers that DISPLAY it rather
   * than drain on it — an unresolved org policy stays distinguishable from a
   * real denial, so the import splash cannot state a denial nobody made. Egress
   * still keys off {@link SyncEgressGateAdapter.transcriptAllowed}.
   */
  transcriptGate: () => TranscriptEgressGate;
};

export function createSyncEgressGateAdapter(
  deps: SyncEgressGateAdapterDeps
): SyncEgressGateAdapter {
  const readInputs = (): SyncEgressGateInputs => {
    deps.ensureResolved();
    return {
      policyState: deps.getPolicyState(),
      tier: consentTierForOrg(
        deps.getConsentRecord(),
        deps.getSessionOrganizationId()
      ),
    };
  };
  return {
    readInputs,
    sessionMetadataAllowed: () => sessionMetadataEgressAllowed(readInputs()),
    transcriptAllowed: () => transcriptEgressAllowed(readInputs()),
    transcriptGate: () => transcriptEgressGate(readInputs()),
  };
}
