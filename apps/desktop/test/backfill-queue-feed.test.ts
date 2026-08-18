/**
 * @file backfill-queue-feed.test.ts
 * @description ISS-4546 (ISS-4493 Part 2): unit coverage for the dedup-safe,
 * hydration-first in-memory `backfillQueue` feed extracted from the sync service.
 * Asserts the pure dedup discipline (mirrors the `loadPendingOutboxIds` re-enqueue
 * loop) and the hydration-first guard that keeps a live inject from preempting the
 * initial hydration / full-walk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BackfillQueueFeedContext,
  feedIdsIntoBackfillQueue,
  injectIdsIntoLiveQueue,
} from "../src/main/agent-sync/backfill-queue-feed.js";

function makeState(overrides?: {
  backfillQueue?: string[];
  backfillQueuedIds?: Iterable<string>;
  incrementalQueuedIds?: Iterable<string>;
  deadLetteredIds?: Iterable<[string, number]>;
}) {
  return {
    backfillQueue: overrides?.backfillQueue ?? [],
    backfillQueuedIds: new Set(overrides?.backfillQueuedIds ?? []),
    incrementalQueuedIds: new Set(overrides?.incrementalQueuedIds ?? []),
    deadLetteredIds: new Map(overrides?.deadLetteredIds ?? []),
  };
}

test("feedIdsIntoBackfillQueue appends genuinely-new ids and records them", () => {
  const state = makeState({ backfillQueue: ["existing"] });
  state.backfillQueuedIds.add("existing");

  const enqueued = feedIdsIntoBackfillQueue(state, ["a", "b"]);

  assert.equal(enqueued, 2);
  assert.deepEqual(state.backfillQueue, ["existing", "a", "b"]);
  assert.ok(state.backfillQueuedIds.has("a"));
  assert.ok(state.backfillQueuedIds.has("b"));
});

test("feedIdsIntoBackfillQueue skips ids already on the backfill queue", () => {
  const state = makeState({ backfillQueue: ["a"], backfillQueuedIds: ["a"] });

  const enqueued = feedIdsIntoBackfillQueue(state, ["a", "b"]);

  assert.equal(enqueued, 1);
  assert.deepEqual(state.backfillQueue, ["a", "b"]);
});

test("feedIdsIntoBackfillQueue skips ids already on the incremental queue", () => {
  const state = makeState({ incrementalQueuedIds: ["inc"] });

  const enqueued = feedIdsIntoBackfillQueue(state, ["inc", "new"]);

  assert.equal(enqueued, 1);
  assert.deepEqual(state.backfillQueue, ["new"]);
  // The incremental id must NOT be double-tracked on the backfill set.
  assert.equal(state.backfillQueuedIds.has("inc"), false);
});

test("feedIdsIntoBackfillQueue skips ids already dead-lettered", () => {
  const state = makeState({
    deadLetteredIds: [["dead", Number.POSITIVE_INFINITY]],
  });

  const enqueued = feedIdsIntoBackfillQueue(state, ["dead", "live"]);

  assert.equal(enqueued, 1);
  assert.deepEqual(state.backfillQueue, ["live"]);
});

// ---------------------------------------------------------------------------
// injectIdsIntoLiveQueue: hydration-first + orchestration side effects
// ---------------------------------------------------------------------------

const HYDRATED_KEY = "source-key-hydrated";

function makeHydratedContext(base = makeState()): {
  ctx: BackfillQueueFeedContext;
  calls: { revisitReset: number; nudge: number; recovered: string[] };
} {
  const calls = { revisitReset: 0, nudge: 0, recovered: [] as string[] };
  const ctx: BackfillQueueFeedContext = {
    ...base,
    hydratedSourceKey: HYDRATED_KEY,
    resolveSyncSourceKey: () => HYDRATED_KEY,
    recoverDeadLetteredId: (id) => {
      // Mirror the service: drop the set-aside marker so the subsequent feed can
      // queue the id as genuinely-new work.
      base.deadLetteredIds.delete(id);
      calls.recovered.push(id);
    },
    resetDeadLetterRevisitGuard: () => {
      calls.revisitReset += 1;
    },
    nudgeAfterInject: () => {
      calls.nudge += 1;
    },
  };
  return { ctx, calls };
}

test("injectIdsIntoLiveQueue feeds the live queue and nudges once hydrated (matching key)", () => {
  const base = makeState();
  const { ctx, calls } = makeHydratedContext(base);
  const logs: string[] = [];

  injectIdsIntoLiveQueue(ctx, ["h1", "h2"], HYDRATED_KEY, (m) => logs.push(m));

  assert.deepEqual(base.backfillQueue, ["h1", "h2"]);
  assert.equal(calls.revisitReset, 1);
  assert.equal(calls.nudge, 1);
  assert.equal(logs.length, 1);
});

test("injectIdsIntoLiveQueue is a no-op for an empty id list", () => {
  const { ctx, calls } = makeHydratedContext();
  let logged = false;

  injectIdsIntoLiveQueue(ctx, [], HYDRATED_KEY, () => {
    logged = true;
  });

  assert.equal(calls.nudge, 0);
  assert.equal(calls.revisitReset, 0);
  assert.equal(logged, false);
});

test("injectIdsIntoLiveQueue does NOT feed or nudge when every id is already tracked", () => {
  const base = makeState({ backfillQueue: ["h1"], backfillQueuedIds: ["h1"] });
  const { ctx, calls } = makeHydratedContext(base);

  injectIdsIntoLiveQueue(ctx, ["h1"], HYDRATED_KEY, () => {
    // No new work → no log.
  });

  assert.deepEqual(base.backfillQueue, ["h1"]);
  // No genuinely-new work, so the loop is not nudged and the revisit guard is
  // untouched — a full-drain optimization must not fire on a pure re-inject.
  assert.equal(calls.nudge, 0);
  assert.equal(calls.revisitReset, 0);
});

test("injectIdsIntoLiveQueue RECOVERS a dead-lettered id on inject, then queues it", () => {
  // Dead-letter recovery edge (PR #4098 review, shafty023): an injected id that is
  // currently set aside as a dead-letter must be RECOVERED (re-pended) and then
  // queued, not silently skipped by the dedup guard — otherwise the re-derived
  // session stays parked. Not specific to the retired FEA-3427 wall-clock heal:
  // the data-revision rebuild re-derives dead-lettered sessions the same way (see
  // the ISS-5135 note on the module doc).
  const base = makeState({
    deadLetteredIds: [["dead", Number.POSITIVE_INFINITY]],
  });
  const { ctx, calls } = makeHydratedContext(base);
  const logs: string[] = [];

  injectIdsIntoLiveQueue(ctx, ["dead", "live"], HYDRATED_KEY, (m) =>
    logs.push(m)
  );

  // The dead-lettered id was recovered, then BOTH ids landed on the live queue.
  assert.deepEqual(calls.recovered, ["dead"]);
  assert.deepEqual(base.backfillQueue, ["dead", "live"]);
  assert.equal(base.deadLetteredIds.has("dead"), false);
  assert.equal(calls.nudge, 1);
  assert.equal(logs.length, 1);
});

test("IDENTITY-MATCH: injecting before hydration (null hydratedSourceKey) is a no-op", () => {
  const base = makeState();
  const calls = { nudge: 0, revisitReset: 0, recovered: 0 };
  const ctx: BackfillQueueFeedContext = {
    ...base,
    // Identity is resolvable, but hydration has NOT completed for it yet.
    hydratedSourceKey: null,
    resolveSyncSourceKey: () => HYDRATED_KEY,
    recoverDeadLetteredId: () => {
      calls.recovered += 1;
    },
    resetDeadLetterRevisitGuard: () => {
      calls.revisitReset += 1;
    },
    nudgeAfterInject: () => {
      calls.nudge += 1;
    },
  };

  injectIdsIntoLiveQueue(ctx, ["h1"], HYDRATED_KEY, () => {
    // Must not log — the ids are left for hydration's own re-enqueue loop.
  });

  // The ids must NOT be pushed onto the live queue ahead of the pending
  // hydration / full-walk. They remain durable in the outbox for hydration.
  assert.deepEqual(base.backfillQueue, []);
  assert.equal(calls.nudge, 0);
  assert.equal(calls.revisitReset, 0);
});

test("IDENTITY-MATCH: the resolved identity drifted away from the hydrated one is a no-op", () => {
  const base = makeState();
  const ctx: BackfillQueueFeedContext = {
    ...base,
    hydratedSourceKey: HYDRATED_KEY,
    // The live identity drifted away from the hydrated one (account switch).
    resolveSyncSourceKey: () => "source-key-other",
    recoverDeadLetteredId: () => undefined,
    resetDeadLetterRevisitGuard: () => undefined,
    nudgeAfterInject: () => undefined,
  };

  injectIdsIntoLiveQueue(ctx, ["h1"], HYDRATED_KEY, () => undefined);

  assert.deepEqual(base.backfillQueue, []);
});

test("IDENTITY-MATCH: A-enqueued/B-hydrated — a captured key not matching the live+hydrated key is refused", () => {
  // The captured source key A no longer matches the live+hydrated identity B
  // (the compute target flipped during the awaited outbox/marker writes). A's ids
  // must be refused so they never enter B's lane and clear B's outbox key while A
  // stays pending.
  const base = makeState();
  let nudged = 0;
  const ctx: BackfillQueueFeedContext = {
    ...base,
    hydratedSourceKey: HYDRATED_KEY,
    resolveSyncSourceKey: () => HYDRATED_KEY,
    recoverDeadLetteredId: () => undefined,
    resetDeadLetterRevisitGuard: () => undefined,
    nudgeAfterInject: () => {
      nudged += 1;
    },
  };

  injectIdsIntoLiveQueue(ctx, ["h1"], "source-key-A", () => undefined);

  assert.deepEqual(base.backfillQueue, []);
  assert.equal(nudged, 0);
});

test("IDENTITY-MATCH: a null captured source key is refused", () => {
  const base = makeState();
  const ctx: BackfillQueueFeedContext = {
    ...base,
    hydratedSourceKey: HYDRATED_KEY,
    resolveSyncSourceKey: () => HYDRATED_KEY,
    recoverDeadLetteredId: () => undefined,
    resetDeadLetterRevisitGuard: () => undefined,
    nudgeAfterInject: () => undefined,
  };

  injectIdsIntoLiveQueue(ctx, ["h1"], null, () => undefined);

  assert.deepEqual(base.backfillQueue, []);
});

test("IDENTITY-MATCH: injecting while offline (null resolved source key) is a no-op", () => {
  const base = makeState();
  const ctx: BackfillQueueFeedContext = {
    ...base,
    hydratedSourceKey: null,
    resolveSyncSourceKey: () => null,
    recoverDeadLetteredId: () => undefined,
    resetDeadLetterRevisitGuard: () => undefined,
    nudgeAfterInject: () => undefined,
  };

  injectIdsIntoLiveQueue(ctx, ["h1"], HYDRATED_KEY, () => undefined);

  assert.deepEqual(base.backfillQueue, []);
});
