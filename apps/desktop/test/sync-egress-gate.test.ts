import assert from "node:assert/strict";
import { test } from "node:test";
import {
  orgPolicyGateAllows,
  sessionMetadataEgressAllowed,
  transcriptEgressAllowed,
  transcriptEgressGate,
} from "../src/main/agent-sync/sync-egress-gate.js";
import { OrgSessionSyncPolicyUnresolved } from "../src/shared/contracts.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

// ISS-4623 — the two-layer session-data egress gate. The org policy is ANDed
// ABOVE the consent tier, so it can only suppress, never widen. An unresolved
// `"unknown"` policy fails closed; an old-server `"unsupported"` degrades to the
// device-consent tier.

test("orgPolicyGateAllows: explicit true allows, false / unknown deny, unsupported degrades", () => {
  assert.equal(orgPolicyGateAllows(true), true);
  assert.equal(orgPolicyGateAllows(false), false);
  assert.equal(
    orgPolicyGateAllows(OrgSessionSyncPolicyUnresolved.Unknown),
    false
  );
  assert.equal(
    orgPolicyGateAllows(OrgSessionSyncPolicyUnresolved.Unsupported),
    true
  );
});

test("sessionMetadataEgressAllowed: needs BOTH the org policy and a metadata-or-fuller tier", () => {
  // Policy on + a permitting tier → allow.
  assert.equal(
    sessionMetadataEgressAllowed({ policyState: true, tier: "metadata" }),
    true
  );
  assert.equal(
    sessionMetadataEgressAllowed({ policyState: true, tier: "full" }),
    true
  );
  // Policy on but tier local / not-yet-consented → deny.
  assert.equal(
    sessionMetadataEgressAllowed({ policyState: true, tier: "local" }),
    false
  );
  assert.equal(
    sessionMetadataEgressAllowed({ policyState: true, tier: null }),
    false
  );
  // Tier permits, but the org policy is off / still loading → deny (outer gate wins).
  assert.equal(
    sessionMetadataEgressAllowed({ policyState: false, tier: "full" }),
    false
  );
  assert.equal(
    sessionMetadataEgressAllowed({
      policyState: OrgSessionSyncPolicyUnresolved.Unknown,
      tier: "full",
    }),
    false
  );
  // Old server (unsupported) degrades to the tier decision.
  assert.equal(
    sessionMetadataEgressAllowed({
      policyState: OrgSessionSyncPolicyUnresolved.Unsupported,
      tier: "metadata",
    }),
    true
  );
});

test("transcriptEgressAllowed: needs BOTH the org policy and the `full` tier", () => {
  assert.equal(
    transcriptEgressAllowed({ policyState: true, tier: "full" }),
    true
  );
  // `metadata` permits the metadata lane but NOT transcripts.
  assert.equal(
    transcriptEgressAllowed({ policyState: true, tier: "metadata" }),
    false
  );
  assert.equal(
    transcriptEgressAllowed({ policyState: true, tier: null }),
    false
  );
  // Policy off / unresolved suppresses even the `full` tier.
  assert.equal(
    transcriptEgressAllowed({ policyState: false, tier: "full" }),
    false
  );
  assert.equal(
    transcriptEgressAllowed({
      policyState: OrgSessionSyncPolicyUnresolved.Unknown,
      tier: "full",
    }),
    false
  );
  assert.equal(
    transcriptEgressAllowed({
      policyState: OrgSessionSyncPolicyUnresolved.Unsupported,
      tier: "full",
    }),
    true
  );
});

test("ISS-5348: transcriptEgressGate separates an unresolved policy from a settled denial", () => {
  // The defect the tri-state exists to fix: `false` and `"unknown"` both
  // collapsed to `tierAllowed: false`, so a boot splash rendered a denial that
  // had not been made.
  assert.equal(
    transcriptEgressGate({
      policyState: OrgSessionSyncPolicyUnresolved.Unknown,
      tier: "full",
    }),
    TranscriptEgressGate.Unresolved
  );
  assert.equal(
    transcriptEgressGate({ policyState: false, tier: "full" }),
    TranscriptEgressGate.Denied
  );
  assert.equal(
    transcriptEgressGate({ policyState: true, tier: "full" }),
    TranscriptEgressGate.Allowed
  );
  // `"unsupported"` is a TERMINAL old-server verdict that degrades to allow.
  // Reporting it as pending would spin forever on a server that will never
  // answer.
  assert.equal(
    transcriptEgressGate({
      policyState: OrgSessionSyncPolicyUnresolved.Unsupported,
      tier: "full",
    }),
    TranscriptEgressGate.Allowed
  );
});

test("ISS-5348: a settled tier verdict outranks an unresolved policy", () => {
  // The tier is a local, synchronously-readable user choice. When it already
  // forbids transcripts there is nothing to wait for, so reporting `Unresolved`
  // would park the UI on a skeleton for a decision that is already made.
  for (const tier of ["metadata", "local"] as const) {
    assert.equal(
      transcriptEgressGate({
        policyState: OrgSessionSyncPolicyUnresolved.Unknown,
        tier,
      }),
      TranscriptEgressGate.Denied,
      `tier ${tier} is a settled no`
    );
  }
  assert.equal(
    transcriptEgressGate({
      policyState: OrgSessionSyncPolicyUnresolved.Unknown,
      tier: null,
    }),
    TranscriptEgressGate.Denied,
    "a not-yet-consented tier is settled too — the user has simply not opted in"
  );
});

test("ISS-5348: transcriptEgressAllowed still fails closed on every non-Allowed gate", () => {
  // The boolean is now DEFINED as `gate === Allowed`, so this pins that the
  // refactor did not widen egress: an unresolved policy must still not upload.
  for (const inputs of [
    { policyState: OrgSessionSyncPolicyUnresolved.Unknown, tier: "full" },
    { policyState: false, tier: "full" },
    { policyState: true, tier: "metadata" },
    { policyState: true, tier: null },
  ] as const) {
    assert.equal(
      transcriptEgressAllowed(inputs),
      transcriptEgressGate(inputs) === TranscriptEgressGate.Allowed
    );
    assert.equal(transcriptEgressAllowed(inputs), false);
  }
});
