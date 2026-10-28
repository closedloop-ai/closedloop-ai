import assert from "node:assert/strict";
import { test } from "vitest";
import {
  importNeverSettledMessage,
  PerfFailureReason,
  resolveSettleAtMs,
  SurfaceWaitBlocker,
  surfaceWaitFailureMessage,
} from "./perf/helpers/import-lane.js";

// ISS-7287. The import lane's two minute-scale bounds used to fail alike, so a
// run that never reached the app read as a run whose import stalled — the
// mistake that gave ISS-6003 a wrong cause. These execute the distinction
// against synthetic screen readings; the lane's own spec cannot, because it can
// only produce one of these states per launched app.
//
// Everything drives the composed message, because the message is what the next
// reader of a failed run actually gets.

const SURFACE_WAIT_MS = 120_000;
const OBSERVATION_MS = 1_920_000;
/** Elapsed-since-launch of the first sample in the closing stable window. */
const WINDOW_STARTED_AT_MS = 2519;

test("ISS-7287: a surface-wait failure and an import timeout carry disjoint reasons", () => {
  const surfaceWait = surfaceWaitFailureMessage({}, SURFACE_WAIT_MS);
  const importTimeout = importNeverSettledMessage({
    observedMs: OBSERVATION_MS,
    countStillChanging: true,
    bootImportEnded: false,
  });

  assert.ok(surfaceWait.includes(PerfFailureReason.SurfaceNeverRendered));
  assert.ok(!surfaceWait.includes(PerfFailureReason.ImportNeverSettled));
  assert.ok(importTimeout.includes(PerfFailureReason.ImportNeverSettled));
  assert.ok(!importTimeout.includes(PerfFailureReason.SurfaceNeverRendered));
});

test("ISS-7287: an unrecognized screen is reported with what was actually on it", () => {
  // The whole diagnostic value of this branch: the only thing that tells the
  // next reader which subsystem to look at is what the renderer had rendered
  // instead.
  const message = surfaceWaitFailureMessage(
    { headings: ["Something went wrong", "Reload"] },
    SURFACE_WAIT_MS
  );

  assert.ok(message.includes(SurfaceWaitBlocker.Unrecognized));
  assert.ok(message.includes("Something went wrong"));
  assert.ok(message.includes("Reload"));
});

test("ISS-7286: a count that never moved is not timed from the poll that first saw it", () => {
  // The populated shape's expected steady state: the snapshot already holds the
  // sessions its own transcripts describe, so a full re-import upserts rows and
  // leaves COUNT(*) flat. Timing that from the window's start reports the whole
  // import as having taken one poll — the false completion, reached a second way.
  assert.equal(
    resolveSettleAtMs({
      stableWindowStartedAtMs: WINDOW_STARTED_AT_MS,
      firstCountChangeAtMs: null,
      observedAtMs: OBSERVATION_MS,
    }),
    OBSERVATION_MS
  );
  // Once the count HAS moved, the window's own start is the answer, and the
  // later confirming polls must not be charged to the import.
  assert.equal(
    resolveSettleAtMs({
      stableWindowStartedAtMs: WINDOW_STARTED_AT_MS,
      firstCountChangeAtMs: 1000,
      observedAtMs: OBSERVATION_MS,
    }),
    WINDOW_STARTED_AT_MS
  );
});

test("ISS-7286: a steady count with no terminal lifecycle does not blame the importer", () => {
  // The app arms its own bound later than this lane's launch clock, and a
  // renderer whose bridge never came up reads identically. Neither is an import
  // that failed to settle, and saying so points the next reader at the importer.
  const stalledLifecycle = importNeverSettledMessage({
    observedMs: OBSERVATION_MS,
    countStillChanging: false,
    bootImportEnded: false,
  });
  assert.ok(
    stalledLifecycle.includes(PerfFailureReason.LifecycleNeverTerminal)
  );
  assert.ok(!stalledLifecycle.includes(PerfFailureReason.ImportNeverSettled));

  const stillChanging = importNeverSettledMessage({
    observedMs: OBSERVATION_MS,
    countStillChanging: true,
    bootImportEnded: false,
  });
  assert.ok(stillChanging.includes(PerfFailureReason.ImportNeverSettled));
  assert.ok(!stillChanging.includes(PerfFailureReason.LifecycleNeverTerminal));
});
