/**
 * @file transcript-analysis-eta.test.ts
 * @description ISS-8507 — the estimate's lifecycle: when it may state a number,
 * when it must refuse, and what a suspended or silent lane is allowed to say.
 *
 * Revision handling, rebasing and the published number live in the sibling
 * suite. Every interruption is covered symmetrically - each pause case has a
 * failure twin, and the anchor is driven as a table over every exit - because
 * these branches share one rule and a rule proved on one branch is not proved
 * on the others.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type AnalysisEtaFold,
  createAnalysisEta,
  DEFAULT_ANALYSIS_ETA_POLICY,
} from "../src/main/transcript-sync/transcript-analysis-eta.js";
import { TranscriptInventoryCompleteness } from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { ByteProgressKind } from "../src/main/transcript-sync/transcript-byte-progress.js";
import { IMPORT_NO_MOVEMENT_GIVE_UP_MS } from "../src/shared/historical-import-bounds.js";
import {
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
  AnalysisParserActivity,
} from "../src/shared/transcript-analysis-eta-contract.js";
import {
  BOUND_REVISION,
  BROKEN_CLOCK_MODES,
  drive,
  expectMeasured,
  inventory,
  LARGE_TOTAL,
  MODEST_TOTAL,
  reasonOf,
  reportFailed,
  reportPaused,
  reportRunning,
  testClock,
  WARM_BYTES,
  WARM_MS,
  WARM_RATE,
  warmToMeasured,
} from "./transcript-analysis-eta-fixtures.js";

test("a fold whose parse lane measured only some of the corpus starts calculating", () => {
  // ISS-8346 ruling 2026-09-04: partial measures over the bytes it did see, so
  // the estimate starts exactly where a complete lane starts.
  const fold = createAnalysisEta(
    inventory({ parseCompleteness: TranscriptInventoryCompleteness.Partial })
  );

  assert.equal(fold.current().kind, AnalysisEtaKind.Calculating);
});

test("a fold whose parse lane measured nothing at all starts indeterminate", () => {
  const fold = createAnalysisEta(
    inventory({
      parseCompleteness: TranscriptInventoryCompleteness.Unavailable,
    })
  );
  assert.equal(fold.current().kind, AnalysisEtaKind.Unavailable);
  assert.equal(
    reasonOf(fold.current()),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
});

test("a short parse lane holding zero eligible bytes starts indeterminate, not complete", () => {
  // The ISS-8346 ruling of 2026-09-04 covers a lane where bytes WERE measured.
  // None were here and something was missed, so `complete` would tell a user
  // the analysis had finished on a machine whose only probe failed.
  const fold = createAnalysisEta(
    inventory({
      eligibleParseBytes: 0,
      parseCompleteness: TranscriptInventoryCompleteness.Partial,
    })
  );

  assert.equal(fold.current().kind, AnalysisEtaKind.Unavailable);
  assert.equal(
    reasonOf(fold.current()),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
});

test("a short parse lane reconciles with the inventory and reaches a measured estimate", () => {
  // The `parse.totalBytes !== inventory.eligibleParseBytes` guard is what would
  // silently re-close the ISS-8346 ruling: partial now states
  // `eligibleParseBytes` as its total, so the two agree and the fold measures.
  const clock = testClock();
  const fold = createAnalysisEta(
    inventory({ parseCompleteness: TranscriptInventoryCompleteness.Partial }),
    { clock: clock.clock }
  );

  const { state } = drive(fold, clock, {
    sampleCount: 7,
    totalBytes: MODEST_TOTAL,
  });

  assert.equal(state.kind, AnalysisEtaKind.Measured);
  assert.equal(expectMeasured(state).throughputBytesPerMs, WARM_RATE);
});

test("a complete inventory with nothing to parse starts complete", () => {
  const fold = createAnalysisEta(inventory({ eligibleParseBytes: 0 }));
  assert.equal(fold.current().kind, AnalysisEtaKind.Complete);
});

test("an ordinary fold starts calculating, never measured with a zero", () => {
  const state = createAnalysisEta(inventory()).current();
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
  assert.equal("remainingMs" in state, false);
});

test("the first running report is calculating and carries no remaining time", () => {
  const clock = testClock();
  const fold = createAnalysisEta(inventory(), { clock: clock.clock });
  const state = reportRunning(fold, 0);
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
  assert.equal("remainingMs" in state, false);
});

test("the sample floor alone does not open the gate", () => {
  const clock = testClock();
  const fold = createAnalysisEta(inventory(), { clock: clock.clock });
  // Seven samples clears the sample floor, but 7 ms of span is far under 2000.
  const { state } = drive(fold, clock, {
    msPerReport: 1,
    sampleCount: 7,
    totalBytes: MODEST_TOTAL,
  });
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
});

test("the span floor alone does not open the gate", () => {
  const clock = testClock();
  const fold = createAnalysisEta(inventory(), { clock: clock.clock });
  // Five samples span 3000 ms but leave only three retained, under the floor.
  const { state } = drive(fold, clock, {
    msPerReport: 1000,
    sampleCount: 5,
    totalBytes: MODEST_TOTAL,
  });
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
});

test("count and time alone cannot publish a thirty-year estimate", () => {
  const clock = testClock();
  const total = 2_400_000_000;
  const fold = createAnalysisEta(inventory({ eligibleParseBytes: total }), {
    clock: clock.clock,
  });
  // Seven one-byte samples over 2800 ms clear the sample and span floors and
  // give a rate of 0.0025 B/ms, which against 2.4 GB extrapolates to about
  // thirty years. Refusing it is the whole point of the byte-volume floor.
  const { state } = drive(fold, clock, {
    bytesPerReport: 1,
    msPerReport: 400,
    sampleCount: 7,
    totalBytes: total,
  });
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
});

test("the byte-volume floor is REACHABLE at file-sized deltas", () => {
  const clock = testClock();
  const total = 2_400_000_000;
  const fold = createAnalysisEta(inventory({ eligibleParseBytes: total }), {
    clock: clock.clock,
  });
  // 17 samples of 64 KiB is 1,114,112 lifetime bytes, past the mebibyte floor.
  // Measured on the RETAINED window instead, this can never pass: the window
  // keeps 16, the trim drops 2, and 14 x 64 KiB is 917,504 — under the floor
  // for ever, leaving the estimate stuck at calculating.
  const { state } = drive(fold, clock, {
    bytesPerReport: 65_536,
    msPerReport: 200,
    sampleCount: 17,
    totalBytes: total,
  });
  assert.equal(state.kind, AnalysisEtaKind.Measured);
});

test("the byte-volume floor is clamped so a small corpus is representable", () => {
  const clock = testClock();
  const total = 700_000;
  const fold = createAnalysisEta(inventory({ eligibleParseBytes: total }), {
    clock: clock.clock,
  });
  // An absolute mebibyte floor is larger than this entire corpus. Clamped to
  // half of it, seven 50,000-byte samples clear it.
  const { state } = drive(fold, clock, {
    bytesPerReport: 50_000,
    sampleCount: 7,
    totalBytes: total,
  });
  assert.equal(state.kind, AnalysisEtaKind.Measured);
});

test("the retained floor of five needs SEVEN accepted samples, not five", () => {
  // The decision table's post-trim boundary, at the FOLD rather than only at the
  // window: the trim drops two, so six accepted leaves four retained and states
  // nothing, and the seventh is the first report that may publish.
  const clock = testClock();
  const fold = createAnalysisEta(inventory(), { clock: clock.clock });
  const six = drive(fold, clock, { sampleCount: 6, totalBytes: MODEST_TOTAL });
  assert.equal(six.state.kind, AnalysisEtaKind.Calculating);

  clock.advance(WARM_MS);
  const seventh = reportRunning(fold, six.processedBytes + WARM_BYTES);
  assert.equal(seventh.kind, AnalysisEtaKind.Measured);
  assert.equal(expectMeasured(seventh).retainedSampleCount, 5);
});

test("retainedSampleCount reports the trimmed set, not everything accepted", () => {
  const clock = testClock();
  const fold = createAnalysisEta(inventory(), { clock: clock.clock });
  const { state } = drive(fold, clock, {
    sampleCount: 9,
    totalBytes: MODEST_TOTAL,
  });
  // Nine accepted, two trimmed: the number the rate actually rests on is seven.
  assert.equal(expectMeasured(state).retainedSampleCount, 7);
});

test("a single fast outlier barely moves the published estimate", () => {
  const clock = testClock();
  const fold = createAnalysisEta(
    inventory({ eligibleParseBytes: LARGE_TOTAL }),
    { clock: clock.clock }
  );
  const warm = drive(fold, clock, { sampleCount: 7, totalBytes: LARGE_TOTAL });
  const before = expectMeasured(warm.state);

  clock.advance(WARM_MS);
  const burst = reportRunning(
    fold,
    warm.processedBytes + WARM_BYTES * 50,
    LARGE_TOTAL
  );
  const after = expectMeasured(burst);
  // A burst fifty times the usual size is the fastest sample in the window, so
  // the trim removes it: the rate is untouched and the estimate moves only by
  // the bytes the burst genuinely consumed.
  assert.equal(after.throughputBytesPerMs, before.throughputBytesPerMs);
  assert.equal(after.remainingBytes, before.remainingBytes - WARM_BYTES * 50);
});

test("a remaining time equals its own inputs exactly", () => {
  const { fold } = warmToMeasured();
  const state = expectMeasured(fold.current());
  assert.equal(state.throughputBytesPerMs, WARM_RATE);
  assert.equal(state.remainingBytes, MODEST_TOTAL - 7 * WARM_BYTES);
  assert.equal(state.rawRemainingMs, state.remainingBytes / WARM_RATE);
  assert.equal(state.remainingMs, state.rawRemainingMs);
  assert.equal(Number.isFinite(state.remainingMs), true);
});

test("a slower lane over the same corpus yields a proportionally longer estimate", () => {
  const fast = warmToMeasured();
  const fastState = expectMeasured(fast.fold.current());

  const clock = testClock();
  const slow = createAnalysisEta(inventory(), { clock: clock.clock });
  drive(slow, clock, {
    msPerReport: WARM_MS * 2,
    sampleCount: 7,
    totalBytes: MODEST_TOTAL,
  });
  const slowState = expectMeasured(slow.current());

  // Same bytes consumed, half the rate: the same remainder, twice the time.
  assert.equal(slowState.remainingBytes, fastState.remainingBytes);
  assert.equal(slowState.throughputBytesPerMs, WARM_RATE / 2);
  assert.equal(slowState.remainingMs, fastState.remainingMs * 2);
});

test("a paused lane reports paused and carries no remaining time", () => {
  const { fold, processedBytes } = warmToMeasured();
  const state = reportPaused(fold, processedBytes);
  assert.equal(state.kind, AnalysisEtaKind.Unavailable);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Paused);
  assert.equal("remainingMs" in state, false);
});

test("a failed lane reports failed and carries no remaining time", () => {
  const { fold, processedBytes } = warmToMeasured();
  const state = reportFailed(fold, processedBytes);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Failed);
  assert.equal("remainingMs" in state, false);
});

test("a failed lane at full byte progress is failed, never complete", () => {
  const { fold } = warmToMeasured();
  const state = reportFailed(fold, MODEST_TOTAL);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Failed);
});

test("a paused lane at full byte progress is paused, never complete", () => {
  // The acceptance criterion says a paused parser does not claim completion.
  // Followed literally rather than read around: liveness sits above the byte
  // lane, so this cannot report complete however far along the bytes are.
  const { fold } = warmToMeasured();
  const state = reportPaused(fold, MODEST_TOTAL);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Paused);
});

test("a failed report with an empty parse lane still reports failed", () => {
  const { fold } = warmToMeasured();
  const state = fold.report({
    activity: AnalysisParserActivity.Failed,
    parse: { kind: ByteProgressKind.Empty },
    revision: BOUND_REVISION,
  });
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Failed);
});

test("every non-sampling exit breaks the interval chain", () => {
  // A table rather than four separate cases, so an exit added later is a
  // missing row instead of a silent hole. Each must leave the next running
  // report anchor-only: no sample, so the retained count does not move.
  // `stalled` is deliberately absent — it is the one refusal that KEEPS its
  // anchor, and its own case below pins that.
  const exits: { name: string; drive: (fold: AnalysisEtaFold) => void }[] = [
    {
      drive: (fold) => {
        reportPaused(fold, 7 * WARM_BYTES);
      },
      name: AnalysisEtaUnavailableReason.Paused,
    },
    {
      drive: (fold) => {
        reportFailed(fold, 7 * WARM_BYTES);
      },
      name: AnalysisEtaUnavailableReason.Failed,
    },
    {
      drive: (fold) => {
        fold.report({
          activity: AnalysisParserActivity.Running,
          parse: { kind: ByteProgressKind.Indeterminate },
          revision: BOUND_REVISION,
        });
      },
      name: AnalysisEtaUnavailableReason.ProgressIndeterminate,
    },
    {
      drive: (fold) => {
        reportRunning(fold, 7 * WARM_BYTES, MODEST_TOTAL, BOUND_REVISION - 1);
      },
      name: "stale-revision no-op",
    },
    {
      drive: (fold) => {
        reportRunning(fold, MODEST_TOTAL);
      },
      name: AnalysisEtaKind.Complete,
    },
  ];

  for (const exit of exits) {
    const { fold, clock, processedBytes } = warmToMeasured();
    const before = expectMeasured(fold.current()).retainedSampleCount;
    exit.drive(fold);
    clock.advance(WARM_MS);
    reportRunning(fold, processedBytes + WARM_BYTES);
    assert.equal(
      expectMeasured(fold.current()).retainedSampleCount,
      before,
      `${exit.name} must leave the next running report anchor-only`
    );
  }
});

test("a running report with a zero byte delta keeps the anchor and takes no sample", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current()).retainedSampleCount;
  clock.advance(WARM_MS);
  reportRunning(fold, processedBytes);
  assert.equal(expectMeasured(fold.current()).retainedSampleCount, before);

  // The anchor was PRESERVED, so the next advance IS sampled — against the older
  // anchor, covering both reports. Had the zero-delta report cleared it, this
  // one would be anchor-only and the retained count would not move at all.
  clock.advance(WARM_MS);
  reportRunning(fold, processedBytes + WARM_BYTES);
  assert.equal(expectMeasured(fold.current()).retainedSampleCount, before + 1);
});

test("a lane reporting regularly with no progress still reaches stalled", () => {
  // The zero-delta report must move neither the anchor nor the stall clock, and
  // the stall refusal must KEEP its anchor. A phrasing that re-anchors the stall
  // clock on either makes this state unreachable through report() entirely.
  const { fold, clock, processedBytes } = warmToMeasured();
  for (let tick = 0; tick < 12; tick += 1) {
    clock.advance(20_000);
    reportRunning(fold, processedBytes);
  }
  assert.equal(reasonOf(fold.current()), AnalysisEtaUnavailableReason.Stalled);
});

test("the stall bound is the sanctioned no-movement give-up, not a private literal", () => {
  assert.equal(
    DEFAULT_ANALYSIS_ETA_POLICY.stallAfterMs,
    IMPORT_NO_MOVEMENT_GIVE_UP_MS
  );
});

test("the stall boundary is exact: one tick before is healthy, at the bound is stalled", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS - 1);
  assert.equal(
    reportRunning(fold, processedBytes).kind,
    AnalysisEtaKind.Measured
  );

  clock.advance(1);
  assert.equal(
    reasonOf(reportRunning(fold, processedBytes)),
    AnalysisEtaUnavailableReason.Stalled
  );
});

test("current() reaches stalled with no further report — the wedged parser", () => {
  // A parser that wedges stops calling report(), so a fold that only checked on
  // write would freeze on its last measured value and never transition.
  const { fold, clock } = warmToMeasured();
  assert.equal(fold.current().kind, AnalysisEtaKind.Measured);
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
  assert.equal(reasonOf(fold.current()), AnalysisEtaUnavailableReason.Stalled);
});

test("current() is pure: calling it does not change what the next report does", () => {
  const observed = warmToMeasured();
  const untouched = warmToMeasured();
  observed.clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
  untouched.clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);

  // Only one of the two folds is READ across the stall boundary.
  assert.equal(
    reasonOf(observed.fold.current()),
    AnalysisEtaUnavailableReason.Stalled
  );

  const next = (run: typeof observed) => {
    run.clock.advance(WARM_MS);
    return reportRunning(run.fold, run.processedBytes + WARM_BYTES);
  };
  const observedNext = expectMeasured(next(observed));
  const untouchedNext = expectMeasured(next(untouched));
  assert.equal(
    observedNext.retainedSampleCount,
    untouchedNext.retainedSampleCount
  );
  assert.equal(observedNext.remainingMs, untouchedNext.remainingMs);
});

test("current() never relabels a terminal state as stalled", () => {
  // Without a kind guard, a legitimately complete fold reports stalled once the
  // caller has simply waited long enough — retracting a true completion.
  const terminals: { name: string; drive: (fold: AnalysisEtaFold) => void }[] =
    [
      {
        drive: (fold) => {
          reportRunning(fold, MODEST_TOTAL);
        },
        name: AnalysisEtaKind.Complete,
      },
      {
        drive: (fold) => {
          reportPaused(fold, 7 * WARM_BYTES);
        },
        name: AnalysisEtaUnavailableReason.Paused,
      },
      {
        drive: (fold) => {
          reportFailed(fold, 7 * WARM_BYTES);
        },
        name: AnalysisEtaUnavailableReason.Failed,
      },
      {
        drive: (fold) => {
          reportRunning(fold, 7 * WARM_BYTES, MODEST_TOTAL, BOUND_REVISION + 1);
        },
        name: AnalysisEtaUnavailableReason.Superseded,
      },
      {
        drive: (fold) => {
          fold.report({
            activity: AnalysisParserActivity.Running,
            parse: { kind: ByteProgressKind.Indeterminate },
            revision: BOUND_REVISION,
          });
        },
        name: AnalysisEtaUnavailableReason.ProgressIndeterminate,
      },
    ];

  for (const terminal of terminals) {
    const { fold, clock } = warmToMeasured();
    terminal.drive(fold);
    const before = fold.current();
    clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS * 2);
    assert.deepEqual(
      fold.current(),
      before,
      `${terminal.name} must survive a long wait unchanged`
    );
  }
});

test("a clock that breaks mid-run stops report() sampling and leaves the state put", () => {
  // Driven on a WARMED fold whose clock then breaks, because a fold that never
  // read a usable clock has no stall mark and so cannot reach these branches at
  // all. What is pinned is the observable contract — an unreadable clock takes
  // no sample and changes nothing — not any particular line.
  for (const mode of BROKEN_CLOCK_MODES) {
    const { fold, clock, processedBytes } = warmToMeasured();
    const before = expectMeasured(fold.current());
    clock.advance(WARM_MS);
    clock.breakWith(mode);
    assert.deepEqual(
      reportRunning(fold, processedBytes + WARM_BYTES),
      before,
      `a ${mode} clock must not move the estimate`
    );
  }
});

test("current() with a clock that breaks mid-run cannot invent a stall", () => {
  // Warmed, then pushed well past the stall bound, then the clock breaks. The
  // fold may not answer a staleness question about a clock it cannot read.
  for (const mode of BROKEN_CLOCK_MODES) {
    const { fold, clock } = warmToMeasured();
    const before = expectMeasured(fold.current());
    clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS * 2);
    clock.breakWith(mode);
    assert.deepEqual(
      fold.current(),
      before,
      `a ${mode} clock must not produce a stall`
    );
  }
});

test("the stalled span is never counted as active analysis time", () => {
  // `activeElapsedMs` is documented as measured ACTIVE time and is monotone, so
  // absorbing an outage into it is permanent. The stall re-seats its anchor
  // precisely so the silent span is never folded into the next sample.
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current()).activeElapsedMs;
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
  assert.equal(
    reasonOf(reportRunning(fold, processedBytes)),
    AnalysisEtaUnavailableReason.Stalled
  );
  clock.advance(WARM_MS);
  const resumed = expectMeasured(
    reportRunning(fold, processedBytes + WARM_BYTES)
  );
  // Only the post-stall interval is active time: the 220 s outage adds nothing.
  assert.equal(resumed.activeElapsedMs, before + WARM_MS);
});

test("repeated stalls do not compound into an inflated estimate", () => {
  // One stalled span folded into the next sample survives the trim, which drops
  // a single extreme; TWO inside one window do not, and the second collapses the
  // rate. Re-seating the anchor is what keeps both cycles out of the window.
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current());
  let consumed = processedBytes;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
    assert.equal(
      reasonOf(reportRunning(fold, consumed)),
      AnalysisEtaUnavailableReason.Stalled
    );
    clock.advance(WARM_MS);
    consumed += WARM_BYTES;
    reportRunning(fold, consumed);
  }
  const after = expectMeasured(fold.current());
  assert.equal(after.throughputBytesPerMs, WARM_RATE);
  assert.ok(
    after.remainingMs < before.remainingMs,
    "two stall cycles must not raise the estimate at all"
  );
});

test("an outage ended by a progressing report is discarded, not measured", () => {
  // The stall refusal only ever runs on a report that did NOT advance. A parser
  // that goes silent past the bound and comes back carrying progress reaches the
  // interval fold first, so without a discard the whole silence lands in one
  // accepted sample: counted as active analysis time, which is monotone and so
  // never recovers, and handed to the window as an outlier the trim can absorb
  // once but not twice. Neither cycle here is preceded by a heartbeat, which is
  // exactly what the sibling stall cases supply.
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current());
  let consumed = processedBytes;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
    consumed += WARM_BYTES;
    reportRunning(fold, consumed);
    clock.advance(WARM_MS);
    consumed += WARM_BYTES;
    reportRunning(fold, consumed);
  }
  const after = expectMeasured(fold.current());
  // Only the two post-outage intervals are active time; the two 220 s silences
  // add nothing, and the rate is the warm-up's rather than one dragged by them.
  assert.equal(after.activeElapsedMs, before.activeElapsedMs + 2 * WARM_MS);
  assert.equal(after.throughputBytesPerMs, WARM_RATE);
});

test("a backward clock reading changes nothing and cannot fabricate a stall", () => {
  // A regressed reading is finite, so the clock helper passes it through and
  // only the sample predicate refuses the negative duration. Rewinding the stall
  // mark with it would accuse a lane that had just made progress.
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current());
  // The rewind must exceed the stall bound, or a rewound mark still reads as
  // healthy when the clock recovers and the case proves nothing.
  const rewindMs = IMPORT_NO_MOVEMENT_GIVE_UP_MS + 80_000;
  clock.advance(-rewindMs);
  reportRunning(fold, processedBytes + WARM_BYTES);
  clock.advance(rewindMs + WARM_MS);
  const recovered = fold.current();
  assert.equal(
    recovered.kind,
    AnalysisEtaKind.Measured,
    "a recovered clock must not read as stalled"
  );
  assert.equal(
    expectMeasured(recovered).activeElapsedMs,
    before.activeElapsedMs
  );
});

test("an interval spanning a pause contributes no sample, and resume does not re-warm", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current());
  reportPaused(fold, processedBytes);
  clock.advance(60_000);
  const after = expectMeasured(reportRunning(fold, processedBytes));
  assert.equal(after.retainedSampleCount, before.retainedSampleCount);
  assert.equal(after.activeElapsedMs, before.activeElapsedMs);
});

test("a pause LONGER than the stall bound then a resume reports measured, not stalled", () => {
  // The anchor-only pass re-anchors the stall clock. Without it the paused span
  // counts as silence and a healthy lane is accused on its first report back.
  const { fold, clock, processedBytes } = warmToMeasured();
  reportPaused(fold, processedBytes);
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS * 2);
  assert.equal(
    reportRunning(fold, processedBytes).kind,
    AnalysisEtaKind.Measured
  );
});

test("a FAILURE longer than the stall bound then a resume reports measured, not stalled", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  reportFailed(fold, processedBytes);
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS * 2);
  assert.equal(
    reportRunning(fold, processedBytes).kind,
    AnalysisEtaKind.Measured
  );
});

test("resume after a stall keeps the window and does not re-warm", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  const before = expectMeasured(fold.current()).retainedSampleCount;
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
  assert.equal(
    reasonOf(reportRunning(fold, processedBytes)),
    AnalysisEtaUnavailableReason.Stalled
  );
  clock.advance(WARM_MS);
  const state = expectMeasured(
    reportRunning(fold, processedBytes + WARM_BYTES)
  );
  // The window survived the refusal, so the first report back is a normal
  // sample rather than a re-warm from nothing.
  assert.equal(state.retainedSampleCount, before + 1);
  // And because the stall re-seated its anchor, that sample measures only the
  // post-stall interval, so the rate is unchanged rather than dragged by the
  // outage. The sibling case above pins the same property on activeElapsedMs.
  assert.equal(state.throughputBytesPerMs, WARM_RATE);
});

test("an indeterminate parse lane reports indeterminate and an empty one reports complete", () => {
  const { fold } = warmToMeasured();
  assert.equal(
    reasonOf(
      fold.report({
        activity: AnalysisParserActivity.Running,
        parse: { kind: ByteProgressKind.Indeterminate },
        revision: BOUND_REVISION,
      })
    ),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
  assert.equal(
    fold.report({
      activity: AnalysisParserActivity.Running,
      parse: { kind: ByteProgressKind.Empty },
      revision: BOUND_REVISION,
    }).kind,
    AnalysisEtaKind.Complete
  );
});

test("a same-revision parse lane whose total disagrees with the inventory is refused, never completed", () => {
  // The revision guard only catches a denominator that announces itself as new.
  // A stale or mixed parse state carrying the BOUND revision and a smaller total
  // announces nothing: its processed bytes clear its own total, so without this
  // guard the fold reports `complete` while the inventory still has eligible
  // bytes left to parse.
  const { fold, processedBytes } = warmToMeasured();
  const smallerTotal = processedBytes + WARM_BYTES;
  assert.ok(smallerTotal < MODEST_TOTAL, "the stale total must be the smaller");

  const state = reportRunning(fold, smallerTotal, smallerTotal, BOUND_REVISION);

  assert.equal(state.kind, AnalysisEtaKind.Unavailable);
  assert.equal(
    reasonOf(state),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
});

test("a same-revision parse lane with a larger total is refused rather than divided by the wrong denominator", () => {
  const { fold, processedBytes } = warmToMeasured();

  const state = reportRunning(
    fold,
    processedBytes,
    MODEST_TOTAL * 2,
    BOUND_REVISION
  );

  assert.equal(
    reasonOf(state),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
  assert.equal("remainingMs" in state, false);
});

test("the fold measures again once the parse lane agrees with the inventory total", () => {
  // The refusal is a refusal, not a terminal state: the mismatched reading is
  // discarded and a well-formed one is measured as usual.
  const { fold, clock, processedBytes } = warmToMeasured();
  reportRunning(fold, processedBytes, MODEST_TOTAL * 2, BOUND_REVISION);

  clock.advance(WARM_MS);
  const state = reportRunning(fold, processedBytes + WARM_BYTES, MODEST_TOTAL);

  assert.equal(state.kind, AnalysisEtaKind.Measured);
});
