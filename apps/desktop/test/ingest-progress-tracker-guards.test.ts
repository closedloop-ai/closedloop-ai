/**
 * @file ingest-progress-tracker-guards.test.ts
 * @description ISS-11281: pins the early-return guards of the first-pass
 * ingest-progress tracker — a repeated `markPreparing`, a late `advance` for a
 * settled pass, a parked pass in the advancing check, and the frozen-scan
 * line's own throttle.
 */
import assert from "node:assert/strict";
import { Harness } from "@repo/lib/harness/types";
import { describe, it } from "vitest";
import { createTracker } from "./helpers/ingest-progress-fixture.js";

const STALL_WARN_MS = 60_000;
const PREPARING_RE = new RegExp(
  `session backfill \\[${Harness.Claude}\\]: preparing`
);
const SCAN_STALL_RE = /NOT ADVANCING: the source scan has not finished/;
const PROGRESS_RE = new RegExp(
  `session backfill \\[${Harness.Claude}\\]: \\d+/\\d+ source file`
);

describe("IngestProgressTracker guards", () => {
  it("announces preparing once per scan, however often it is marked", () => {
    const { tracker, lines } = createTracker();
    tracker.markPreparing(Harness.Claude);
    tracker.markPreparing(Harness.Claude);
    assert.equal(lines.filter((line) => PREPARING_RE.test(line)).length, 1);
    assert.equal(tracker.snapshot().preparing, true);
  });

  it("reports a frozen scan once per window, and not before the window", () => {
    const { tracker, clock, lines } = createTracker();
    tracker.markPreparing(Harness.Claude);
    const start = clock.now();

    clock.advanceTo(start + STALL_WARN_MS - 1);
    tracker.checkStalls();
    assert.equal(lines.filter((line) => SCAN_STALL_RE.test(line)).length, 0);

    clock.advanceTo(start + STALL_WARN_MS);
    tracker.checkStalls();
    clock.advanceTo(start + STALL_WARN_MS + 1000);
    tracker.checkStalls();
    assert.equal(lines.filter((line) => SCAN_STALL_RE.test(line)).length, 1);

    clock.advanceTo(start + 2 * STALL_WARN_MS);
    tracker.checkStalls();
    assert.equal(lines.filter((line) => SCAN_STALL_RE.test(line)).length, 2);
  });

  it("counts a late durable advance on a settled pass without logging it or re-arming the pass", () => {
    const run = (lateAdvance: boolean) => {
      const { tracker, clock, lines } = createTracker();
      tracker.beginPass(Harness.Claude, 2);
      tracker.advance(Harness.Claude, 0, 0);
      tracker.settlePass(Harness.Claude);
      const linesAfterSettle = lines.length;
      clock.advanceTo(clock.now() + 60_000);
      if (lateAdvance) {
        tracker.advance(Harness.Claude, 5, 5);
      }
      const logsFromLateAdvance = lines.slice(linesAfterSettle);
      const advancingAfterSettle = tracker.hasAdvancingPass(60_000);
      // A later pass for the same harness re-enters the existing entry, which
      // is where the late count becomes visible.
      tracker.beginPass(Harness.Claude, 1);
      return {
        logsFromLateAdvance,
        advancingAfterSettle,
        byHarness: tracker.snapshot().byHarness,
      };
    };

    const late = run(true);
    assert.deepEqual(late.logsFromLateAdvance, []);
    assert.equal(
      late.logsFromLateAdvance.some((line) => PROGRESS_RE.test(line)),
      false
    );
    assert.equal(late.advancingAfterSettle, false);
    // Pins current behavior, filed as ISS-11321: the late advance bumps the
    // settled pass's `processed` past its total (2 -> 3), so the next pass
    // opens at 3/3 instead of 2/3.
    assert.deepEqual(late.byHarness, [
      { harness: Harness.Claude, total: 3, processed: 3 },
    ]);
    assert.deepEqual(run(false).byHarness, [
      { harness: Harness.Claude, total: 3, processed: 2 },
    ]);
  });

  it("skips a parked pass when asking whether the import is advancing", () => {
    const { tracker, clock } = createTracker();
    tracker.beginPass(Harness.Claude, 3);
    tracker.beginPass(Harness.Codex, 3);
    tracker.advance(Harness.Codex, 0, 0);
    tracker.noteSuspended(Harness.Claude);
    clock.advanceTo(clock.now() + 1000);
    assert.equal(tracker.hasAdvancingPass(60_000), true);

    tracker.noteSuspended(Harness.Codex);
    assert.equal(tracker.hasAdvancingPass(60_000), false);
  });
});
