import { BranchSessionPresence } from "@repo/api/src/types/branch";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { DATE_RANGES } from "../../../shared/lib/format-utils";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import {
  type BranchViewArrangement,
  branchArrangementPageSize,
  branchArrangementsEqual,
  DEFAULT_BRANCH_ARRANGEMENT,
  parseBranchSavedViews,
} from "../branch-saved-views";
import {
  BranchSortDir,
  BranchSortKey,
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "../branch-sort-group";

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
      columnWidths: { status: 180 },
      pageSize: 100,
      grouping: EMPTY_TABLE_GROUPING,
      collapsedGroups: { "repo|": ["acme/web"] },
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

  /**
   * ISS-9447 M5. One row per field of `BranchViewArrangement`, each holding a
   * value that genuinely differs from `base()`. The `satisfies` makes the table
   * exhaustive: adding a field to the arrangement fails typecheck HERE until it
   * has a row, and the row then fails at runtime until `branchArrangementsEqual`
   * actually compares it. That is the guard the function had none of — it is
   * hand-maintained, and a field left out makes the switcher's "modified" marker
   * claim the table matches a view it has diverged from on that axis.
   */
  const DIVERGENT_FIELD_VALUES = {
    // A collapse-only change: same axis, one more band closed.
    collapsedGroups: { "repo|": ["acme/web", "acme/api"] },
    columnOrder: ["owner", "status", "repo"],
    columnWidths: { status: 999 },
    dateRange: "90d",
    filters: { ...DEFAULT_BRANCH_FILTERS, tags: ["release"] },
    grouping: {
      primary: {
        ...EMPTY_TABLE_GROUPING.primary,
        fieldId: "owner",
      },
      secondary: EMPTY_TABLE_GROUPING.secondary,
    },
    hiddenColumns: ["repo", "owner", "status"],
    pageSize: 500,
    sortDir: BranchSortDir.Desc,
    sortKey: BranchSortKey.Repo,
  } as const satisfies {
    [TField in keyof Required<BranchViewArrangement>]: BranchViewArrangement[TField];
  };

  it.each(Object.keys(DIVERGENT_FIELD_VALUES))(
    "flags a changed %s as modified",
    (field) => {
      const changed = {
        ...base(),
        [field]:
          DIVERGENT_FIELD_VALUES[field as keyof typeof DIVERGENT_FIELD_VALUES],
      };
      expect(branchArrangementsEqual(base(), changed)).toBe(false);
    }
  );
});

describe("ISS-9447 M5: columnWidths and pageSize on a named arrangement", () => {
  it("resolves an absent pageSize to the surface default, both sides", () => {
    // A view saved before M5 carries no page size, and "none" is not a choice.
    // Resolving it in the apply but not in the modified check — or the other way
    // round — makes such a view report itself modified the instant it is
    // applied, which is what one shared resolver prevents.
    const [view] = parseBranchSavedViews({
      views: [VALID_VIEW],
      activeViewId: "v1",
    }).views;
    expect(view.arrangement.pageSize).toBeUndefined();
    // Against the surface constant rather than through the resolver a second
    // time. `DEFAULT_BRANCH_ARRANGEMENT` now SPELLS `pageSize` (ISS-9447 review
    // — the default arrangement is the one that states an opinion about
    // rows-per-page), but this comparison predates that and must not go back to
    // resolving both sides: with both omitted it was `f(undefined) ===
    // f(undefined)` and could not fail.
    expect(branchArrangementPageSize(view.arrangement)).toBe(
      DEFAULT_TABLE_PAGE_SIZE
    );
    expect(
      branchArrangementsEqual(view.arrangement, {
        ...view.arrangement,
        pageSize: branchArrangementPageSize(DEFAULT_BRANCH_ARRANGEMENT),
      })
    ).toBe(true);
  });

  it("drops an implausible stored width, so the restored view does not open as Modified", () => {
    // ISS-9447 (review). The parse used to accept any finite positive width
    // while the APPLY path filtered at a 10_000px ceiling, so this 10001 reached
    // the saved arrangement and never reached the live table — and this
    // comparison, which is what drives the switcher's "modified" marker, saw a
    // saved `{ status: 10001 }` against a live `{}` on the first render of a
    // view the reader had just opened and never touched. One predicate behind
    // both boundaries is what makes the two maps agree.
    const [view] = parseBranchSavedViews({
      views: [
        {
          ...VALID_VIEW,
          arrangement: {
            ...VALID_VIEW.arrangement,
            columnWidths: { owner: 240, status: 10_001 },
          },
        },
      ],
      activeViewId: "v1",
    }).views;

    expect(view.arrangement.columnWidths).toEqual({ owner: 240 });
    expect(
      branchArrangementsEqual(view.arrangement, {
        ...view.arrangement,
        columnWidths: { owner: 240 },
      })
    ).toBe(true);
  });

  it("degrades a malformed width or page size without dropping the view", () => {
    const [view] = parseBranchSavedViews({
      views: [
        {
          ...VALID_VIEW,
          arrangement: {
            ...VALID_VIEW.arrangement,
            columnWidths: { owner: -5, status: 220 },
            pageSize: 0,
          },
        },
      ],
      activeViewId: "v1",
    }).views;
    expect(view.arrangement.columnWidths).toEqual({ status: 220 });
    expect(view.arrangement.pageSize).toBeUndefined();
    expect(view.arrangement.hiddenColumns).toEqual(["repo"]);
  });

  it("keeps a view whose stored sort this build cannot spell", () => {
    // The named store's half of M5's third criterion. A `.default()` only
    // answers an ABSENT key, so an unusable stored value failed the arrangement
    // and the whole named view vanished from the switcher — the reader's saved
    // filters and columns with it.
    const [view] = parseBranchSavedViews({
      views: [
        {
          ...VALID_VIEW,
          arrangement: {
            ...VALID_VIEW.arrangement,
            sortDir: "sideways",
            sortKey: "a-column-this-build-removed",
          },
        },
      ],
      activeViewId: "v1",
    }).views;
    expect(view.arrangement.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(view.arrangement.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
    expect(view.arrangement.filters.owners).toEqual(["alice"]);
    expect(view.arrangement.columnOrder).toEqual(["status", "owner"]);
  });
});
