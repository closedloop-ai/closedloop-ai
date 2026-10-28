/**
 * @file transcript-analysis-eta-revisions.test.ts
 * @description ISS-8507 — which inventory the estimate is speaking about, and
 * what number it is allowed to publish about it.
 *
 * Split from the lifecycle suite by responsibility rather than by size. Two
 * groups live here: revision handling and rebasing (does this fold still speak
 * for the current source set?) and the publish policy plus the wire projection
 * (is the number it states checkable by whoever receives it?).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createAnalysisEta } from "../src/main/transcript-sync/transcript-analysis-eta.js";
import { TranscriptInventoryCompleteness } from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { IMPORT_NO_MOVEMENT_GIVE_UP_MS } from "../src/shared/historical-import-bounds.js";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  ANALYSIS_ETA_UNAVAILABLE_REASONS,
  ANALYSIS_ETA_WIRE_KEYS,
  AnalysisEtaConfidence,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
  AnalysisParserActivity,
  type MeasuredAnalysisEta,
  toAnalysisEtaWire,
} from "../src/shared/transcript-analysis-eta-contract.js";
import {
  BOUND_REVISION,
  drive,
  expectMeasured,
  inventory,
  LARGE_TOTAL,
  MODEST_TOTAL,
  measured,
  reasonOf,
  reportFailed,
  reportPaused,
  reportRunning,
  testClock,
  WARM_BYTES,
  WARM_MS,
  warmToMeasured,
} from "./transcript-analysis-eta-fixtures.js";

/** Drives a steadily-worsening lane and records every measured state it passes. */
function worseningRun(stepMs: number, steps: number): MeasuredAnalysisEta[] {
  const clock = testClock();
  const fold = createAnalysisEta(
    inventory({ eligibleParseBytes: LARGE_TOTAL }),
    {
      clock: clock.clock,
    }
  );
  const warm = drive(fold, clock, { sampleCount: 7, totalBytes: LARGE_TOTAL });
  const states = [expectMeasured(warm.state)];
  let processedBytes = warm.processedBytes;
  for (let index = 0; index < steps; index += 1) {
    clock.advance(stepMs);
    processedBytes += WARM_BYTES;
    states.push(
      expectMeasured(reportRunning(fold, processedBytes, LARGE_TOTAL))
    );
  }
  return states;
}

test("a stale revision no-ops and returns the previous state unchanged", () => {
  const { fold, processedBytes } = warmToMeasured();
  const before = fold.current();
  const state = reportRunning(
    fold,
    processedBytes + WARM_BYTES,
    MODEST_TOTAL,
    BOUND_REVISION - 1
  );
  assert.deepEqual(state, before);
});

test("a failed report carrying a STALE revision still reports failed", () => {
  // Liveness is not stale-revision-scoped; byte numbers are. With the stale
  // filter above the activity check this report is swallowed and a dead lane
  // keeps replaying its countdown.
  const { fold, processedBytes } = warmToMeasured();
  const state = reportFailed(
    fold,
    processedBytes,
    MODEST_TOTAL,
    BOUND_REVISION - 1
  );
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Failed);
});

test("a stale failed report does not let a completed fold replay its completion", () => {
  const { fold } = warmToMeasured();
  reportRunning(fold, MODEST_TOTAL);
  assert.equal(fold.current().kind, AnalysisEtaKind.Complete);
  const state = reportFailed(
    fold,
    MODEST_TOTAL,
    MODEST_TOTAL,
    BOUND_REVISION - 1
  );
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Failed);
});

test("a failed report carrying a NEWER revision reports superseded, not failed", () => {
  // Supersession outranks liveness: a newer inventory means this fold has to be
  // replaced whatever the lane is doing.
  const { fold, processedBytes } = warmToMeasured();
  const state = reportFailed(
    fold,
    processedBytes,
    MODEST_TOTAL,
    BOUND_REVISION + 1
  );
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Superseded);
});

