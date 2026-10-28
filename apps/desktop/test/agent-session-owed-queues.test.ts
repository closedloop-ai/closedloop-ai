/**
 * @file agent-session-owed-queues.test.ts
 * @description ISS-10429 — the two helpers the session lane's owed queues are
 * read and pruned through. The stamp eviction is the load-bearing half: a
 * removal that left a stamp behind would hold the ISS-8041 prefix boundary at a
 * row nothing owes any more, so the burn-down would report a cursor waiting on
 * a delivered session for as long as the lane ran.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  collectOwedIds,
  dequeueOwedIds,
} from "../src/main/agent-sync/agent-session-owed-queues.js";

describe("collectOwedIds — ISS-8041: every id a lane still owes", () => {
  it("names both queues and the pinned chunk tail", () => {
    assert.deepEqual(collectOwedIds(["i"], ["b"], "chunked"), [
      "i",
      "b",
      "chunked",
    ]);
  });

  it("adds nothing when no chunk tail is pinned", () => {
    assert.deepEqual(collectOwedIds(["i"], ["b"], null), ["i", "b"]);
  });
});

describe("dequeueOwedIds", () => {
  function queues() {
    return {
      queuedIds: new Set(["a", "b", "c"]),
      stamps: new Map([
        ["a", "2026-08-25T21:00:00.000Z"],
        ["b", "2026-08-25T21:05:00.000Z"],
        ["c", "2026-08-25T21:10:00.000Z"],
      ]),
    };
  }

  it("answers the queue that remains and evicts the removed stamps", () => {
    const state = queues();
    const remaining = dequeueOwedIds(
      ["a", "b", "c"],
      state.queuedIds,
      state.stamps,
      ["a", "c"]
    );
    assert.deepEqual(remaining, ["b"]);
    assert.deepEqual([...state.queuedIds], ["b"]);
    assert.deepEqual([...state.stamps.keys()], ["b"]);
  });

  it("leaves the queue it was handed untouched", () => {
    const state = queues();
    const queue = ["a", "b"];
    dequeueOwedIds(queue, state.queuedIds, state.stamps, ["a"]);
    assert.deepEqual(
      queue,
      ["a", "b"],
      "a reader holding the previous array still sees what it was handed"
    );
  });

  it("ignores ids the queue never held", () => {
    const state = queues();
    const remaining = dequeueOwedIds(["a"], state.queuedIds, state.stamps, [
      "gone",
    ]);
    assert.deepEqual(remaining, ["a"]);
    assert.deepEqual([...state.stamps.keys()], ["a", "b", "c"]);
  });
});
