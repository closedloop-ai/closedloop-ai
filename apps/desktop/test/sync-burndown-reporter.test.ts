/**
 * @file sync-burndown-reporter.test.ts
 * @description ISS-5387 — the periodic burn-down reporter must tell the truth
 * about whether the desktop is caught up, and must make a lane that is
 * WORKING but not RECORDING PROGRESS visible.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SyncBurndownQuery,
  SyncBurndownStoreSample,
} from "../src/main/database/sync-burndown-store.js";
import {
  SyncBurndownLogLevel,
  SyncBurndownReporter,
  type SyncLaneStallReport,
} from "../src/main/sync/sync-burndown-reporter.js";
import { SyncLaneId } from "../src/shared/sync-burndown-contract.js";

const REPORTER_RE_1 = /fully synced to cloud/;
const REPORTER_RE_2 =
  /session_metadata\] NOT fully synced .*4 item\(s\) were dead-lettered/;
const REPORTER_RE_3 = /ALL LANES FULLY SYNCED/;
const REPORTER_RE_4 =
  /not fully synced — session_metadata=drained_with_dead_letters/;
const REPORTER_RE_5 = /ALL LANES FULLY SYNCED to cloud \(5 lane\(s\)/;
const REPORTER_RE_6 = /session_metadata\] drained/;
const REPORTER_RE_7 = /session_metadata\] idle_not_running/;
const REPORTER_RE_8 = /session_metadata\] fully synced/;
const REPORTER_RE_9 = /not fully synced — /;
const REPORTER_RE_10 = /session_metadata\] never_started/;
const REPORTER_RE_11 = /session_metadata\] draining/;
const REPORTER_RE_12 = /DURABLE CURSOR NOT ADVANCING/;
const REPORTER_RE_13 = /stayed at 2026-08-03T20:56:53\.196Z/;
const REPORTER_RE_14 = /invocation_parts\] draining items=6/;
const REPORTER_RE_15 = /invocation_parts\] fully synced/;
const REPORTER_RE_16 = /\/(Users|home)\//;
const REPORTER_RE_17 = /\.jsonl/;
const REPORTER_RE_18 = /Bearer|sk_live_|api[_-]?key/i;
const REPORTER_RE_19 =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const REPORTER_RE_20 = /session_metadata\] draining items=1 .*sent=2\.8MiB/;
const REPORTER_RE_21 = /sent=1\.0KiB/;
const SESSION_NO_CARRIED_WORK_RE =
  /session_metadata\].*sinceLastPass: done=0 sent=0B/;
const COMPONENT_DRAINING_RE = /component_inventory\] draining items=3200/;
const TRACE_COMMENTS_DRAINING_RE = /trace_comments\] draining items=6/;
const ALL_LANES_SYNCED_RE = /ALL LANES FULLY SYNCED/;

const TEMPLATE_KEY = "agent_component_invocations";
const SESSION_KEY = "agent_sessions:ct-1";
const COMPONENT_KEY = "agent_components:v3:ct-1";

type LoggedLine = { level: SyncBurndownLogLevel; message: string };

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

type Harness = {
  reporter: SyncBurndownReporter;
  lines: LoggedLine[];
  stalls: SyncLaneStallReport[];
  queries: SyncBurndownQuery[];
  readCount: () => number;
  setSample: (sample: SyncBurndownStoreSample) => void;
  setRunning: (running: boolean) => void;
  setComputeTargetId: (computeTargetId: string | null) => void;
};

function buildHarness(
  options: { running?: boolean; sample?: SyncBurndownStoreSample } = {}
): Harness {
  const lines: LoggedLine[] = [];
  const stalls: SyncLaneStallReport[] = [];
  const queries: SyncBurndownQuery[] = [];
  let sample = options.sample ?? emptySample();
  let running = options.running ?? true;
  let computeTargetId: string | null = "ct-1";
  let reads = 0;
  const reporter = new SyncBurndownReporter({
    getSource: () => ({
      readSyncBurndown: (query) => {
        reads += 1;
        queries.push(query);
        return Promise.resolve(sample);
      },
    }),
    getSessionSourceKey: () => SESSION_KEY,
    getInvocationSourceKey: () => `${TEMPLATE_KEY}:ct-1`,
    invocationTemplateSourceKey: TEMPLATE_KEY,
    getComponentSourceKey: () => COMPONENT_KEY,
    getTranscriptComputeTargetId: () => computeTargetId,
    isSessionLaneRunning: () => running,
    isInvocationLaneRunning: () => running,
    isTranscriptLaneRunning: () => running,
    isComponentLaneRunning: () => running,
    isTraceCommentLaneRunning: () => running,
    log: (level, message) => {
      lines.push({ level, message });
    },
    onLaneStall: (report) => {
      stalls.push(report);
    },
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  return {
    reporter,
    lines,
    stalls,
    queries,
    readCount: () => reads,
    setSample: (next) => {
      sample = next;
    },
    setRunning: (next) => {
      running = next;
    },
    setComputeTargetId: (next) => {
      computeTargetId = next;
    },
  };
}

function messages(lines: LoggedLine[]): string {
  return lines.map((line) => line.message).join("\n");
}

describe("SyncBurndownReporter — the fully-synced signal", () => {
  it("does NOT log fully synced for a lane drained WITH dead-lettered rows", async () => {
    const sample = emptySample();
    sample.sessionOutbox.deadLettered = 4;
    const harness = buildHarness({ sample });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const text = messages(harness.lines);
    const sessionLines = harness.lines.filter((line) =>
      line.message.includes(SyncLaneId.SessionMetadata)
    );
    assert.ok(sessionLines.length > 0, "the session lane reported something");
    assert.equal(
      sessionLines.some((line) => REPORTER_RE_1.test(line.message)),
      false,
      "an outbox emptied by GIVING UP must never claim it caught up"
    );
    assert.match(text, REPORTER_RE_2);
    assert.doesNotMatch(text, REPORTER_RE_3);
    // The other three lanes ARE drained; the verdict must still be withheld.
    assert.match(text, REPORTER_RE_4);
  });

  it("logs fully synced per lane and for all lanes when every lane is genuinely drained", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const text = messages(harness.lines);
    for (const lane of [
      SyncLaneId.SessionMetadata,
      SyncLaneId.InvocationParts,
      SyncLaneId.TranscriptArchive,
      SyncLaneId.ComponentInventory,
    ]) {
      assert.match(
        text,
        new RegExp(`\\[${lane}\\] fully synced to cloud`),
        `${lane} reports its own drain`
      );
    }
    assert.match(text, REPORTER_RE_5);
  });

  it("distinguishes idle-not-running from drained", async () => {
    const harness = buildHarness({ running: true });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    const drainedText = messages(harness.lines);
    assert.match(drainedText, REPORTER_RE_6);

    harness.lines.length = 0;
    harness.setRunning(false);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const idleText = messages(harness.lines);
    assert.match(idleText, REPORTER_RE_7);
    assert.doesNotMatch(
      idleText,
      REPORTER_RE_8,
      "a lane whose gate shut has stopped trying, not caught up"
    );
    assert.match(idleText, REPORTER_RE_9);
  });

  it("reports never_started for a lane that has never been observed running", async () => {
    const harness = buildHarness({ running: false });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    assert.match(messages(harness.lines), REPORTER_RE_10);
  });

  it("re-arms: drain → new work → drain logs the verdict twice", async () => {
    const harness = buildHarness();
    harness.reporter.start();

    await harness.reporter.sampleOnce();
    const firstDrain = harness.lines.filter((line) =>
      REPORTER_RE_8.test(line.message)
    ).length;
    assert.equal(firstDrain, 1, "the first drain is announced once");

    // New work arrives.
    const busy = emptySample();
    busy.sessionOutbox.pending = 7;
    busy.sessionOutbox.oldestPendingEnqueuedAtIso = "2026-08-06T11:00:00.000Z";
    harness.setSample(busy);
    await harness.reporter.sampleOnce();
    assert.match(messages(harness.lines), REPORTER_RE_11);

    // ...and drains again.
    harness.setSample(emptySample());
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const drains = harness.lines.filter((line) =>
      REPORTER_RE_8.test(line.message)
    ).length;
    assert.equal(
      drains,
      2,
      "the signal must re-arm: a second genuine drain is announced again"
    );
    const allSynced = harness.lines.filter((line) =>
      REPORTER_RE_3.test(line.message)
    ).length;
    assert.equal(allSynced, 2, "the all-lanes verdict re-arms too");
  });
});

describe("SyncBurndownReporter — cursor stall (the ISS-5347 shape)", () => {
  function frozenCursorSample(): SyncBurndownStoreSample {
    const sample = emptySample();
    sample.cursorsBySourceKey = {
      [COMPONENT_KEY]: {
        sourceKey: COMPONENT_KEY,
        observedTopUpdatedAt: "2026-08-03T20:56:53.196Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
        updatedAt: "2026-08-03T20:57:50.000Z",
        dataRevision: 65,
      },
    };
    return sample;
  }

  it("makes a lane that uploads while its durable cursor stands still visible", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();

    // First pass establishes the baseline; a single sample cannot prove a stall.
    harness.reporter.recordComponentRecordsSent(50);
    await harness.reporter.sampleOnce();
    assert.equal(harness.stalls.length, 0);

    // Second pass: the lane keeps uploading, the cursor has not moved.
    harness.reporter.recordComponentRecordsSent(50);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      harness.stalls.length,
      1,
      "the stall must reach the monitored sink, not only the log"
    );
    assert.equal(harness.stalls[0]?.lane, SyncLaneId.ComponentInventory);
    assert.equal(harness.stalls[0]?.workCompletedSincePrevious, 50);
    const warn = harness.lines.filter(
      (line) => line.level === SyncBurndownLogLevel.Warn
    );
    assert.ok(
      warn.some((line) => REPORTER_RE_12.test(line.message)),
      "and it must be legible in the log"
    );
    assert.match(
      messages(harness.lines),
      REPORTER_RE_13,
      "the frozen position itself is named"
    );
  });

  it("stays silent when the cursor advances, even with heavy upload activity", async () => {
    const first = frozenCursorSample();
    const harness = buildHarness({ sample: first });
    harness.reporter.start();
    harness.reporter.recordComponentRecordsSent(500);
    await harness.reporter.sampleOnce();

    const advanced = emptySample();
    advanced.cursorsBySourceKey = {
      [COMPONENT_KEY]: {
        sourceKey: COMPONENT_KEY,
        observedTopUpdatedAt: "2026-08-06T11:59:00.000Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
        updatedAt: "2026-08-06T11:59:01.000Z",
        dataRevision: 68,
      },
    };
    harness.setSample(advanced);
    harness.reporter.recordComponentRecordsSent(500);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(harness.stalls.length, 0);
    assert.doesNotMatch(messages(harness.lines), REPORTER_RE_12);
  });

  it("never flags the lanes that keep no durable cursor by design", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();
    // Drive real work through BOTH cursor-less lanes across two passes.
    harness.reporter.recordInvocationPartSent();
    await harness.reporter.sampleOnce();
    const draining = emptySample();
    draining.transcript.inFlightFiles = 12;
    draining.cursorsBySourceKey = frozenCursorSample().cursorsBySourceKey;
    harness.setSample(draining);
    harness.reporter.recordInvocationPartSent();
    await harness.reporter.sampleOnce();
    harness.setSample(frozenCursorSample());
    harness.reporter.recordInvocationPartSent();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const flagged = harness.stalls.map((stall) => stall.lane);
    assert.equal(
      flagged.includes(SyncLaneId.InvocationParts),
      false,
      "the invocation lane's position lives in its own cursors table, not sync_state"
    );
    assert.equal(
      flagged.includes(SyncLaneId.TranscriptArchive),
      false,
      "the transcript lane's durable state is a per-file byte offset, not a watermark"
    );
  });

  it("stays silent for a quiet lane whose cursor simply has nothing to record", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    assert.equal(
      harness.stalls.length,
      0,
      "no work completed means no evidence the cursor should have moved"
    );
  });

  it("raises the monitored signal once per stall episode, then re-arms after recovery", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();
    for (let pass = 0; pass < 4; pass += 1) {
      harness.reporter.recordComponentRecordsSent(10);
      await harness.reporter.sampleOnce();
    }
    assert.equal(
      harness.stalls.length,
      1,
      "a multi-pass stall is one alert, not one per interval"
    );

    const advanced = emptySample();
    advanced.cursorsBySourceKey = {
      [COMPONENT_KEY]: {
        sourceKey: COMPONENT_KEY,
        observedTopUpdatedAt: "2026-08-06T11:00:00.000Z",
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
        updatedAt: "2026-08-06T11:00:01.000Z",
        dataRevision: 68,
      },
    };
    harness.setSample(advanced);
    harness.reporter.recordComponentRecordsSent(10);
    await harness.reporter.sampleOnce();

    harness.setSample(advanced);
    harness.reporter.recordComponentRecordsSent(10);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      harness.stalls.length,
      2,
      "a stall that recurs after a genuine advance must alert again"
    );
  });
});

describe("SyncBurndownReporter — cost and content discipline", () => {
  it("issues exactly one store read per sample regardless of queue size", async () => {
    const huge = emptySample();
    huge.sessionOutbox.pending = 50_000;
    huge.invocationOutbox.pending = 12_000;
    huge.invocationOutbox.pendingParts = 12_000;
    huge.transcript.inFlightFiles = 8819;
    const harness = buildHarness({ sample: huge });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    assert.equal(
      harness.readCount(),
      2,
      "the burn-down is aggregate: no per-item query, and none added on any hot path"
    );
  });

  it("scopes the invocation query to the DELIVERY key while naming the template key separately", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    const query = harness.queries[0];
    assert.ok(query, "a query was issued");
    assert.equal(query.invocationSourceKey, `${TEMPLATE_KEY}:ct-1`);
    assert.equal(query.invocationTemplateSourceKey, TEMPLATE_KEY);
    assert.notEqual(
      query.invocationSourceKey,
      query.invocationTemplateSourceKey,
      "delivery depth must never be measured against the unscoped template key"
    );
  });

  it("counts un-materialized template sessions as work still owed", async () => {
    const sample = emptySample();
    sample.invocationOutbox.pendingTemplateSessions = 6;
    const harness = buildHarness({ sample });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    const text = messages(harness.lines);
    assert.match(text, REPORTER_RE_14);
    assert.doesNotMatch(
      text,
      REPORTER_RE_15,
      "an empty delivery queue with templates left to clone is not drained"
    );
  });

  it("emits no session ids, file paths, payload bodies, or credentials", async () => {
    const busy = emptySample();
    busy.sessionOutbox.pending = 3;
    busy.sessionOutbox.oldestPendingEnqueuedAtIso = "2026-08-06T11:00:00.000Z";
    busy.transcript.inFlightFiles = 2;
    busy.transcript.bytesRemaining = 4096;
    busy.transcript.oldestInFlightUpdatedAtIso = "2026-08-06T10:00:00.000Z";
    const harness = buildHarness({ sample: busy });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 2048 });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const text = messages(harness.lines);
    assert.doesNotMatch(text, REPORTER_RE_16, "no filesystem paths");
    assert.doesNotMatch(text, REPORTER_RE_17, "no transcript file names");
    assert.doesNotMatch(text, REPORTER_RE_18, "no credentials");
    assert.doesNotMatch(text, REPORTER_RE_19, "no session/target uuids");
  });

  it("carries bytes sent per pass so re-send amplification is legible", async () => {
    const busy = emptySample();
    busy.sessionOutbox.pending = 1;
    const harness = buildHarness({ sample: busy });
    harness.reporter.start();
    // One session re-chunked and re-sent whole: many bytes, one item remaining.
    for (let chunk = 0; chunk < 11; chunk += 1) {
      harness.reporter.recordSessionBatch({
        accepted: true,
        payloadBytes: 262_144,
      });
    }
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    assert.match(
      messages(harness.lines),
      REPORTER_RE_20,
      "2.8MiB on the wire behind `items=1` is the amplification the counters must show"
    );
  });

  it("keeps unreported work when the store read fails, instead of discarding it", async () => {
    const lines: LoggedLine[] = [];
    let failNext = true;
    const sample = emptySample();
    const reporter = new SyncBurndownReporter({
      getSource: () => ({
        readSyncBurndown: () =>
          failNext
            ? Promise.reject(new Error("db host restarting"))
            : Promise.resolve(sample),
      }),
      getSessionSourceKey: () => SESSION_KEY,
      getInvocationSourceKey: () => `${TEMPLATE_KEY}:ct-1`,
      invocationTemplateSourceKey: TEMPLATE_KEY,
      getComponentSourceKey: () => COMPONENT_KEY,
      getTranscriptComputeTargetId: () => "ct-1",
      isSessionLaneRunning: () => true,
      isInvocationLaneRunning: () => true,
      isTranscriptLaneRunning: () => true,
      isComponentLaneRunning: () => true,
      isTraceCommentLaneRunning: () => true,
      log: (level, message) => {
        lines.push({ level, message });
      },
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    reporter.start();
    reporter.recordSessionBatch({ accepted: true, payloadBytes: 1024 });
    await reporter.sampleOnce();
    assert.equal(lines.length, 0, "a failed diagnostic read emits nothing");

    failNext = false;
    await reporter.sampleOnce();
    reporter.stop();
    assert.match(
      messages(lines),
      REPORTER_RE_21,
      "work observed while the store was unavailable is reported by the next successful sample"
    );
  });

  it("no-ops when the sync source has no burn-down read (older/fake source)", async () => {
    const lines: LoggedLine[] = [];
    const reporter = new SyncBurndownReporter({
      getSource: () => ({}),
      getSessionSourceKey: () => null,
      getInvocationSourceKey: () => null,
      invocationTemplateSourceKey: TEMPLATE_KEY,
      getComponentSourceKey: () => null,
      getTranscriptComputeTargetId: () => null,
      isSessionLaneRunning: () => false,
      isInvocationLaneRunning: () => false,
      isTranscriptLaneRunning: () => false,
      isComponentLaneRunning: () => false,
      isTraceCommentLaneRunning: () => false,
      log: (level, message) => {
        lines.push({ level, message });
      },
    });
    reporter.start();
    await reporter.sampleOnce();
    reporter.stop();
    assert.deepEqual(lines, []);
  });
});

describe("SyncBurndownReporter — lifecycle and target scoping", () => {
  it("forgets its baselines on stop so a restart re-emits the verdict", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    const afterFirstRun = harness.lines.length;
    assert.ok(afterFirstRun > 0, "the first run emits a baseline verdict");

    harness.reporter.stop();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    // Without clearing state, the restarted run would see "no change" against
    // the previous lifecycle's latches and say nothing at all.
    assert.ok(
      harness.lines.length > afterFirstRun,
      "a restarted reporter re-baselines instead of inheriting stale latches"
    );
  });

  it("discards an in-flight read that lands after stop()", async () => {
    const lines: LoggedLine[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const reporter = new SyncBurndownReporter({
      getSource: () => ({
        readSyncBurndown: () =>
          new Promise((resolve) => {
            gate.release = () => resolve(emptySample());
          }),
      }),
      getSessionSourceKey: () => SESSION_KEY,
      getInvocationSourceKey: () => `${TEMPLATE_KEY}:ct-1`,
      invocationTemplateSourceKey: TEMPLATE_KEY,
      getComponentSourceKey: () => COMPONENT_KEY,
      getTranscriptComputeTargetId: () => "ct-1",
      isSessionLaneRunning: () => true,
      isInvocationLaneRunning: () => true,
      isTranscriptLaneRunning: () => true,
      isComponentLaneRunning: () => true,
      isTraceCommentLaneRunning: () => true,
      log: (level, message) => {
        lines.push({ level, message });
      },
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    reporter.start();
    const pending = reporter.sampleOnce();
    reporter.stop();
    gate.release?.();
    await pending;
    assert.deepEqual(
      lines,
      [],
      "a read that resolves after stop() must not repopulate the state stop() cleared"
    );
  });

  it("does not diff one target's counters against another target's baseline", async () => {
    const harness = buildHarness();
    const busy = emptySample();
    busy.sessionOutbox.pending = 40;
    harness.setSample(busy);
    await harness.reporter.sampleOnce();

    // The compute target switches. The counters accumulated below belong to the
    // OLD target; pairing them with the new target's queue would attribute one
    // account's work to another.
    harness.setComputeTargetId("ct-2");
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 4096 });
    const drained = emptySample();
    harness.setSample(drained);
    harness.lines.length = 0;
    await harness.reporter.sampleOnce();

    assert.equal(
      harness.stalls.length,
      0,
      "a target switch must not raise a stall under the new target's identity"
    );
    assert.match(
      messages(harness.lines),
      SESSION_NO_CARRIED_WORK_RE,
      "cross-target work is dropped rather than credited to the new target"
    );
  });

  it("counts a cursor sweep's backlog instead of calling it drained", async () => {
    const harness = buildHarness();
    const backfilling = emptySample();
    backfilling.componentInventory.rowsRemaining = 3200;
    harness.setSample(backfilling);
    await harness.reporter.sampleOnce();
    const text = messages(harness.lines);
    assert.match(text, COMPONENT_DRAINING_RE);
    assert.equal(
      ALL_LANES_SYNCED_RE.test(text),
      false,
      "a lane mid-backfill must not let the all-lanes verdict claim caught up"
    );
  });

  it("counts pending trace comments as work owed to the cloud", async () => {
    const harness = buildHarness();
    const withComments = emptySample();
    withComments.traceComments.pendingComments = 4;
    withComments.traceComments.pendingReplyComments = 2;
    harness.setSample(withComments);
    await harness.reporter.sampleOnce();
    const text = messages(harness.lines);
    assert.match(text, TRACE_COMMENTS_DRAINING_RE);
    assert.equal(
      ALL_LANES_SYNCED_RE.test(text),
      false,
      "undelivered comments must disqualify the all-lanes verdict"
    );
  });
});

describe("SyncBurndownReporter — the latest-snapshot accessor (ISS-5477)", () => {
  it("has no snapshot to report before the first sample", () => {
    const harness = buildHarness();
    harness.reporter.start();

    // ISS-5477 reads this to decide whether the renderer may move its read
    // source to the cloud, so "we have not looked" must be distinguishable from
    // "nothing is owed" — a fabricated empty snapshot here would move a
    // freshly-signed-in user onto a cloud holding nothing.
    assert.equal(harness.reporter.getLatestSnapshot(), null);
    harness.reporter.stop();
  });

  it("exposes the most recent sample without taking one", async () => {
    const sample = emptySample();
    sample.sessionOutbox.pending = 12;
    const harness = buildHarness({ sample });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    const readsAfterSample = harness.readCount();
    const snapshot = harness.reporter.getLatestSnapshot();
    assert.ok(snapshot, "a sample was taken, so there is one to report");
    assert.equal(snapshot.lanes.length, 5);
    const sessionLane = snapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(sessionLane?.itemsRemaining, 12);
    // A reader must never make this observer participate in the lanes it
    // measures: reading the accessor issues no store query.
    assert.equal(harness.readCount(), readsAfterSample);
    harness.reporter.stop();
  });

  it("forgets the snapshot on stop, so a stopped reporter cannot look drained", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    assert.ok(harness.reporter.getLatestSnapshot());

    harness.reporter.stop();

    assert.equal(harness.reporter.getLatestSnapshot(), null);
  });

  it("withholds the snapshot when the compute target changed after it was taken", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    assert.ok(harness.reporter.getLatestSnapshot());

    // One account's drained verdict must never be read as another's. The sample
    // on hand describes ct-1's queues; under ct-2 there is no answer yet.
    harness.setComputeTargetId("ct-2");
    assert.equal(harness.reporter.getLatestSnapshot(), null);

    // A fresh sample under the new target restores an answer.
    await harness.reporter.sampleOnce();
    assert.ok(harness.reporter.getLatestSnapshot());
    harness.reporter.stop();
  });
});

/**
 * ISS-5973: the reporter must actually RAISE the no-progress stall.
 *
 * `detectNoProgressStall` is unit-tested next door as a pure function, but the
 * consecutive-sample counter, the per-episode latch, the re-arm, and the
 * `onLaneStall` emission all live HERE. Without these cases, deleting
 * `maybeWarnNoProgress` outright would leave the whole suite green.
 *
 * The fixture carries the live stalling condition: a session lane holding a
 * backlog it never touches, exactly as measured on the 2026-08-11 install
 * (2,928 ready rows, `attempt_count = 0`, never attempted).
 */
