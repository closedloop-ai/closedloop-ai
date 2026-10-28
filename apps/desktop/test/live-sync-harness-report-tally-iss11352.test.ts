import assert from "node:assert/strict";
import {
  SyncLane,
  SyncOutcome,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { describe, test } from "vitest";
import {
  type LiveSyncObservations,
  tallySyncBatch,
  UNATTRIBUTED_LANE,
} from "../scripts/live-sync-harness-report.js";

function freshObservations(): LiveSyncObservations {
  return { lanes: new Map(), syncFailures: [], rejectedDetails: [] };
}

describe("tallySyncBatch lane attribution and outcome buckets", () => {
  test("a batch with no lane is tallied under the unattributed bucket, never a real lane", () => {
    const observations = freshObservations();
    tallySyncBatch(observations, { outcome: SyncOutcome.Success });

    assert.deepEqual([...observations.lanes.keys()], [UNATTRIBUTED_LANE]);
    assert.deepEqual(observations.lanes.get(UNATTRIBUTED_LANE), {
      lane: UNATTRIBUTED_LANE,
      accepted: 1,
      rejected: 0,
      deferred: 0,
      deadLettered: 0,
      reasons: [],
    });
  });

  test("a dead-lettered batch counts as dead-lettered, not rejected, and keeps its reason", () => {
    const observations = freshObservations();
    tallySyncBatch(observations, {
      outcome: SyncOutcome.DeadLetter,
      lane: SyncLane.SessionMetadata,
      reason: SyncReason.SessionMissing,
    });

    assert.deepEqual(observations.lanes.get(SyncLane.SessionMetadata), {
      lane: SyncLane.SessionMetadata,
      accepted: 0,
      rejected: 0,
      deferred: 0,
      deadLettered: 1,
      reasons: [SyncReason.SessionMissing],
    });
  });

  test("an invocation-part dead-letter for session_missing is dead-lettered, not deferred", () => {
    const observations = freshObservations();
    tallySyncBatch(observations, {
      outcome: SyncOutcome.DeadLetter,
      lane: SyncLane.InvocationParts,
      reason: SyncReason.SessionMissing,
    });

    assert.deepEqual(observations.lanes.get(SyncLane.InvocationParts), {
      lane: SyncLane.InvocationParts,
      accepted: 0,
      rejected: 0,
      deferred: 0,
      deadLettered: 1,
      reasons: [SyncReason.SessionMissing],
    });
  });

  test("a failure with no reason is a rejection that adds nothing to the reason list", () => {
    const observations = freshObservations();
    tallySyncBatch(observations, {
      outcome: SyncOutcome.Failure,
      lane: SyncLane.SessionMetadata,
    });
    tallySyncBatch(observations, {
      outcome: SyncOutcome.Failure,
      lane: SyncLane.SessionMetadata,
    });

    assert.deepEqual(observations.lanes.get(SyncLane.SessionMetadata), {
      lane: SyncLane.SessionMetadata,
      accepted: 0,
      rejected: 2,
      deferred: 0,
      deadLettered: 0,
      reasons: [],
    });
  });
});
