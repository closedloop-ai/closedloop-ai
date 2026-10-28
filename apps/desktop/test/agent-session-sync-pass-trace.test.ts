/**
 * @file agent-session-sync-pass-trace.test.ts
 * @description ISS-6214 — pin WHICH metric the sync-pass slow threshold is on.
 *
 * The predicate has always compared TOTAL elapsed pass time (`fired→completed`)
 * against the threshold, while its docstring said a slow pass was one that
 * crossed the threshold "anywhere" — i.e. in a single stage gap. Those two
 * readings disagree on a real and common sample: three 4s stages total 12s but
 * no single gap is anywhere near 10s. Nothing pinned which one was intended, so
 * a later reader "fixing" the code to match the comment would have silently
 * narrowed the ISS-5993 starvation signal.
 *
 * These cases make the total-elapsed reading enforceable rather than merely
 * documented. The first is the discriminating one: it is TRUE under total
 * elapsed and FALSE under any per-stage rule.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isSlowSyncPass,
  SYNC_PASS_TRACE_SLOW_TOTAL_MS,
  SyncPassOutcome,
  type SyncPassTraceSample,
  SyncPassTrigger,
} from "../src/main/agent-sync/agent-session-sync-pass-trace.js";

/**
 * Hand-written stage boundaries, never derived from the threshold constant — a
 * sample computed from `SYNC_PASS_TRACE_SLOW_TOTAL_MS` would move with it and
 * could not police it.
 */
function sampleWithStageGaps(gaps: {
  firedToAdmittedMs: number;
  admittedToStartedMs: number;
  startedToCompletedMs: number;
}): SyncPassTraceSample {
  const admittedAtMs = gaps.firedToAdmittedMs;
  const startedAtMs = admittedAtMs + gaps.admittedToStartedMs;
  return {
    trigger: SyncPassTrigger.Poll,
    firedAtMs: 0,
    admittedAtMs,
    startedAtMs,
    completedAtMs: startedAtMs + gaps.startedToCompletedMs,
    outcome: SyncPassOutcome.Idle,
  };
}

test("ISS-6214: stage gaps that individually stay under the threshold are slow once they TOTAL past it", () => {
  // 4s + 4s + 4s = 12s total, no single gap above 4s. Slow under the implemented
  // total-elapsed metric; NOT slow under the "any stage gap" reading the old
  // docstring described.
  assert.equal(
    isSlowSyncPass(
      sampleWithStageGaps({
        firedToAdmittedMs: 4000,
        admittedToStartedMs: 4000,
        startedToCompletedMs: 4000,
      })
    ),
    true
  );
});

test("ISS-6214: a pass whose stage gaps total under the threshold is not slow", () => {
  // 3s + 3s + 3s = 9s — under 10s on every reading, so this is the sibling that
  // proves the case above is not simply "always true".
  assert.equal(
    isSlowSyncPass(
      sampleWithStageGaps({
        firedToAdmittedMs: 3000,
        admittedToStartedMs: 3000,
        startedToCompletedMs: 3000,
      })
    ),
    false
  );
});

test("ISS-6214: the threshold is inclusive at exactly the named total", () => {
  assert.equal(SYNC_PASS_TRACE_SLOW_TOTAL_MS, 10_000);
  assert.equal(
    isSlowSyncPass(
      sampleWithStageGaps({
        firedToAdmittedMs: 10_000,
        admittedToStartedMs: 0,
        startedToCompletedMs: 0,
      })
    ),
    true
  );
});

test("ISS-6214: a pass abandoned before `started` still measures fired→completed", () => {
  // `startedAtMs` is null when the pass never reached DB work. The total is
  // still the whole trigger-to-finally span, so an abandoned pass that sat 12s
  // behind the background-slot gate is reported slow rather than skipped.
  assert.equal(
    isSlowSyncPass({
      trigger: SyncPassTrigger.WorkArrival,
      firedAtMs: 0,
      admittedAtMs: 11_000,
      startedAtMs: null,
      completedAtMs: 12_000,
      outcome: SyncPassOutcome.Abandoned,
    }),
    true
  );
});
