import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { describe, expect, it } from "vitest";
import {
  branchListDateWindowSql,
  branchListFilterFlagsSql,
  branchListOrderBySql,
} from "./branch-list-filter-sql";

/**
 * The expectations are literal, never read back from the registry the SQL is
 * derived from: an expectation computed from the declaration agrees with the
 * declaration however it is flipped.
 */
const SHIPPED_SORT_KEYS = [
  BranchListSortKey.Name,
  BranchListSortKey.Owner,
  BranchListSortKey.Sessions,
  BranchListSortKey.Changes,
  BranchListSortKey.Status,
  BranchListSortKey.PullRequest,
  BranchListSortKey.LastActivity,
  BranchListSortKey.Repo,
  BranchListSortKey.Priority,
];

function query(
  overrides: Partial<BranchServerPageQuery> = {}
): BranchServerPageQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
    ...overrides,
  };
}

describe("Branch list SQL value semantics", () => {
  it("lets a branch with no last-active instant through a bounded date window", () => {
    const sql = branchListDateWindowSql(
      query({ startDate: "2026-08-18T00:00:00.000Z" })
    ).sql;

    expect(sql).toContain("dims.last_active_at IS NULL");
    expect(sql).toContain("OR");
  });

  it("requires a change count before applying a Changes bound", () => {
    const sql = branchListFilterFlagsSql(query({ locMin: 1, locMax: 10 })).sql;

    expect(sql).toContain("dims.loc_change IS NOT NULL");
  });

  it("applies no Changes predicate when no bound is set", () => {
    const sql = branchListFilterFlagsSql(query()).sql;

    expect(sql).not.toContain("dims.loc_change");
  });

  it.each(SHIPPED_SORT_KEYS)(
    "ranks an unrankable branch after ranked ones on %s, in both directions",
    (sortKey) => {
      for (const sortDir of [
        BranchListSortDirection.Asc,
        BranchListSortDirection.Desc,
      ]) {
        const sql = branchListOrderBySql(
          query({ sortKey, sortDir }),
          DEFAULT_BRANCH_STATUS_ORDERING
        ).sql;

        expect(sql).toContain("IS NULL) ASC");
      }
    }
  );
});