test("a newer revision supersedes, and a completed fold does not replay its completion", () => {
  const { fold } = warmToMeasured();
  reportRunning(fold, MODEST_TOTAL);
  assert.equal(fold.current().kind, AnalysisEtaKind.Complete);
  const state = reportRunning(fold, 0, MODEST_TOTAL * 2, BOUND_REVISION + 1);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Superseded);
});

test("supersession is sticky", () => {
  const { fold, processedBytes } = warmToMeasured();
  reportRunning(fold, processedBytes, MODEST_TOTAL, BOUND_REVISION + 1);
  const state = reportRunning(fold, processedBytes + WARM_BYTES);
  assert.equal(reasonOf(state), AnalysisEtaUnavailableReason.Superseded);
});

test("the highest revision seen advances even through the sticky short-circuit", () => {
  // Recording it anywhere later than step one freezes the counter behind the
  // short-circuit, and a rebase then accepts an inventory already proven stale.
  const { fold, processedBytes } = warmToMeasured();
  reportRunning(fold, processedBytes, MODEST_TOTAL, BOUND_REVISION + 1);
  reportRunning(fold, processedBytes, MODEST_TOTAL, BOUND_REVISION + 2);
  assert.equal(
    fold.rebase(inventory({ revision: BOUND_REVISION + 1 })),
    fold,
    "a rebase onto a revision already superseded must be refused"
  );
});

test("a rebase after a stale-revision FAILED report is still refused", () => {
  // The failed arm exits before the byte lane, so this proves the counter is
  // advanced above every short-circuit rather than inside the running path.
  const clock = testClock();
  const fold = createAnalysisEta(inventory({ revision: 1 }), {
    clock: clock.clock,
  });
  reportFailed(fold, 0, MODEST_TOTAL, 3);
  assert.equal(fold.rebase(inventory({ revision: 2 })), fold);
});

test("a superseded fold recovers through a rebase onto the revision that superseded it", () => {
  // A strict comparison against the highest revision seen refuses exactly this
  // call and strands the caller in a permanent unavailable.
  const { fold, processedBytes } = warmToMeasured();
  reportRunning(fold, processedBytes, MODEST_TOTAL, BOUND_REVISION + 1);
  const rebased = fold.rebase(inventory({ revision: BOUND_REVISION + 1 }));
  assert.notEqual(rebased, fold);
  assert.equal(rebased.current().kind, AnalysisEtaKind.Calculating);
});

test("a rebase returns a fold carrying nothing, so it starts calculating", () => {
  // It receives no parse report, so it cannot have satisfied the byte-volume
  // floor; reporting measured here would be a number with no current evidence.
  const { fold } = warmToMeasured();
  const rebased = fold.rebase(
    inventory({
      eligibleParseBytes: MODEST_TOTAL * 2,
      revision: BOUND_REVISION + 1,
    })
  );
  const state = rebased.current();
  assert.equal(state.kind, AnalysisEtaKind.Calculating);
  if (state.kind !== AnalysisEtaKind.Calculating) {
    throw new Error("unreachable");
  }
  assert.equal(state.retainedSampleCount, 0);
  assert.equal(state.activeElapsedMs, 0);
  assert.equal(state.inventoryRevision, BOUND_REVISION + 1);
});

test("a rebased fold requalifies against the NEW total once it has fresh evidence", () => {
  // The rebased fold inherits the original's deps, so it must be driven on the
  // SAME clock — a fresh one would leave every interval at zero duration.
  const { fold, clock } = warmToMeasured();
  const nextTotal = MODEST_TOTAL * 4;
  const rebased = fold.rebase(
    inventory({ eligibleParseBytes: nextTotal, revision: BOUND_REVISION + 1 })
  );
  const state = expectMeasured(
    drive(rebased, clock, {
      revision: BOUND_REVISION + 1,
      sampleCount: 7,
      totalBytes: nextTotal,
    }).state
  );
  assert.equal(state.remainingBytes, nextTotal - 7 * WARM_BYTES);
  assert.equal(state.inventoryRevision, BOUND_REVISION + 1);
});

