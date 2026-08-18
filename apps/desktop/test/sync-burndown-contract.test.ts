import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  areAllLanesFullySynced,
  classifyLaneDrainState,
  detectCursorStall,
  detectNoProgressStall,
  formatAllLanesVerdictLine,
  formatCursorStallLine,
  formatLaneBurndownLine,
  formatLaneFullySyncedLine,
  formatNoProgressStallLine,
  isLaneFullySynced,
  NO_PROGRESS_STALL_SAMPLES,
  OldestPendingBasis,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

const CONTRACT_RE_1 = /not fully synced/;
const CONTRACT_RE_2 = /transcript_archive=drained_with_dead_letters/;
const CONTRACT_RE_3 = /ALL LANES FULLY SYNCED/;
const CONTRACT_RE_4 = /items=12/;
const CONTRACT_RE_5 = /bytes=3\.0MiB/;
const CONTRACT_RE_6 = /chunks=n\/a/;
const CONTRACT_RE_7 = /deadLettered=2/;
const CONTRACT_RE_8 = /oldestPending=1h \(last_state_change\)/;
const CONTRACT_RE_9 = /sent=1\.0MiB/;
const CONTRACT_RE_10 = /items=n\/a/;
const CONTRACT_RE_11 = /bytes=unknown/;
const CONTRACT_RE_12 = /bytes=0B/;
const CONTRACT_RE_13 = /fully synced/;
const CONTRACT_RE_14 = /0 remaining, 0 dead-lettered/;
const LOWER_BOUND_ITEMS_RE = /items=>=200/;
const EXACT_200_ITEMS_RE = /items=200\b/;
const UNMEASURED_RE = /unmeasured=7/;
const GIB_BYTES_RE = /bytes=2\.50GiB/;
const MIB_BYTES_RE = /MiB/;
const STALL_ABSENT_CURSOR_RE = /stayed at none\b/;
const STALL_NULLISH_CURSOR_RE = /stayed at (?:null|undefined)/;
const NO_PROGRESS_LINE_RE = /LANE NOT DRAINING/;
const NO_PROGRESS_ITEMS_RE = /2928 item\(s\) still owed/;
const NO_PROGRESS_UNKNOWN_RE = /unknown item\(s\) still owed/;

function lane(overrides: Partial<SyncLaneBurndown> = {}): SyncLaneBurndown {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: null,
    unmeasuredRows: 0,
    bytesRemaining: 0,
    chunksRemaining: 0,
    deadLetteredCount: 0,
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

describe("sync burn-down lane classification", () => {
  it("never reports a lane with dead-lettered items as fully synced", () => {
    const state = classifyLaneDrainState({
      started: true,
      gateOpen: true,
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
      itemsRemaining: 0,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    });
    const drained = classifyLaneDrainState({
      started: true,
      gateOpen: true,
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
      itemsRemaining: 0,
      deadLetteredCount: 0,
      unmeasuredRows: 3,
    });
    assert.equal(state, SyncLaneDrainState.RemainingUnknown);
    assert.equal(isLaneFullySynced(lane({ state })), false);
  });

  it("still reports a fully measured, empty, gate-open lane as drained", () => {
    // The guard above must not swallow the one state that means caught up.
    assert.equal(
      classifyLaneDrainState({
        started: true,
        gateOpen: true,
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
    // The session lane deliberately withholds its watermark until both queues
    // are empty (the acked-contiguous rule), and during a historical backfill
    // the watermark is already parked at the corpus maximum. Accepted batches
    // there cannot move it, so a motionless cursor beside a SHRINKING queue is
    // normal progress, not the ISS-5347 freeze.
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

describe("sync burn-down log lines", () => {
  it("carries counts, sizes, ages, and the durable cursor — and no content", () => {
    const line = formatLaneBurndownLine(
      lane({
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 12,
        bytesRemaining: 3_145_728,
        chunksRemaining: null,
        deadLetteredCount: 2,
        oldestPendingAgeMs: 90 * 60 * 1000,
        oldestPendingBasis: OldestPendingBasis.LastStateChange,
        workCompletedSincePrevious: 4,
        bytesSentSincePrevious: 1_048_576,
      })
    );
    assert.match(line, CONTRACT_RE_4);
    assert.match(line, CONTRACT_RE_5);
    assert.match(line, CONTRACT_RE_6);
    assert.match(line, CONTRACT_RE_7);
    assert.match(line, CONTRACT_RE_8);
    assert.match(line, CONTRACT_RE_9);
  });

  it("prints an unmeasurable quantity as unknown rather than zero", () => {
    const line = formatLaneBurndownLine(
      lane({ bytesRemaining: null, itemsRemaining: null })
    );
    assert.match(line, CONTRACT_RE_10);
    assert.match(line, CONTRACT_RE_11);
    assert.doesNotMatch(
      line,
      CONTRACT_RE_12,
      "a fabricated zero is the reassuring lie this burn-down exists to stop"
    );
  });

  it("states zero remaining AND zero dead-lettered on the fully-synced line", () => {
    const line = formatLaneFullySyncedLine(lane());
    assert.match(line, CONTRACT_RE_13);
    assert.match(line, CONTRACT_RE_14);
  });

  it("scales a multi-gigabyte remainder to GiB, not a five-digit MiB count", () => {
    // A first backfill routinely owes gigabytes. `2621440.0MiB` is technically
    // true and operationally unreadable, which is how a burn-down line stops
    // being read at all.
    const line = formatLaneBurndownLine(
      lane({ bytesRemaining: 2.5 * 1024 ** 3 })
    );
    assert.match(line, GIB_BYTES_RE);
    assert.doesNotMatch(line, MIB_BYTES_RE);
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
