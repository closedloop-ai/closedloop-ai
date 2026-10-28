import assert from "node:assert/strict";
import { test } from "vitest";
import { transcriptEgressGate } from "../src/main/agent-sync/sync-egress-gate.js";
import {
  resolveTranscriptNeverExpected,
  type TranscriptNeverExpectedInput,
} from "../src/renderer/shared-agent-sessions/transcript-never-expected.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { syncTierExcludesTranscripts } from "../src/shared/sync-observability-tier.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

/**
 * ISS-7516 — the two halves of "this session's transcript is never coming".
 *
 * The DISPLAY predicate ({@link syncTierExcludesTranscripts}) and the EGRESS
 * gate deliberately disagree on exactly one input, and that disagreement is
 * asserted here rather than left to a comment: egress fails closed on a
 * not-yet-consented device, while the copy must not claim a level the user has
 * never chosen.
 *
 * The ATTRIBUTION rule ({@link resolveTranscriptNeverExpected}) is the half a
 * "make the state render" change is most likely to skip, so every way it must
 * WITHHOLD the claim has its own case — an unsettled read, an unreadable
 * record, an answer bound to another org, an unknown device, and above all a
 * session that came from a different machine.
 */

const THIS_DEVICE = "compute-target-this";
const OTHER_DEVICE = "compute-target-other";
const ORG = "org-1";

function record(overrides: Partial<SyncConsentRecord> = {}): SyncConsentRecord {
  return {
    tier: "metadata",
    bound: true,
    organizationId: ORG,
    ...overrides,
  };
}

function neverExpected(
  overrides: Partial<TranscriptNeverExpectedInput> = {}
): boolean {
  return resolveTranscriptNeverExpected({
    consentResolved: true,
    consentRecord: record(),
    organizationId: ORG,
    deviceComputeTargetId: THIS_DEVICE,
    sessionComputeTargetId: THIS_DEVICE,
    ...overrides,
  });
}

test("ISS-7516: only an explicit transcript-excluding tier is a settled exclusion", () => {
  assert.equal(syncTierExcludesTranscripts("metadata"), true);
  assert.equal(syncTierExcludesTranscripts("local"), true);
  // The positive sibling: the one tier that DOES carry transcripts is never an
  // exclusion, so a `full` machine can still be honestly mid-upload.
  assert.equal(syncTierExcludesTranscripts("full"), false);
  // A not-yet-consented device has no level to blame. Egress still fails closed
  // on it (asserted below); the COPY must not.
  assert.equal(syncTierExcludesTranscripts(null), false);
});

test("ISS-7516: the display predicate and the egress gate diverge only on the unconsented device", () => {
  // Settled exclusion: both agree there is nothing coming.
  assert.equal(syncTierExcludesTranscripts("metadata"), true);
  assert.equal(
    transcriptEgressGate({ tier: "metadata" }),
    TranscriptEgressGate.Denied
  );
  // Not consented: egress is Denied (fails closed) while the display predicate
  // withholds — the whole reason the two are separate functions.
  assert.equal(syncTierExcludesTranscripts(null), false);
  assert.equal(
    transcriptEgressGate({ tier: null }),
    TranscriptEgressGate.Denied
  );
  // And the permitted tier still drains, so folding the predicate into the gate
  // did not widen it.
  assert.equal(
    transcriptEgressGate({ tier: "full" }),
    TranscriptEgressGate.Allowed
  );
});

test("ISS-7516: claims the settled absence for a session recorded on this machine", () => {
  assert.equal(neverExpected(), true);
});

test("ISS-7516: withholds the claim for a session recorded on another machine", () => {
  // The defect this guard exists to prevent: a `metadata` machine reading a
  // colleague's session would otherwise blame its own level for an upload that
  // is genuinely still in flight on a `full` machine — trading one false
  // statement for another.
  assert.equal(neverExpected({ sessionComputeTargetId: OTHER_DEVICE }), false);
});

test("ISS-7516: withholds the claim when either identity is unknown", () => {
  assert.equal(neverExpected({ deviceComputeTargetId: null }), false);
  assert.equal(neverExpected({ sessionComputeTargetId: null }), false);
  // Two unknowns are not a match: `null === null` must not be read as "same
  // machine".
  assert.equal(
    neverExpected({
      deviceComputeTargetId: null,
      sessionComputeTargetId: null,
    }),
    false
  );
});

test("ISS-7516: withholds the claim until the consent read has settled", () => {
  assert.equal(neverExpected({ consentResolved: false }), false);
  // A settled read that produced no record is version skew, not a level.
  assert.equal(neverExpected({ consentRecord: null }), false);
});

test("ISS-7516: withholds the claim when the answer was bound to another org", () => {
  assert.equal(neverExpected({ organizationId: "org-2" }), false);
  // The positive sibling: an UNBOUND answer (pre-ISS-5489) does cover every
  // org, so the org term narrows only answers that carry a binding.
  assert.equal(
    neverExpected({
      consentRecord: record({ bound: false }),
      organizationId: "org-2",
    }),
    true
  );
});

test("ISS-7516: withholds the claim on a machine whose level does carry transcripts", () => {
  assert.equal(
    neverExpected({ consentRecord: record({ tier: "full" }) }),
    false
  );
});