test("a rebase onto a SHRINKING source set never yields a negative or non-finite time", () => {
  const { fold, clock } = warmToMeasured();
  const smaller = 3_000_000;
  const rebased = fold.rebase(
    inventory({ eligibleParseBytes: smaller, revision: BOUND_REVISION + 1 })
  );
  const state = expectMeasured(
    drive(rebased, clock, {
      revision: BOUND_REVISION + 1,
      sampleCount: 7,
      totalBytes: smaller,
    }).state
  );
  assert.equal(state.remainingBytes, smaller - 7 * WARM_BYTES);
  assert.ok(state.remainingMs > 0);
  assert.equal(Number.isFinite(state.remainingMs), true);
});

test("a rebase onto a zero-byte or unmeasured inventory states that instead of a time", () => {
  const { fold } = warmToMeasured();
  const empty = fold.rebase(
    inventory({ eligibleParseBytes: 0, revision: BOUND_REVISION + 1 })
  );
  assert.equal(empty.current().kind, AnalysisEtaKind.Complete);

  const unavailable = fold.rebase(
    inventory({
      parseCompleteness: TranscriptInventoryCompleteness.Unavailable,
      revision: BOUND_REVISION + 2,
    })
  );
  assert.equal(
    reasonOf(unavailable.current()),
    AnalysisEtaUnavailableReason.ProgressIndeterminate
  );
});

test("a rebase onto a short-but-measured inventory starts calculating, not indeterminate", () => {
  // ISS-8346 ruling 2026-09-04: partial measures over the bytes it did see, so
  // a re-sweep that loses one probe keeps its estimate rather than dropping it.
  const { fold } = warmToMeasured();

  const partial = fold.rebase(
    inventory({
      parseCompleteness: TranscriptInventoryCompleteness.Partial,
      revision: BOUND_REVISION + 1,
    })
  );

  assert.equal(partial.current().kind, AnalysisEtaKind.Calculating);
});

test("a rebase onto an equal or lower revision returns the same fold", () => {
  const { fold } = warmToMeasured();
  assert.equal(fold.rebase(inventory({ revision: BOUND_REVISION })), fold);
  assert.equal(fold.rebase(inventory({ revision: BOUND_REVISION - 1 })), fold);
});

test("a rebase works on a fold that is mid-stall", () => {
  const { fold, clock } = warmToMeasured();
  clock.advance(IMPORT_NO_MOVEMENT_GIVE_UP_MS);
  assert.equal(reasonOf(fold.current()), AnalysisEtaUnavailableReason.Stalled);
  const rebased = fold.rebase(inventory({ revision: BOUND_REVISION + 1 }));
  assert.notEqual(rebased, fold);
  assert.equal(rebased.current().kind, AnalysisEtaKind.Calculating);
});

test("the published estimate never rises unless the raw one is 20% above it", () => {
  // The invariant, checked on every consecutive pair, plus proof the run
  // actually exercised a hold — otherwise this passes on a lane that never
  // worsened at all.
  const states = worseningRun(WARM_MS + 50, 6);
  let heldAtLeastOnce = false;
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1];
    const state = states[index];
    if (state.remainingMs > previous.remainingMs) {
      assert.ok(
        state.rawRemainingMs >= previous.remainingMs * 1.2,
        `report ${index} raised the estimate without a material worsening`
      );
    }
    if (state.rawRemainingMs > state.remainingMs) {
      heldAtLeastOnce = true;
    }
  }
  assert.ok(heldAtLeastOnce, "the run must contain at least one held report");
});

test("a held estimate still reconciles with the inputs shipped beside it", () => {
  // The whole reason the raw value ships: during a hold `remainingMs` is NOT
  // remainingBytes / throughputBytesPerMs, and a consumer re-deriving the
  // estimate would otherwise get an answer that contradicts the payload with no
  // way to tell which number was the lie.
  const held = worseningRun(WARM_MS + 50, 6).filter(
    (state) => state.rawRemainingMs > state.remainingMs
  );
  assert.ok(held.length > 0, "the run must contain at least one held report");
  for (const state of held) {
    assert.equal(
      state.rawRemainingMs,
      state.remainingBytes / state.throughputBytesPerMs
    );
    assert.ok(state.rawRemainingMs < state.remainingMs * 1.2);
  }
});

