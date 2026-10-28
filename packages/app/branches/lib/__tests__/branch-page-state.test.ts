import { BranchListCapability } from "@repo/api/src/types/branch-list-contract";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it, vi } from "vitest";
import {
  branchListHasCompletePopulation,
  isBranchPageDataPresentationPending,
  resolveBranchDisplayRows,
  resolveBranchPageState,
  selectPresentedBranchPageData,
  shouldUseBranchServerControls,
  shouldWithholdBranchPageData,
} from "../branch-page-state";
import {
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
} from "../branch-row";
import { BranchSortDir, BranchSortKey } from "../branch-sort-group";

describe("branchListHasCompletePopulation", () => {
  it("requires a response whose items cover the served total without continuation", () => {
    expect(
      branchListHasCompletePopulation({
        hasMore: false,
        items: [branchRow("a", "2026-08-20T00:00:00Z")],
        total: 1,
      })
    ).toBe(true);
    expect(branchListHasCompletePopulation(undefined)).toBe(false);
    expect(
      branchListHasCompletePopulation({
        hasMore: true,
        items: [branchRow("a", "2026-08-20T00:00:00Z")],
        total: 1,
      })
    ).toBe(false);
    expect(
      branchListHasCompletePopulation({
        hasMore: false,
        items: [branchRow("a", "2026-08-20T00:00:00Z")],
        total: 2,
      })
    ).toBe(false);
  });
});

describe("shouldUseBranchServerControls", () => {
  it("requires either pending, placeholder, or active server data", () => {
    expect(shouldUseBranchServerControls(true, false, false)).toBe(true);
    expect(shouldUseBranchServerControls(false, true, false)).toBe(true);
    expect(shouldUseBranchServerControls(false, false, true)).toBe(true);
    expect(shouldUseBranchServerControls(false, false, false)).toBe(false);
  });
});

describe("resolveBranchDisplayRows", () => {
  const old = branchRow("old", "2026-08-18T00:00:00Z");
  const recent = branchRow("recent", "2026-08-20T00:00:00Z");

  it("preserves server-owned page rows without client filtering or sorting", () => {
    const rows = [recent, old];
    expect(
      resolveBranchDisplayRows(rows, {
        serverPageActive: true,
        startDate: "2026-08-19T00:00:00Z",
        sortKey: BranchSortKey.Name,
        sortDir: BranchSortDir.Asc,
      })
    ).toEqual({ visibleRows: rows, sortedRows: rows });
  });

  it("filters and sorts only the complete legacy corpus", () => {
    const resolved = resolveBranchDisplayRows([recent, old], {
      serverPageActive: false,
      startDate: "2026-08-19T00:00:00Z",
      sortKey: BranchSortKey.Name,
      sortDir: BranchSortDir.Asc,
    });
    expect(resolved.visibleRows).toEqual([recent]);
    expect(resolved.sortedRows).toEqual([recent]);
  });
});

describe("shouldWithholdBranchPageData", () => {
  it.each([
    { placeholder: true, withheld: true },
    { placeholder: false, withheld: false },
  ])(
    "returns $withheld when placeholder data is $placeholder",
    ({ placeholder, withheld }) => {
      expect(
        shouldWithholdBranchPageData({
          isPlaceholderData: placeholder,
          isViewReady: true,
        })
      ).toBe(withheld);
    }
  );

  it("withholds a server-produced placeholder", () => {
    expect(
      shouldWithholdBranchPageData({
        isPlaceholderData: true,
        isViewReady: true,
        pageData: serverProducedPageData,
      })
    ).toBe(true);
  });

  /**
   * ISS-8127. Settled data on the complete-corpus path is the case that shipped
   * the defect: no server-page capability is present, so the placeholder clause
   * below can never fire, and before this clause existed nothing withheld a
   * corpus the stale default window was about to narrow.
   */
  it("withholds settled complete-corpus data until the view has restored", () => {
    expect(
      shouldWithholdBranchPageData({
        isPlaceholderData: false,
        isViewReady: false,
      })
    ).toBe(true);
  });

  it("presents that same data once the view has restored", () => {
    expect(
      shouldWithholdBranchPageData({
        isPlaceholderData: false,
        isViewReady: true,
      })
    ).toBe(false);
  });
});

