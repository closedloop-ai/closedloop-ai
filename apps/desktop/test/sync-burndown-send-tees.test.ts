/**
 * @file sync-burndown-send-tees.test.ts
 * @description ISS-5387 — the burn-down's "work completed" counters must be
 * incremented only inside the branch where delivery actually happened.
 *
 * These counters are what `detectCursorStall` reads before asserting that
 * uploads are succeeding while the durable cursor stands still. Counting an
 * ATTEMPT instead of a RESULT turned an ordinary failed send — a 500, a 429, an
 * expired token, all of which deliberately leave the cursor unchanged — into a
 * `sync.durable_cursor.stalled` alert claiming the exact opposite.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
} from "@repo/api/src/types/agent-component-invocation";
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import {
  recordAcceptedComponentRecords,
  recordAcceptedInvocationPart,
} from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import type { SyncBurndownStoreSample } from "../src/main/database/sync-burndown-store.js";
import {
  type SyncBurndownLogLevel,
  SyncBurndownReporter,
} from "../src/main/sync/sync-burndown-reporter.js";

const COMPONENT_DONE_RE = /component_inventory\].*sinceLastPass: done=(\d+)/;
const INVOCATION_DONE_RE = /invocation_parts\].*sinceLastPass: done=(\d+)/;

function emptySample(): SyncBurndownStoreSample {
  return {
    sessionOutbox: {
      pending: 0,
      readyPending: 0,
      deadLettered: 0,
      oldestPendingEnqueuedAtIso: null,
      unmeasuredRows: 0,
    },
    invocationOutbox: {
      pending: 0,
      readyPending: 0,
      deadLettered: 0,
      oldestPendingEnqueuedAtIso: null,
      unmeasuredRows: 0,
      pendingSessions: 0,
      pendingParts: 0,
      pendingPayloadBytes: 0,
      pendingTemplateSessions: 0,
      pendingTemplateSessionsTruncated: false,
    },
    transcript: {
      inFlightFiles: 0,
      strandedIdleFiles: 0,
      deadFiles: 0,
      bytesRemaining: 0,
      oldestInFlightUpdatedAtIso: null,
      unmeasuredRows: 0,
    },
    componentInventory: { rowsRemaining: 0, deadLetteredCount: 0 },
    traceComments: {
      pendingComments: 0,
      pendingReplyComments: 0,
      oldestPendingCreatedAtIso: null,
      unmeasuredRows: 0,
    },
    cursorsBySourceKey: {},
  };
}

/**
 * A reporter whose emitted lines are the observable: the counters are private,
 * so the assertions read the `done=` figure off the lane line the reporter
 * actually prints rather than reaching into internals.
 */
function buildReporter(): {
  reporter: SyncBurndownReporter;
  sample: () => Promise<string>;
} {
  const lines: string[] = [];
  const reporter = new SyncBurndownReporter({
    getSource: () => ({
      readSyncBurndown: () => Promise.resolve(emptySample()),
    }),
    getSessionSourceKey: () => "agent_sessions:ct-1",
    getInvocationSourceKey: () => "agent_component_invocations:ct-1",
    invocationTemplateSourceKey: "agent_component_invocations",
    getComponentSourceKey: () => "agent_components:v3:ct-1",
    getTranscriptComputeTargetId: () => "ct-1",
    isSessionLaneRunning: () => true,
    isInvocationLaneRunning: () => true,
    isTranscriptLaneRunning: () => true,
    isComponentLaneRunning: () => true,
    isTraceCommentLaneRunning: () => true,
    log: (_level: SyncBurndownLogLevel, message: string) => {
      lines.push(message);
    },
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  return {
    reporter,
    sample: async () => {
      lines.length = 0;
      await reporter.sampleOnce();
      return lines.join("\n");
    },
  };
}

function doneCount(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (match === null) {
    throw new Error(`expected a lane line matching ${pattern}, got:\n${text}`);
  }
  return Number(match[1]);
}

function componentResult(outcome: ComponentSyncSendOutcome) {
  return { outcome, firstUnsentChunkIndex: null, chunkCount: 1 };
}

describe("ISS-5387 send tees count results, not attempts", () => {
  it("counts component records only when the batch was ACCEPTED", async () => {
    const harness = buildReporter();
    recordAcceptedComponentRecords(
      harness.reporter,
      25,
      componentResult(ComponentSyncSendOutcome.Accepted)
    );
    assert.equal(
      doneCount(await harness.sample(), COMPONENT_DONE_RE),
      25,
      "an accepted batch is work the durable cursor was expected to record"
    );
  });

  it("counts nothing for a LaneFailure, which leaves the cursor unchanged", async () => {
    const harness = buildReporter();
    recordAcceptedComponentRecords(
      harness.reporter,
      25,
      componentResult(ComponentSyncSendOutcome.LaneFailure)
    );
    assert.equal(
      doneCount(await harness.sample(), COMPONENT_DONE_RE),
      0,
      "a 500/429/expired-token send must not read as completed work"
    );
  });

  it("counts nothing for a BatchRejected send", async () => {
    const harness = buildReporter();
    recordAcceptedComponentRecords(
      harness.reporter,
      25,
      componentResult(ComponentSyncSendOutcome.BatchRejected)
    );
    assert.equal(doneCount(await harness.sample(), COMPONENT_DONE_RE), 0);
  });

  it("counts an invocation part only on an ACCEPTED ack", async () => {
    const harness = buildReporter();
    recordAcceptedInvocationPart(harness.reporter, {
      kind: "ack",
      ack: {
        accepted: true,
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        externalGenerationId: "gen-1",
        partIndex: 0,
        partHash: "a".repeat(64),
        state: AgentComponentInvocationSyncAckState.Staged,
      },
    });
    assert.equal(doneCount(await harness.sample(), INVOCATION_DONE_RE), 1);
  });

  it("counts nothing when the part could not be delivered", async () => {
    const harness = buildReporter();
    recordAcceptedInvocationPart(harness.reporter, {
      kind: "unavailable",
      status: 503,
    });
    recordAcceptedInvocationPart(harness.reporter, {
      kind: "retry",
      error: "socket hang up",
    });
    assert.equal(
      doneCount(await harness.sample(), INVOCATION_DONE_RE),
      0,
      "an undelivered part is not completed work"
    );
  });
});
