import { describe, expect, it } from "vitest";
import { type BranchRow, branchRows } from "../mock";
import { sortBranchRows } from "./branch-sort";

describe("sortBranchRows", () => {
  it("sorts Last active by its timestamp instead of the display label", () => {
    const sorted = sortBranchRows(branchRows, "lastActivity", "desc");

    expect(sorted.map(({ id }) => id)).toEqual([
      "br_awaiting_sync",
      "br_1284",
      "br_1270",
      "br_1281",
      "br_session_cost",
      "br_saml",
      "br_dependabot",
      "br_files_zero",
      "br_unpriced_sessions",
      "br_1289",
      "br_dark_mode",
    ]);
  });

  it("breaks equal sort keys by stable name and identity", () => {
    const alpha = {
      ...(branchRows[0] as BranchRow),
      id: "branch-b",
      branchName: "alpha",
      additions: 10,
      deletions: 5,
    };
    const sameNameFirst = { ...alpha, id: "branch-a" };
    const beta = { ...alpha, id: "branch-c", branchName: "beta" };

    expect(
      sortBranchRows([beta, alpha, sameNameFirst], "changes", "asc").map(
        (row) => row.id
      )
    ).toEqual(["branch-a", "branch-b", "branch-c"]);
    expect(
      sortBranchRows([beta, alpha, sameNameFirst], "changes", "desc").map(
        (row) => row.id
      )
    ).toEqual(["branch-a", "branch-b", "branch-c"]);
  });

  it("keeps unavailable values last in both directions", () => {
    const present = { ...(branchRows[0] as BranchRow), id: "present" };
    const missing = { ...present, id: "missing", owner: null, prNumber: null };

    expect(
      sortBranchRows([missing, present], "owner", "asc").map((row) => row.id)
    ).toEqual(["present", "missing"]);
    expect(
      sortBranchRows([missing, present], "owner", "desc").map((row) => row.id)
    ).toEqual(["present", "missing"]);
    expect(
      sortBranchRows([missing, present], "pullRequest", "asc").map(
        (row) => row.id
      )
    ).toEqual(["present", "missing"]);
  });

  it("sorts pull requests by repository before number", () => {
    const source = branchRows[0] as BranchRow;
    const ten = { ...source, id: "ten", repo: "acme/web", prNumber: 10 };
    const two = { ...source, id: "two", repo: "acme/web", prNumber: 2 };
    const other = { ...source, id: "other", repo: "acme/api", prNumber: 9 };

    expect(
      sortBranchRows([ten, two, other], "pullRequest", "asc").map(
        (row) => row.id
      )
    ).toEqual(["other", "two", "ten"]);
  });
});
