/**
 * @file sync-burndown-reporter.test.ts
 * @description ISS-5387 — the periodic burn-down reporter must tell the truth
 * about whether the desktop is caught up, and must make a lane that is
 * WORKING but not RECORDING PROGRESS visible.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import {
  SyncBurndownLogLevel,
  SyncBurndownReporter,
} from "../src/main/sync/sync-burndown-reporter.js";
import {
  areAllLanesFullySynced,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../src/shared/sync-burndown-contract.js";
import {
  buildHarness,
  COMPONENT_KEY,
  emptySample,
  type LoggedLine,
  messages,
  SESSION_KEY,
  TEMPLATE_KEY,
} from "./sync-burndown-reporter-harness.js";

const REPORTER_RE_1 = /fully synced to cloud/;
const REPORTER_RE_2 =
  /session_metadata\] NOT fully synced .*4 item\(s\) were dead-lettered/;
const REPORTER_RE_3 = /ALL LANES FULLY SYNCED/;
const REPORTER_RE_4 =
  /not fully synced — session_metadata=drained_with_dead_letters/;
const REPORTER_RE_4_LANES = /ALL LANES FULLY SYNCED to cloud \(4 lane\(s\)/;
const REPORTER_RE_6 = /session_metadata\] drained/;
const REPORTER_RE_7 = /session_metadata\] idle_not_running/;
const REPORTER_RE_8 = /session_metadata\] fully synced/;
const REPORTER_RE_9 = /not fully synced — /;
const UNQUERIED_LINE_RE =
  /session_metadata\] remaining_unknown items=n\/a chunks=n\/a bytes=unknown/;
const UNQUERIED_CAUSE_RE =
  /session_metadata\] NOT reported as fully synced .* it had no source key this sample, so the store never queried its queue/;
const REPORTER_RE_10 = /session_metadata\] never_started/;
const REPORTER_RE_11 = /session_metadata\] draining/;
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
const ALL_LANES_SYNCED_RE = /ALL LANES FULLY SYNCED/;
const ITEM5_UNKNOWN_VERDICT_RE =
  /\[session_metadata\] NOT reported as fully synced — nothing known outstanding, but 3 row\(s\) carry a status this build cannot classify/;

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
    // The other four lanes ARE drained; the verdict must still be withheld.
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
    assert.match(text, REPORTER_RE_4_LANES);
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
    busy.sessionOutbox.oldestPendingSinceIso = "2026-08-06T11:00:00.000Z";
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
    busy.sessionOutbox.oldestPendingSinceIso = "2026-08-06T11:00:00.000Z";
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
      getIdentity: () => null,
      isSessionLaneRunning: () => true,
      isInvocationLaneRunning: () => true,
      isTranscriptLaneRunning: () => true,
      isComponentLaneRunning: () => true,
      isLaneDeliveryConsented: () => true,
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
      getIdentity: () => null,
      isSessionLaneRunning: () => false,
      isInvocationLaneRunning: () => false,
      isTranscriptLaneRunning: () => false,
      isComponentLaneRunning: () => false,
      isLaneDeliveryConsented: () => true,
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
      getIdentity: () => null,
      isSessionLaneRunning: () => true,
      isInvocationLaneRunning: () => true,
      isTranscriptLaneRunning: () => true,
      isComponentLaneRunning: () => true,
      isLaneDeliveryConsented: () => true,
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
    assert.equal(snapshot.lanes.length, 4);
    const sessionLane = snapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(sessionLane?.itemsRemaining, 12);
    // A reader must never make this observer participate in the lanes it
    // measures: reading the accessor issues no store query.
    assert.equal(harness.readCount(), readsAfterSample);
    harness.reporter.stop();
  });

  it("reports a malformed persisted pending timestamp as an unknown age", async () => {
    const sample = emptySample();
    sample.sessionOutbox.pending = 1;
    sample.sessionOutbox.oldestPendingSinceIso = "malformed";
    const harness = buildHarness({ sample });
    harness.reporter.start();

    await harness.reporter.sampleOnce();

    const snapshot = harness.reporter.getLatestSnapshot();
    assert.ok(snapshot);
    const sessionLane = snapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.SessionMetadata
    );
    assert.ok(sessionLane);
    assert.equal(sessionLane.oldestPendingAgeMs, null);
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

describe("SyncBurndownReporter — the blocked session resume (ISS-9823)", () => {
  /**
   * The session lane's row from the most recent sample, or `undefined` when no
   * sample is on hand. Deliberately assertion-free: an assertion inside a helper
   * runs outside the case that called it, so the runner cannot attribute it —
   * each case below asserts the row is there before reading it.
   */
  function sessionLaneOf(
    harness: ReturnType<typeof buildHarness>
  ): SyncLaneBurndown | undefined {
    return harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((row) => row.lane === SyncLaneId.SessionMetadata);
  }

  it("reports a caught-up session lane as remaining_unknown while its resume read is failing", async () => {
    // The whole defect, at the reporter: `emptySample()` is a device that owes
    // nothing on every count the burn-down can measure, which is exactly the
    // population the abort produces — it returns before the enqueue, so no row
    // is ever written. `drained` here is a screen asserting health while local
    // data never leaves the machine.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await harness.reporter.sampleOnce();

    const lane = sessionLaneOf(harness);
    assert.ok(lane, "a sample was taken and it carries the session lane");
    assert.equal(lane.resumeBlocked, true, "the row carries the fact itself");
    assert.equal(lane.state, SyncLaneDrainState.RemainingUnknown);
    assert.equal(
      areAllLanesFullySynced(harness.reporter.getLatestSnapshot()?.lanes ?? []),
      false,
      "and ALL LANES FULLY SYNCED can no longer be printed for this device"
    );
    harness.reporter.stop();
  });

  it("leaves every other lane's resumeBlocked structurally false", async () => {
    // The scoping half. Only the session lane runs a once-per-identity resume
    // hydration, so a fault on it must not disqualify the four lanes that have
    // no such read to fail.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await harness.reporter.sampleOnce();

    const snapshot = harness.reporter.getLatestSnapshot();
    assert.ok(snapshot);
    for (const lane of snapshot.lanes) {
      if (lane.lane === SyncLaneId.SessionMetadata) {
        continue;
      }
      assert.equal(
        lane.resumeBlocked,
        false,
        `${lane.lane} has no resume read of its own`
      );
      assert.equal(lane.state, SyncLaneDrainState.Drained);
    }
    harness.reporter.stop();
  });

  it("holds the level ACROSS sampling windows, which reset the activity counters", async () => {
    // Constraint on where the level may live. Every successful sample ends in
    // `resetActivityCounters()`, which clears what one WINDOW observed — and
    // this condition outlives a window by construction, because the lane is
    // wedged until the durable read recovers. Held there, the fault would be
    // erased between samples and the very next line would call the device
    // drained again.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();

    const lane = sessionLaneOf(harness);
    assert.ok(lane);
    assert.equal(
      lane.state,
      SyncLaneDrainState.RemainingUnknown,
      "the third window still reports the fault the first one recorded"
    );
    harness.reporter.stop();
  });

  it("survives a compute-target switch, because that boundary is observed a window late", async () => {
    // ISS-9823 review. The expectation this replaces asserted that the scope
    // boundary CLEARS the level, and the behavior deliberately changed: the
    // switch is detected at SAMPLE time, one 60s window after the fact, while
    // the outcome is teed at the sync lane's own 5s tick — so the fault sitting
    // on the level by then is most likely the INCOMING target's, recorded by its
    // first hydration. Clearing erased it and published `drained` for a lane
    // already known to be wedged: one whole window of the exact false
    // "up to date" this ticket exists to remove.
    //
    // Not clearing errs the other way and errs safely — an incoming HEALTHY
    // target reads `remaining_unknown` until its own hydration answers `Seeded`,
    // which is one tick away because a failed read re-arms `hydratedSourceKey`.
    // Unknown-for-a-tick is a state a caller must wait on; drained-for-a-window
    // is a claim it acts on.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);
    await harness.reporter.sampleOnce();
    assert.equal(
      sessionLaneOf(harness)?.state,
      SyncLaneDrainState.RemainingUnknown
    );

    harness.setComputeTargetId("ct-2");
    await harness.reporter.sampleOnce();

    assert.equal(
      sessionLaneOf(harness)?.state,
      SyncLaneDrainState.RemainingUnknown,
      "the boundary alone does not attest that the new target's read landed"
    );

    // The new identity's own hydration is what settles it, and it can settle it
    // either way — so the assertion above is not a level that never clears.
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Seeded);
    await harness.reporter.sampleOnce();

    const lane = sessionLaneOf(harness);
    assert.ok(lane, "the new target took its own sample");
    assert.equal(lane.resumeBlocked, false);
    assert.equal(
      lane.state,
      SyncLaneDrainState.Drained,
      "the new target is judged on its own reads"
    );
    harness.reporter.stop();
  });

  it("leaves the level alone on a DISCARDED outcome, so an account switch raises nothing", async () => {
    // The negative at this seam, and the reason `Discarded` is not simply
    // folded into `Seeded`: a supersede that landed between a failing read and
    // its retry must not clear a fault it knows nothing about, any more than it
    // may set one.
    const harness = buildHarness();
    harness.reporter.start();

    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Discarded);
    await harness.reporter.sampleOnce();
    assert.equal(
      sessionLaneOf(harness)?.state,
      SyncLaneDrainState.Drained,
      "a supersede on its own reports nothing"
    );

    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Discarded);
    await harness.reporter.sampleOnce();

    assert.equal(
      sessionLaneOf(harness)?.state,
      SyncLaneDrainState.RemainingUnknown,
      "and a supersede after a fault does not clear it"
    );
    harness.reporter.stop();
  });
});

