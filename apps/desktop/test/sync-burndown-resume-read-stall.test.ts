/**
 * @file sync-burndown-resume-read-stall.test.ts
 * @description ISS-9823 — a session lane whose once-per-identity resume read
 * keeps failing must PAGE, and must page on the device the bug was filed about:
 * the one that was already caught up.
 *
 * The whole hazard of this detector is that it is trivially easy to write a
 * version that cannot fire on its own bug and still passes every test. The
 * abort returns before `enqueueIncrementalUpdates`, so on a caught-up device no
 * outbox row is ever written, `pending` stays 0, and the lane classifies as
 * `remaining_unknown` — never `draining`, which is the state the three
 * pre-existing detectors are built around. A detector gated on `draining` would
 * be silent on exactly the population ISS-9823 describes, so the state each
 * case drives through is load-bearing rather than incidental.
 *
 * A new file rather than an addition to `sync-burndown-contract.test.ts` (869
 * lines) or `sync-burndown-reporter-stalls.test.ts` (903), following the
 * ISS-8768 / ISS-7401 split precedent and the 1,000-line ceiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import {
  detectResumeBlockedStall,
  NO_PROGRESS_STALL_SAMPLES,
  OldestPendingBasis,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
  SyncLaneStallKind,
} from "../src/shared/sync-burndown-contract.js";
import {
  buildHarness,
  type Harness,
  messages,
} from "./sync-burndown-reporter-harness.js";

const RESUME_READ_FAILING_RE = /RESUME READ FAILING/;
const RESUME_READ_MIGRATION_RE = /check for an unapplied desktop migration/;
const RESUME_READ_DISOWNED_ZERO_RE =
  /measured remainder \(items=0\) is not evidence of anything/;

/**
 * A lane row as the reporter builds one. `state` is passed explicitly rather
 * than derived, so a case can pin the exact classifier answer the detector is
 * being held against.
 */
function lane(overrides: Partial<SyncLaneBurndown> = {}): SyncLaneBurndown {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.RemainingUnknown,
    resumeBlocked: true,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: 0,
    unmeasuredRows: 0,
    bytesRemaining: null,
    chunksRemaining: null,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    remainderBasis: SyncLaneRemainderBasis.Counted,
    oldestPendingSinceIso: null,
    oldestPendingBasis: OldestPendingBasis.EnqueuedAt,
    oldestPendingAgeMs: null,
    tracksDurableCursor: true,
    durableCursorValue: "2026-08-06T10:00:00.000Z",
    durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
    durableCursorAgeMs: 1000,
    workCompletedSincePrevious: 0,
    bytesSentSincePrevious: 0,
    ...overrides,
  };
}

describe("detectResumeBlockedStall (ISS-9823)", () => {
  it("fires on the CAUGHT-UP device, whose lane is remaining_unknown and never draining", () => {
    // The primary case, and the one a `draining` precondition would miss
    // entirely: nothing is owed on any count the burn-down can measure, because
    // the abort is what keeps the outbox empty.
    assert.equal(
      detectResumeBlockedStall({
        current: lane(),
        consecutiveResumeBlockedSamples: NO_PROGRESS_STALL_SAMPLES,
      }),
      true
    );
  });

  it("also fires on a wedged lane that IS still holding rows", () => {
    // The measured-backlog side answers `draining`, so this detector must not
    // be written as an equality against `remaining_unknown` either. The
    // pre-existing no-progress alert also fires there; they say different
    // things and an operator acts on them differently.
    assert.equal(
      detectResumeBlockedStall({
        current: lane({
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2928,
          readyItemsRemaining: 2928,
        }),
        consecutiveResumeBlockedSamples: NO_PROGRESS_STALL_SAMPLES,
      }),
      true
    );
  });

  it("does not fire before the threshold, so one transient SQLite lock cannot page", () => {
    for (let samples = 0; samples < NO_PROGRESS_STALL_SAMPLES; samples += 1) {
      assert.equal(
        detectResumeBlockedStall({
          current: lane(),
          consecutiveResumeBlockedSamples: samples,
        }),
        false,
        `${samples} consecutive sample(s) is below the ${NO_PROGRESS_STALL_SAMPLES}-sample threshold`
      );
    }
  });

  it("does not fire for a lane that is not running, however long the level has stood", () => {
    // A shut gate is a different defect with a different owner
    // (`detectGatedBacklogStall`), and a lane that has never started has not
    // attempted the read this alert is about.
    for (const state of [
      SyncLaneDrainState.NeverStarted,
      SyncLaneDrainState.IdleNotRunning,
    ]) {
      assert.equal(
        detectResumeBlockedStall({
          current: lane({ state }),
          consecutiveResumeBlockedSamples: NO_PROGRESS_STALL_SAMPLES * 10,
        }),
        false,
        `${state} is not a lane whose resume read is failing while it tries`
      );
    }
  });

  it("does not fire for a healthy lane, however many samples have accrued", () => {
    assert.equal(
      detectResumeBlockedStall({
        current: lane({
          resumeBlocked: false,
          state: SyncLaneDrainState.Drained,
        }),
        consecutiveResumeBlockedSamples: NO_PROGRESS_STALL_SAMPLES * 10,
      }),
      false
    );
  });
});

