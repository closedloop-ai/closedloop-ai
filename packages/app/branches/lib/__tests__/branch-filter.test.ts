import { BranchSessionPresence } from "@repo/api/src/types/branch";
import type {
  FilterFacetGroup,
  FilterMenuGroup,
  FilterRangeGroup,
} from "@repo/design-system/components/ui/table-filters";
import { describe, expect, it, vi } from "vitest";
import { legacyBranchFilterFacetGroups as branchFilterFacetGroups } from "../branch-filter-adapter";
import {
  type BranchFilters,
  type BranchRow,
  BranchRowStatus,
  branchOwnerFilterOptions,
  branchRepoFilterOptions,
  branchSessionPresenceFilterOptions,
  branchStatusFilterOptions,
  clampBranchLocRange,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
} from "../branch-row";

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

const NONE: BranchFilters = {
  ...DEFAULT_BRANCH_FILTERS,
  statuses: [],
  owners: [],
  repos: [],
  sessionPresence: [],
};

/** Narrows a menu group to a multi-select options facet by id. */
function facetGroup(
  groups: FilterMenuGroup[],
  id: string
): FilterFacetGroup | undefined {
  const group = groups.find((candidate) => candidate.id === id);
  return group && group.kind !== "range" ? group : undefined;
}

/** Narrows a menu group to the range facet by id. */
function rangeGroup(
  groups: FilterMenuGroup[],
  id: string
): FilterRangeGroup | undefined {
  const group = groups.find((candidate) => candidate.id === id);
  return group?.kind === "range" ? group : undefined;
}

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

describe("filterBranchRows — linked session presence (FEA-4003)", () => {
  const SESSION_ROWS: BranchRow[] = [
    row({ id: "has1", sessionCount: 2 }),
    row({ id: "has2", sessionCount: 1 }),
    row({ id: "none1", sessionCount: 0 }),
  ];

  it("keeps only rows WITH a linked session for Has", () => {
    const result = filterBranchRows(SESSION_ROWS, {
      ...NONE,
      sessionPresence: [BranchSessionPresence.Has],
    });
    expect(result.map((r) => r.id)).toEqual(["has1", "has2"]);
  });

  it("keeps only rows WITHOUT a linked session for None", () => {
    const result = filterBranchRows(SESSION_ROWS, {
      ...NONE,
      sessionPresence: [BranchSessionPresence.None],
    });
    expect(result.map((r) => r.id)).toEqual(["none1"]);
  });

  it("selecting both presence values matches every row", () => {
    const result = filterBranchRows(SESSION_ROWS, {
      ...NONE,
      sessionPresence: [BranchSessionPresence.Has, BranchSessionPresence.None],
    });
    expect(result.map((r) => r.id)).toEqual(["has1", "has2", "none1"]);
  });
});

describe("filterBranchRows — LOC change range (FEA-4003)", () => {
  const LOC_ROWS: BranchRow[] = [
    row({ id: "small", additions: 3, deletions: 2 }), // 5
    row({ id: "mid", additions: 40, deletions: 10 }), // 50
    row({ id: "big", additions: 400, deletions: 100 }), // 500
    row({ id: "unavailable", additions: null, deletions: null }), // null LOC
    row({ id: "partial", additions: 10, deletions: null }), // 10 (one count)
  ];

  it("applies an inclusive lower bound", () => {
    const result = filterBranchRows(LOC_ROWS, { ...NONE, locMin: 50 });
    expect(result.map((r) => r.id)).toEqual(["mid", "big"]);
  });

  it("applies an inclusive upper bound", () => {
    const result = filterBranchRows(LOC_ROWS, { ...NONE, locMax: 10 });
    expect(result.map((r) => r.id)).toEqual(["small", "partial"]);
  });

  it("applies a bounded window", () => {
    const result = filterBranchRows(LOC_ROWS, {
      ...NONE,
      locMin: 10,
      locMax: 50,
    });
    expect(result.map((r) => r.id)).toEqual(["mid", "partial"]);
  });

  it("EXCLUDES rows with unavailable LOC once a bound is set", () => {
    const result = filterBranchRows(LOC_ROWS, { ...NONE, locMin: 0 });
    expect(result.map((r) => r.id)).not.toContain("unavailable");
  });

  it("keeps unavailable-LOC rows when no bound is set", () => {
    const result = filterBranchRows(LOC_ROWS, NONE);
    expect(result.map((r) => r.id)).toContain("unavailable");
  });
});

