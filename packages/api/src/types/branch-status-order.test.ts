import { describe, expect, it } from "vitest";
import { ARTIFACT_STATUS_ROOT } from "./artifact-status.ts";
import { BRANCH_STATUS_MAPPING } from "./artifact-status-mapping.ts";
import { BranchStatus } from "./branch.ts";
import {
  BRANCH_STATUS_ROOT_FIRST_ORDER,
  BRANCH_STATUS_SORT_ORDER,
  BranchStatusOrderingName,
  branchStatusOrderingFor,
  branchStatusRank,
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "./branch-status-order.ts";

describe("BRANCH_STATUS_ROOT_FIRST_ORDER", () => {
  /**
   * The literal is the oracle on purpose. Deriving the expectation the same way the
   * implementation does would assert only that a stable sort is stable; this pins the
   * ORDER a reader actually sees, which is the thing ISS-9437 changes.
   */
  it("puts draft first and keeps the vocabulary order inside each root", () => {
    expect([...BRANCH_STATUS_ROOT_FIRST_ORDER]).toEqual([
      BranchStatus.Draft,
      BranchStatus.Open,
      BranchStatus.Review,
      BranchStatus.Blocked,
      BranchStatus.Merged,
      BranchStatus.Closed,
    ]);
  });

  it("is the same option SET as today, only reordered", () => {
    expect([...BRANCH_STATUS_ROOT_FIRST_ORDER].sort()).toEqual(
      [...BRANCH_STATUS_SORT_ORDER].sort()
    );
  });

  it("is non-decreasing in root rank, which is what makes it root-first", () => {
    const roots = BRANCH_STATUS_ROOT_FIRST_ORDER.map(
      (status) => BRANCH_STATUS_MAPPING[status as BranchStatus].root
    );
    const rootOrder = Object.values(ARTIFACT_STATUS_ROOT);
    const ranks = roots.map((root) => rootOrder.indexOf(root as never));

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

/**
 * The flag-OFF path must not move a single row. That includes a quirk: today an
 * unrecognized or absent status ranks at `BRANCH_STATUS_SORT_ORDER.length`, so it
 * sorts last on ascending and FIRST on descending. Reproducing it exactly is the
 * contract — correcting it here would ship a perceivable reorder on the default
 * path, which the closed-by-default policy forbids.
 */
describe("DEFAULT_BRANCH_STATUS_ORDERING", () => {
  it("ranks identically to branchStatusRank for every status, including misses", () => {
    for (const status of Object.values(BranchStatus)) {
      expect(DEFAULT_BRANCH_STATUS_ORDERING.rank(status)).toBe(
        branchStatusRank(status)
      );
    }
    expect(DEFAULT_BRANCH_STATUS_ORDERING.rank("not-a-status")).toBe(
      branchStatusRank("not-a-status")
    );
    expect(DEFAULT_BRANCH_STATUS_ORDERING.rank(null)).toBe(
      branchStatusRank(null)
    );
  });

  it("never reports null, so no comparator changes its null handling when the flag is off", () => {
    expect(DEFAULT_BRANCH_STATUS_ORDERING.rank("not-a-status")).not.toBe(null);
    expect(DEFAULT_BRANCH_STATUS_ORDERING.rank(null)).not.toBe(null);
  });

  it("serves today's facet order", () => {
    expect([...DEFAULT_BRANCH_STATUS_ORDERING.order]).toEqual([
      ...BRANCH_STATUS_SORT_ORDER,
    ]);
  });
});

describe("ROOT_FIRST_BRANCH_STATUS_ORDERING", () => {
  it("ranks draft before open — the visible flip", () => {
    const draft = ROOT_FIRST_BRANCH_STATUS_ORDERING.rank(BranchStatus.Draft);
    const open = ROOT_FIRST_BRANCH_STATUS_ORDERING.rank(BranchStatus.Open);

    expect(draft).not.toBe(null);
    expect(open).not.toBe(null);
    expect(draft as number).toBeLessThan(open as number);
  });

  it("reports an unranked status as null, which is what parks it last in BOTH directions", () => {
    expect(ROOT_FIRST_BRANCH_STATUS_ORDERING.rank("not-a-status")).toBe(null);
    expect(ROOT_FIRST_BRANCH_STATUS_ORDERING.rank(null)).toBe(null);
    expect(ROOT_FIRST_BRANCH_STATUS_ORDERING.rank(undefined)).toBe(null);
    expect(ROOT_FIRST_BRANCH_STATUS_ORDERING.rank("")).toBe(null);
  });

  it("serves the SAME array its rank is derived from, so sort order equals facet order", () => {
    expect(ROOT_FIRST_BRANCH_STATUS_ORDERING.order).toBe(
      BRANCH_STATUS_ROOT_FIRST_ORDER
    );
    const ranks = BRANCH_STATUS_ROOT_FIRST_ORDER.map((status) =>
      ROOT_FIRST_BRANCH_STATUS_ORDERING.rank(status)
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("branchStatusOrderingFor", () => {
  it("selects a whole ordering rather than handing back the boolean", () => {
    expect(branchStatusOrderingFor(false)).toBe(DEFAULT_BRANCH_STATUS_ORDERING);
    expect(branchStatusOrderingFor(true)).toBe(
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );
    expect(branchStatusOrderingFor(false).name).toBe(
      BranchStatusOrderingName.Vocabulary
    );
    expect(branchStatusOrderingFor(true).name).toBe(
      BranchStatusOrderingName.RootFirst
    );
  });
});