describe("selectPresentedBranchPageData", () => {
  const previousData = { cohort: "previous" };

  it("removes previous-key placeholder data from presentation", () => {
    expect(
      selectPresentedBranchPageData(serverProducedPageData, {
        isPlaceholderData: true,
        isViewReady: true,
      })
    ).toBeUndefined();
  });

  it("keeps matching-key cached server data", () => {
    expect(
      selectPresentedBranchPageData(previousData, {
        isPlaceholderData: false,
        isViewReady: true,
      })
    ).toBe(previousData);
  });

  it("removes legacy complete-corpus placeholder data", () => {
    expect(
      selectPresentedBranchPageData(previousData, {
        isPlaceholderData: true,
        isViewReady: true,
      })
    ).toBeUndefined();
  });

  /**
   * ISS-8127: the cohort request and the summary cards are both built from
   * what this returns, so withholding here is what stops a cohort narrowed by
   * the pre-restore default window from reaching the producer.
   */
  it("removes cached data whose window the restore has not confirmed", () => {
    expect(
      selectPresentedBranchPageData(previousData, {
        isPlaceholderData: false,
        isViewReady: false,
      })
    ).toBeUndefined();
  });
});

describe("isBranchPageDataPresentationPending", () => {
  it("treats placeholder data as loading", () => {
    expect(
      isBranchPageDataPresentationPending({
        isPending: false,
        isPlaceholderData: true,
        isError: false,
        isViewReady: true,
        pageData: serverProducedPageData,
      })
    ).toBe(true);
  });

  it("lets a rejected server placeholder render Retry", () => {
    expect(
      isBranchPageDataPresentationPending({
        isPending: false,
        isPlaceholderData: true,
        isError: true,
        isViewReady: true,
        pageData: serverProducedPageData,
      })
    ).toBe(false);
  });

  it("withholds legacy placeholder data as loading", () => {
    expect(
      isBranchPageDataPresentationPending({
        isPending: false,
        isPlaceholderData: true,
        isError: false,
        isViewReady: true,
      })
    ).toBe(true);
  });

  /**
   * ISS-8127: withholding must read as LOADING, not as an empty result. The
   * surface briefly showing a skeleton is the accepted cost; showing "0
   * branches" for data that is merely unconfirmed would be the same lie in a
   * different font.
   */
  it("reports loading while the view restores over settled data", () => {
    expect(
      isBranchPageDataPresentationPending({
        isPending: false,
        isPlaceholderData: false,
        isError: false,
        isViewReady: false,
      })
    ).toBe(true);
  });

  it("still surfaces an error raised before the view restored", () => {
    expect(
      isBranchPageDataPresentationPending({
        isPending: false,
        isPlaceholderData: false,
        isError: true,
        isViewReady: false,
      })
    ).toBe(false);
  });
});

