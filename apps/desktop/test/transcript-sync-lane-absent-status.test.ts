import assert from "node:assert/strict";
import { test } from "vitest";
import { transcriptSyncLaneAbsentStatus } from "../src/main/transcript-sync/transcript-sync-lane-absent-status.js";
import { resolveTranscriptNeverExpected } from "../src/renderer/shared-agent-sessions/transcript-never-expected.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { TranscriptEgressGate } from "../src/shared/transcript-sync-status-contract.js";

/**
 * ISS-7516 (review, cid 3836611089) — the metadata tier is the one that has NO
 * transcript-sync service, so the no-lane snapshot is the ONLY status a
 * metadata-level machine ever serves.
 *
 * `DataSyncLevel.Metadata` persists `transcriptSyncEnabled` false, and
 * `AppMain` constructs `this.transcriptSync` only when that flag is true, so
 * `getTranscriptSync()` returns null and the renderer reads this shape. While
 * this shape hardcoded `computeTargetId: null`, the attribution half of
 * `resolveTranscriptNeverExpected` could never be satisfied on that tier — the
 * verdict was unreachable on exactly the machines it describes, and the panel
 * went on promising an upload that was never queued.
 *
 * The cases below therefore drive the two halves TOGETHER: the snapshot the
 * composition root actually serves, fed into the resolver the panel actually
 * reads. Testing either alone is what let the gap survive review.
 */

const THIS_DEVICE = "compute-target-this";
const OTHER_DEVICE = "compute-target-other";
const ORG = "org-1";

function metadataConsent(): SyncConsentRecord {
  return { tier: "metadata", bound: true, organizationId: ORG };
}

/** The renderer's read of a no-lane machine, end to end. */
function neverExpectedOnLanelessMachine(
  deviceComputeTargetId: string | null,
  sessionComputeTargetId: string | null
): boolean {
  const snapshot = transcriptSyncLaneAbsentStatus(deviceComputeTargetId);
  return resolveTranscriptNeverExpected({
    consentResolved: true,
    consentRecord: metadataConsent(),
    organizationId: ORG,
    deviceComputeTargetId: snapshot.computeTargetId,
    sessionComputeTargetId,
  });
}

test("ISS-7516: a metadata-tier machine with no lane still reaches the never-expected verdict for its OWN session", () => {
  // The regression this file exists for. Before the fix the snapshot returned a
  // hardcoded null identity, the attribution check failed, and this read false —
  // the panel kept saying the source machine would upload a transcript that was
  // never queued.
  assert.equal(neverExpectedOnLanelessMachine(THIS_DEVICE, THIS_DEVICE), true);
});

test("ISS-7516: the no-lane snapshot carries identity without claiming a healthy lane", () => {
  const snapshot = transcriptSyncLaneAbsentStatus(THIS_DEVICE);
  assert.equal(snapshot.computeTargetId, THIS_DEVICE);
  // Identity is the ONLY field that survives the absence of a lane. Every gate
  // must still read closed (ISS-4716/ISS-5348) — a snapshot that carried an id
  // by loosening these would trade one false statement for another.
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.online, false);
  assert.equal(snapshot.tierGate, TranscriptEgressGate.Denied);
  assert.equal(snapshot.storeReady, false);
});

test("ISS-7516: a laneless machine still withholds the claim for another machine's session", () => {
  // Attribution is not weakened by the fix. A metadata device reads the org's
  // cloud sessions, and a colleague's `full` machine may genuinely be uploading.
  assert.equal(
    neverExpectedOnLanelessMachine(THIS_DEVICE, OTHER_DEVICE),
    false
  );
});

test("ISS-7516: an unknown identity stays 'cannot attribute', never an assumed match", () => {
  // Offline or signed out. The honest answer is unknown, so the claim is
  // withheld — the fix supplies a real id where one exists, it does not default
  // the verdict to true when one does not.
  assert.equal(neverExpectedOnLanelessMachine(null, THIS_DEVICE), false);
  assert.equal(transcriptSyncLaneAbsentStatus(null).computeTargetId, null);
});
