import assert from "node:assert/strict";
import test from "node:test";
import {
  InsightsResultCache,
  insightsCacheKey,
} from "../src/main/database/db-host/insights-cache.js";

const KEY_A = insightsCacheKey(["delivery", "90"]);
const KEY_B = insightsCacheKey(["utilization", "90"]);

test("returns a cached result without recomputing on a hit at the same epoch", async () => {
  let calls = 0;
  const cache = new InsightsResultCache();
  const compute = () => {
    calls++;
    return Promise.resolve({ n: calls });
  };

  const first = await cache.get(KEY_A, compute);
  const second = await cache.get(KEY_A, compute);

  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(second, { n: 1 });
  assert.equal(calls, 1, "second hit must not recompute");
});

test("recomputes after the epoch advances past the cooldown", async () => {
  let nowMs = 1000;
  let calls = 0;
  const cache = new InsightsResultCache({
    staleServeCooldownMs: 100,
    now: () => nowMs,
  });
  const compute = () => {
    calls++;
    return Promise.resolve({ n: calls });
  };

  assert.deepEqual(await cache.get(KEY_A, compute), { n: 1 });
  cache.bumpDataEpoch();
  // Advance the clock past the cooldown so the stale entry recomputes.
  nowMs += 200;
  assert.deepEqual(await cache.get(KEY_A, compute), { n: 2 });
  assert.equal(calls, 2);
});

test("serves the last-good value while the epoch churns inside the cooldown (backfill debounce)", async () => {
  let nowMs = 1000;
  let calls = 0;
  const cache = new InsightsResultCache({
    staleServeCooldownMs: 5000,
    now: () => nowMs,
  });
  const compute = () => {
    calls++;
    return Promise.resolve({ n: calls });
  };

  assert.deepEqual(await cache.get(KEY_A, compute), { n: 1 });
  // Simulate a backfill: epoch advances many times within the cooldown window.
  for (let i = 0; i < 50; i++) {
    cache.bumpDataEpoch();
    nowMs += 10; // still well under the 5000ms cooldown in aggregate
    assert.deepEqual(
      await cache.get(KEY_A, compute),
      { n: 1 },
      "stale-but-present value is served during backfill"
    );
  }
  assert.equal(calls, 1, "no recompute thrash during backfill");
});

test("single-flights concurrent identical requests", async () => {
  let calls = 0;
  let resolveCompute: (() => void) | null = null;
  const cache = new InsightsResultCache();
  const compute = () =>
    new Promise<{ n: number }>((resolve) => {
      calls++;
      resolveCompute = () => resolve({ n: calls });
    });

  const p1 = cache.get(KEY_A, compute);
  const p2 = cache.get(KEY_A, compute);
  // Let the concurrency slot acquire (a microtask) so compute actually starts.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, "only one computation starts for identical keys");

  resolveCompute?.();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, { n: 1 });
  assert.deepEqual(r2, { n: 1 });
});

test("bounds concurrency across different keys to one computation at a time", async () => {
  let running = 0;
  let maxRunning = 0;
  const cache = new InsightsResultCache({ maxConcurrency: 1 });
  const makeCompute = (value: string) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return value;
  };

  const [a, b] = await Promise.all([
    cache.get(KEY_A, makeCompute("a")),
    cache.get(KEY_B, makeCompute("b")),
  ]);

  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(maxRunning, 1, "at most one computation runs concurrently");
});
