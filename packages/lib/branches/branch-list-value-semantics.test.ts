import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  buildBranchServerPage,
  countImpossibleBranchLastActiveInstants,
  countRetainedUnavailableBranchRows,
} from "./branch-list-page";
import {
  branchRow,
  branchServerPageQuery,
} from "./branch-list-page.test-fixtures";

const NOW = "2026-08-18T18:00:00.000Z";
const IN_WINDOW = "2026-08-18T12:00:00.000Z";
const BEFORE_WINDOW = "2026-08-01T12:00:00.000Z";
const WINDOW_START = "2026-08-18T00:00:00.000Z";
const AFTER_NOW = "2027-01-01T00:00:00.000Z";

function idsOf(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe("Branch list bad and absent value semantics", () => {
  it("retains a branch with no last-active instant inside a date window", () => {
    const page = buildBranchServerPage(
      [
        branchRow({ id: "in-window", lastActivityAt: IN_WINDOW }),
        branchRow({ id: "before-window", lastActivityAt: BEFORE_WINDOW }),
        branchRow({ id: "no-activity", lastActivityAt: "" }),
      ],
      branchServerPageQuery({
        startDate: WINDOW_START,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );

    expect(idsOf(page.items).sort()).toEqual(["in-window", "no-activity"]);
    expect(page.total).toBe(2);
  });

  /**
   * The `unavailable` column's own case, which nothing exercised before #7893:
   * this row's Last-active metric FAILED TO LOAD, so it reaches the window as
   * `Unavailable` rather than `Missing`, and the window reads that column for it.
   * Flipping `BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS.unavailable` to `Exclude`
   * drops `metric-unavailable` here and leaves `no-activity` above untouched.
   */
  it("retains a branch whose last-active metric could not be loaded", () => {
    const page = buildBranchServerPage(
      [
        branchRow({ id: "in-window", lastActivityAt: IN_WINDOW }),
        branchRow({ id: "before-window", lastActivityAt: BEFORE_WINDOW }),
        branchRow({
          id: "metric-unavailable",
          lastActivityAt: IN_WINDOW,
          canonicalLastActiveAt: {
            state: BranchMetricAvailability.Unavailable,
            value: null,
          },
        }),
      ],
      branchServerPageQuery({
        startDate: WINDOW_START,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );

    expect(idsOf(page.items).sort()).toEqual([
      "in-window",
      "metric-unavailable",
    ]);
  });

  /**
   * ISS-9482's "never coerce a malformed value into a plausible one": an instant
   * that cannot be true is still retained by the window — that is the graceful
   * result and it does not change — but it is COUNTED, so corrupt stored activity
   * is distinguishable from a branch nobody has touched.
   */
  it("counts an impossible last-active instant without hiding the branch", () => {
    const rows = [
      branchRow({ id: "in-window", lastActivityAt: IN_WINDOW }),
      branchRow({ id: "unparseable", lastActivityAt: "not-a-timestamp" }),
      branchRow({ id: "future", lastActivityAt: AFTER_NOW }),
      branchRow({ id: "no-activity", lastActivityAt: "" }),
    ];
    const page = buildBranchServerPage(
      rows,
      branchServerPageQuery({
        startDate: WINDOW_START,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );

    expect(idsOf(page.items).sort()).toEqual([
      "future",
      "in-window",
      "no-activity",
      "unparseable",
    ]);
    // An absent instant is NOT impossible, so it is excluded from this count and
    // included in the retained-unavailable one.
    expect(countImpossibleBranchLastActiveInstants(rows, NOW)).toBe(2);
    expect(countRetainedUnavailableBranchRows(rows, NOW)).toBe(3);
  });

  it("cuts a branch with no change count out of a Changes range", () => {
    const page = buildBranchServerPage(
      [
        branchRow({ id: "inside", additions: 3, deletions: 2 }),
        branchRow({ id: "outside", additions: 400, deletions: 100 }),
        branchRow({ id: "no-change-count", additions: null, deletions: null }),
      ],
      branchServerPageQuery({ locMin: 1, locMax: 10 }),
      NOW
    );

    expect(idsOf(page.items)).toEqual(["inside"]);
    expect(page.total).toBe(1);
  });

  it("keeps a branch with no change count when no Changes bound is set", () => {
    const page = buildBranchServerPage(
      [
        branchRow({ id: "inside", additions: 3, deletions: 2 }),
        branchRow({ id: "no-change-count", additions: null, deletions: null }),
      ],
      branchServerPageQuery({}),
      NOW
    );

    expect(page.total).toBe(2);
  });

  it("orders a branch the sort key cannot rank last in both directions", () => {
    const rows = [
      branchRow({ id: "unranked", additions: null, deletions: null }),
      branchRow({ id: "small", additions: 1, deletions: 0 }),
      branchRow({ id: "large", additions: 900, deletions: 0 }),
    ];

    const ascending = buildBranchServerPage(
      rows,
      branchServerPageQuery({
        sortKey: BranchListSortKey.Changes,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    const descending = buildBranchServerPage(
      rows,
      branchServerPageQuery({
        sortKey: BranchListSortKey.Changes,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW
    );

    expect(idsOf(ascending.items)).toEqual(["small", "large", "unranked"]);
    expect(idsOf(descending.items)).toEqual(["large", "small", "unranked"]);
  });
});