describe("SyncBurndownReporter — the RemainingUnknown verdict (ISS-8142, ISS-10082)", () => {
  it("reports an unmeasurable-rows lane as RemainingUnknown, disqualifies the all-lanes verdict, and warns rather than informs", async () => {
    // RemainingUnknown is exercised against the pure classifier and the
    // renderer hook, but nothing drove an unmeasuredRows>0 sample through the
    // REPORTER itself. If it collapsed to Drained here, the app would print
    // ALL LANES FULLY SYNCED while rows this build cannot classify sit in the
    // outbox — exactly the read the ISS-5477 cloud-read gate relies on being
    // truthful.
    const sample = emptySample();
    sample.sessionOutbox.pending = 0;
    sample.sessionOutbox.deadLettered = 0;
    sample.sessionOutbox.unmeasuredRows = 3;
    const harness = buildHarness({ sample });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    const snapshot = harness.reporter.getLatestSnapshot();
    assert.ok(snapshot);
    const sessionLane = snapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.SessionMetadata
    );
    assert.ok(sessionLane);
    assert.equal(sessionLane.state, SyncLaneDrainState.RemainingUnknown);
    assert.equal(
      areAllLanesFullySynced(snapshot.lanes),
      false,
      "unmeasurable rows must disqualify the all-lanes verdict even though every count reads zero"
    );

    const verdictLine = harness.lines.find((line) =>
      ITEM5_UNKNOWN_VERDICT_RE.test(line.message)
    );
    assert.ok(verdictLine, "the lane emitted its remaining-unknown verdict");
    assert.equal(
      verdictLine.level,
      SyncBurndownLogLevel.Warn,
      "an unproven remainder must page at WARN, not read as routine INFO"
    );
    harness.reporter.stop();
  });

  /**
   * ISS-10082 (AC3), on the SESSION lane. Its key and its gate read the same
   * getter (`desktop-sync-lane-composition.ts:477/500`), so the two disagree
   * either across `sampleOnce`'s await — the scope is captured before the store
   * read and the gate is read after it — or on a FALSY-BUT-NOT-NULL target id,
   * where `computeTargetId ? … : null` yields a null key while
   * `getSyncComputeTargetId() !== null` still holds the gate open.
   *
   * The simultaneous two-resolver disagreement is the INVOCATION and COMPONENT
   * lanes' mechanism, not this one; the case below covers it.
   */
  it("reports an OPEN-gate lane whose queue was never queried as remaining_unknown, not drained", async () => {
    const sample = emptySample();
    // Everything else about this sample says "caught up". The single fact that
    // changes is that nobody looked.
    sample.sessionOutbox.remainderBasis = SyncLaneRemainderBasis.Unqueried;
    const harness = buildHarness({ sample, running: true });
    harness.setSourceKeys({ session: null });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    const snapshot = harness.reporter.getLatestSnapshot();
    harness.reporter.stop();
    assert.ok(snapshot);
    const lane = snapshot.lanes.find(
      (candidate) => candidate.lane === SyncLaneId.SessionMetadata
    );
    assert.ok(lane);
    assert.equal(
      lane.state,
      SyncLaneDrainState.RemainingUnknown,
      "a lane the store never queried has not been shown to be caught up, and `drained` is the one state that claims it has"
    );
    assert.equal(
      lane.itemsRemaining,
      null,
      "the placeholder zero must be published as the unknown it is — every consumer already reads null as unknown, and a 0 as measured"
    );
    assert.equal(
      lane.readyItemsRemaining,
      null,
      "the eligible-now depth was not measured either, and a measured 0 there suppresses the no-progress stall"
    );
    assert.equal(
      areAllLanesFullySynced(snapshot.lanes),
      false,
      "ALL LANES FULLY SYNCED must not print over a lane nobody read"
    );
    const logged = messages(harness.lines);
    assert.match(
      logged,
      UNQUERIED_LINE_RE,
      "the operator line must show the remainders as unknown rather than as a reassuring row of zeros"
    );
    assert.match(
      logged,
      UNQUERIED_CAUSE_RE,
      "and must name THIS cause — not the structural 'exposes no measurable remainder' sentence, which describes a lane with no queue rather than a queue nobody read"
    );
  });

  /**
   * ISS-10082, on the INVOCATION lane — the one that needs no await window at
   * all. `getInvocationSourceKey` resolves through
   * `identityBoundTranscriptComputeTargetId`, which is null unless the raw
   * online target and the identity-bound one AGREE, while
   * `isInvocationLaneRunning` reads only `getTranscriptComputeTargetId()`. An
   * account-switch flap makes them disagree at one instant: gate open, key null.
   *
   * The gated-backlog suite's invocation cases all run with the gate SHUT, so
   * without this one the lane with the genuinely raceless path is uncovered.
   */
  it("reports an OPEN-gate INVOCATION lane whose delivery queue was never queried as remaining_unknown", async () => {
    const sample = emptySample();
    sample.invocationOutbox.remainderBasis = SyncLaneRemainderBasis.Unqueried;
    const harness = buildHarness({ sample, running: true });
    harness.setSourceKeys({ invocation: null });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    const snapshot = harness.reporter.getLatestSnapshot();
    harness.reporter.stop();
    assert.ok(snapshot);
    const lane = snapshot.lanes.find(
      (candidate) => candidate.lane === SyncLaneId.InvocationParts
    );
    assert.ok(lane);
    assert.equal(
      lane.state,
      SyncLaneDrainState.RemainingUnknown,
      "gate open and delivery key null is reachable without a race, and the placeholder behind it must not read as caught up"
    );
    assert.equal(lane.itemsRemaining, null);
    assert.equal(
      lane.bytesRemaining,
      null,
      "`bytes=0` on a queue nobody read is the same confident zero one column over"
    );
    assert.equal(lane.chunksRemaining, null);
  });
});

