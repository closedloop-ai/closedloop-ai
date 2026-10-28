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
  branchListOrderBySql,
  branchListTextCollationSql,
} from "./branch-list-filter-sql";
import { decodeBranchServerPageRows } from "./branch-server-page-read";
import {
  type BranchListSqlRow,
  BranchListSqlRowKind,
} from "./branch-server-page-sql";

/**
 * ISS-9585 — the SQL half of the ordering ruling.
 *
 * The collation NAME is written out here rather than read back from
 * `LIST_QUERY_TEXT_COLLATION`: an expectation taken from the constant the SQL
 * derives agrees with it however it is retuned, which is the one mutation this
 * file exists to catch.
 */
const COLLATED = 'COLLATE "und-x-icu"';

/**
 * Which keys rank text, stated once per member. The two lists below are
 * DERIVED from this map rather than written out beside it: a hand-written list
 * of sort keys widens to `BranchListSortKey[]`, so a tenth key would compile
 * into neither and be covered by neither case. This shape cannot be written
 * without naming every member, so `tsc` refuses the tenth until it is placed.
 */
const SORT_KEY_COLLATES: Readonly<Record<BranchListSortKey, boolean>> = {
  [BranchListSortKey.Name]: true,
  [BranchListSortKey.Owner]: true,
  [BranchListSortKey.Repo]: true,
  [BranchListSortKey.PullRequest]: true,
  [BranchListSortKey.Sessions]: false,
  [BranchListSortKey.Changes]: false,
  [BranchListSortKey.LastActivity]: false,
  [BranchListSortKey.Status]: false,
  [BranchListSortKey.Priority]: false,
};

const SORT_KEYS = Object.values(BranchListSortKey);

/** Every sort key the kernel collates, so the two mirrors rank text alike. */
const COLLATED_SORT_KEYS = SORT_KEYS.filter((key) => SORT_KEY_COLLATES[key]);

/** Ranked numerically or by rank expression, so no collation belongs on them. */
const UNCOLLATED_SORT_KEYS = SORT_KEYS.filter((key) => !SORT_KEY_COLLATES[key]);

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

describe("Branch list SQL text ordering (ISS-9585)", () => {
  it("names the ICU root collation the kernel comparator is pinned to", () => {
    expect(branchListTextCollationSql().sql).toBe(COLLATED);
  });

  it.each(COLLATED_SORT_KEYS)("collates the %s sort key", (sortKey) => {
    const sql = branchListOrderBySql(
      query({ sortKey }),
      DEFAULT_BRANCH_STATUS_ORDERING
    ).sql;

    // The tie-break carries the collation too, so count rather than match: a
    // key that lost its own collation would still find the tie-break's.
    expect(sql.split(COLLATED).length - 1).toBeGreaterThanOrEqual(2);
  });

  it.each(UNCOLLATED_SORT_KEYS)(
    "collates only the tie-break on the %s sort key",
    (sortKey) => {
      const sql = branchListOrderBySql(
        query({ sortKey }),
        DEFAULT_BRANCH_STATUS_ORDERING
      ).sql;

      expect(sql.split(COLLATED).length - 1).toBe(1);
    }
  );
});

/**
 * These bind the UTC instant, and deliberately do not claim to prove host
 * independence: a `process.env.TZ` reassignment does not reach `Date` inside
 * this app's vitest worker, so a loop over zones here would agree with itself
 * whatever the code did. That half is pinned where the reassignment does take —
 * `packages/lib/branches/branch-list-ordering-semantics.test.ts` and
 * `packages/api/src/types/__tests__/list-query-ordering-semantics.test.ts`.
 */
describe("Branch list SQL window anchoring (ISS-9585)", () => {
  it("binds the UTC instant for a zone-less bound", () => {
    const values = branchListDateWindowSql(
      query({ startDate: "2026-09-25T00:00:00", endDate: "2026-09-26T12:30" })
    ).values;

    expect(values).toEqual([
      new Date(Date.UTC(2026, 8, 25)),
      new Date(Date.UTC(2026, 8, 26, 12, 30)),
    ]);
  });

  it("keeps the instant a bound already named for itself", () => {
    const values = branchListDateWindowSql(
      query({
        startDate: "2026-09-25T00:00:00Z",
        endDate: "2026-09-26T00:00:00+02:00",
      })
    ).values;

    expect(values).toEqual([
      new Date(Date.UTC(2026, 8, 25)),
      new Date(Date.UTC(2026, 8, 25, 22)),
    ]);
  });
});

/**
 * The facet menus are assembled in TypeScript on BOTH mirrors, so the ordering
 * ruling reaches them through a comparator rather than through a collation
 * clause. This mirror used to keep a private copy of that comparator built on a
 * bare `localeCompare()` — host-dependent, and free to disagree with the
 * kernel's menu over the same corpus. These drive the real decode so that copy
 * cannot come back unnoticed.
 */
function ownerFacetRow(id: string, label: string): BranchListSqlRow {
  return {
    kind: BranchListSqlRowKind.Facet,
    facet: "owners",
    value: id,
    label,
    count: 1,
    ord: null,
  };
}

function decodedOwnerIds(rows: readonly BranchListSqlRow[]): string[] {
  return decodeBranchServerPageRows(
    rows,
    DEFAULT_BRANCH_STATUS_ORDERING
  ).facets.owners.options.map((option) => option.id);
}

describe("Branch list SQL facet ordering (ISS-9585)", () => {
  it("collates the labels its menu shows", () => {
    expect(
      decodedOwnerIds([
        ownerFacetRow("id-zeta", "Zeta"),
        ownerFacetRow("id-alpha", "alpha"),
        ownerFacetRow("id-arger", "ärger"),
        ownerFacetRow("id-beta", "Beta"),
      ])
    ).toEqual(["id-alpha", "id-arger", "id-beta", "id-zeta"]);
  });

  it("breaks a shared-label tie by code unit, as the kernel menu does", () => {
    // The collated class puts "github|owner" first, so this sequence is the one
    // the replaced `localeCompare` tie-break could not produce. Written out
    // rather than derived from the comparator.
    expect(
      decodedOwnerIds([
        ownerFacetRow("github|Owner", "Owner"),
        ownerFacetRow("github|owner", "Owner"),
      ])
    ).toEqual(["github|Owner", "github|owner"]);
  });
});
