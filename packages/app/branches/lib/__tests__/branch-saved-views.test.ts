import { BranchSessionPresence } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { DATE_RANGES } from "../../../shared/lib/format-utils";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import {
  type BranchViewArrangement,
  branchArrangementsEqual,
  DEFAULT_BRANCH_ARRANGEMENT,
  parseBranchSavedViews,
} from "../branch-saved-views";
import { BranchSortDir, BranchSortKey } from "../branch-sort-group";

const VALID_VIEW = {
  id: "v1",
  name: "Mine",
  arrangement: {
    sortKey: BranchSortKey.Name,
    sortDir: BranchSortDir.Asc,
    dateRange: "30d",
    hiddenColumns: ["repo"],
    columnOrder: ["status", "owner"],
    filters: {
      statuses: ["open"],
      owners: ["alice"],
      repos: [],
      sessionPresence: [BranchSessionPresence.Has],
      locMin: 10,
      locMax: 500,
    },
  },
};

describe("parseBranchSavedViews", () => {
  it("parses a well-formed collection including filters", () => {
    const result = parseBranchSavedViews({
      views: [VALID_VIEW],
      activeViewId: "v1",
    });
    expect(result.views).toHaveLength(1);
    expect(result.activeViewId).toBe("v1");
    const arr = result.views[0].arrangement;
    expect(arr.sortKey).toBe(BranchSortKey.Name);
    expect(arr.hiddenColumns).toEqual(["repo"]);
    expect(arr.columnOrder).toEqual(["status", "owner"]);
    expect(arr.filters.statuses).toEqual(["open"]);
    expect(arr.filters.sessionPresence).toEqual([BranchSessionPresence.Has]);
    expect(arr.filters.locMin).toBe(10);
  });

  it("degrades a malformed blob to an empty collection", () => {
    expect(parseBranchSavedViews(null).views).toHaveLength(0);
    expect(parseBranchSavedViews("nope").activeViewId).toBeNull();
    expect(parseBranchSavedViews({ views: 5 }).views).toHaveLength(0);
  });

  it("drops a single corrupt view without rejecting the whole collection", () => {
    const result = parseBranchSavedViews({
      views: [VALID_VIEW, { id: "", name: "", arrangement: {} }],
      activeViewId: "v1",
    });
    expect(result.views).toHaveLength(1);
    expect(result.views[0].id).toBe("v1");
  });

  it("clamps a dangling activeViewId (its view was dropped) to null", () => {
    const result = parseBranchSavedViews({
      views: [VALID_VIEW],
      activeViewId: "gone",
    });
    expect(result.activeViewId).toBeNull();
  });

  it("parses every canonical DATE_RANGES member (enum tracks the const, not a copy)", () => {
    for (const range of DATE_RANGES) {
      const result = parseBranchSavedViews({
        views: [
          {
            id: `v-${range}`,
            name: range,
            arrangement: {
              sortKey: BranchSortKey.LastActivity,
              sortDir: BranchSortDir.Desc,
              dateRange: range,
              hiddenColumns: [],
              columnOrder: [],
            },
          },
        ],
        activeViewId: `v-${range}`,
      });
      // Each canonical range round-trips verbatim; none silently degrades to
      // the "7d" default (which is what a stale hardcoded enum would do to a
      // newly added range).
      expect(result.views[0].arrangement.dateRange).toBe(range);
    }
  });

  it("preserves unknown arrangement fields across a read→write round-trip (forward compat)", () => {
    // A NEWER build persisted a view carrying a field this build does not know
    // (e.g. FEA-4168's columnWidths, or any future additive key).
    const forwardCompat = {
      views: [
        {
          id: "fc1",
          name: "Future",
          description: "a field a newer build added at the view level",
          arrangement: {
            sortKey: BranchSortKey.Name,
            sortDir: BranchSortDir.Asc,
            dateRange: "7d",
            hiddenColumns: [],
            columnOrder: [],
            filters: { ...DEFAULT_BRANCH_FILTERS },
            columnWidths: { repo: 200, status: 120 },
          },
        },
      ],
      activeViewId: "fc1",
      schemaVersion: 2,
    };
    const parsed = parseBranchSavedViews(forwardCompat);
    // Re-serializing the parsed collection (what the persist effect writes back)
    // must still carry the unknown fields — this build leaves data it does not
    // understand alone instead of stripping and overwriting it.
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(roundTripped.schemaVersion).toBe(2);
    expect(roundTripped.views[0].description).toBe(
      "a field a newer build added at the view level"
    );
    expect(roundTripped.views[0].arrangement.columnWidths).toEqual({
      repo: 200,
      status: 120,
    });
    // Known fields still validated normally.
    expect(parsed.views[0].arrangement.dateRange).toBe("7d");
  });

  it("defaults filters to no-facet when absent/malformed", () => {
    const result = parseBranchSavedViews({
      views: [
        {
          id: "v2",
          name: "NoFilters",
          arrangement: {
            sortKey: BranchSortKey.LastActivity,
            sortDir: BranchSortDir.Desc,
            dateRange: "7d",
            hiddenColumns: [],
            columnOrder: [],
          },
        },
      ],
      activeViewId: "v2",
    });
    expect(result.views[0].arrangement.filters).toEqual({
      ...DEFAULT_BRANCH_FILTERS,
    });
  });
});

describe("branchArrangementsEqual (modified-marker divergence check)", () => {
  function base(): BranchViewArrangement {
    return {
      sortKey: BranchSortKey.Name,
      sortDir: BranchSortDir.Asc,
      dateRange: "30d",
      hiddenColumns: ["repo", "owner"],
      columnOrder: ["status", "owner"],
      filters: {
        ...DEFAULT_BRANCH_FILTERS,
        statuses: ["open", "merged"],
        owners: ["alice"],
        repos: [],
        sessionPresence: [BranchSessionPresence.Has],
        locMin: 10,
        locMax: 500,
      },
    };
  }

  it("treats an identical arrangement as equal (not modified)", () => {
    expect(branchArrangementsEqual(base(), base())).toBe(true);
  });

  it("ignores order in hiddenColumns and facet arrays (sets, not lists)", () => {
    const reordered = base();
    reordered.hiddenColumns = ["owner", "repo"];
    reordered.filters.statuses = ["merged", "open"];
    expect(branchArrangementsEqual(base(), reordered)).toBe(true);
  });

  it("is order-sensitive for columnOrder (order is meaningful)", () => {
    const reordered = base();
    reordered.columnOrder = ["owner", "status"];
    expect(branchArrangementsEqual(base(), reordered)).toBe(false);
  });

  it("flags a changed time window as modified", () => {
    const moved = base();
    moved.dateRange = "7d";
    expect(branchArrangementsEqual(base(), moved)).toBe(false);
  });

  it("flags a changed sort, facet, and LOC bound as modified", () => {
    const sorted = base();
    sorted.sortDir = BranchSortDir.Desc;
    expect(branchArrangementsEqual(base(), sorted)).toBe(false);

    const facet = base();
    facet.filters.owners = ["bob"];
    expect(branchArrangementsEqual(base(), facet)).toBe(false);

    const loc = base();
    loc.filters.locMax = 999;
    expect(branchArrangementsEqual(base(), loc)).toBe(false);
  });

  it("treats the default arrangement as equal to itself", () => {
    expect(
      branchArrangementsEqual(
        { ...DEFAULT_BRANCH_ARRANGEMENT },
        { ...DEFAULT_BRANCH_ARRANGEMENT }
      )
    ).toBe(true);
  });
});
