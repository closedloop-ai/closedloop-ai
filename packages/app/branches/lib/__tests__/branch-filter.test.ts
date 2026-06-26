import { describe, expect, it } from "vitest";
import {
  type BranchFilters,
  type BranchRow,
  BranchRowStatus,
  branchRepoFilterOptions,
  branchStatusFilterOptions,
  filterBranchRows,
} from "../branch-sample-data";

function row(overrides: Partial<BranchRow>): BranchRow {
  return {
    id: overrides.id ?? "br_1",
    branchName: "agent/work",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Avery",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: 0,
    ahead: 1,
    additions: 1,
    deletions: 0,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
    ...overrides,
  };
}

const ROWS: BranchRow[] = [
  row({
    id: "a",
    owner: "Avery",
    repo: "acme/web",
    status: BranchRowStatus.Open,
  }),
  row({
    id: "b",
    owner: "Sam",
    repo: "acme/api",
    status: BranchRowStatus.Merged,
  }),
  row({
    id: "c",
    owner: "Sam",
    repo: "acme/web",
    status: BranchRowStatus.Open,
  }),
];

const NONE: BranchFilters = { statuses: [], owners: [], repos: [] };

describe("filterBranchRows (multi-select)", () => {
  it("returns all rows when every facet is empty", () => {
    expect(filterBranchRows(ROWS, NONE)).toHaveLength(3);
  });

  it("matches rows in ANY selected owner (OR within a facet)", () => {
    const result = filterBranchRows(ROWS, {
      ...NONE,
      owners: ["Avery", "Sam"],
    });
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ANDs across facets", () => {
    const result = filterBranchRows(ROWS, {
      ...NONE,
      owners: ["Sam"],
      repos: ["web"],
    });
    expect(result.map((r) => r.id)).toEqual(["c"]);
  });

  it("filters by status by row status key", () => {
    const result = filterBranchRows(ROWS, {
      ...NONE,
      statuses: [BranchRowStatus.Merged],
    });
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("facet option helpers", () => {
  it("derives short repo options with counts", () => {
    const options = branchRepoFilterOptions(ROWS);
    expect(options.map((o) => o.id)).toEqual(["api", "web"]);
    expect(options.find((o) => o.id === "web")?.count).toBe(2);
  });

  it("lists every defined status with counts", () => {
    const options = branchStatusFilterOptions(ROWS);
    expect(options.find((o) => o.id === BranchRowStatus.Open)?.count).toBe(2);
    expect(options.find((o) => o.id === BranchRowStatus.Merged)?.count).toBe(1);
  });
});