test("a material worsening does publish, so a hold cannot become permanent", () => {
  const states = worseningRun(WARM_MS * 4, 16);
  const rose = states.some(
    (state, index) =>
      index > 0 && state.remainingMs > states[index - 1].remainingMs
  );
  assert.ok(rose, "a sustained worsening must eventually raise the estimate");
  const last = states.at(-1);
  if (!last) {
    throw new Error("the run produced no states");
  }
  assert.ok(last.remainingMs > states[0].remainingMs);
  assert.equal(
    last.rawRemainingMs,
    last.remainingBytes / last.throughputBytesPerMs
  );
});

test("a decreasing estimate publishes freely, report after report", () => {
  const { fold, clock, processedBytes } = warmToMeasured();
  let previous = expectMeasured(fold.current()).remainingMs;
  let consumed = processedBytes;
  for (let index = 0; index < 5; index += 1) {
    clock.advance(WARM_MS);
    consumed += WARM_BYTES;
    const state = expectMeasured(reportRunning(fold, consumed));
    assert.ok(
      state.remainingMs < previous,
      `report ${index} must lower the estimate`
    );
    assert.equal(state.remainingMs, state.rawRemainingMs);
    previous = state.remainingMs;
  }
});

test("the gate closes again when the evidence evaporates", () => {
  // A latch cannot close, and the window turns over completely: sixteen
  // one-byte samples leave the rate resting on fourteen milliseconds while an
  // extrapolation measured in weeks keeps publishing.
  const { fold, clock, processedBytes } = warmToMeasured(LARGE_TOTAL);
  let consumed = processedBytes;
  for (let index = 0; index < 16; index += 1) {
    clock.advance(1);
    consumed += 1;
    reportRunning(fold, consumed, LARGE_TOTAL);
  }
  assert.equal(fold.current().kind, AnalysisEtaKind.Calculating);
});

test("the gate does not close on ordinary eviction", () => {
  // A retained span of 1904 ms is under the 2000 ms floor but over half of it.
  // A live floor with no hysteresis flickers back to calculating here on a
  // perfectly healthy lane.
  const { fold, clock, processedBytes } = warmToMeasured(LARGE_TOTAL);
  let consumed = processedBytes;
  for (let index = 0; index < 16; index += 1) {
    clock.advance(136);
    consumed += WARM_BYTES;
    reportRunning(fold, consumed, LARGE_TOTAL);
  }
  assert.equal(fold.current().kind, AnalysisEtaKind.Measured);
});

test("confidence is provisional until the window is full", () => {
  const { fold, clock, processedBytes } = warmToMeasured(LARGE_TOTAL);
  assert.equal(
    expectMeasured(fold.current()).confidence,
    AnalysisEtaConfidence.Provisional
  );
  let consumed = processedBytes;
  for (let index = 0; index < 10; index += 1) {
    clock.advance(WARM_MS);
    consumed += WARM_BYTES;
    reportRunning(fold, consumed, LARGE_TOTAL);
  }
  assert.equal(
    expectMeasured(fold.current()).confidence,
    AnalysisEtaConfidence.Established
  );
});

test("the wire projection carries the discriminator on every kind", () => {
  // The four states are told apart by `kind` and nothing else, so a projection
  // that dropped it would defeat the whole contract.
  const { fold, processedBytes } = warmToMeasured();
  const measuredWire = toAnalysisEtaWire(fold.current());
  const calculatingWire = toAnalysisEtaWire(
    createAnalysisEta(inventory()).current()
  );
  const completeWire = toAnalysisEtaWire(
    createAnalysisEta(inventory({ eligibleParseBytes: 0 })).current()
  );
  const unavailableWire = toAnalysisEtaWire(reportFailed(fold, processedBytes));
  assert.equal(measuredWire.kind, AnalysisEtaKind.Measured);
  assert.equal(calculatingWire.kind, AnalysisEtaKind.Calculating);
  assert.equal(completeWire.kind, AnalysisEtaKind.Complete);
  assert.equal(unavailableWire.kind, AnalysisEtaKind.Unavailable);
  for (const wire of [
    measuredWire,
    calculatingWire,
    completeWire,
    unavailableWire,
  ]) {
    assert.equal(wire.contractVersion, ANALYSIS_ETA_CONTRACT_VERSION);
    assert.equal(typeof wire.inventoryRevision, "number");
  }
});

