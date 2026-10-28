// ISS-6136 — the shared IN-list chunking bound, split out of
// `session-pr-links.test.ts` so neither file carries two responsibilities. The
// predicates and merged-PR classification stay there; the chunk helpers are a
// concern of their own (how an id list is split and how the slices are run),
// and they are the half this ticket changed.

import { describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "./db-fanout";
import {
  chunkQueryIds,
  countInIdChunks,
  LINK_BRANCH_QUERY_CHUNK_SIZE,
  readInIdChunks,
} from "./session-pr-links-chunking";

describe("chunkQueryIds", () => {
  it("never emits a chunk wider than the shared IN-list bound", () => {
    const ids = Array.from(
      { length: LINK_BRANCH_QUERY_CHUNK_SIZE * 2 + 1 },
      (_unused, index) => `id-${index}`
    );

    const chunks = chunkQueryIds(ids);

    expect(chunks).toHaveLength(3);
    expect(
      chunks.every((chunk) => chunk.length <= LINK_BRANCH_QUERY_CHUNK_SIZE)
    ).toBe(true);
    // A partition, not a sample: every id appears exactly once.
    expect(chunks.flat()).toEqual(ids);
  });

  it("emits nothing for an empty id list", () => {
    expect(chunkQueryIds([])).toEqual([]);
  });
});

describe("readInIdChunks", () => {
  // Built once: the point is a single chunk's `read` resolving to a row count
  // that overflows a spread into `Array#push`, not the shape of each row.
  const OVER_SPREAD_LIMIT_ROW_COUNT = 200_000;
  const bigRowSet = Array.from(
    { length: OVER_SPREAD_LIMIT_ROW_COUNT },
    (_unused, i) => ({ i })
  );

  it("accumulates 200,000 rows from a single chunk instead of throwing (RangeError regression)", async () => {
    // `rows.push(...(await read(chunk)))` threw `RangeError: Maximum call
    // stack size exceeded` on a chunk this wide, because the chunk bounds the
    // ID list (500) and NOT the row count — neither caller's `read` supplies a
    // `take`. A single id keeps `chunkQueryIds` to one chunk, so `read` is
    // exercised exactly once with the oversized result.
    const read = vi.fn(async (_chunk: string[]) => bigRowSet);

    const rows = await readInIdChunks(["id-1"], read);

    expect(rows).toHaveLength(OVER_SPREAD_LIMIT_ROW_COUNT);
  });

  it("returns rows in chunk order and preserves each chunk's row order", async () => {
    const ids = Array.from(
      { length: LINK_BRANCH_QUERY_CHUNK_SIZE * 2 + 1 },
      (_unused, index) => `id-${index}`
    );
    const read = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })));

    const rows = await readInIdChunks(ids, read);

    // The concatenated order is a direct function of chunk order (IDs) and
    // within-chunk order — asserted explicitly rather than just checking length.
    expect(rows).toEqual(ids.map((id) => ({ id })));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("calls read zero times and returns [] for an empty id list", async () => {
    const read = vi.fn(async (_chunk: string[]) => []);

    const rows = await readInIdChunks([], read);

    expect(read).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  // ISS-6136. The chunk loop used to `await` each chunk before starting the
  // next, so a scope wide enough to need N chunks paid N times the round trip
  // of one. Barrier, not a clock: every chunk's `read` blocks until as many as
  // the bound admits have entered TOGETHER, so a sequential implementation can
  // never release it and fails on the explicit timeout rather than passing
  // slowly. The id list chunks one PAST the bound (see `overBoundIds`) so the
  // case pins the CEILING too: dropping `mapWithDbConcurrency` for an unbounded
  // `Promise.all` peaks at the chunk count and reds this assertion.
  it("runs chunks concurrently rather than one at a time", async () => {
    const ids = overBoundIds();
    const expectedPeak = expectedPeakInFlight(chunkQueryIds(ids).length);
    let entered = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    let releaseAll = () => {
      // Replaced synchronously by the executor below, before any read runs.
    };
    const allEntered = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const read = vi.fn(async (chunk: string[]) => {
      entered += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (entered === expectedPeak) {
        releaseAll();
      }
      await allEntered;
      inFlight -= 1;
      return chunk.map((id) => ({ id }));
    });

    const rows = await readInIdChunks(ids, read);

    expect(peakInFlight).toBe(expectedPeak);
    // Concurrency must not cost the order callers index into: chunk order, then
    // within-chunk order, exactly as the sequential loop produced.
    expect(rows).toEqual(ids.map((id) => ({ id })));
  }, 10_000);

  // The order guarantee is only load-bearing when chunks can finish out of
  // order, which is precisely what concurrency introduced.
  it("returns rows in chunk order when later chunks resolve first", async () => {
    const ids = Array.from(
      { length: LINK_BRANCH_QUERY_CHUNK_SIZE * 2 + 1 },
      (_unused, index) => `id-${index}`
    );
    const pending: (() => void)[] = [];
    const read = vi.fn(
      (chunk: string[]) =>
        new Promise<{ id: string }[]>((resolve) => {
          pending.push(() => resolve(chunk.map((id) => ({ id }))));
        })
    );

    const rowsPromise = readInIdChunks(ids, read);
    await waitForCallCount(read, 3);
    // Settle last-to-first, the reverse of the order the chunks were issued in.
    for (const resolveChunk of [...pending].reverse()) {
      resolveChunk();
    }

    expect(await rowsPromise).toEqual(ids.map((id) => ({ id })));
  }, 10_000);
});

describe("countInIdChunks", () => {
  it("sums every chunk's count and runs the chunks concurrently", async () => {
    const ids = overBoundIds();
    const expectedPeak = expectedPeakInFlight(chunkQueryIds(ids).length);
    let entered = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    let releaseAll = () => {
      // Replaced synchronously by the executor below, before any count runs.
    };
    const allEntered = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const count = vi.fn(async (chunk: string[]) => {
      entered += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (entered === expectedPeak) {
        releaseAll();
      }
      await allEntered;
      inFlight -= 1;
      return chunk.length;
    });

    const total = await countInIdChunks(ids, count);

    expect(peakInFlight).toBe(expectedPeak);
    // The chunks partition the id list, so the sum is the whole population.
    expect(total).toBe(ids.length);
  }, 10_000);

  it("counts zero times and returns 0 for an empty id list", async () => {
    const count = vi.fn(async (_chunk: string[]) => 0);

    expect(await countInIdChunks([], count)).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });
});

/** Yields until `spy` has been called `times` times, or throws after 1,000 turns. */
async function waitForCallCount(
  spy: { mock: { calls: unknown[] } },
  times: number
): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (spy.mock.calls.length >= times) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `expected ${times} calls, saw ${spy.mock.calls.length} after 1000 microtask turns`
  );
}