describe("clampBranchLocRange (FEA-4003)", () => {
  it("floors a negative min at 0", () => {
    expect(clampBranchLocRange({ min: -5 })).toEqual({
      min: 0,
      max: undefined,
    });
  });

  it("floors a negative max at 0 (a max-only negative bound becomes max: 0)", () => {
    // A `max: -5` is meaningless as an upper bound, but it is floored UP to 0
    // (not dropped): the resulting `{max: 0}` keeps only branches with 0 LOC,
    // consistent with the floor-not-drop rule the docstring documents.
    expect(clampBranchLocRange({ max: -5 })).toEqual({
      min: undefined,
      max: 0,
    });
  });

  it("clamps an inverted range so min never exceeds max", () => {
    expect(clampBranchLocRange({ min: 100, max: 10 })).toEqual({
      min: 10,
      max: 10,
    });
  });

  it("drops non-finite bounds to undefined", () => {
    expect(clampBranchLocRange({ min: Number.NaN, max: 20 })).toEqual({
      min: undefined,
      max: 20,
    });
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

  it("derives sorted owner options with counts", () => {
    const options = branchOwnerFilterOptions(ROWS);
    expect(options.map((o) => o.id)).toEqual(["Avery", "Sam"]);
    expect(options.find((o) => o.id === "Sam")?.count).toBe(2);
    expect(options.find((o) => o.id === "Avery")?.count).toBe(1);
  });

  it("derives linked-session presence options with per-bucket counts", () => {
    const options = branchSessionPresenceFilterOptions([
      row({ id: "x", sessionCount: 1 }),
      row({ id: "y", sessionCount: 0 }),
      row({ id: "z", sessionCount: 0 }),
    ]);
    expect(options.find((o) => o.id === BranchSessionPresence.Has)?.count).toBe(
      1
    );
    expect(
      options.find((o) => o.id === BranchSessionPresence.None)?.count
    ).toBe(2);
  });
});

describe("branchFilterFacetGroups", () => {
  it("renders Status / Owner / Repository / Linked session / LOC change", () => {
    const groups = branchFilterFacetGroups(ROWS, NONE, vi.fn());
    expect(groups.map((g) => g.id)).toEqual([
      "status",
      "owner",
      "repo",
      "session",
      "loc",
    ]);
    expect(rangeGroup(groups, "loc")?.kind).toBe("range");
  });

  it("toggles the owners array via the Owner facet", () => {
    const onChange = vi.fn();
    const groups = branchFilterFacetGroups(ROWS, NONE, onChange);
    facetGroup(groups, "owner")?.onToggle("Sam");
    expect(onChange).toHaveBeenCalledWith({ ...NONE, owners: ["Sam"] });
  });

  it("toggles the sessionPresence array via the Linked session facet", () => {
    const onChange = vi.fn();
    const groups = branchFilterFacetGroups(ROWS, NONE, onChange);
    facetGroup(groups, "session")?.onToggle(BranchSessionPresence.Has);
    expect(onChange).toHaveBeenCalledWith({
      ...NONE,
      sessionPresence: [BranchSessionPresence.Has],
    });
  });

  it("emits clamped LOC bounds via the LOC change range facet", () => {
    const onChange = vi.fn();
    const groups = branchFilterFacetGroups(ROWS, NONE, onChange);
    // Inverted input is clamped before it reaches state.
    rangeGroup(groups, "loc")?.onChange({ min: 500, max: 100 });
    expect(onChange).toHaveBeenCalledWith({
      ...NONE,
      locMin: 100,
      locMax: 100,
    });
  });

  it("clears LOC bounds to undefined", () => {
    const onChange = vi.fn();
    const groups = branchFilterFacetGroups(
      ROWS,
      { ...NONE, locMin: 10, locMax: 50 },
      onChange
    );
    rangeGroup(groups, "loc")?.onChange({ min: undefined, max: undefined });
    expect(onChange).toHaveBeenCalledWith({
      ...NONE,
      locMin: undefined,
      locMax: undefined,
    });
  });
});
