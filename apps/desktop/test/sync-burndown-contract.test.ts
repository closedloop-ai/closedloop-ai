import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  areAllLanesFullySynced,
  classifyLaneDrainState,
  detectCursorStall,
  detectGatedBacklogStall,
  detectNoProgressStall,
  formatAllLanesVerdictLine,
  formatCursorStallLine,
  formatLaneBurndownLine,
  formatNoProgressStallLine,
  GATE_SHUT_STALL_SAMPLES,
  isLaneFullySynced,
  NO_PROGRESS_STALL_SAMPLES,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import { burndownLane as lane } from "./support/sync-burndown-fixtures.js";

const CONTRACT_RE_1 = /not fully synced/;
const CONTRACT_RE_2 = /transcript_archive=drained_with_dead_letters/;
const CONTRACT_RE_3 = /ALL LANES FULLY SYNCED/;
const LOWER_BOUND_ITEMS_RE = /items=>=200/;
const EXACT_200_ITEMS_RE = /items=200\b/;
const UNMEASURED_RE = /unmeasured=7/;
const STALL_ABSENT_CURSOR_RE = /stayed at none\b/;
const STALL_NULLISH_CURSOR_RE = /stayed at (?:null|undefined)/;
const NO_PROGRESS_LINE_RE = /LANE NOT DRAINING/;
const NO_PROGRESS_ITEMS_RE = /2928 item\(s\) still owed/;
const NO_PROGRESS_UNKNOWN_RE = /unknown item\(s\) still owed/;