/**
 * How many of `totalChunks` can be in flight at once under the shared bound.
 *
 * Derived, not written down: `DB_FANOUT_MAX_CONCURRENCY` is itself derived from
 * the pool size, and `db-fanout.ts` says shrinking the pool is MEANT to move it.
 * A hard-coded 3 here would, on a pool small enough to admit 2, leave the third
 * `read` never entering — so the barrier would never release and the case would
 * fail as a bare 10-second timeout pointing at a hang instead of at the bound.
 */
function expectedPeakInFlight(totalChunks: number): number {
  return Math.min(totalChunks, DB_FANOUT_MAX_CONCURRENCY);
}

/**
 * An id list that chunks into one MORE slice than the bound admits, so a barrier
 * case over it observes `DB_FANOUT_MAX_CONCURRENCY` rather than its own chunk
 * count.
 *
 * The distinction is what makes those cases able to fail. At or below the bound
 * the two implementations agree — 3 chunks peak at 3 whether the fan-out is
 * bounded or an unbounded `Promise.all` — so the assertion holds under the exact
 * mutation it exists to catch. One chunk past the bound separates them: bounded
 * peaks at the bound, unbounded peaks at the chunk count.
 */
function overBoundIds(): string[] {
  return Array.from(
    {
      length: LINK_BRANCH_QUERY_CHUNK_SIZE * (DB_FANOUT_MAX_CONCURRENCY + 1),
    },
    (_unused, index) => `id-${index}`
  );
}
