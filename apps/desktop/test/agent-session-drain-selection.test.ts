/**
 * @file agent-session-drain-selection.test.ts
 * @description ISS-6166 unit coverage for the pure lane-selection policy in
 * `selectDrainCandidates`, driven directly over a fake `pickReady` probe.
 *
 * `agent-session-sync-backfill-fairness.test.ts` proves the FLOOR end-to-end
 * through the real service: an unbroken incremental lane no longer starves the
 * historical backfill. What it structurally cannot see is the other end of the
 * policy — the UNSPENT reservation (wongk on PR #4946). Its backfill corpus is
 * always ready, so the reserved tick always finds backfill work and the
 * hand-back branch never executes; deleting that branch outright would leave it
 * green while every reserved tick on a real install — where backfill rows sit
 * inside a rate-limit backoff window — dropped a READY incremental batch on the
 * floor and shipped nothing.
 *
 * That is the reservation's stated contract: a FLOOR on fairness, never a
 * ceiling on throughput (`main/sync/AGENTS.md` invariant 5, mirroring how
 * `loadReadyInvocationSyncOutboxParts` returns an unspent never-attempted
 * reservation to its FIFO half). Pinned here against synthetic queues so each
 * branch is exercised by an input that isolates it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  advanceIncrementalPassCount,
  type DrainSelectionInput,
  selectDrainCandidates,
} from "../src/main/agent-sync/agent-session-drain-selection.js";
import { MAX_CONSECUTIVE_INCREMENTAL_PASSES } from "../src/main/agent-sync/agent-session-sync-limits.js";

const NOW_MS = 1_770_000_000_000;

/**
 * A `pickReady` that admits only the ids in `readyIds` — the shape of the
 * service's real probe, whose deferred-retry deadlines reject a row that is
 * inside its backoff window.
 */
function pickReadyFrom(
  readyIds: readonly string[]
): DrainSelectionInput["pickReady"] {
  const ready = new Set(readyIds);
  return (queue, limit) => queue.filter((id) => ready.has(id)).slice(0, limit);
}

function selection(overrides: Partial<DrainSelectionInput>) {
  return selectDrainCandidates({
    nowMs: NOW_MS,
    incrementalQueue: [],
    backfillQueue: [],
    // Well past the coalescing window, so the ISS-5085 gate is never the reason
    // a case here picks nothing.
    lastIncrementalBatchAttemptedAtMs: NOW_MS - 600_000,
    consecutiveIncrementalPasses: 0,
    pickReady: pickReadyFrom([]),
    validationBisectIds: new Set<string>(),
    ...overrides,
  });
}

test("ISS-6166: a RESERVED tick whose backfill is entirely in backoff hands the tick back to incremental", () => {
  // The reservation has fired (backfill work exists, the incremental lane has
  // won its quota of consecutive ticks), but every backfill row is inside a
  // rate-limit backoff window, so the ready filter returns none of them. The
  // incremental batch is ready and must still ship: an unspent reservation is
  // handed back, never burned on an empty tick.
  const result = selection({
    incrementalQueue: ["inc-1", "inc-2"],
    backfillQueue: ["back-1", "back-2"],
    consecutiveIncrementalPasses: MAX_CONSECUTIVE_INCREMENTAL_PASSES,
    pickReady: pickReadyFrom(["inc-1", "inc-2"]),
  });

  assert.equal(
    result.syncMode,
    AgentSessionSyncMode.Incremental,
    "the unspent reservation was handed back to the ready incremental lane"
  );
  assert.deepEqual(result.candidateIds, ["inc-1", "inc-2"]);
  // The coalescing stamp only moves when a batch was actually selected.
  assert.equal(result.incrementalAttemptedAtMs, NOW_MS);
});

test("ISS-6166: a RESERVED tick spends the reservation when its backfill IS ready", () => {
  // The counterfactual for the hand-back above: with the same reservation and a
  // ready backfill row, backfill must win — otherwise the hand-back would be
  // indistinguishable from never reserving at all.
  const result = selection({
    incrementalQueue: ["inc-1"],
    backfillQueue: ["back-1"],
    consecutiveIncrementalPasses: MAX_CONSECUTIVE_INCREMENTAL_PASSES,
    pickReady: pickReadyFrom(["inc-1", "back-1"]),
  });

  assert.equal(result.syncMode, AgentSessionSyncMode.Backfill);
  assert.deepEqual(result.candidateIds, ["back-1"]);
  // A backfill win must not restart the incremental coalescing window.
  assert.equal(result.incrementalAttemptedAtMs, null);
});

test("ISS-6166: an UNRESERVED tick still prefers a ready incremental batch", () => {
  const result = selection({
    incrementalQueue: ["inc-1"],
    backfillQueue: ["back-1"],
    consecutiveIncrementalPasses: MAX_CONSECUTIVE_INCREMENTAL_PASSES - 1,
    pickReady: pickReadyFrom(["inc-1", "back-1"]),
  });

  assert.equal(result.syncMode, AgentSessionSyncMode.Incremental);
  assert.deepEqual(result.candidateIds, ["inc-1"]);
});

test("FEA-1461: an UNRESERVED tick falls through to backfill when every incremental row is in backoff", () => {
  const result = selection({
    incrementalQueue: ["inc-1"],
    backfillQueue: ["back-1"],
    consecutiveIncrementalPasses: 0,
    pickReady: pickReadyFrom(["back-1"]),
  });

  assert.equal(result.syncMode, AgentSessionSyncMode.Backfill);
  assert.deepEqual(result.candidateIds, ["back-1"]);
});

test("ISS-6166: a tick where NEITHER lane is ready selects nothing and leaves the stamp alone", () => {
  const result = selection({
    incrementalQueue: ["inc-1"],
    backfillQueue: ["back-1"],
    consecutiveIncrementalPasses: MAX_CONSECUTIVE_INCREMENTAL_PASSES,
    pickReady: pickReadyFrom([]),
  });

  assert.equal(result.syncMode, null);
  assert.deepEqual(result.candidateIds, []);
  assert.equal(result.incrementalAttemptedAtMs, null);
});

test("ISS-6166: an EMPTY backfill queue never reserves, so the policy is inert once history has drained", () => {
  const result = selection({
    incrementalQueue: ["inc-1"],
    backfillQueue: [],
    consecutiveIncrementalPasses: MAX_CONSECUTIVE_INCREMENTAL_PASSES * 10,
    pickReady: pickReadyFrom(["inc-1"]),
  });

  assert.equal(result.syncMode, AgentSessionSyncMode.Incremental);
  assert.deepEqual(result.candidateIds, ["inc-1"]);
});

test("ISS-6166: the pass counter advances on incremental, resets on backfill, and holds on an idle tick", () => {
  assert.equal(
    advanceIncrementalPassCount(2, AgentSessionSyncMode.Incremental),
    3
  );
  assert.equal(
    advanceIncrementalPassCount(9, AgentSessionSyncMode.Backfill),
    0
  );
  // An idle tick neither spends nor resets the reservation — otherwise a lane
  // that goes quiet mid-reservation would silently lose the fairness floor it
  // had already earned.
  assert.equal(advanceIncrementalPassCount(9, null), 9);
});
