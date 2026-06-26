import { describe, expect, it } from "vitest";
import { type BranchRow, BranchRowStatus } from "../branch-sample-data";
import {
  BranchSortDir,
  BranchSortKey,
  filterBranchRowsByWindow,
  sortBranchRows,
} from "../branch-sort-group";

function row(over: Partial<BranchRow>): BranchRow {
  return {
    id: over.id ?? "id",
    branchName: "agent/x",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Alex",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: null,
    ahead: null,
    additions: null,
    deletions: null,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
    ...over,
  };
}

describe("sortBranchRows", () => {
  it("sorts by name ascending and descending", () => {
    const rows = [
      row({ id: "c", branchName: "c" }),
      row({ id: "a", branchName: "a" }),
      row({ id: "b", branchName: "b" }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Asc).map(
        (r) => r.id
      )
    ).toEqual(["a", "b", "c"]);
    expect(
      sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["c", "b", "a"]);
  });

  it("sorts by changes (additions+deletions) and sessions", () => {
    const rows = [
      row({ id: "small", additions: 1, deletions: 1, sessionCount: 5 }),
      row({ id: "big", additions: 100, deletions: 50, sessionCount: 1 }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.Changes, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["big", "small"]);
    expect(
      sortBranchRows(rows, BranchSortKey.Sessions, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["small", "big"]);
  });

  it("sorts by lastActivity by instant — desc newest-first, asc oldest-first, mixed formats", () => {
    // Mixed separators (space vs `T`) on purpose: a byte-wise compare would
    // misorder the space-separated value, so this proves the sort parses instants.
    const rows = [
      row({ id: "old", lastActivityAt: "2026-06-10 00:00:00" }),
      row({ id: "new", lastActivityAt: "2026-06-18T00:00:00.000Z" }),
      row({ id: "mid", lastActivityAt: "2026-06-14T00:00:00.000Z" }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.LastActivity, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["new", "mid", "old"]);
    expect(
      sortBranchRows(rows, BranchSortKey.LastActivity, BranchSortDir.Asc).map(
        (r) => r.id
      )
    ).toEqual(["old", "mid", "new"]);
  });
});

describe("filterBranchRowsByWindow", () => {
  const START = "2026-06-17T00:00:00.000Z";

  it("returns all rows when the window is 'All time' (no startDate)", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    expect(filterBranchRowsByWindow(rows, undefined)).toBe(rows);
  });

  it("compares by instant, not byte-wise — keeps a recent space-separated timestamp", () => {
    // Same calendar date as START but a space separator (` ` 0x20) sorts before
    // `T` (0x54) in a string compare, so a byte-wise filter would wrongly drop
    // this still-recent row. Its instant is on/after START in every timezone.
    const rows = [
      row({ id: "recent", lastActivityAt: "2026-06-17 23:59:59" }),
      row({ id: "old", lastActivityAt: "2026-06-10 12:00:00" }),
    ];
    expect(filterBranchRowsByWindow(rows, START).map((r) => r.id)).toEqual([
      "recent",
    ]);
  });

  it("keeps rows with a null or unparseable timestamp (never silently drops)", () => {
    const rows = [
      row({ id: "null", lastActivityAt: undefined }),
      row({ id: "junk", lastActivityAt: "not-a-date" }),
    ];
    expect(
      filterBranchRowsByWindow(rows, START)
        .map((r) => r.id)
        .sort()
    ).toEqual(["junk", "null"]);
  });
});
