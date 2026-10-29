import assert from "node:assert/strict";
import { test } from "vitest";
import { createSyncEgressGateAdapter } from "../src/main/agent-sync/sync-egress-gate-adapter.js";
import type { SyncObservabilityTier } from "../src/shared/contracts.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

// ISS-5348 — the LIVE-STATE adapter over the pure egress gate. The decision
// itself is covered by sync-egress-gate.test.ts; what is asserted here is the
// BINDING half that moved out of app.ts: the inputs are re-read on every
// evaluation. ISS-11449 removed the outer org-policy input and its self-heal
// kick, so the consent tier is the whole of what is bound here.

type GateHarness = {
  adapter: ReturnType<typeof createSyncEgressGateAdapter>;
  setTier: (next: SyncObservabilityTier | null) => void;
  setConsentRecord: (next: SyncConsentRecord) => void;
  setSessionOrganizationId: (next: string | null) => void;
};

/**
 * `tier` seeds an UNBOUND record — a pre-ISS-5489 answer, which covers every org
 * — so the tests that predate the org binding keep asserting exactly what they
 * always did. The binding cases set the record explicitly.
 */
function createHarness(tier: SyncObservabilityTier | null): GateHarness {
  let currentRecord: SyncConsentRecord = {
    tier,
    organizationId: null,
    bound: false,
  };
  let currentSessionOrganizationId: string | null = null;
  const adapter = createSyncEgressGateAdapter({
    getConsentRecord: () => currentRecord,
    getSessionOrganizationId: () => currentSessionOrganizationId,
  });
  return {
    adapter,
    setTier: (next) => {
      currentRecord = { ...currentRecord, tier: next };
    },
    setConsentRecord: (next) => {
      currentRecord = next;
    },
    setSessionOrganizationId: (next) => {
      currentSessionOrganizationId = next;
    },
  };
}

test("readInputs reads the consent tier live on every evaluation", () => {
  const harness = createHarness("local");

  assert.deepEqual(harness.adapter.readInputs(), { tier: "local" });

  harness.setTier("full");

  assert.deepEqual(harness.adapter.readInputs(), { tier: "full" });
});

test("a later consent change flips the decisions without re-wiring the adapter", () => {
  const harness = createHarness(null);

  assert.equal(harness.adapter.sessionMetadataAllowed(), false);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setTier("metadata");
  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setTier("full");
  assert.equal(harness.adapter.sessionMetadataAllowed(), true);
  assert.equal(harness.adapter.transcriptAllowed(), true);
});

test("transcriptGate and transcriptAllowed answer from the same tier read", () => {
  const harness = createHarness("full");

  assert.equal(harness.adapter.transcriptGate(), TranscriptEgressGate.Allowed);
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setTier("metadata");
  assert.equal(harness.adapter.transcriptGate(), TranscriptEgressGate.Denied);
  assert.equal(harness.adapter.transcriptAllowed(), false);

  harness.setTier(null);
  assert.equal(harness.adapter.transcriptGate(), TranscriptEgressGate.Denied);
  assert.equal(harness.adapter.transcriptAllowed(), false);
});

test("an answer bound to another org does not authorize this one (ISS-5489)", () => {
  // The takeover modal cannot be the enforcement boundary: the lanes upload from
  // main on their own timers and never consult it. A device that answered Full
  // for org A used to keep uploading at Full the moment the session switched to
  // org B, while the takeover was still on screen asking B's question.
  const harness = createHarness(null);
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
  const harness = createHarness("full");
  harness.setSessionOrganizationId("org_acme");
  assert.equal(harness.adapter.transcriptAllowed(), true);

  harness.setSessionOrganizationId("org_globex");
  assert.equal(harness.adapter.transcriptAllowed(), true);
});