describe("resolveBranchPageState", () => {
  it("keeps server controls while placeholder rows are withheld", () => {
    const serverSetPage = vi.fn();
    const serverHandleFiltersChange = vi.fn();
    const legacySetPage = vi.fn();
    const legacyHandleFiltersChange = vi.fn();

    const state = resolveBranchPageState({
      serverPageActive: false,
      serverControlsActive: true,
      server: {
        filters: { ...DEFAULT_BRANCH_FILTERS, names: ["selected-key"] },
        page: 0,
        setPage: serverSetPage,
        handleFiltersChange: serverHandleFiltersChange,
        replaceViewParams: vi.fn(),
        commitCollapsedGroups: vi.fn(),
        commitGrouping: vi.fn(),
      },
      legacy: {
        filters: { ...DEFAULT_BRANCH_FILTERS, names: ["previous-key"] },
        page: 2,
        setPage: legacySetPage,
        handleFiltersChange: legacyHandleFiltersChange,
        replaceViewParams: vi.fn(),
        filteredRows: [],
        pagedRows: [],
        total: 0,
        totalPages: 1,
      },
      data: undefined,
      rows: [],
      pageSize: 20,
    });

    expect(state.filters.names).toEqual(["selected-key"]);
    expect(state.setPage).toBe(serverSetPage);
    expect(state.handleFiltersChange).toBe(serverHandleFiltersChange);
  });

  // ISS-9582: a band toggle commits through the server hook, which owns the
  // grouping view, but writes the URL through whichever controls own the facets
  // on screen — the legacy writer re-asserting stale server facets is the defect.
  it.each([
    ["legacy", false, false],
    ["server (placeholder)", false, true],
    ["server (served page)", true, true],
  ] as const)(
    "writes a grouping gesture's URL through the %s controls",
    (owner, serverPageActive, serverControlsActive) => {
      const server = controls(0);
      const legacy = {
        ...controls(0),
        filteredRows: [],
        pagedRows: [],
        total: 0,
        totalPages: 1,
      };
      const state = resolveBranchPageState({
        serverPageActive,
        serverControlsActive,
        server,
        legacy,
        data: undefined,
        rows: [],
        pageSize: 20,
      });
      const collapsed = { "repo|": ["acme/web"] };

      state.handleCollapsedGroupsChange(collapsed);
      state.handleGroupingChange(EMPTY_TABLE_GROUPING);

      expect(server.commitCollapsedGroups).toHaveBeenCalledWith(collapsed);
      expect(server.commitGrouping).toHaveBeenCalledWith(EMPTY_TABLE_GROUPING);
      const [writer, idle] =
        owner === "legacy" ? [legacy, server] : [server, legacy];
      expect(writer.replaceViewParams).toHaveBeenCalledTimes(2);
      expect(idle.replaceViewParams).not.toHaveBeenCalled();
    }
  );

  it("derives legacy range values from the selected legacy page", () => {
    const row = branchRow("row", "2026-08-20T00:00:00Z");
    const state = resolveBranchPageState({
      serverPageActive: false,
      server: controls(0),
      legacy: {
        ...controls(1),
        filteredRows: [row],
        pagedRows: [row],
        total: 25,
        totalPages: 2,
      },
      data: undefined,
      rows: [],
      pageSize: 20,
    });
    expect(state).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 25,
      totalPages: 2,
      from: 21,
      to: 25,
      filteredRows: [row],
      pagedRows: [row],
    });
  });

  it("derives server page and empty range values from response metadata", () => {
    const row = branchRow("row", "2026-08-20T00:00:00Z");
    const populated = resolveBranchPageState({
      serverPageActive: true,
      server: controls(0),
      legacy: {
        ...controls(0),
        filteredRows: [],
        pagedRows: [],
        total: 0,
        totalPages: 1,
      },
      data: {
        rows: [],
        total: 45,
        pageInfo: { offset: 25, limit: 25 },
      } as never,
      rows: [row],
      pageSize: 20,
    });
    expect(populated).toMatchObject({
      page: 1,
      pageSize: 25,
      total: 45,
      totalPages: 2,
      from: 26,
      to: 45,
      filteredRows: [row],
      pagedRows: [row],
    });

    const empty = resolveBranchPageState({
      serverPageActive: true,
      server: controls(0),
      legacy: {
        ...controls(0),
        filteredRows: [],
        pagedRows: [],
        total: 0,
        totalPages: 1,
      },
      data: undefined,
      rows: [],
      pageSize: 20,
    });
    expect(empty).toMatchObject({
      total: 0,
      from: 0,
      to: 0,
      page: 0,
      pageSize: 20,
    });
  });
});

const serverProducedPageData = {
  list: {
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
    },
  },
};

function controls(page: number) {
  return {
    filters: DEFAULT_BRANCH_FILTERS,
    page,
    setPage: vi.fn(),
    handleFiltersChange: vi.fn(),
    replaceViewParams: vi.fn(),
    commitCollapsedGroups: vi.fn(),
    commitGrouping: vi.fn(),
  };
}

function branchRow(id: string, lastActivityAt: string): BranchRow {
  return {
    id,
    branchName: id,
    baseBranch: "main",
    repo: "org/repo",
    owner: "Ada",
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
    lastActivityLabel: "now",
    lastActivityAt,
  };
}
