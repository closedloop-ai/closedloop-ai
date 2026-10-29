/**
 * ISS-8200: the ordering and origin contract of the shared identity probe.
 *
 * Each case here pins a property a single `findFirst(... { in: candidates })`
 * CANNOT express, which is why the probe is ordered rather than a set read:
 * which key wins when two rows exist, and which candidate set a value gets given
 * where it came from.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IndexKeyOrigin,
  indexKeyLookupCandidates,
  normalizeStoredIndexKey,
  resolveByAnyIndexKey,
} from "./index-key-lookup";
import {
  hasProjectedIndexKeyShape,
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "./index-key-projection";

/** Over the byte budget, so it is genuinely re-keyed at the write. */
const OVER_BUDGET = "s".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED = projectIndexKey(OVER_BUDGET).value;
/** A realistic id, inside the budget — the shape of essentially all traffic. */
const IN_BUDGET = "019ff900-1000-7000-8000-000000000001";

/** A fake point read that only knows about rows stored under `storedKeys`. */
function storeHolding(storedKeys: readonly string[]) {
  return vi.fn((candidate: string) =>
    Promise.resolve(
      storedKeys.includes(candidate) ? { artifactId: `row:${candidate}` } : null
    )
  );
}

describe("resolveByAnyIndexKey", () => {
  it("resolves a legacy row still stored under its RAW key", async () => {
    // The ISS-8200 defect: the write re-keyed to the projection, so a lane
    // asking only for the projected key misses a row that has been sitting
    // under the raw value since before ISS-8069.
    const find = storeHolding([OVER_BUDGET]);

    const match = await resolveByAnyIndexKey(OVER_BUDGET, find);

    expect(match?.record).toEqual({ artifactId: `row:${OVER_BUDGET}` });
    expect(match?.storedKey).toBe(OVER_BUDGET);
  });

  it("prefers the PROJECTED row and never probes the raw key when it exists", async () => {
    // The ordering IS the contract. Both rows exist, and the projected key is
    // what every write since ISS-8069 lands on, so it must win — a single
    // `in` list over both candidates would pick between them unordered and the
    // same identity could resolve to a different row on consecutive requests.
    const find = storeHolding([PROJECTED, OVER_BUDGET]);

    const match = await resolveByAnyIndexKey(OVER_BUDGET, find);

    expect(match?.storedKey).toBe(PROJECTED);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(PROJECTED);
  });

  it("costs exactly one probe for a value inside the byte budget", async () => {
    // What keeps this affordable on every ordinary request: an id the budget
    // never bound has ONE candidate, so the probe degenerates to the single
    // lookup it replaced.
    const find = storeHolding([IN_BUDGET]);

    const match = await resolveByAnyIndexKey(IN_BUDGET, find);

    expect(match?.storedKey).toBe(IN_BUDGET);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("returns null when the identity has no row under any candidate", async () => {
    const find = storeHolding([]);

    expect(await resolveByAnyIndexKey(OVER_BUDGET, find)).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("never re-projects a STORED value, which would land on a key no table holds", async () => {
    // `projectIndexKey` is deliberately not idempotent (ISS-8254), so
    // projecting a value read back OUT of a column digests the PROJECTION
    // rather than the original. The stored origin exists to stop that.
    const find = storeHolding([PROJECTED]);

    const match = await resolveByAnyIndexKey(
      PROJECTED,
      find,
      IndexKeyOrigin.Stored
    );

    expect(match?.storedKey).toBe(PROJECTED);
    expect(find).not.toHaveBeenCalledWith(projectIndexKey(PROJECTED).value);
  });
});

describe("indexKeyLookupCandidates", () => {
  it("offers the projected key then the raw key for an over-budget WIRE value", () => {
    expect(indexKeyLookupCandidates(OVER_BUDGET)).toEqual([
      PROJECTED,
      OVER_BUDGET,
    ]);
  });

  it("offers a STORED projected key only as itself", () => {
    expect(hasProjectedIndexKeyShape(PROJECTED)).toBe(true);
    expect(indexKeyLookupCandidates(PROJECTED, IndexKeyOrigin.Stored)).toEqual([
      PROJECTED,
    ]);
  });

  it("offers a STORED raw over-budget key plus the key it would project to", () => {
    // The other direction of the same miss: a sibling table that DID project
    // the column holds the projected form of a value this table stored raw.
    expect(
      indexKeyLookupCandidates(OVER_BUDGET, IndexKeyOrigin.Stored)
    ).toEqual([OVER_BUDGET, PROJECTED]);
  });

  it("degenerates to the single key for an in-budget value in either origin", () => {
    expect(indexKeyLookupCandidates(IN_BUDGET)).toEqual([IN_BUDGET]);
    expect(indexKeyLookupCandidates(IN_BUDGET, IndexKeyOrigin.Stored)).toEqual([
      IN_BUDGET,
    ]);
  });
});

describe("normalizeStoredIndexKey", () => {
  it("folds a legacy RAW key onto the projected key callers index on", () => {
    // The set-read half of the fix: a union `in` returns rows under whichever
    // key each is stored, and they have to land in the caller's map under ONE
    // key or the widened read resolves nothing it can look up again.
    expect(normalizeStoredIndexKey(OVER_BUDGET)).toBe(PROJECTED);
  });

  it("returns an already-projected key unchanged", () => {
    // The trap: `projectIndexKey` is not idempotent (ISS-8254), so re-projecting
    // a stored projection digests the projection and yields a third key that
    // matches nothing. Deleting the shape guard makes this return that key.
    expect(normalizeStoredIndexKey(PROJECTED)).toBe(PROJECTED);
    expect(projectIndexKey(PROJECTED).value).not.toBe(PROJECTED);
  });

  it("leaves an in-budget key alone", () => {
    expect(normalizeStoredIndexKey(IN_BUDGET)).toBe(IN_BUDGET);
  });
});
