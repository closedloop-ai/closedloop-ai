import assert from "node:assert/strict";
import { test } from "vitest";
import {
  sessionMetadataEgressAllowed,
  transcriptEgressAllowed,
  transcriptEgressGate,
} from "../src/main/agent-sync/sync-egress-gate.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

// ISS-4623 — the pure session-data egress gate. ISS-11449 removed its OUTER
// layer, the server-owned org policy that was ANDed above the per-device consent
// tier, so what remains is the tier: an explicit non-`null` value is
// authoritative, and a not-yet-consented `null` suppresses the lane.

test("sessionMetadataEgressAllowed: a metadata-or-fuller tier, and nothing less", () => {
  assert.equal(sessionMetadataEgressAllowed({ tier: "metadata" }), true);
  assert.equal(sessionMetadataEgressAllowed({ tier: "full" }), true);
  // `local` is an answered choice that keeps everything on this machine.
  assert.equal(sessionMetadataEgressAllowed({ tier: "local" }), false);
  // A not-yet-consented device suppresses the lane rather than defaulting open.
  assert.equal(sessionMetadataEgressAllowed({ tier: null }), false);
});

test("transcriptEgressAllowed: the `full` tier, and nothing less", () => {
  assert.equal(transcriptEgressAllowed({ tier: "full" }), true);
  // `metadata` permits the metadata lane but NOT transcripts — the one input on
  // which the two lanes must disagree.
  assert.equal(transcriptEgressAllowed({ tier: "metadata" }), false);
  assert.equal(transcriptEgressAllowed({ tier: "local" }), false);
  assert.equal(transcriptEgressAllowed({ tier: null }), false);
});

test("ISS-5348: transcriptEgressGate answers a settled verdict for every tier", () => {
  // ISS-5348 gave this a third state, `Unresolved`, for the boot window in which
  // the org policy had not been fetched — a denial nobody had made, which the
  // import splash rendered as settled fact. ISS-11449 removed that state with the
  // policy: the tier is a local, synchronously-readable user choice, so every
  // read has an answer and there is nothing left to be pending on.
  assert.equal(
    transcriptEgressGate({ tier: "full" }),
    TranscriptEgressGate.Allowed
  );
  for (const tier of ["metadata", "local"] as const) {
    assert.equal(
      transcriptEgressGate({ tier }),
      TranscriptEgressGate.Denied,
      `tier ${tier} is a settled no`
    );
  }
  assert.equal(
    transcriptEgressGate({ tier: null }),
    TranscriptEgressGate.Denied,
    "a not-yet-consented tier is settled too — the user has simply not opted in"
  );
});

test("ISS-5348: transcriptEgressAllowed is exactly `gate === Allowed`", () => {
  // The boolean is DEFINED as the gate's `Allowed` arm, so this pins that the two
  // cannot drift: the value a lane drains on and the value the renderer displays
  // are one decision.
  for (const tier of ["full", "metadata", "local", null] as const) {
    assert.equal(
      transcriptEgressAllowed({ tier }),
      transcriptEgressGate({ tier }) === TranscriptEgressGate.Allowed,
      `tier ${tier}`
    );
  }
});