describe("sync burn-down lane classification", () => {
  it("never reports a lane with dead-lettered items as fully synced", () => {
    const state = classifyLaneDrainState({
      started: true,
      gateOpen: true,
      resumeBlocked: false,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      itemsRemaining: 0,
      deadLetteredCount: 3,
      unmeasuredRows: 0,
    });
    assert.equal(
      state,
      SyncLaneDrainState.DrainedWithDeadLetters,
      "an empty queue whose rows were ABANDONED is gave-up, not caught-up"
    );
    assert.equal(
      isLaneFullySynced(lane({ state, deadLetteredCount: 3 })),
      false,
      "only `drained` may be reported as fully synced"
    );
  });

  it("distinguishes idle-not-running from drained", () => {
    const idle = classifyLaneDrainState({
      started: true,
      gateOpen: false,
      resumeBlocked: false,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      itemsRemaining: 0,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    });
    const drained = classifyLaneDrainState({
      started: true,
      gateOpen: true,
      resumeBlocked: false,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      itemsRemaining: 0,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    });
    assert.equal(idle, SyncLaneDrainState.IdleNotRunning);
    assert.equal(drained, SyncLaneDrainState.Drained);
    assert.notEqual(
      idle,
      drained,
      "a lane with a shut gate has stopped trying, not caught up"
    );
    assert.equal(isLaneFullySynced(lane({ state: idle })), false);
  });

  it("distinguishes never-started from idle-not-running", () => {
    assert.equal(
      classifyLaneDrainState({
        started: false,
        gateOpen: false,
        resumeBlocked: false,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        itemsRemaining: 0,
        deadLetteredCount: 0,
        unmeasuredRows: 0,
      }),
      SyncLaneDrainState.NeverStarted
    );
  });

  it("decides liveness before queue depth so a shut gate cannot read as drained", () => {
    assert.equal(
      classifyLaneDrainState({
        started: true,
        gateOpen: false,
        resumeBlocked: false,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        itemsRemaining: 12,
        deadLetteredCount: 4,
        unmeasuredRows: 0,
      }),
      SyncLaneDrainState.IdleNotRunning
    );
  });

  it("never reports an UNMEASURABLE remainder as caught up", () => {
    // The ISS-5387 review case: a gate-open cursor sweep mid-backfill reported
    // `null` remaining, `null` collapsed to zero, and the lane landed in
    // `drained` — which is what let ALL LANES FULLY SYNCED print during a first
    // backfill. Unknown is not zero.
    const state = classifyLaneDrainState({
      started: true,
      gateOpen: true,
      resumeBlocked: false,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      itemsRemaining: null,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    });
    assert.equal(state, SyncLaneDrainState.RemainingUnknown);
    assert.equal(isLaneFullySynced(lane({ state })), false);
  });

  it("never reports a lane holding unclassifiable rows as caught up", () => {
    const state = classifyLaneDrainState({
      started: true,
      gateOpen: true,
      resumeBlocked: false,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      itemsRemaining: 0,
      deadLetteredCount: 0,
      unmeasuredRows: 3,
    });
    assert.equal(state, SyncLaneDrainState.RemainingUnknown);
    assert.equal(isLaneFullySynced(lane({ state })), false);
  });

  it("never claims the queue emptied while the resume is blocked, for any settled count", () => {
    // ISS-9823. The cheap alternative this rejected — having the reporter pass
    // `itemsRemaining: null` for a blocked session lane — answers correctly for
    // a clean empty queue and gets the dead-letter row wrong: the dead-letter
    // check runs BEFORE the null-remainder check, so a device that also gave up
    // on some sessions would still report `drained_with_dead_letters`, which
    // claims the queue emptied. Reading the flag ahead of EVERY branch that
    // makes that claim is what makes the answer uniform.
    const counts: {
      itemsRemaining: number | null;
      deadLetteredCount: number;
    }[] = [
      { itemsRemaining: 0, deadLetteredCount: 0 },
      { itemsRemaining: 0, deadLetteredCount: 3 },
      { itemsRemaining: null, deadLetteredCount: 0 },
    ];
    for (const combination of counts) {
      assert.equal(
        classifyLaneDrainState({
          started: true,
          gateOpen: true,
          resumeBlocked: true,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
          itemsRemaining: combination.itemsRemaining,
          deadLetteredCount: combination.deadLetteredCount,
          unmeasuredRows: 0,
        }),
        SyncLaneDrainState.RemainingUnknown,
        `expected ${JSON.stringify(combination)} to be remaining_unknown`
      );
    }
  });

  it("keeps a blocked lane with a MEASURED backlog answering draining", () => {
    // ISS-9823 review: the position of the blocked-resume check is what this
    // pins, and reading it ahead of this count is the regression. `draining` on
    // both samples is the whole precondition of `detectNoProgressStall` and of
    // the reporter's `zeroWorkSamples` tally, so a wedged device still holding
    // rows must keep reporting `draining` — otherwise the monitored
    // `sync.durable_cursor.stalled` error that already covers it can never fire
    // again, and this ticket costs an alert instead of adding one.
    for (const deadLetteredCount of [0, 3]) {
      assert.equal(
        classifyLaneDrainState({
          started: true,
          gateOpen: true,
          resumeBlocked: true,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
          itemsRemaining: 12,
          deadLetteredCount,
          unmeasuredRows: 0,
        }),
        SyncLaneDrainState.Draining,
        `expected a blocked lane holding 12 row(s) with ${deadLetteredCount} dead letter(s) to stay draining`
      );
    }
  });

  it("leaves a shut gate answering idle_not_running even with a blocked resume", () => {
    // The ordering the cases above must not have disturbed: liveness still
    // decides first, and a lane that has stopped trying reports that it stopped
    // rather than that its resume is wedged. Without this, moving the new check
    // one line earlier would go unnoticed.
    assert.equal(
      classifyLaneDrainState({
        started: true,
        gateOpen: false,
        resumeBlocked: true,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        itemsRemaining: 0,
        deadLetteredCount: 0,
        unmeasuredRows: 0,
      }),
      SyncLaneDrainState.IdleNotRunning
    );
  });

  it("still reports a fully measured, empty, gate-open lane as drained", () => {
    // The guard above must not swallow the one state that means caught up.
    assert.equal(
      classifyLaneDrainState({
        started: true,
        gateOpen: true,
        resumeBlocked: false,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        itemsRemaining: 0,
        deadLetteredCount: 0,
        unmeasuredRows: 0,
      }),
      SyncLaneDrainState.Drained
    );
  });
});