test("the wire projection OMITS what a kind does not carry", () => {
  // Asserted with `in`, never against undefined: a key present and set to
  // undefined passes an undefined check and is exactly the shape the omission
  // rule forbids on a version-skewed boundary.
  const { fold, processedBytes } = warmToMeasured();
  const measuredWire = toAnalysisEtaWire(fold.current());
  assert.equal("remainingMs" in measuredWire, true);
  assert.equal("rawRemainingMs" in measuredWire, true);
  assert.equal("reason" in measuredWire, false);

  const calculatingWire = toAnalysisEtaWire(
    createAnalysisEta(inventory()).current()
  );
  assert.equal("remainingMs" in calculatingWire, false);
  assert.equal("throughputBytesPerMs" in calculatingWire, false);
  assert.equal("confidence" in calculatingWire, false);
  assert.equal("retainedSampleCount" in calculatingWire, true);

  const completeWire = toAnalysisEtaWire(
    createAnalysisEta(inventory({ eligibleParseBytes: 0 })).current()
  );
  assert.equal("remainingMs" in completeWire, false);
  assert.equal("retainedSampleCount" in completeWire, false);
  assert.equal("reason" in completeWire, false);

  const unavailableWire = toAnalysisEtaWire(reportPaused(fold, processedBytes));
  assert.equal("reason" in unavailableWire, true);
  assert.equal("remainingMs" in unavailableWire, false);
  assert.equal("activeElapsedMs" in unavailableWire, false);
});

test("every unavailable reason survives the wire projection", () => {
  // Driven off the reason set itself, so a reason added later without a
  // projection arm fails here rather than crossing the boundary unnamed.
  for (const reason of ANALYSIS_ETA_UNAVAILABLE_REASONS) {
    const wire = toAnalysisEtaWire({
      contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
      inventoryRevision: BOUND_REVISION,
      kind: AnalysisEtaKind.Unavailable,
      reason,
    });
    assert.equal(wire.reason, reason);
    assert.equal(wire.kind, AnalysisEtaKind.Unavailable);
  }
});

test("no projection emits a key the contract does not declare", () => {
  // The consumer of ANALYSIS_ETA_WIRE_KEYS, which is derived from the
  // compile-time keys-covered witness. Together they close the loop in both
  // directions: the witness fails `tsc` when a member gains a key the wire
  // shape has not learned, and this fails when a projection emits one that is
  // not in the contract at all.
  const { fold, processedBytes } = warmToMeasured();
  const projections = [
    toAnalysisEtaWire(fold.current()),
    toAnalysisEtaWire(createAnalysisEta(inventory()).current()),
    toAnalysisEtaWire(
      createAnalysisEta(inventory({ eligibleParseBytes: 0 })).current()
    ),
    toAnalysisEtaWire(
      fold.report({
        activity: AnalysisParserActivity.Failed,
        parse: measured(processedBytes, MODEST_TOTAL),
        revision: BOUND_REVISION,
      })
    ),
  ];
  for (const wire of projections) {
    for (const key of Object.keys(wire)) {
      assert.ok(
        ANALYSIS_ETA_WIRE_KEYS.includes(
          key as (typeof ANALYSIS_ETA_WIRE_KEYS)[number]
        ),
        `${key} is not a declared wire key`
      );
    }
  }
});

test("every numeric field the wire emits is finite", () => {
  const { fold } = warmToMeasured();
  const wire = toAnalysisEtaWire(fold.current());
  for (const [key, value] of Object.entries(wire)) {
    if (typeof value === "number") {
      assert.equal(Number.isFinite(value), true, `${key} must be finite`);
    }
  }
});
