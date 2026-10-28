/**
 * @file bounded-map.test.ts
 * @description ISS-9678 — the merged suite for the one bounded-map primitive,
 * carrying what `apps/api/lib/bounded-cache.test.ts` and the `BoundedMap` block
 * of `apps/desktop/test/sync-hygiene-bounded-caches.test.ts` each pinned before
 * the two implementations were folded together.
 *
 * Every cap here is a LITERAL rather than a read of a production constant, so a
 * retune fails a consumer's own test rather than silently carrying its
 * expectation along with it.
 *
 * Counterfactuals, each naming only what it actually kills: dropping the
 * constructor guard entirely fails "rejects every cap it cannot honor"; keeping
 * the guard but writing it as `maxEntries < 1` without the `isSafeInteger` half
 * fails only the `1.5`, `NaN`, `Infinity`, and past-safe-range rows, and the
 * `NaN` row is the one that matters — a `NaN` cap makes every `size >= cap`
 * comparison false, so the map grows without limit while reading as bounded.
 * Reverting `set` to the pre-merge `BoundedCache` body — `if (this.has(key))
 * delete; else if (size >= cap) evict-with-an-`!== undefined`-guard` — fails
 * only "evicts an `undefined` key". Widening the cap comparison from `>=` to
 * `>` fails "never exceeds its cap". Dropping the rewrite refresh fails
 * "re-writing a key at capacity". Moving the cap off the instance onto a
 * module-level `let` the constructor overwrites fails ONLY "holds each
 * instance's cap independently" — every other case here runs one map to
 * completion before the next is constructed, so the shared write lands too
 * late for any of them to observe it.
 */
import { describe, expect, it } from "vitest";
import { BoundedMap } from "./bounded-map";

describe("BoundedMap", () => {
  it("rejects every cap it cannot honor", () => {
    for (const cap of [
      0,
      -1,
      -10_000,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => new BoundedMap<string, number>(cap), `cap ${cap}`).toThrow(
        RangeError
      );
    }
  });

  // The sibling of the rejection table: a cap on the accepted side of every
  // boundary above must construct, or the guard could be passing by rejecting
  // everything.
  it("accepts the smallest and largest caps it can honor, and bounds at both", () => {
    const smallest = new BoundedMap<string, number>(1);
    smallest.set("a", 1);
    smallest.set("b", 2);
    expect([...smallest.entries()]).toEqual([["b", 2]]);

    const largest = new BoundedMap<string, number>(Number.MAX_SAFE_INTEGER);
    largest.set("a", 1);
    largest.set("b", 2);
    expect(largest.size).toBe(2);
  });

  // Two live caps, written INTERLEAVED. The order is the whole point: every
  // other case here holds one map at a time, and the boundary case above
  // finishes with its cap-1 map before constructing the cap-MAX one, so a cap
  // kept in module or static state rather than on the instance satisfies all of
  // them. Interleaving is what lets the second construction be observed by the
  // first map, and six caps on one class collapsing to whichever was built last
  // is a process-wide unbounded map wearing a bound.
  it("holds each instance's cap independently", () => {
    const tight = new BoundedMap<string, number>(2);
    const loose = new BoundedMap<string, number>(5);

    for (const [index, key] of ["a", "b", "c", "d", "e"].entries()) {
      tight.set(key, index);
      loose.set(key, index);
    }

    expect([...tight.entries()]).toEqual([
      ["d", 3],
      ["e", 4],
    ]);
    expect([...loose.keys()]).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("evicts the oldest write once the cap is reached, keeping the newest", () => {
    const map = new BoundedMap<string, number>(3);
    for (const [index, key] of ["a", "b", "c", "d", "e"].entries()) {
      map.set(key, index);
    }
    expect([...map.entries()]).toEqual([
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]);
  });

  it("re-writing a key at capacity refreshes it and evicts nothing", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // Deliberately NOT the oldest key: overwriting the oldest one is the single
    // case where evict-then-write and refresh-then-write agree, so a test that
    // rewrote "a" here would pass against a `set` that had no refresh at all.
    map.set("b", 9);
    expect([...map.keys()]).toEqual(["a", "c", "b"]);

    // "b" was just refreshed, so the next insert must take "a", not "b".
    map.set("d", 4);
    expect([...map.entries()]).toEqual([
      ["c", 3],
      ["b", 9],
      ["d", 4],
    ]);
  });

  it("never exceeds its cap under repeated insertion", () => {
    const map = new BoundedMap<number, number>(3);
    for (let value = 0; value < 100; value += 1) {
      map.set(value, value);
      expect(map.size).toBeLessThanOrEqual(3);
    }
    expect([...map.keys()]).toEqual([97, 98, 99]);
  });

  // The one behavioural defect the merge closed beyond validation. The retired
  // `BoundedCache` guarded its eviction with `oldest !== undefined`, so a map
  // whose oldest key WAS `undefined` evicted nothing and grew one past its cap
  // on every such pass. `!oldest.done` distinguishes "the map is empty" from
  // "the oldest key is `undefined`", which is the distinction that guard
  // collapsed.
  it("evicts an `undefined` key rather than growing past the cap", () => {
    const map = new BoundedMap<string | undefined, number>(2);
    map.set(undefined, 0);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    expect(map.has(undefined)).toBe(false);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });
});
