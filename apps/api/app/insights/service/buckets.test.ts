/**
 * ISS-4754 (ruling 5) — `bucketByLabelCounts` must be a pure function of its
 * entries, not of the order they arrived in.
 *
 * WHY THIS IS NOT A STYLE TEST. The sort was `(a, b) => b.value - a.value` with
 * no secondary key, so equal counts fell through to `Map` insertion order. The
 * entries come straight from a Postgres `groupBy` / `GROUPING SETS`, whose row
 * order is unordered by contract — so the SAME data could emit a different array
 * on two reads. Measured before the fix: `[Read, Bash, Glob]` all at 1 emitted
 * `Read,Bash,Glob` inserted one way and `Glob,Bash,Read` inserted the other.
 *
 * The golden corpus makes it bite: `core_features.tool_counts` holds a ten-way
 * tie at 1 (plus ties at 2, 3, 6, 13, 22, 72), and Golden Layer 5 freezes these
 * responses as byte-compared fixtures. A nondeterministic tie order would bake
 * one arbitrary permutation into a committed fixture and make its byte-stability
 * assertion permanently flaky.
 *
 * The first case is the counterfactual: it fails on the pre-fix implementation
 * and passes after, so it cannot go vacuously green.
 *
 * ONE existing assertion moved because of this: `service.test.ts`'s
 * `sessionsByStatus` expectation is a 1-1 tie between "Completed" and "Active",
 * so it now reads `[Active, Completed]`. That file is grandfathered shrink-only,
 * which is why the reasoning lives here rather than as a comment beside it.
 */
import { describe, expect, it } from "vitest";
import { bucketByLabelCounts } from "@/app/insights/service/buckets";

const TIED_ASCENDING = [
  { label: "Bash", value: 1 },
  { label: "Glob", value: 1 },
  { label: "Read", value: 1 },
];

const TIED_DESCENDING = [
  { label: "Read", value: 1 },
  { label: "Glob", value: 1 },
  { label: "Bash", value: 1 },
];

describe("bucketByLabelCounts", () => {
  it("emits the same order for tied counts regardless of insertion order", () => {
    const forward = bucketByLabelCounts(TIED_ASCENDING);
    const reversed = bucketByLabelCounts(TIED_DESCENDING);

    expect(forward).toEqual(reversed);
    expect(forward.map((bucket) => bucket.label)).toEqual([
      "Bash",
      "Glob",
      "Read",
    ]);
  });

  it("keeps descending count as the primary key, so the tie-break never outranks it", () => {
    const buckets = bucketByLabelCounts([
      { label: "Zebra", value: 9 },
      { label: "Alpha", value: 2 },
    ]);

    expect(buckets.map((bucket) => bucket.label)).toEqual(["Zebra", "Alpha"]);
  });

  it("merges labels that collide after transformation before ranking them", () => {
    const buckets = bucketByLabelCounts([
      { label: "In Progress", value: 3 },
      { label: "Unknown", value: 1 },
      { label: "In Progress", value: 2 },
    ]);

    expect(buckets).toEqual([
      { key: "In Progress", label: "In Progress", value: 5 },
      { key: "Unknown", label: "Unknown", value: 1 },
    ]);
  });

  it("returns an empty list for no entries rather than a zero-valued bucket", () => {
    expect(bucketByLabelCounts([])).toEqual([]);
  });
});