describe("SyncBurndownReporter — no-progress stall (ISS-5973)", () => {
  function stalledSessionSample(): SyncBurndownStoreSample {
    const sample = emptySample();
    sample.sessionOutbox = {
      pending: 2928,
      // Every one of them ELIGIBLE — `next_attempt_at` was NULL on all 2,928
      // rows. That is what makes this a stall rather than a backoff.
      readyPending: 2928,
      deadLettered: 0,
      oldestPendingEnqueuedAtIso: "2026-08-09T14:20:15.000Z",
      unmeasuredRows: 0,
    };
    return sample;
  }

  const sessionStalls = (harness: Harness) =>
    harness.stalls.filter((stall) => stall.lane === SyncLaneId.SessionMetadata);

  it("raises a monitored stall for a running lane that delivers nothing", async () => {
    const harness = buildHarness({ sample: stalledSessionSample() });
    harness.reporter.start();

    // The lane is never fed any completed work: it just sits on the backlog.
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    const stalls = sessionStalls(harness);
    assert.equal(
      stalls.length,
      1,
      "a lane delivering nothing must reach the monitored sink, once per episode"
    );
    assert.equal(stalls[0]?.workCompletedSincePrevious, 0);
    assert.equal(stalls[0]?.itemsRemaining, 2928);
  });

  it("does not raise while the whole backlog is inside its backoff window", async () => {
    // The same 2,928-row backlog, but every row is DEFERRED — the shape a
    // `protocol_unavailable` outage produces, which parks invocation parts for
    // five minutes against a one-minute sample. Nothing is eligible, so
    // completing nothing is the retry schedule working. Alerting here would page
    // on every routine outage and teach an operator to ignore the signal.
    const sample = stalledSessionSample();
    sample.sessionOutbox = { ...sample.sessionOutbox, readyPending: 0 };
    const harness = buildHarness({ sample });
    harness.reporter.start();

    for (let pass = 0; pass < 6; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(sessionStalls(harness).length, 0);
  });

  it("carries the lower-bound flag into the monitored stall", async () => {
    // The invocation lane's template probe caps at 200, so `itemsRemaining` is a
    // FLOOR. Dropping that on the way to the alert reports a 3,500-session
    // backfill as an exact, reassuring `200`.
    const sample = emptySample();
    sample.invocationOutbox = {
      ...sample.invocationOutbox,
      pendingTemplateSessions: 200,
      pendingTemplateSessionsTruncated: true,
    };
    const harness = buildHarness({ sample });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    const stall = harness.stalls.find(
      (entry) => entry.lane === SyncLaneId.InvocationParts
    );
    assert.equal(stall?.itemsRemaining, 200);
    assert.equal(
      stall?.itemsRemainingIsLowerBound,
      true,
      "the capped probe's floor was dropped — the alert presents 200 as exact"
    );
  });

  it("does not raise before the threshold, so one quiet sample is not an alert", async () => {
    const harness = buildHarness({ sample: stalledSessionSample() });
    harness.reporter.start();

    // Baseline plus one zero-work sample: below the consecutive-sample bar.
    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(sessionStalls(harness).length, 0);
  });

  it("does not raise for a lane whose gate is shut rather than stalled", async () => {
    const harness = buildHarness({
      sample: stalledSessionSample(),
      running: false,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    // `idle_not_running` is a closed gate — a different defect with a different
    // owner. Reporting it here would bury the real signal.
    assert.equal(sessionStalls(harness).length, 0);
  });

  it("clears the latch on a compute-target switch, so the new target re-reports", async () => {
    const harness = buildHarness({ sample: stalledSessionSample() });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(sessionStalls(harness).length, 1);

    // The target switches. `discardCrossTargetBaselines` must drop the
    // no-progress counter and latch with the rest of the baselines, or the new
    // target's own stall would be suppressed as "already reported".
    harness.setComputeTargetId("ct-2");
    for (let pass = 0; pass < 5; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      2,
      "the new target's stall must be reported under its own identity"
    );
  });

  it("clears the latch across stop/start, so a fresh run re-reports", async () => {
    const harness = buildHarness({ sample: stalledSessionSample() });
    harness.reporter.start();
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(sessionStalls(harness).length, 1);

    harness.reporter.stop();
    harness.reporter.start();
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      2,
      "a restarted reporter must not inherit the previous run's latch"
    );
  });

  it("re-arms after the lane drains, so a later stall is reported again", async () => {
    const harness = buildHarness({ sample: stalledSessionSample() });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(sessionStalls(harness).length, 1);

    // The lane recovers and drains completely, then backs up again.
    harness.setSample(emptySample());
    await harness.reporter.sampleOnce();
    harness.setSample(stalledSessionSample());
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      2,
      "the latch must re-arm after a genuine drain, not suppress the next episode"
    );
  });
});