/**
 * The reporter half. The pure detector above cannot see the tally, the episode
 * latch, the warn-line throttle, or the `onLaneStall` emission — without these
 * cases, deleting `maybeWarnResumeBlocked` outright would leave the whole suite
 * green.
 */
describe("SyncBurndownReporter — blocked resume read (ISS-9823)", () => {
  const sessionStalls = (harness: Harness) =>
    harness.stalls.filter((stall) => stall.lane === SyncLaneId.SessionMetadata);

  async function sample(harness: Harness, passes: number): Promise<void> {
    for (let pass = 0; pass < passes; pass += 1) {
      await harness.reporter.sampleOnce();
    }
  }

  it("raises the monitored stall for a caught-up device whose resume read keeps failing", async () => {
    // `buildHarness()`'s default sample owes nothing on every measurable count
    // — the exact population the abort produces. Today this device prints
    // ALL LANES FULLY SYNCED; nothing pages.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await sample(harness, NO_PROGRESS_STALL_SAMPLES);
    harness.reporter.stop();

    const stalls = sessionStalls(harness);
    assert.equal(
      stalls.length,
      1,
      "a device whose durable read is failing must reach the monitored sink, once per episode"
    );
    assert.equal(
      stalls[0]?.kind,
      SyncLaneStallKind.ResumeReadFailed,
      "the operator action here is a durable read, not a queue or a credential"
    );
    assert.equal(
      stalls[0]?.itemsRemaining,
      0,
      "the measured remainder rides the alert as it was measured; the SENTENCE is what disowns it"
    );
    const text = messages(harness.lines);
    assert.match(text, RESUME_READ_FAILING_RE);
    assert.match(text, RESUME_READ_MIGRATION_RE);
    assert.match(
      text,
      RESUME_READ_DISOWNED_ZERO_RE,
      "a stall line reading items=0 with no qualifier says the opposite of the condition it reports"
    );
  });

  it("stays silent for a single transient failing read", async () => {
    // One SQLite lock is not a wedge. The read recovers before the threshold,
    // and nothing may page.
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await sample(harness, NO_PROGRESS_STALL_SAMPLES - 1);
    assert.equal(
      sessionStalls(harness).length,
      0,
      "below the threshold nothing is reported"
    );

    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Seeded);
    await sample(harness, NO_PROGRESS_STALL_SAMPLES * 2);
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      0,
      "a recovered read re-arms the tally, so the samples before it can never accumulate toward a page"
    );
    assert.doesNotMatch(messages(harness.lines), RESUME_READ_FAILING_RE);
  });

  it("stays silent through an identity supersede, so an account switch never pages", async () => {
    // `Discarded` is an ordinary account or compute-target switch. Treating it
    // as a fault would page on every sign-in, which is the trade this whole
    // ticket refused to make.
    const harness = buildHarness();
    harness.reporter.start();

    for (let pass = 0; pass < NO_PROGRESS_STALL_SAMPLES * 2; pass += 1) {
      harness.reporter.recordSessionResumeOutcome(
        OutboxResumeOutcome.Discarded
      );
      await harness.reporter.sampleOnce();
    }

    // And a stop() mid-hydration: the lifecycle boundary clears the level, so
    // the restarted run starts from a clean sheet rather than inheriting a
    // fault it can no longer attribute.
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);
    harness.reporter.stop();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Discarded);
    await sample(harness, NO_PROGRESS_STALL_SAMPLES * 2);
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      0,
      "a supersede is not a fault, and a stop() takes the run's observations with it"
    );
    assert.doesNotMatch(messages(harness.lines), RESUME_READ_FAILING_RE);
  });

  it("re-arms after recovery, so a fault that returns is a new episode", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);
    await sample(harness, NO_PROGRESS_STALL_SAMPLES);
    assert.equal(sessionStalls(harness).length, 1);

    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.Seeded);
    await harness.reporter.sampleOnce();

    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);
    await sample(harness, NO_PROGRESS_STALL_SAMPLES);
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      2,
      "a read that fails again after a genuine recovery is a new episode, not a suppressed one"
    );
  });

  it("throttles the recurring warn line while the monitored alert still fires once", async () => {
    const harness = buildHarness({
      // 3 samples per throttle window (3,600,000ms / 1,200,000ms), so the
      // throttle is observable in a handful of passes rather than the 60+ the
      // real 60s default would need.
      intervalMs: 20 * 60 * 1000,
    });
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await sample(harness, 10);
    harness.reporter.stop();

    assert.equal(
      harness.lines.filter((line) => RESUME_READ_FAILING_RE.test(line.message))
        .length,
      3,
      "sample 3 (first occurrence) plus hourly re-prints at samples 6 and 9 — a wedge that never clears must not warn every sample forever"
    );
    assert.equal(
      sessionStalls(harness).length,
      1,
      "the monitored alert dedupes per episode; only the local log line's cadence changes"
    );
  });

  it("does not page the four lanes that run no resume read of their own", async () => {
    const harness = buildHarness();
    harness.reporter.start();
    harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

    await sample(harness, NO_PROGRESS_STALL_SAMPLES);
    harness.reporter.stop();

    assert.deepEqual(
      harness.stalls
        .filter((stall) => stall.kind === SyncLaneStallKind.ResumeReadFailed)
        .map((stall) => stall.lane),
      [SyncLaneId.SessionMetadata],
      "only the lane that HAS a once-per-identity resume read can have one fail"
    );
  });
});