describe("SyncBurndownReporter — corrupt persisted timestamps and delta flooring (ISS-8142)", () => {
  it("reports a corrupt persisted cursor write timestamp as an unknown age, not a fabricated zero", async () => {
    // SQLite enforces no TEXT-column format: a value another process wrote, a
    // partial write, or plain bit-rot reaches this column exactly as-is
    // regardless of what the TypeScript type declares. `ageMsFrom` must read it
    // as unknown rather than compute an age against garbage — a fabricated `0`
    // would print as "brand new" for a cursor nobody can actually place in time.
    for (const corruptUpdatedAt of ["not-a-date", ""]) {
      const sample = emptySample();
      sample.cursorsBySourceKey[SESSION_KEY] = {
        sourceKey: SESSION_KEY,
        observedTopUpdatedAt: "some-cursor-value",
        updatedAt: corruptUpdatedAt,
        dataRevision: 1,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
      };
      const harness = buildHarness({ sample });
      harness.reporter.start();
      await harness.reporter.sampleOnce();

      const snapshot = harness.reporter.getLatestSnapshot();
      assert.ok(snapshot);
      const sessionLane = snapshot.lanes.find(
        (lane) => lane.lane === SyncLaneId.SessionMetadata
      );
      assert.ok(sessionLane);
      assert.equal(
        sessionLane.durableCursorAgeMs,
        null,
        `a corrupt cursor write timestamp (${JSON.stringify(corruptUpdatedAt)}) must read as unknown, not zero`
      );
      harness.reporter.stop();
    }
  });

  it("carries the unknown cursor age into the monitored stall report instead of a fabricated zero", async () => {
    // Reachable end to end: a batch completes (workCompletedSincePrevious > 0)
    // against an unmoving cursor whose write timestamp is corrupt TEXT — the
    // ISS-5347 shape this reporter exists to catch. Downstream,
    // sync-lane-stall-telemetry.ts omits `durableCursorAgeMs` on `null` rather
    // than emitting a zero that would read as the best possible outcome.
    const busy = emptySample();
    busy.sessionOutbox.pending = 5;
    busy.cursorsBySourceKey[SESSION_KEY] = {
      sourceKey: SESSION_KEY,
      observedTopUpdatedAt: "cursor-v1",
      updatedAt: "not-a-date",
      dataRevision: 1,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    };
    const harness = buildHarness({ sample: busy });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    // The queue holds steady and the cursor value is unchanged, but a batch
    // completed — uploads landing, persistence motionless.
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 4096 });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      harness.stalls.length,
      1,
      "the frozen cursor raises exactly one stall"
    );
    assert.equal(
      harness.stalls[0]?.durableCursorAgeMs,
      null,
      "a corrupt cursor write timestamp must reach the stall report as unknown, not a fabricated brand-new age"
    );
  });

  it("floors a per-pass delta at zero rather than reporting a growing queue as negative progress, and reports zero with no previous sample to diff against (positiveDelta)", async () => {
    const firstSample = emptySample();
    firstSample.transcript.inFlightFiles = 5;
    const harness = buildHarness({ sample: firstSample });
    harness.reporter.start();
    await harness.reporter.sampleOnce();

    const firstSnapshot = harness.reporter.getLatestSnapshot();
    assert.ok(firstSnapshot);
    const firstTranscriptLane = firstSnapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.TranscriptArchive
    );
    assert.ok(firstTranscriptLane);
    assert.equal(
      firstTranscriptLane.workCompletedSincePrevious,
      0,
      "positiveDelta has no previous sample to diff against yet, so it must report zero rather than the raw in-flight count"
    );

    // The in-flight count GROWS — new files entered flight — rather than shrinks.
    const grownSample = emptySample();
    grownSample.transcript.inFlightFiles = 12;
    harness.setSample(grownSample);
    await harness.reporter.sampleOnce();

    const secondSnapshot = harness.reporter.getLatestSnapshot();
    assert.ok(secondSnapshot);
    const secondTranscriptLane = secondSnapshot.lanes.find(
      (lane) => lane.lane === SyncLaneId.TranscriptArchive
    );
    assert.ok(secondTranscriptLane);
    assert.equal(
      secondTranscriptLane.workCompletedSincePrevious,
      0,
      "Math.max(0, previous - current) must floor a growing queue's delta at zero, never report it negative"
    );
    harness.reporter.stop();
  });
});
