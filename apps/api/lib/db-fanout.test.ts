/**
 * FEA-3299: unit tests for the bounded DB fan-out helper.
 *
 * The pooled-connection guarantee lives here, so per-site regression tests can
 * assert their call site routes through the helper without re-proving the
 * bounding itself.
 */
import {
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
  DB_POOL_MAX_IAM,
} from "@repo/database/pool-config";
import { describe, expect, it } from "vitest";
import {
  createDbFanoutLimiter,
  DB_FANOUT_MAX_CONCURRENCY,
  mapWithDbConcurrency,
} from "./db-fanout";

describe("DB_FANOUT_MAX_CONCURRENCY", () => {
  // The 2026-07-15 outage happened because a payload cap (200) and a pool size
  // (20) were set independently and only met at runtime. These pin the bound to
  // the pool so the two cannot drift apart again: shrink either pool and this
  // fails rather than silently re-opening the fan-out.
  it("spends at most half of the smallest pool", () => {
    const smallestPool = Math.min(
      DB_POOL_MAX_IAM,
      DB_POOL_MAX_DATABASE_URL_DEFAULT
    );

    expect(DB_FANOUT_MAX_CONCURRENCY).toBeLessThanOrEqual(smallestPool / 2);
  });

  it("stays above 1 so bounding does not serialize the fan-out", () => {
    expect(DB_FANOUT_MAX_CONCURRENCY).toBeGreaterThan(1);
  });

  it("resolves to 5 — the bound #2892 set by hand for the incident path", () => {
    // Not redundant with the derivation: this is the value the incident fix and
    // every pre-existing bounded site (pr-read-repair, ingest-repo-execution-
    // results, google import, gdrive import) use. If the derivation ever moves
    // it, that divergence should be a deliberate, visible change.
    expect(DB_FANOUT_MAX_CONCURRENCY).toBe(5);
  });
});

/**
 * Track peak concurrent executions of a mapper.
 *
 * Yields several microtasks inside the tracked window so that overlapping calls
 * are observed as in-flight simultaneously before any of them settles — without
 * this an unbounded fan-out can serialize by accident and hide the bug.
 */
function trackPeak() {
  const state = { inFlight: 0, peak: 0 };
  const run = async <T>(value: T): Promise<T> => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.inFlight -= 1;
    return value;
  };
  return { run, state };
}

describe("mapWithDbConcurrency", () => {
  // Sized off the bound rather than hardcoded: the payload must exceed the bound
  // or the assertions have no power — with items <= bound an unbounded fan-out
  // would pass them too.
  const ITEM_COUNT = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;
  const items = Array.from({ length: ITEM_COUNT }, (_, i) => i);

  it("bounds peak in-flight to DB_FANOUT_MAX_CONCURRENCY", async () => {
    const { run, state } = trackPeak();

    await mapWithDbConcurrency(items, (item) => run(item));

    // An unbounded Promise.all would peak at 12 here.
    expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
    expect(state.peak).toBeGreaterThan(1);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];

    await mapWithDbConcurrency(items, async (item) => {
      await Promise.resolve();
      seen.push(item);
      return item;
    });

    expect(seen).toHaveLength(ITEM_COUNT);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("preserves input order in the result regardless of settle order", async () => {
    // Later items resolve first; the result must still line up with `items`,
    // because callers index into it and .flat() it.
    const result = await mapWithDbConcurrency(items, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, ITEM_COUNT - item));
      return item * 2;
    });

    expect(result).toEqual(items.map((item) => item * 2));
  });

  it("passes the index to the mapper", async () => {
    const result = await mapWithDbConcurrency(["a", "b", "c"], (item, index) =>
      Promise.resolve(`${index}:${item}`)
    );

    expect(result).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("is fail-fast: a rejecting item propagates rather than being swallowed", async () => {
    await expect(
      mapWithDbConcurrency(items, (item) =>
        item === 3 ? Promise.reject(new Error("boom")) : Promise.resolve(item)
      )
    ).rejects.toThrow("boom");
  });

  it("returns an empty array for empty input without invoking the mapper", async () => {
    let calls = 0;

    const result = await mapWithDbConcurrency([], () => {
      calls += 1;
      return Promise.resolve(null);
    });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  // Bounds compose by addition, not by maximum. Two sibling fan-outs that each
  // build their own limiter peak at 2x the bound — which is exactly the bug this
  // helper's `limiter` parameter exists to prevent (loop-context-pack.ts).
  it("shares one concurrency budget across sibling fan-outs when given a limiter", async () => {
    const { run, state } = trackPeak();
    const limiter = createDbFanoutLimiter();

    await Promise.all([
      mapWithDbConcurrency(items, (item) => run(item), limiter),
      mapWithDbConcurrency(items, (item) => run(item), limiter),
    ]);

    expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
  });

  it("stacks to 2x when sibling fan-outs each build their own limiter", async () => {
    // Documents the failure mode the shared limiter prevents. If this ever stops
    // holding, the sharing in loop-context-pack is no longer load-bearing.
    const { run, state } = trackPeak();

    await Promise.all([
      mapWithDbConcurrency(items, (item) => run(item)),
      mapWithDbConcurrency(items, (item) => run(item)),
    ]);

    expect(state.peak).toBeGreaterThan(DB_FANOUT_MAX_CONCURRENCY);
    expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY * 2);
  });
});
