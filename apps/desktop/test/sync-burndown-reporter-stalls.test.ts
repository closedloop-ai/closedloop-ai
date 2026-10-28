/**
 * @file sync-burndown-reporter-stalls.test.ts
 * @description ISS-5347 / ISS-5973 — the reporter must make a lane that is
 * WORKING but not RECORDING PROGRESS visible, and must not cry stall over a
 * lane that is delivering.
 *
 * Split out of `sync-burndown-reporter.test.ts` (ISS-7401): stall DETECTION is
 * a separate responsibility from the fully-synced signal, cost discipline, and
 * lifecycle scoping the sibling file covers, and the combined file crossed the
 * 1,000-line ceiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SyncBurndownStoreSample } from "../src/main/database/sync-burndown-store.js";
import { SyncBurndownLogLevel } from "../src/main/sync/sync-burndown-reporter.js";
import {
  SyncLaneId,
  SyncLaneRemainderBasis,
  SyncLaneStallKind,
} from "../src/shared/sync-burndown-contract.js";
import {
  buildHarness,
  COMPONENT_KEY,
  emptySample,
  type Harness,
  messages,
  refillingSessionOutboxSample,
} from "./sync-burndown-reporter-harness.js";

const REPORTER_RE_12 = /DURABLE CURSOR NOT ADVANCING/;
const REPORTER_RE_13 = /stayed at 2026-08-03T20:56:53\.196Z/;

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

  it("ISS-7401: carries the reported cleared-row count on the stall it still raises", async () => {
    // The refill shape: 40 rows acked per window, 40 more enqueued, so depth
    // never moves and the parked watermark never moves either. This harness
    // names no cursor boundary, so under ISS-10429 the count cannot suppress.
    // The alarm still fires, and the count rides it for triage.
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 40,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 40,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const sessionStalls = harness.stalls.filter(
      (stall) => stall.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(
      sessionStalls.length,
      1,
      "cleared rows with no known cursor boundary must not disarm the alarm"
    );
    assert.equal(
      sessionStalls[0]?.queueRowsClearedSincePrevious,
      40,
      "and the alert must carry what the lane reported, for triage"
    );
  });

  it("ISS-7401: DOES report a stall at the same flat depth when no row was cleared", async () => {
    // The counterfactual sibling. Identical queue depth, identical parked
    // cursor, identical accepted batches — but the outbox never shrank, so bytes
    // are going out and nothing is being recorded anywhere. That is the ISS-5347
    // freeze and it must still page.
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 0,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 0,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const sessionStalls = harness.stalls.filter(
      (stall) => stall.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(
      sessionStalls.length,
      1,
      "uploads landing while the outbox never shrinks is still a stall"
    );
    assert.equal(sessionStalls[0]?.itemsRemaining, 120);
    // STRICT: `assert.equal` would also pass on `undefined`, which is the very
    // unmeasured state this case exists to tell apart from a reported zero.
    assert.strictEqual(
      sessionStalls[0]?.queueRowsClearedSincePrevious,
      0,
      "a REPORTED zero is a measurement and must publish as one"
    );
  });

  it("ISS-7401: leaves the count UNMEASURED when the accepted batch reported none", async () => {
    // The distinction the two cases above cannot draw between them. Same flat
    // depth, same accepted batches — but this caller passes no
    // `durablyClearedRows` at all, so nothing counted rows. Publishing `0` here
    // would put a measured "cleared nothing" on the alert on behalf of a caller
    // that measured nothing, which is a different fact and the more alarming of
    // the two. `null` is the honest representation of unknown, and it is what
    // makes `reportSyncLaneStall` OMIT the field rather than assert a zero.
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 4096 });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 4096 });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const sessionStalls = harness.stalls.filter(
      (stall) => stall.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(sessionStalls.length, 1, "the alarm is unchanged either way");
    // STRICT: `undefined == null` is TRUE, so a loose compare could not tell an
    // explicit unmeasured from a field the stall report forgot to set at all.
    assert.strictEqual(
      sessionStalls[0]?.queueRowsClearedSincePrevious,
      null,
      "an omitted count must not surface as a measured zero"
    );
  });

  it("ISS-7401: a measured window does not leak into the next unmeasured one", async () => {
    // The reset half of the same distinction: the tally is per-sample, so a
    // window that measured 40 must leave the FOLLOWING window unmeasured rather
    // than carrying 40 forward or decaying it to a measured 0.
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 40,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({ accepted: true, payloadBytes: 4096 });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const sessionStalls = harness.stalls.filter(
      (stall) => stall.lane === SyncLaneId.SessionMetadata
    );
    assert.strictEqual(
      sessionStalls[0]?.queueRowsClearedSincePrevious,
      null,
      "the previous window's 40 must not be republished on this stall"
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
    // Read before `stop()`: it nulls the retained snapshot.
    const transcriptLane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((entry) => entry.lane === SyncLaneId.TranscriptArchive);
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

    // Direct assertion on the built lane, not only on the absence of a stall:
    // `drainedQueueSincePrevious` short-circuits `detectCursorStall` for this
    // lane regardless of `tracksDurableCursor`, so the silence above would also
    // pass with the flag flipped to `true`.
    assert.equal(
      transcriptLane?.tracksDurableCursor,
      false,
      "the transcript lane must state it keeps no sync_state watermark"
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

  /**
   * ISS-8142 item 9. The test above is named "once per stall episode" and the
   * re-arm comment in the reporter promises "a multi-hour stall is one alert,
   * not one an interval". Neither sentence holds when upload activity
   * ALTERNATES: `detectCursorStall` answers false on any sample with no work
   * completed, which clears the episode latch, so the next working sample raises
   * a SECOND monitored error for the same unbroken freeze.
   *
   * Pinned as CURRENT behaviour, not asserted as correct — the re-arm-on-quiet
   * rule is deliberate and documented. What is wrong is the two sentences that
   * claim more than the code delivers; this case is what makes the gap visible
   * instead of leaving a future reader to trust the prose.
   */
  it("raises a SECOND alert for one unbroken stall when work alternates", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();

    // Two working samples against a frozen cursor: the episode is raised.
    for (let pass = 0; pass < 2; pass += 1) {
      harness.reporter.recordComponentRecordsSent(10);
      await harness.reporter.sampleOnce();
    }
    assert.equal(harness.stalls.length, 1, "the episode is open");

    // One quiet sample. The cursor is just as frozen as before — nothing was
    // fixed — but no work completed, so the detector answers false and the
    // latch clears.
    await harness.reporter.sampleOnce();
    assert.equal(
      harness.stalls.length,
      1,
      "a quiet sample raises nothing of its own"
    );

    // Work resumes against the SAME frozen cursor.
    harness.reporter.recordComponentRecordsSent(10);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      harness.stalls.length,
      2,
      "today one unbroken stall pages twice across an idle gap — the 'once per episode' guarantee does not survive alternating work"
    );
  });

  /**
   * ISS-8142 item 6. `recordSessionBatch` refuses a non-finite or negative
   * count, and refusing must leave the window UNMEASURED rather than promoting
   * it to a measured `0` — `0` says "a delivery path ran and removed nothing",
   * which is the alarming reading, on the alert whose whole job is telling those
   * two populations apart. NaN, Infinity and MAX_SAFE_INTEGER appeared zero
   * times across all three burndown suites before this case.
   */
  it("refuses a non-finite or negative cleared-row count and leaves the window unmeasured", async () => {
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    for (const durablyClearedRows of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -5,
    ]) {
      harness.reporter.recordSessionBatch({
        accepted: true,
        payloadBytes: 4096,
        durablyClearedRows,
      });
    }
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: Number.NaN,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const stall = harness.stalls.find(
      (entry) => entry.lane === SyncLaneId.SessionMetadata
    );
    // STRICT: `undefined == null` is true, so a loose compare could not tell a
    // deliberate unmeasured from a field that was never set.
    assert.strictEqual(
      stall?.queueRowsClearedSincePrevious,
      null,
      "three refused values must not add up to a measured zero"
    );
  });

  it("refuses a non-finite or negative payload size rather than tallying it", async () => {
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    for (const payloadBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      harness.reporter.recordSessionBatch({ accepted: true, payloadBytes });
    }
    await harness.reporter.sampleOnce();
    // Read before `stop()`: it nulls the retained snapshot, and the optional
    // chain would then swallow that into an `undefined` that quietly matches
    // nothing.
    const lane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((entry) => entry.lane === SyncLaneId.SessionMetadata);
    harness.reporter.stop();

    assert.equal(
      lane?.bytesSentSincePrevious,
      0,
      "a refused size must contribute nothing — NaN would poison every later total"
    );
  });

  /**
   * ISS-8142 item 6, the half the guard ADMITS. `Number.isFinite(x) && x >= 0`
   * lets a FRACTIONAL count and a magnitude past `Number.MAX_SAFE_INTEGER`
   * straight through to a monitored alert, where each renders as a confident
   * real measurement. AGENTS.md names both as part of the impossible set a
   * validity predicate must cover, so this case PINS today's admission rather
   * than blessing it — tightening the guard changes what reaches an alert and is
   * a behaviour change ISS-8142 scoped to tests only. The PR flags it for a
   * ruling.
   */
  it("today ADMITS a fractional cleared-row count onto the alert", async () => {
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 1.5,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 1.5,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const stall = harness.stalls.find(
      (entry) => entry.lane === SyncLaneId.SessionMetadata
    );
    assert.equal(
      stall?.queueRowsClearedSincePrevious,
      1.5,
      "1.5 rows cannot have been deleted; the guard admits it and the alert states it as measured"
    );
  });

  it("today ADMITS a cleared-row count past MAX_SAFE_INTEGER onto the alert", async () => {
    const harness = buildHarness({ sample: refillingSessionOutboxSample(120) });
    harness.reporter.start();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: Number.MAX_SAFE_INTEGER + 2,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.recordSessionBatch({
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: Number.MAX_SAFE_INTEGER + 2,
    });
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const stall = harness.stalls.find(
      (entry) => entry.lane === SyncLaneId.SessionMetadata
    );
    assert.ok(
      (stall?.queueRowsClearedSincePrevious ?? 0) > Number.MAX_SAFE_INTEGER,
      "a magnitude no outbox can hold is admitted and published as a measurement"
    );
  });

  /**
   * ISS-8142 item 7. `recordComponentRecordsSent` feeds
   * `workCompletedSincePrevious`, which `detectCursorStall` reads as "work
   * completed" — so a bad value here either FABRICATES a stall or SUPPRESSES a
   * real one, depending on which way it lands.
   */
  it("refuses a non-finite, negative or zero component count", async () => {
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();
    for (const count of [Number.NaN, -3, 0]) {
      harness.reporter.recordComponentRecordsSent(count);
    }
    await harness.reporter.sampleOnce();
    const lane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((entry) => entry.lane === SyncLaneId.ComponentInventory);
    harness.reporter.stop();

    assert.equal(
      lane?.workCompletedSincePrevious,
      0,
      "refused counts must leave the stall detector's input at zero, not poison it"
    );
    assert.equal(
      harness.stalls.length,
      0,
      "and no work completed means no fabricated cursor stall"
    );
  });

  it("today ADMITS a fractional component count into the stall detector's input", async () => {
    // The same admitted-value shape as the cleared-row pair above: 2.5 records
    // cannot have been sent, and it counts as work — which is what makes a
    // frozen cursor page. Pinned, not blessed; see the PR.
    const harness = buildHarness({ sample: frozenCursorSample() });
    harness.reporter.start();
    harness.reporter.recordComponentRecordsSent(2.5);
    await harness.reporter.sampleOnce();
    const lane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((entry) => entry.lane === SyncLaneId.ComponentInventory);
    harness.reporter.stop();

    assert.equal(lane?.workCompletedSincePrevious, 2.5);
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
      withheld: 0,
      oldestPendingSinceIso: "2026-08-09T14:20:15.000Z",
      unmeasuredRows: 0,
      parkedPending: 0,
      remainderBasis: SyncLaneRemainderBasis.Counted,
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
    // ISS-7401: the no-progress leg carries the count too, and here the honest
    // value is UNMEASURED. This lane is never fed a batch at all, so nothing
    // ever counted its cleared rows; a `0` would state on the alert that a
    // delivery path ran and removed nothing, which no code in this case did.
    // The reported-zero shape belongs to the cursor-frozen sibling above, which
    // drives `recordSessionBatch` with an explicit `durablyClearedRows: 0`: this
    // leg requires `workCompletedSincePrevious <= 0`, and the tally only
    // advances on an ACCEPTED batch, so a measured count here is unreachable by
    // construction rather than merely untested.
    assert.strictEqual(stalls[0]?.queueRowsClearedSincePrevious, null);
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

  it("does not page on the first eligible sample after the backoff window clears", async () => {
    // ISS-8142 BUG 2. The `readyItemsRemaining === 0` guard exempts the deferred
    // window from the stall detector, but the consecutive-sample counter was
    // incremented BEFORE the detector was consulted — so it kept counting
    // through the very window the guard exempts. By the time a routine
    // `protocol_unavailable` outage cleared, the count was already past the
    // three-sample threshold and the lane raised the monitored error on the
    // FIRST sample it was eligible again, before it had any chance to deliver.
    // That is precisely the alert fatigue the guard was added to prevent.
    const deferred = stalledSessionSample();
    deferred.sessionOutbox = { ...deferred.sessionOutbox, readyPending: 0 };
    const harness = buildHarness({ sample: deferred });
    harness.reporter.start();

    for (let pass = 0; pass < 6; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(
      sessionStalls(harness).length,
      0,
      "the deferred window itself must stay silent (the pre-existing guarantee)"
    );

    // The backoff expires: the backlog is eligible again, and the lane has not
    // yet had a single interval in which it could have delivered anything.
    harness.setSample(stalledSessionSample());
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      0,
      "one eligible sample is not three; the deferred window must not have pre-loaded the counter"
    );
  });

  it("does not pre-load the counter on the very FIRST sample when it is deferred", async () => {
    // The narrow case a multi-sample fixture cannot see. `zeroWorkExemptionFor`
    // used to answer "not exempt" whenever there was no previous sample, before
    // it ever looked at `readyItemsRemaining` — so sample 1 after `start()`
    // tallied even when the whole backlog was deferred, and only samples 2+ were
    // re-armed. With ONE deferred sample there is nothing to re-arm it, so the
    // pre-load survives and the lane pages after only TWO eligible samples
    // instead of the three `NO_PROGRESS_STALL_SAMPLES` promises.
    const deferred = stalledSessionSample();
    deferred.sessionOutbox = { ...deferred.sessionOutbox, readyPending: 0 };
    const harness = buildHarness({ sample: deferred });
    harness.reporter.start();

    await harness.reporter.sampleOnce();

    harness.setSample(stalledSessionSample());
    await harness.reporter.sampleOnce();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      0,
      "two eligible samples is not three — the single deferred sample must not have counted"
    );
  });

  it("still raises once three ELIGIBLE zero-work samples accrue after a deferral", async () => {
    // The other side of the same guard: re-arming the counter must not disable
    // the detector. Without this, BUG 2 could be "fixed" by never counting at
    // all and the suite above would not notice.
    const deferred = stalledSessionSample();
    deferred.sessionOutbox = { ...deferred.sessionOutbox, readyPending: 0 };
    const harness = buildHarness({ sample: deferred });
    harness.reporter.start();

    for (let pass = 0; pass < 6; pass += 1) {
      await harness.reporter.sampleOnce();
    }

    harness.setSample(stalledSessionSample());
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    const stalls = sessionStalls(harness);
    assert.equal(
      stalls.length,
      1,
      "a lane that is genuinely eligible and delivering nothing must still page"
    );
    assert.equal(stalls[0]?.workCompletedSincePrevious, 0);
    assert.equal(stalls[0]?.itemsRemaining, 2928);
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

  it("does not raise NO-PROGRESS for a lane whose gate is shut rather than stalled", async () => {
    const harness = buildHarness({
      sample: stalledSessionSample(),
      running: false,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    // A closed gate is a different defect from a running lane that will not
    // move, and conflating them would bury the real signal. ISS-8768 gave that
    // different defect its OWN owner, so the assertion is by KIND: the
    // no-progress contract is unchanged, and what used to be silence here is now
    // the gate-shut kind rather than nothing at all.
    assert.equal(
      sessionStalls(harness).filter(
        (stall) => stall.kind === SyncLaneStallKind.NoProgress
      ).length,
      0,
      "no-progress describes a RUNNING lane; a gated one must never borrow its wording"
    );
    assert.deepEqual(
      sessionStalls(harness).map((stall) => stall.kind),
      [SyncLaneStallKind.GateShutWithBacklog],
      "the gated lane is reported once, under its own kind (ISS-8768)"
    );
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
