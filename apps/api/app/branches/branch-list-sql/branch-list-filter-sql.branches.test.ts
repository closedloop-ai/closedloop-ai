import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { DEFAULT_BRANCH_STATUS_ORDERING } from "@repo/api/src/types/branch-status-order";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchListDateWindowSql,
  branchListFilterFlagsSql,
  branchListOrderBySql,
} from "./branch-list-filter-sql";

vi.mock(
  "@repo/api/src/types/list-query-value-semantics",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/api/src/types/list-query-value-semantics")
      >();
    return {
      ...actual,
      listQueryRetainsUnjudgeableRow: vi.fn(
        actual.listQueryRetainsUnjudgeableRow
      ),
      listQueryOrdersUnrankedRowFirst: vi.fn(
        actual.listQueryOrdersUnrankedRowFirst
      ),
    };
  }
);

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("branchListDateWindowSql", () => {
  it("bounds only the end when no start date is given", () => {
    const sql = branchListDateWindowSql(
      query({ endDate: "2026-08-10T00:00:00.000Z" })
    ).sql;

    expect(sql).toContain("dims.last_active_at <=");
    expect(sql).not.toContain("dims.last_active_at >=");
  });

  it("bounds only the start when no end date is given", () => {
    const sql = branchListDateWindowSql(
      query({ startDate: "2026-08-01T00:00:00.000Z" })
    ).sql;

    expect(sql).toContain("dims.last_active_at >=");
    expect(sql).not.toContain("dims.last_active_at <=");
  });

  it("drops the null-retaining OR clause when the semantics decline to retain an unjudgeable row", async () => {
    const { listQueryRetainsUnjudgeableRow } = await import(
      "@repo/api/src/types/list-query-value-semantics"
    );
    vi.mocked(listQueryRetainsUnjudgeableRow).mockReturnValueOnce(false);

    const sql = branchListDateWindowSql(
      query({ startDate: "2026-08-01T00:00:00.000Z" })
    ).sql;

    expect(sql).not.toContain("IS NULL");
    expect(sql).toContain("dims.last_active_at >=");
  });
});

describe("branchListOrderBySql", () => {
  it("orders an unranked row DESC when the sort key's semantics ask for unranked-first", async () => {
    const { listQueryOrdersUnrankedRowFirst } = await import(
      "@repo/api/src/types/list-query-value-semantics"
    );
    vi.mocked(listQueryOrdersUnrankedRowFirst).mockReturnValueOnce(true);

    const sql = branchListOrderBySql(
      query({ sortKey: BranchListSortKey.Name }),
      DEFAULT_BRANCH_STATUS_ORDERING
    ).sql;

    expect(sql).toContain("IS NULL) DESC,");
  });

  it("null-checks the sort key's own ranking expression rather than a bare NULL literal", () => {
    const sql = branchListOrderBySql(
      query({ sortKey: BranchListSortKey.Name }),
      DEFAULT_BRANCH_STATUS_ORDERING
    ).sql;

    // The unranked-row null check must test the Name key's real expression
    // (branch_name), not fall back to a placeholder `NULL IS NULL` that would
    // rank every row as equally "unranked".
    expect(sql).toMatch(NAME_SORT_NULL_CHECK_PATTERN);
  });
});

describe("branchListFilterFlagsSql — loc range", () => {
  it("bounds only the lower end when locMax is unset", () => {
    const sql = branchListFilterFlagsSql(query({ locMin: 5 })).sql;

    expect(sql).toContain("dims.loc_change >= ");
    expect(sql).not.toContain("dims.loc_change <=");
  });

  it("bounds only the upper end when locMin is unset", () => {
    const sql = branchListFilterFlagsSql(query({ locMax: 5 })).sql;

    expect(sql).toContain("dims.loc_change <= ");
    expect(sql).not.toContain("dims.loc_change >=");
  });

  it("retains a branch with no change count when the semantics ask to retain it", async () => {
    const { listQueryRetainsUnjudgeableRow } = await import(
      "@repo/api/src/types/list-query-value-semantics"
    );
    vi.mocked(listQueryRetainsUnjudgeableRow).mockReturnValueOnce(true);

    const sql = branchListFilterFlagsSql(query({ locMin: 1 })).sql;

    expect(sql).toContain("dims.loc_change IS NULL");
    expect(sql).toContain("OR");
  });
});

describe("branchListFilterFlagsSql — priority filter", () => {
  it("matches TRUE unconditionally with no priority selection", () => {
    const sql = branchListFilterFlagsSql(query()).sql;

    expect(sql).toContain("pass_priority");
    // No members, no unset token selected: the whole predicate degenerates to
    // TRUE rather than an empty ANY()/OR().
    expect(sql).not.toContain("dims.priority");
  });

  it("matches only the unset arm when just the unset token is selected", () => {
    const sql = branchListFilterFlagsSql(
      query({ priorities: [PRIORITY_UNSET_VALUE] })
    ).sql;

    expect(sql).toContain("dims.priority IS NULL");
    expect(sql).not.toContain("= ANY");
  });

  it("ORs a member match with the unset arm when both are selected", () => {
    const sql = branchListFilterFlagsSql(
      query({ priorities: [Priority.High, PRIORITY_UNSET_VALUE] })
    ).sql;

    expect(sql).toContain("dims.priority::text = ANY");
    expect(sql).toContain("dims.priority IS NULL");
    expect(sql).toMatch(PRIORITY_MEMBER_OR_UNSET_PATTERN);
  });
});

const PRIORITY_MEMBER_OR_UNSET_PATTERN =
  /\(dims\.priority::text = ANY\([^)]*\) OR dims\.priority IS NULL\)/;
const NAME_SORT_NULL_CHECK_PATTERN = /\(flagged\.branch_name[^)]*IS NULL\)/;

describe("branchListFilterFlagsSql — includes/overlaps predicates", () => {
  it("builds a real ANY()/overlap predicate once a facet has a real selection", () => {
    const sql = branchListFilterFlagsSql(
      query({ names: ["main"], collaborators: ["user-1"] })
    ).sql;

    expect(sql).toContain("dims.branch_name = ANY");
    expect(sql).toContain("dims.collaborator_keys &&");
  });

  it("matches unconditionally for a facet selection that is present but empty", () => {
    const sql = branchListFilterFlagsSql(
      query({ names: [], collaborators: [] })
    ).sql;

    // An explicit empty array is not `undefined` — the length check (not just
    // the nullish check) must still short-circuit both predicates to TRUE.
    expect(sql).not.toContain("dims.branch_name = ANY");
    expect(sql).not.toContain("dims.collaborator_keys &&");
  });
});