describe("sync burn-down bounded-probe honesty", () => {
  it("prints a capped item count as a floor, never as an exact number", () => {
    const line = formatLaneBurndownLine(
      lane({
        lane: SyncLaneId.InvocationParts,
        itemsRemaining: 200,
        itemsRemainingIsLowerBound: true,
      })
    );
    // A 3,500-session backlog must not read as `items=200`.
    assert.match(line, LOWER_BOUND_ITEMS_RE);
    assert.equal(EXACT_200_ITEMS_RE.test(line), false);
  });

  it("prints an exact count bare when the probe did not cap", () => {
    const line = formatLaneBurndownLine(
      lane({ itemsRemaining: 200, itemsRemainingIsLowerBound: false })
    );
    assert.match(line, EXACT_200_ITEMS_RE);
  });

  it("surfaces unclassifiable rows on the lane line", () => {
    assert.match(
      formatLaneBurndownLine(lane({ unmeasuredRows: 7 })),
      UNMEASURED_RE
    );
  });
});

describe("sync burn-down cursor-stall detection", () => {
  function stallLane(overrides: Partial<SyncLaneBurndown>): SyncLaneBurndown {
    return lane({
      lane: SyncLaneId.SessionMetadata,
      tracksDurableCursor: true,
      workCompletedSincePrevious: 5,
      ...overrides,
    });
  }

  it("does NOT cry stall while the lane's own queue is draining", () => {
    // The session lane holds its watermark at the acked-contiguous prefix
    // boundary, and during a historical backfill the watermark is already parked
    // at the corpus maximum (FEA-3473) — which ISS-8041's never-move-backwards
    // refusal keeps it at. Accepted batches there cannot move it, so a motionless
    // cursor beside a SHRINKING queue is normal progress, not the ISS-5347 freeze.
    const previous = stallLane({
      itemsRemaining: 400,
      workCompletedSincePrevious: 0,
    });
    const current = stallLane({ itemsRemaining: 250 });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("cries stall when work completed, the queue did not move, and neither did the cursor", () => {
    const previous = stallLane({
      itemsRemaining: 0,
      workCompletedSincePrevious: 0,
    });
    const current = stallLane({ itemsRemaining: 0 });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("cries stall when the cursor is REWRITTEN at the same stale position", () => {
    // `sqliteAdvanceSyncState` stamps `updated_at` on every call whether or not
    // the watermark moved, so a fresh write timestamp is evidence of an ATTEMPT,
    // not of recorded progress. Keying on it would miss a lane re-persisting the
    // same position forever.
    const previous = stallLane({
      itemsRemaining: 0,
      workCompletedSincePrevious: 0,
      durableCursorValue: "2026-08-06T10:00:00.000Z",
      durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
    });
    const current = stallLane({
      itemsRemaining: 0,
      durableCursorValue: "2026-08-06T10:00:00.000Z",
      durableCursorWrittenAtIso: "2026-08-06T10:05:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("ISS-7401: a cleared-row count ALONE does NOT suppress the stall", () => {
    // PR #5915 removed a suppression that trusted this count on its own. Under
    // ISS-10429 the count suppresses only when the cursor boundary moved
    // forward too, and this fixture names no boundary on either side, so every
    // count here still stalls.
    const previous = stallLane({
      itemsRemaining: 120,
      workCompletedSincePrevious: 0,
    });
    for (const reported of [40, 0, null]) {
      const current = stallLane({
        itemsRemaining: 120,
        queueRowsClearedSincePrevious: reported,
      });
      assert.equal(
        detectCursorStall({ previous, current }),
        true,
        `a flat-depth frozen cursor still stalls with cleared=${reported}`
      );
    }
  });

  it("ISS-7401: a genuine drain still suppresses, on the store-read depth", () => {
    // The distinction the case above turns on: net depth actually shrinking IS
    // independent evidence, and still silences the detector. Without this, the
    // change above could be satisfied by a detector that never suppresses.
    const previous = stallLane({
      itemsRemaining: 120,
      workCompletedSincePrevious: 0,
    });
    const current = stallLane({
      itemsRemaining: 80,
      queueRowsClearedSincePrevious: null,
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("stays quiet once the cursor actually advances", () => {
    const previous = stallLane({
      itemsRemaining: 0,
      workCompletedSincePrevious: 0,
      durableCursorValue: "2026-08-06T10:00:00.000Z",
    });
    const current = stallLane({
      itemsRemaining: 0,
      durableCursorValue: "2026-08-06T10:04:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });
});

describe("sync burn-down all-lanes verdict", () => {
  it("requires EVERY lane to qualify", () => {
    const lanes = [
      lane({ lane: SyncLaneId.SessionMetadata }),
      lane({
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.DrainedWithDeadLetters,
        deadLetteredCount: 2,
      }),
    ];
    assert.equal(areAllLanesFullySynced(lanes), false);
    const line = formatAllLanesVerdictLine(lanes);
    assert.match(line, CONTRACT_RE_1);
    assert.match(line, CONTRACT_RE_2);
    assert.doesNotMatch(
      line,
      CONTRACT_RE_3,
      "one disqualified lane must suppress the clean verdict entirely"
    );
  });

  it("emits the unambiguous verdict only when every lane is drained", () => {
    const lanes = [
      lane({ lane: SyncLaneId.SessionMetadata }),
      lane({ lane: SyncLaneId.InvocationParts }),
    ];
    assert.equal(areAllLanesFullySynced(lanes), true);
    assert.match(formatAllLanesVerdictLine(lanes), CONTRACT_RE_3);
  });

  it("does not call an empty lane set fully synced", () => {
    assert.equal(areAllLanesFullySynced([]), false);
  });
});

describe("sync burn-down cursor-stall detection", () => {
  it("flags a lane completing work while its durable cursor stands still", () => {
    // The ISS-5347 shape: uploads keep succeeding, the persisted cursor does not
    // move, and nothing else in the lane reports a failure.
    const frozen = {
      durableCursorValue: "2026-08-03T20:56:53.196Z",
      durableCursorWrittenAtIso: "2026-08-03T20:57:50.000Z",
    };
    const previous = lane({
      lane: SyncLaneId.ComponentInventory,
      ...frozen,
      workCompletedSincePrevious: 40,
    });
    const current = lane({
      lane: SyncLaneId.ComponentInventory,
      ...frozen,
      workCompletedSincePrevious: 37,
    });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("does not flag a quiet lane whose cursor simply has nothing to record", () => {
    const previous = lane({ workCompletedSincePrevious: 0 });
    const current = lane({ workCompletedSincePrevious: 0 });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("does not flag a lane whose cursor advanced", () => {
    const previous = lane({
      durableCursorValue: "2026-08-06T09:00:00.000Z",
      durableCursorWrittenAtIso: "2026-08-06T09:00:01.000Z",
      workCompletedSincePrevious: 5,
    });
    const current = lane({
      durableCursorValue: "2026-08-06T10:00:00.000Z",
      durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
      workCompletedSincePrevious: 5,
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("flags a lane doing work that has NEVER persisted a cursor", () => {
    // `buildComponentCursorPersist(null)` returning undefined: not a frozen
    // cursor, an absent one — and just as invisible.
    const previous = lane({
      durableCursorValue: null,
      durableCursorWrittenAtIso: null,
      workCompletedSincePrevious: 12,
    });
    const current = lane({
      durableCursorValue: null,
      durableCursorWrittenAtIso: null,
      workCompletedSincePrevious: 12,
    });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("does not flag a lane that keeps no durable cursor by design", () => {
    // The invocation-parts and transcript lanes hold their durable position
    // elsewhere. Reading their permanent absence of a `sync_state` row as a
    // stall would fire on every drain and train operators to ignore the alert.
    const shape = {
      lane: SyncLaneId.TranscriptArchive,
      tracksDurableCursor: false,
      durableCursorValue: null,
      durableCursorWrittenAtIso: null,
      workCompletedSincePrevious: 12,
    };
    assert.equal(
      detectCursorStall({ previous: lane(shape), current: lane(shape) }),
      false
    );
  });

  it("returns false with no previous sample to compare against", () => {
    assert.equal(
      detectCursorStall({ previous: null, current: lane() }),
      false,
      "a first sample cannot prove a cursor failed to move"
    );
  });
});

describe("sync burn-down unmeasured inputs", () => {
  const FROZEN_CURSOR = {
    durableCursorValue: "2026-08-06T10:00:00.000Z",
    durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
  };

  it("does not cry stall when the pass reported NO work count at all", () => {
    // `workCompletedSincePrevious: null` is "not measured", not "did work".
    // Reading an unmeasured pass as activity would fire the stall warning on
    // every sampler gap — beside a cursor that is legitimately standing still
    // because nothing happened.
    const previous = lane({
      ...FROZEN_CURSOR,
      workCompletedSincePrevious: null,
    });
    const current = lane({
      ...FROZEN_CURSOR,
      workCompletedSincePrevious: null,
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("does not read an UNKNOWN queue depth as a drain, so a frozen cursor still cries stall", () => {
    // `itemsRemaining: null` means the bounded probe could not answer, not that
    // the queue shrank. Treating unknown as progress would silence the warning
    // on exactly the mid-backfill passes where the depth probe gives up.
    const previousUnknown = lane({
      ...FROZEN_CURSOR,
      itemsRemaining: null,
      workCompletedSincePrevious: 9,
    });
    const currentMeasured = lane({
      ...FROZEN_CURSOR,
      itemsRemaining: 250,
      workCompletedSincePrevious: 9,
    });
    assert.equal(
      detectCursorStall({
        previous: previousUnknown,
        current: currentMeasured,
      }),
      true,
      "unknown → 250 is not a proven drain"
    );
    assert.equal(
      detectCursorStall({
        previous: currentMeasured,
        current: previousUnknown,
      }),
      true,
      "250 → unknown is not a proven drain either"
    );
  });

  it("names an ABSENT cursor as none on the stall line", () => {
    // The `buildComponentCursorPersist(null)` lane: it has never written a
    // position at all. The line has to say so in words an operator can act on,
    // not leak the nullish value into the persisted gateway log.
    const line = formatCursorStallLine(
      lane({ durableCursorValue: null, workCompletedSincePrevious: 12 })
    );
    assert.match(line, STALL_ABSENT_CURSOR_RE);
    assert.doesNotMatch(line, STALL_NULLISH_CURSOR_RE);
  });
});

/**
 * ISS-5973: the no-progress detector — a lane that is RUNNING with a live
 * backlog and completing nothing.
 *
 * The fixture carries the STALLING condition on purpose: a `Draining` lane (which
 * by construction means running, with items still owed) reporting zero completed
 * work, sampled repeatedly. A healthy-queue fixture passes against the unfixed
 * code and proves nothing.
 */
describe("ISS-5973 no-progress lane stall", () => {
  const draining = (overrides: Partial<SyncLaneBurndown> = {}) =>
    lane({
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 2928,
      workCompletedSincePrevious: 0,
      ...overrides,
    });

  it("fires once the zero-work samples reach the threshold", () => {
    const previous = draining();
    const current = draining();
    assert.equal(
      detectNoProgressStall({
        previous,
        current,
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES,
      }),
      true
    );
  });

  it("does not fire before the threshold, so one quiet interval is not an alert", () => {
    assert.equal(
      detectNoProgressStall({
        previous: draining(),
        current: draining(),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES - 1,
      }),
      false
    );
  });

  it("does not fire when the lane completed work", () => {
    assert.equal(
      detectNoProgressStall({
        previous: draining(),
        current: draining({ workCompletedSincePrevious: 1 }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("does not fire for a lane that is gated off rather than stalled", () => {
    // `idle_not_running` is a CLOSED GATE — a different defect with a different
    // owner. Reporting it here would bury the real no-progress signal in noise.
    assert.equal(
      detectNoProgressStall({
        previous: draining({ state: SyncLaneDrainState.IdleNotRunning }),
        current: draining({ state: SyncLaneDrainState.IdleNotRunning }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("does not fire on a drained lane", () => {
    assert.equal(
      detectNoProgressStall({
        previous: lane(),
        current: lane(),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("does not fire when the whole backlog is inside its backoff window", () => {
    // `protocol_unavailable` defers invocation parts for five minutes and the
    // reporter samples every minute, so a routine outage clears the three-sample
    // threshold on its own. Nothing is ELIGIBLE, so completing nothing is the
    // schedule working — not a lane refusing to work a live queue.
    assert.equal(
      detectNoProgressStall({
        previous: draining({ readyItemsRemaining: 0 }),
        current: draining({ readyItemsRemaining: 0 }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("still fires when the backlog is eligible and simply not being worked", () => {
    // The measured incident: 2,928 rows with `next_attempt_at` NULL — every one
    // of them ready — and not a single attempt across two days.
    assert.equal(
      detectNoProgressStall({
        previous: draining({ readyItemsRemaining: 2928 }),
        current: draining({ readyItemsRemaining: 2928 }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES,
      }),
      true
    );
  });

  it("treats a shrinking durable byte remainder as progress", () => {
    // The transcript lane: an archive upload advances `synced_byte_offset` on a
    // file that is STILL in flight, so the in-flight FILE count — and with it
    // this lane's `workCompletedSincePrevious` — does not move while megabytes
    // are landing. Alerting here says "local data is not reaching the cloud"
    // about the delivery in progress.
    assert.equal(
      detectNoProgressStall({
        previous: draining({
          lane: SyncLaneId.TranscriptArchive,
          bytesRemaining: 8_000_000,
        }),
        current: draining({
          lane: SyncLaneId.TranscriptArchive,
          bytesRemaining: 5_000_000,
        }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("treats a shrinking item queue as progress", () => {
    assert.equal(
      detectNoProgressStall({
        previous: draining({ itemsRemaining: 2928 }),
        current: draining({ itemsRemaining: 2900 }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES + 10,
      }),
      false
    );
  });

  it("still fires when bytes went on the wire but the durable remainder did not move", () => {
    // Re-send amplification: one growing session uploaded whole, over and over.
    // Bytes on the WIRE are not progress — nothing was retired — so reading
    // `bytesSentSincePrevious` instead of the remainder would suppress the exact
    // failure this detector exists for.
    assert.equal(
      detectNoProgressStall({
        previous: draining({ bytesRemaining: 8_000_000 }),
        current: draining({
          bytesRemaining: 8_000_000,
          bytesSentSincePrevious: 4_000_000,
        }),
        consecutiveZeroWorkSamples: NO_PROGRESS_STALL_SAMPLES,
      }),
      true
    );
  });

  it("names the owed backlog in the warning line", () => {
    const line = formatNoProgressStallLine(draining());
    assert.match(line, NO_PROGRESS_LINE_RE);
    assert.match(line, NO_PROGRESS_ITEMS_RE);
  });

  it("reports an unmeasurable backlog as unknown, never a fabricated zero", () => {
    assert.match(
      formatNoProgressStallLine(draining({ itemsRemaining: null })),
      NO_PROGRESS_UNKNOWN_RE
    );
  });
});

const PARKED_TWO_RE = / parked=2$/;
const PARKED_ANY_RE = /parked=/;

describe("ISS-7096 parked-partition visibility", () => {
  it("carries parked depth only when measured and non-zero", () => {
    assert.match(
      formatLaneBurndownLine(lane({ parkedCount: 2 })),
      PARKED_TWO_RE
    );
    assert.doesNotMatch(
      formatLaneBurndownLine(lane({ parkedCount: 0 })),
      PARKED_ANY_RE
    );
    // Absent (an older main process): unknown is not zero, and not printed.
    assert.doesNotMatch(formatLaneBurndownLine(lane({})), PARKED_ANY_RE);
  });
});

const WITHHELD_THREE_RE = /withheld=3/;
const WITHHELD_ANY_RE = /withheld=/;
const ITEMS_TWO_RE = /items=2/;

describe("ISS-7246 withheld visibility", () => {
  it("carries withheld depth only when measured and non-zero", () => {
    assert.match(
      formatLaneBurndownLine(lane({ withheldCount: 3 })),
      WITHHELD_THREE_RE
    );
    assert.doesNotMatch(
      formatLaneBurndownLine(lane({ withheldCount: 0 })),
      WITHHELD_ANY_RE
    );
    assert.doesNotMatch(formatLaneBurndownLine(lane({})), WITHHELD_ANY_RE);
  });

  it("reports withheld work beside owed work without inflating it", () => {
    const line = formatLaneBurndownLine(
      lane({ itemsRemaining: 2, withheldCount: 3 })
    );
    // The whole point of the split: a phantom-heavy install stays legible
    // WITHOUT its phantoms being counted as work anyone is waiting on.
    assert.match(line, ITEMS_TWO_RE);
    assert.match(line, WITHHELD_THREE_RE);
  });
});

/**
 * ISS-8768: the detector for a lane whose gate is SHUT while the machine is
 * consented to deliver — the case {@link detectNoProgressStall} names as "a
 * different defect with a different owner" and deliberately does not cover.
 */
describe("detectGatedBacklogStall (ISS-8768)", () => {
  const gated = (overrides: Partial<SyncLaneBurndown> = {}) =>
    lane({
      state: SyncLaneDrainState.IdleNotRunning,
      itemsRemaining: 985,
      ...overrides,
    });

  it("fires for a consented, gated lane sitting on a backlog at the threshold", () => {
    assert.equal(
      detectGatedBacklogStall({
        previous: gated(),
        current: gated(),
        deliveryConsented: true,
        consecutiveGatedSamples: GATE_SHUT_STALL_SAMPLES,
      }),
      true
    );
  });

  it("does not fire below the threshold", () => {
    assert.equal(
      detectGatedBacklogStall({
        previous: gated(),
        current: gated(),
        deliveryConsented: true,
        consecutiveGatedSamples: GATE_SHUT_STALL_SAMPLES - 1,
      }),
      false,
      "a gate is legitimately shut for the first moments of a launch"
    );
  });

  it("does not fire when the machine is not consented to deliver", () => {
    assert.equal(
      detectGatedBacklogStall({
        previous: gated(),
        current: gated(),
        deliveryConsented: false,
        consecutiveGatedSamples: GATE_SHUT_STALL_SAMPLES,
      }),
      false,
      "a shut gate is the correct state for a deliberately-local install"
    );
  });

  it("does not fire on an UNKNOWN remainder", () => {
    assert.equal(
      detectGatedBacklogStall({
        previous: gated({ itemsRemaining: null }),
        current: gated({ itemsRemaining: null }),
        deliveryConsented: true,
        consecutiveGatedSamples: GATE_SHUT_STALL_SAMPLES,
      }),
      false,
      "an unmeasured queue is not evidence of a backlog; paging on it would fire on a probe failure"
    );
  });

  it("does not fire for a lane that is running", () => {
    assert.equal(
      detectGatedBacklogStall({
        previous: gated({ state: SyncLaneDrainState.Draining }),
        current: gated({ state: SyncLaneDrainState.Draining }),
        deliveryConsented: true,
        consecutiveGatedSamples: GATE_SHUT_STALL_SAMPLES,
      }),
      false,
      "a running lane that is stuck is detectNoProgressStall's case, not this one"
    );
  });
});
