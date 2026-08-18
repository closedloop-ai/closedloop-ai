import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyncEgressGateAdapter } from "../src/main/agent-sync/sync-egress-gate-adapter.js";
import type {
  OrgSessionSyncPolicyState,
  SyncObservabilityTier,
} from "../src/shared/contracts.js";
import { OrgSessionSyncPolicyUnresolved } from "../src/shared/contracts.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

// ISS-5348 — the LIVE-STATE adapter over the pure egress gate. The decision
// itself is covered by sync-egress-gate.test.ts; what is asserted here is the
// BINDING half that moved out of app.ts: both inputs are re-read on every
// evaluation, and every evaluation kicks the policy store's self-heal.

type GateHarness = {
  adapter: ReturnType<typeof createSyncEgressGateAdapter>;
  setPolicyState: (next: OrgSessionSyncPolicyState) => void;
  setTier: (next: SyncObservabilityTier | null) => void;
  setConsentRecord: (next: SyncConsentRecord) => void;
  setSessionOrganizationId: (next: string | null) => void;
  ensureResolvedCalls: () => number;
};

/**
 * `tier` seeds an UNBOUND record — a pre-ISS-5489 answer, which covers every org
 * — so the tests that predate the org binding keep asserting exactly what they
 * always did. The binding cases set the record explicitly.
 */
function createHarness(
  policyState: OrgSessionSyncPolicyState,
  tier: SyncObservabilityTier | null
): GateHarness {
  let currentPolicyState = policyState;
  let currentRecord: SyncConsentRecord = {
    tier,
    organizationId: null,
    bound: false,
  };
  let currentSessionOrganizationId: string | null = null;
  let calls = 0;
  const adapter = createSyncEgressGateAdapter({
    ensureResolved: () => {
      calls += 1;
    },
    getConsentRecord: () => currentRecord,
    getPolicyState: () => currentPolicyState,
    getSessionOrganizationId: () => currentSessionOrganizationId,
  });
  return {
    adapter,
    setPolicyState: (next) => {
      currentPolicyState = next;
    },
    setTier: (next) => {
      currentRecord = { ...currentRecord, tier: next };
    },
    setConsentRecord: (next) => {
      currentRecord = next;
    },
    setSessionOrganizationId: (next) => {
      currentSessionOrganizationId = next;
    },
    ensureResolvedCalls: () => calls,
  };
}

test("readInputs reads both inputs live and kicks the policy self-heal each time", () => {
  const harness = createHarness(
    OrgSessionSyncPolicyUnresolved.Unknown,
    "local"
  );

  assert.deepEqual(harness.adapter.readInputs(), {
    policyState: OrgSessionSyncPolicyUnresolved.Unknown,
    tier: "local",
  });
  assert.equal(harness.ensureResolvedCalls(), 1);

  harness.setPolicyState(true);
  harness.setTier("full");

  assert.deepEqual(harness.adapter.readInputs(), {
    policyState: true,
    tier: "full",
  });
  assert.equal(harness.ensureResolvedCalls(), 2);
});

test("a later consent change flips the decisions without re-wiring the adapter", () => {
  const harness = createHarness(true, null);

  assert.equal(harness.adapter.sessionMetadataAllowed(), false);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setTier("metadata");
  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setTier("full");
  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), true);
});

test("an org-policy close suppresses both lanes on the very next read", () => {
  const harness = createHarness(true, "full");

  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setPolicyState(false);

  assert.equal(harness.adapter.sessionMetadataAllowed(), false);
  assert.equal(harness.adapter.transcriptAllowed(), false);
});

test("transcriptGate keeps the unresolved window distinct while egress fails closed", () => {
  const harness = createHarness(OrgSessionSyncPolicyUnresolved.Unknown, "full");

  assert.equal(
    harness.adapter.transcriptGate(),
    TranscriptEgressGate.Unresolved
  );
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setPolicyState(true);
  assert.equal(harness.adapter.transcriptGate(), TranscriptEgressGate.Allowed);
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setPolicyState(false);
  assert.equal(harness.adapter.transcriptGate(), TranscriptEgressGate.Denied);
  assert.equal(harness.adapter.transcriptAllowed(), false);
});

test("an answer bound to another org does not authorize this one (ISS-5489)", () => {
  // The takeover modal cannot be the enforcement boundary: the lanes upload from
  // main on their own timers and never consult it. A device that answered Full
  // for org A used to keep uploading at Full the moment the session switched to
  // org B, while the takeover was still on screen asking B's question.
  const harness = createHarness(true, null);
  harness.setConsentRecord({
    tier: "full",
    organizationId: "org_acme",
    bound: true,
  });

  harness.setSessionOrganizationId("org_acme");
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setSessionOrganizationId("org_globex");
  assert.equal(harness.adapter.readInputs().tier, null);
  assert.equal(harness.adapter.sessionMetadataAllowed(), false);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  // Answering for the new org restores it, without re-wiring the adapter.
  harness.setConsentRecord({
    tier: "metadata",
    organizationId: "org_globex",
    bound: true,
  });
  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), false);
});

test("a pre-binding answer still covers every org", () => {
  // An UNBOUND record is a pre-ISS-5489 install: a real tier, no binding. The
  // modal honors it rather than re-asking a settled question, and the gate has to
  // agree — narrowing egress here would silently stop syncing for every existing
  // user the moment this shipped.
  const harness = createHarness(true, "full");
  harness.setSessionOrganizationId("org_acme");
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setSessionOrganizationId("org_globex");
  assert.equal(harness.adapter.transcriptAllowed(), true);
});

test("every decision helper kicks the policy self-heal, not just readInputs", () => {
  const harness = createHarness(true, "full");

  harness.adapter.sessionMetadataAllowed();
  harness.adapter.transcriptAllowed();
  harness.adapter.transcriptGate();

  assert.equal(harness.ensureResolvedCalls(), 3);
});
