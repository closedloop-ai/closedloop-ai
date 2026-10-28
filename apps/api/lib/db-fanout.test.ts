/**
 * FEA-3299: unit tests for the bounded DB fan-out helper.
 *
 * The pooled-connection guarantee lives here, so per-site regression tests can
 * assert their call site routes through the helper without re-proving the
 * bounding itself.
 */
import {
  createDbAcquisitionBudget,
  withDbAcquisitionBudget,
} from "@repo/database/acquisition-budget";
import {
  DB_ACQUISITION_BUDGET_MAX,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
  DB_POOL_MAX_IAM,
} from "@repo/database/pool-config";
import { describe, expect, it } from "vitest";
import {
  createCountingPool,
  readWithRelations,
} from "./__tests__/support/counting-pool";
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
    // every pre-existing bounded site (ingest-repo-execution-results, google
    // import, gdrive import) use. If the derivation ever moves
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
  // helper's `limiter` parameter exists to prevent.
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
    // holding, a shared limiter is no longer load-bearing.
    const { run, state } = trackPeak();

    await Promise.all([
      mapWithDbConcurrency(items, (item) => run(item)),
      mapWithDbConcurrency(items, (item) => run(item)),
    ]);

    expect(state.peak).toBeGreaterThan(DB_FANOUT_MAX_CONCURRENCY);
    expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY * 2);
  });
});

describe("mapWithDbConcurrency connection budget (ISS-8431)", () => {
  // Wide enough that the call bound alone cannot pass these: with 10 relation
  // edges a mapped call takes 11 connections, so bounding calls at 5 admits 55.
  const RELATION_EDGES = 10;
  const ITEM_COUNT = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;
  const items = Array.from({ length: ITEM_COUNT }, (_, i) => i);
  // Wide enough that a single in-flight call fills a budget on its own.
  const SATURATING_EDGES = DB_ACQUISITION_BUDGET_MAX * 2;

  it("bounds peak connections when every mapped call carries an include tree", async () => {
    const { pool, state } = createCountingPool();

    await mapWithDbConcurrency(items, () =>
      readWithRelations(pool, RELATION_EDGES)
    );

    // Bounding CALLS is what this helper used to promise, and it is not this:
    // 5 concurrent calls x 11 connections each is 55 against a pool of 10. The
    // assertion is on connections precisely because the two units diverged.
    expect(state.peak).toBeLessThanOrEqual(DB_ACQUISITION_BUDGET_MAX);
    expect(state.peak).toBeGreaterThan(1);
  });

  it("still bounds connections when the mapped calls are already limited to one", async () => {
    // Even a single in-flight call outruns the pool on its own once its include
    // tree is wider than the pool, so the call bound cannot be the thing saving
    // us here.
    const { pool, state } = createCountingPool();

    await mapWithDbConcurrency([0], () =>
      readWithRelations(pool, DB_POOL_MAX_DATABASE_URL_DEFAULT + 5)
    );

    expect(state.peak).toBeLessThanOrEqual(DB_ACQUISITION_BUDGET_MAX);
  });

  it("the same fan-out is unbounded in connections without the budget", async () => {
    // The counterfactual, so the two assertions above cannot quietly become
    // vacuous: run the identical work with no budget in scope and watch the
    // call bound fail to contain it.
    const { pool, state } = createCountingPool();

    await Promise.all(
      items
        .slice(0, DB_FANOUT_MAX_CONCURRENCY)
        .map(() => readWithRelations(pool, RELATION_EDGES))
    );

    expect(state.peak).toBe(DB_FANOUT_MAX_CONCURRENCY * (RELATION_EDGES + 1));
    expect(state.peak).toBeGreaterThan(DB_POOL_MAX_DATABASE_URL_DEFAULT);
  });

  it("stacks to N x the budget across sibling fan-outs with no outer scope", async () => {
    // The unit correction does not survive sibling stacking on its own: each
    // `mapWithDbConcurrency` opens its OWN budget when nothing wraps it, so two
    // siblings admit twice the ceiling against one pool. This is the
    // counterfactual for the case below.
    const { pool, state } = createCountingPool();
    const limiter = createDbFanoutLimiter();

    // Wider than the budget, so ONE in-flight call saturates its own scope. With
    // a narrower tree the peak would depend on how the shared limiter happened
    // to split its slots between the two siblings, and the assertion would be
    // measuring scheduling rather than the stacking.
    await Promise.all([
      mapWithDbConcurrency(
        items,
        () => readWithRelations(pool, SATURATING_EDGES),
        limiter
      ),
      mapWithDbConcurrency(
        items,
        () => readWithRelations(pool, SATURATING_EDGES),
        limiter
      ),
    ]);

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX * 2);
    // Two siblings alone take the WHOLE `DATABASE_URL` pool, leaving nothing
    // for the concurrent requests the pool exists to serve. That is the
    // starvation shape.
    expect(state.peak).toBeGreaterThanOrEqual(DB_POOL_MAX_DATABASE_URL_DEFAULT);
  });

  it("collapses sibling fan-outs onto one budget when wrapped in a single scope", async () => {
    // The remedy for the case above, and what a caller with concurrent siblings
    // must do: one scope, which the inner fan-outs join rather than opening
    // their own.
    const { pool, state } = createCountingPool();
    const limiter = createDbFanoutLimiter();

    await withDbAcquisitionBudget(
      async () =>
        await Promise.all([
          mapWithDbConcurrency(
            items,
            () => readWithRelations(pool, SATURATING_EDGES),
            limiter
          ),
          mapWithDbConcurrency(
            items,
            () => readWithRelations(pool, SATURATING_EDGES),
            limiter
          ),
        ]),
      createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("shares one connection budget across a fan-out's mapped calls", async () => {
    // Each mapped call joining the fan-out's scope rather than opening its own
    // is what makes the bound describe the fan-out instead of one call.
    const { pool, state } = createCountingPool();

    await mapWithDbConcurrency(items, () => readWithRelations(pool, 3));

    expect(state.peak).toBeLessThanOrEqual(DB_ACQUISITION_BUDGET_MAX);
  });
});
