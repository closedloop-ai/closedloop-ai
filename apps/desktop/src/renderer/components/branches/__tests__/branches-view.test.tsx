import {
  type BranchAnalytics,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BRANCH_GRID_TABLE_V2_PAGE_SIZE } from "@repo/app/branches/hooks/use-branch-filter-state";
import {
  type BranchFilters,
  DEFAULT_BRANCH_FILTERS,
} from "@repo/app/branches/lib/branch-row";
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { PRODUCT_GRID_FAVORITE_COLUMN_LABEL } from "@repo/app/shared/lib/product-grid-favorites";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { desktopBranchDetailHref } from "../../../shared-branches/branch-hrefs";
import { renderView, wireRow } from "./test-helpers";

const {
  beginSignInMock,
  openGitHubConnectMock,
  useDesktopAuthMock,
  summaryCardsPropsMock,
  applyArrangementMock,
  setSharedDateRangeMock,
  savedViewsApplyMock,
  savedViewsSnapshotMock,
  savedViewsPropMock,
  cohortAnalyticsMock,
  useSharedDateRangeMock,
} = vi.hoisted(() => ({
  beginSignInMock: vi.fn(),
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
  summaryCardsPropsMock: vi.fn(),
  // FEA-4180 (whitlockk review): the two live-state setters a switched saved view
  // must drive TOGETHER on desktop — sort/columns/order through the view-state
  // hook's `applyArrangement`, and the time window through the SHARED
  // date-range store's `setDateRange` (desktop keeps the window out of
  // view-state extras). The shared hook test can't cover this desktop-only
  // split, so we capture the `apply` bundle the desktop adapter hands
  // `useBranchSavedViews` and assert both setters fire on a select.
  applyArrangementMock: vi.fn(),
  setSharedDateRangeMock: vi.fn(),
  savedViewsApplyMock: vi.fn(),
  // ISS-9447 M5: the arrangement this surface CAPTURES into a named view. The
  // shared hook cannot see whether the desktop adapter actually hands it the
  // widths and rows-per-page it reads from view-state — that assembly is here.
  savedViewsSnapshotMock: vi.fn(),
  savedViewsPropMock: vi.fn(),
  cohortAnalyticsMock: vi.fn(),
  useSharedDateRangeMock: vi.fn(),
}));

// Only the table is under test here, so the data-fetching siblings (summary
// cards) and the controlled toolbar are stubbed to markers. The view now
// fetches list + analytics together via `pageData` (FEA-3056 follow-up), so
// the fake source's `pageData` wraps `listMock` and pairs it with a neutral
// analytics fixture that summary cards (mocked out) never reads.
// Mirrors the marker-mock style in app-shell-routing.test.tsx. The summary-cards marker
// records its props so the view's wiring into the cards can be asserted.
vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: { approved?: boolean }) => {
    summaryCardsPropsMock(props);
    return null;
  },
}));
// ISS-8909: the v2 list surface is the only Branches arm, and it spreads this
// host's one toolbar prop set into `BranchesListToolbarV2`. The capture moved
// here from the retired v1 `BranchesToolbar`, which no longer renders.
vi.mock(
  "@repo/app/branches/components/branches-list-toolbar-v2",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/branches/components/branches-list-toolbar-v2")
    >()),
    BranchesListToolbarV2: (props: { savedViews?: unknown }) => {
      savedViewsPropMock(props.savedViews);
      return null;
    },
  })
);

// FEA-4180 (whitlockk review): mock the shared saved-views hook so the desktop
// adapter's `apply` bundle (built from the view-state `applyArrangement` + the
// SHARED `setDateRange`) is captured here. The real hook is exercised by its
// own package tests; this desktop test proves the Electron-surface wiring that
// routes the window through the shared store while sort/columns go through
// view-state.
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: (
    _store: unknown,
    snapshot: unknown,
    apply: {
      applyArrangement: (a: {
        sortKey: string;
        sortDir: string;
        dateRange: string;
        hiddenColumns: string[];
        columnOrder: string[];
        columnWidths: Record<string, number>;
        pageSize?: number;
      }) => void;
      applyFilters: (f: unknown) => void;
    }
  ) => {
    savedViewsSnapshotMock(snapshot);
    savedViewsApplyMock(apply);
    return {
      views: [],
      activeViewId: null,
      modified: false,
      // ISS-8127: the surface withholds its cohort request until the restored
      // ACTIVE view's arrangement has been applied. Default TRUE here so every
      // case that is not about that gate behaves as before; the gate's own case
      // drives it. A stub that omits this reads as "never settled" and silently
      // withholds every cohort request in this file.
      isArrangementSettled: true,
      onSelectView: vi.fn(),
      onCreateView: vi.fn(),
      onUpdateView: vi.fn(),
      onRenameView: vi.fn(),
      onDeleteView: vi.fn(),
    };
  },
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

// The shared date-range hook reads localStorage (unavailable in jsdom) and
// defaults to DEFAULT_DATE_RANGE ("7d"). Mock to "all" so the fixed-date fixture row isn't filtered
// by the client-side time window (this test asserts row → detail links, not
// windowing).
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: useSharedDateRangeMock,
}));

// ISS-8909: v2 HONORS the saved view's column order and page size; v1 ignored both.
const { viewStateOverrides } = vi.hoisted(() => ({
  viewStateOverrides: {} as { columnOrder?: string[]; pageSize?: number },
}));

// The renderer jsdom env has no localStorage, so the real hook's saved-view
// seeding is a no-op — mock the hook to a deterministic view state.
vi.mock(
  "@repo/app/branches/hooks/use-branch-view-state",
  async (importOriginal) => ({
    // ISS-8909: the v2 list surface is the only Branches arm now, and its
    // toolbar reads more of this module than the v1 one did. Stand down only
    // the hook these cases pin; a bare factory drops the rest.
    ...(await importOriginal<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >()),
    useBranchViewState: (_persistKey: string, approved = false) => ({
      // ISS-8127: the view gates presentation on this, so a stub omitting it
      // reads as "never restored" and withholds every row. These suites are
      // not about the restore, so the view is already settled.
      isViewReady: true,
      sortKey: "updated",
      sortDir: "desc",
      // "all" so the fixed-date fixture row isn't filtered by the client-side time
      // window (this test asserts row → detail links, not windowing).
      dateRange: "all",
      visibleColumns: new Set(
        approved
          ? [
              "owner",
              "collaborators",
              "sessions",
              "changes",
              "status",
              "pr",
              "lastActivity",
              "repo",
              "tags",
              "project",
            ]
          : [
              "repo",
              "owner",
              "status",
              "updated",
              "sessions",
              "changes",
              "behindAhead",
              "pr",
              "checks",
            ]
      ),
      // Approved and legacy state both expose representative orders to the host.
      columnOrder:
        viewStateOverrides.columnOrder ??
        (approved
          ? ["status", "owner", "sessions"]
          : ["repo", "owner", "status", "lastActivity", "sessions", "changes"]),
      setColumnOrder: vi.fn(),
      // ISS-9447 M5: concrete values, not `undefined` — the desktop capture case
      // asserts these exact ones reach the saved-views snapshot, so a stub that
      // left them absent would pass whether the adapter wired them or not.
      columnWidths: { status: 220 },
      setColumnWidth: vi.fn(),
      pageSize: viewStateOverrides.pageSize ?? 100,
      setPageSize: vi.fn(),
      setSort: vi.fn(),
      toggleSortDir: vi.fn(),
      setDateRange: vi.fn(),
      toggleColumn: vi.fn(),
      resetColumns: vi.fn(),
      resetView: vi.fn(),
      // FEA-4180: the combined sort/window/columns/order setter a switched saved
      // view drives on desktop. Hoisted so the wiring test can assert it fires.
      applyArrangement: applyArrangementMock,
    }),
  })
);

const SUMMARY_METRICS_ERROR_PATTERN = /couldn't load the summary metrics/i;
const COHORT_CLAIM_PATTERN =
  /Updating Branches for|Couldn't update Branches for/i;
const RETRY_BUTTON_NAME_PATTERN = /retry/i;
const HIDDEN_REVEAL_TEXT_PATTERN = /hidden/;
// FEA-4004 retired this flag; the string is kept only so the regression below
// can force the pre-PR default-hide branch on. If the removal ever regressed,
// the old code would still gate on this key and hide the merged/agent rows,
// failing the assertions (whitlockk review).
const RETIRED_BRANCHES_HIDE_CRUFT_FLAG = "branches-hide-cruft";

let listItems: WireBranchRow[] = [wireRow];
let sessionCostUsd: Record<string, number> | undefined;
const listMock = vi.fn();

// `usage`/`analytics`/`detail`/`comments` are never reached (their consumers
// are mocked out or unused here), so they stay pending rather than carrying
// throwaway fixtures. `pageData` backs the table (via `listMock`) paired with
// a neutral analytics fixture the mocked-out summary cards never read.
const dataSource: BranchesDataSource = {
  scope: "local",
  list: listMock,
  detail: () => new Promise<never>(() => undefined),
  comments: () => new Promise<never>(() => undefined),
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: cohortAnalyticsMock,
  pageData: async (filters) => ({
    list: await listMock(filters),
    analytics: makeBranchAnalytics(),
  }),
};

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

type BranchQueryFreshnessOptions = {
  refetchOnWindowFocus?: unknown;
  staleTime?: unknown;
};

let desktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(viewStateOverrides, {
    columnOrder: undefined,
    pageSize: undefined,
  });
  useSharedDateRangeMock.mockReturnValue({
    dateRange: "all",
    setDateRange: setSharedDateRangeMock,
  });
  listItems = [wireRow];
  sessionCostUsd = undefined;
  listMock.mockImplementation(() =>
    Promise.resolve({
      items: listItems,
      total: listItems.length,
      viewerScope: BranchViewerScope.Self,
      ...(sessionCostUsd ? { sessionCostUsd } : {}),
    })
  );
  cohortAnalyticsMock.mockImplementation(async (request) => ({
    matchedBranchIds: request.branchIds,
    canonicalMetrics: makeBranchListMetrics({
      cohortSize: request.branchIds.length,
    }),
  }));
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: beginSignInMock,
  });
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

afterEach(() => {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("BranchesView row → detail links", () => {
  it("does not announce a cohort notice during initial loading or failure", async () => {
    useSharedDateRangeMock.mockReturnValue({
      dateRange: "7d",
      setDateRange: setSharedDateRangeMock,
    });
    const pendingSource = {
      ...dataSource,
      pageData: () => new Promise<never>(() => undefined),
    };
    const pending = renderView(pendingSource, undefined, [
      BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY,
    ]);
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).toBeNull();
    pending.unmount();

    const failedSource = {
      ...dataSource,
      pageData: () => Promise.reject(new Error("list unavailable")),
    };
    renderView(failedSource, undefined, [
      BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY,
    ]);
    await screen.findByRole("button", { name: RETRY_BUTTON_NAME_PATTERN });
    expect(screen.queryByText(COHORT_CLAIM_PATTERN)).toBeNull();
  });

  it("reuses each fresh UTC-day query key across remounts and range returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));
    useSharedDateRangeMock.mockReturnValue({
      dateRange: "30d",
      setDateRange: setSharedDateRangeMock,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    try {
      const first = renderView(dataSource, queryClient);
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
      first.unmount();
      vi.setSystemTime(new Date("2026-06-20T12:00:00.001Z"));

      const sameDay = renderView(dataSource, queryClient);
      await screen.findByText("feature/x");
      expect(listMock).toHaveBeenCalledTimes(1);
      sameDay.unmount();

      useSharedDateRangeMock.mockReturnValue({
        dateRange: "7d",
        setDateRange: setSharedDateRangeMock,
      });
      const otherRange = renderView(dataSource, queryClient);
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
      otherRange.unmount();

      useSharedDateRangeMock.mockReturnValue({
        dateRange: "30d",
        setDateRange: setSharedDateRangeMock,
      });
      const cachedRange = renderView(dataSource, queryClient);
      await screen.findByText("feature/x");
      expect(listMock).toHaveBeenCalledTimes(2);
      cachedRange.unmount();
      vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));

      renderView(dataSource, queryClient);
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    } finally {
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  // ISS-5809: same defect, same fix, other surface — a window ending at yesterday
  // 23:59:59.999 dropped every branch touched today off a list sorted by recent
  // activity. Asserted on the Electron adapter's own request.
  it("requests a window that includes the in-progress UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));
    useSharedDateRangeMock.mockReturnValue({
      dateRange: "30d",
      setDateRange: setSharedDateRangeMock,
    });

    try {
      renderView(dataSource);
      await waitFor(() => expect(listMock).toHaveBeenCalled());

      const filters = listMock.mock.lastCall?.[0];
      expect(filters?.endDate).toBe("2026-06-20T23:59:59.999Z");
      expect(filters?.startDate).toBe("2026-05-22T00:00:00.000Z");
      expect(filters?.pageMode).toBeUndefined();
      expect(filters?.limit).toBeUndefined();
      expect(filters?.offset).toBeUndefined();
      expect(Date.parse(filters?.endDate ?? "")).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests one fixed producer page for split-capable cloud sources", async () => {
    const emptyFacet = {
      availability: BranchListFacetAvailability.Complete,
      options: [],
    };
    // ISS-8909: still ONE fixed producer page, at the size the view resolves.
    viewStateOverrides.pageSize = BRANCH_GRID_TABLE_V2_PAGE_SIZE;
    const splitDataSource = {
      ...dataSource,
      scope: "http",
      supportsSplitPageData: true,
      // Split sources read analytics separately, and v2 gates the page on it.
      analytics: () => Promise.resolve(makeBranchAnalytics()),
    };
    listMock.mockResolvedValue({
      items: makeNumberedBranchRows(BRANCH_GRID_TABLE_V2_PAGE_SIZE),
      total: 47,
      viewerScope: BranchViewerScope.Self,
      pageInfo: {
        capability: BranchListCapability.ServerPaginationV1,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        requestedOffset: 0,
        now: "2026-08-18T18:00:00.000Z",
      },
      facets: {
        names: emptyFacet,
        owners: emptyFacet,
        collaborators: emptyFacet,
        statuses: emptyFacet,
        pullRequests: emptyFacet,
        lastActiveRanges: emptyFacet,
        repositories: emptyFacet,
        tags: emptyFacet,
      },
    });

    renderView(splitDataSource);

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pageMode: BranchListPageMode.Server,
          limit: BRANCH_GRID_TABLE_V2_PAGE_SIZE,
          offset: 0,
          sortKey: BranchListSortKey.LastActivity,
          sortDir: BranchListSortDirection.Desc,
        })
      )
    );
    // ISS-8909: the range sentence v1 drew from page/pageSize/total stays pinned
    // by the sibling fallback-pagination case and by branches-page.spec.ts.
    expect(await screen.findByText("feature/sort-01")).toBeTruthy();
    expect(cohortAnalyticsMock).not.toHaveBeenCalled();
  });

  it("renders filter-empty copy when a server-side facet returns no rows", async () => {
    useSharedDateRangeMock.mockReturnValue({
      dateRange: "30d",
      setDateRange: setSharedDateRangeMock,
    });
    const splitDataSource = {
      ...dataSource,
      scope: "http",
      supportsSplitPageData: true,
    };
    listMock
      .mockResolvedValueOnce(makeServerListResult([wireRow]))
      .mockResolvedValueOnce(makeServerListResult([]));

    renderView(splitDataSource);
    expect(await screen.findByText("feature/x")).toBeDefined();

    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | { applyFilters: (filters: BranchFilters) => void }
      | undefined;
    act(() => {
      apply?.applyFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["missing-owner"],
      });
    });

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock.mock.lastCall?.[0]).toMatchObject({
      owners: ["missing-owner"],
      pageMode: BranchListPageMode.Server,
    });
    expect(await screen.findByText("No matching branches")).toBeDefined();
    expect(
      screen.getByText(
        "No branches match the current filters. Try clearing a filter."
      )
    ).toBeDefined();
    expect(
      screen.queryByText("No branches were active in the selected date range.")
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });

  it("resets fallback pagination when sorting a legacy producer response", async () => {
    // ISS-8909: 60 rows over 25 is the same THREE pages this case always walked.
    viewStateOverrides.pageSize = BRANCH_GRID_TABLE_V2_PAGE_SIZE;
    listItems = makeNumberedBranchRows(60);
    renderView(dataSource);

    expect(await screen.findByText("1–25 of 60")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(await screen.findByText("26–50 of 60")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(await screen.findByText("51–60 of 60")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(await screen.findByText("1–25 of 60")).toBeDefined();
  });

  it("renders the exact approved schema without a Desktop Labs flag", async () => {
    // ISS-8909: pins the SHIPPED DEFAULT schema, so render with no saved order.
    viewStateOverrides.columnOrder = [];
    renderView(
      dataSource,
      undefined,
      [],
      "/branches",
      true,
      createStaticFeatureFlagAdapter({ enabledFlags: [] })
    );

    const headings = await screen.findAllByRole("heading", {
      level: 1,
      name: "Branches",
    });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.classList.contains("sr-only")).toBe(true);
    const scrollRegion = screen.getByRole("region", { name: "Branches" });
    // ISS-8909: the shared surface owns this element and renders a `div`. Role,
    // name, tab stop and the classes below are the contract; only the tag moved.
    expect(scrollRegion.tagName).toBe("DIV");
    expect(scrollRegion.tabIndex).toBe(0);
    expect([...scrollRegion.classList]).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-auto"])
    );
    await screen.findByText("feature/x");
    // ISS-12456: this fixture's source carries no `supportsTags` or
    // `supportsProject`, so the approved schema's Tags and Project columns
    // are absent here — the same opt-in Priority already has (also absent,
    // since this source carries no `updatePriority`).
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim())
    ).toEqual([
      // ISS-12918: Branches inherits the shared far-left star column.
      PRODUCT_GRID_FAVORITE_COLUMN_LABEL,
      "Name",
      "Owner",
      "Collaborators",
      "Linked sessions",
      "Changes",
      "Status",
      "Pull request",
      "Last active",
      "Repository",
    ]);
  });

  it("links rows into the detail route", async () => {
    const { container } = renderView(dataSource);

    expect(await screen.findByText("feature/x")).toBeDefined();
    await waitFor(() =>
      expect(
        container.querySelector(`a[href="${desktopBranchDetailHref(wireRow)}"]`)
      ).not.toBeNull()
    );
  });

  it("overrides desktop ambient staleTime so focus can recheck cloud hydration", async () => {
    const { queryClient } = renderView(dataSource);

    expect(await screen.findByText("feature/x")).toBeDefined();

    const query = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["branches", "page-data"] })
      .find((candidate) => candidate.queryKey.length > 2);
    const options = query?.options as BranchQueryFreshnessOptions | undefined;
    expect(options?.staleTime).toBe(90_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  // The GitHub-connect flow (opens connect, signed-out sign-in-first routing,
  // and both local-fallback cases) lives in
  // branches-view-github-connect.test.tsx to keep this file under the
  // repo's 1000-line ceiling.
});

describe("BranchesView always shows merged + agent/bot branches (FEA-4004)", () => {
  const mergedWireRow: WireBranchRow = {
    ...wireRow,
    id: "owner%2Frepo::landed",
    branchName: "feature/landed",
    status: BranchStatus.Merged,
  };
  const agentWireRow: WireBranchRow = {
    ...wireRow,
    id: "owner%2Frepo::worktree-agent-x",
    branchName: "worktree-agent-deadbeef",
    sessionIds: [],
  };

  it("renders merged and session-less agent branches by default, with no hidden reveal", async () => {
    // FEA-4004 removed the "Hide Merged & Agent Branches" default-hide, so every
    // branch — merged, agent-worktree with no linked session — renders by
    // default and there is no "N hidden · Show" reveal. Enable the retired flag
    // so this fails against the pre-PR implementation (which gated the hide on
    // it) rather than passing trivially with the flag off (whitlockk review).
    listItems = [wireRow, mergedWireRow, agentWireRow];
    renderView(dataSource, undefined, [RETIRED_BRANCHES_HIDE_CRUFT_FLAG]);

    expect(await screen.findByText("feature/x")).toBeDefined();
    expect(screen.getByText("feature/landed")).toBeDefined();
    expect(screen.getByText("worktree-agent-deadbeef")).toBeDefined();
    expect(screen.queryByText(HIDDEN_REVEAL_TEXT_PATTERN)).toBeNull();
  });
});

// FEA-3988: the zero-data read routes through the shared `EmptyState`
// (title + description + a tokenized icon) instead of a bare centered
// "No branches yet." string, so it matches the Sessions/Plans/branch-detail
// empty scale on both desktop and web (this list view is shared via `@repo/app`).
describe("BranchesView empty state (FEA-3988)", () => {
  it("renders the genuine 'No branches yet' onboarding state when no branches exist at all", async () => {
    listItems = [];
    const { container } = renderView(dataSource);

    expect(await screen.findByText("No branches yet")).toBeDefined();
    expect(
      screen.getByText(
        "Branches appear here once they're synced from your connected provider."
      )
    ).toBeDefined();
    // The canonical EmptyState renders its glyph inside an EmptyMedia icon slot;
    // a bare "No branches yet." <div> had no svg. This proves the icon variant.
    expect(container.querySelector("svg")).not.toBeNull();
    // The genuine-empty must NOT read as the filtered-empty state.
    expect(screen.queryByText("No matching branches")).toBeNull();
  });
});

describe("BranchesView saved-view apply wiring (FEA-4180, Electron surface)", () => {
  it("routes a switched view's arrangement through view-state AND its window through the shared date-range store together", async () => {
    renderView(dataSource);
    await screen.findByText("feature/x");

    // Capture the `apply` bundle the desktop adapter handed the saved-views hook.
    // `applyArrangement` here is the desktop-only `applySavedArrangement`, which
    // must fan a switched view out to BOTH the view-state setter (sort/columns/
    // order) and the SHARED date-range store (the time window) — the split the
    // shared hook test cannot cover.
    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | {
          applyArrangement: (a: {
            sortKey: string;
            sortDir: string;
            dateRange: string;
            hiddenColumns: string[];
            columnOrder: string[];
            columnWidths: Record<string, number>;
            pageSize?: number;
          }) => void;
        }
      | undefined;
    expect(apply?.applyArrangement).toBeTypeOf("function");

    apply?.applyArrangement({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["repo"],
      columnOrder: ["status", "owner"],
      columnWidths: { owner: 140 },
      pageSize: 500,
    });

    // Sort/columns/order went through the view-state hook…
    expect(applyArrangementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["repo"],
        columnOrder: ["status", "owner"],
        // ISS-9447 M5: the desktop wrapper splits the WINDOW out and must pass
        // the rest through whole — a wrapper that rebuilt the arrangement from
        // named fields would silently drop these two.
        columnWidths: { owner: 140 },
        pageSize: 500,
      })
    );
    // …and the time window went through the SHARED date-range store, together.
    expect(setSharedDateRangeMock).toHaveBeenCalledWith("30d");
  });

  it("captures the live widths and rows-per-page into the saved-view snapshot", async () => {
    renderView(dataSource);
    await screen.findByText("feature/x");

    // ISS-9447 M5: desktop's own half of the capture. Both shells read these
    // from `useBranchViewState`, but each assembles its own snapshot object, so
    // this is the only place that can catch the desktop one omitting them.
    const snapshot = savedViewsSnapshotMock.mock.calls.at(-1)?.[0] as
      | { columnWidths?: Record<string, number>; pageSize?: number }
      | undefined;
    expect(snapshot?.columnWidths).toEqual({ status: 220 });
    expect(snapshot?.pageSize).toBe(100);
  });

  it("requests exact producer metrics for the Desktop filtered cohort", async () => {
    listItems = [
      wireRow,
      {
        ...wireRow,
        id: "owner%2Frepo::other",
        branchName: "feature/other",
        owner: "bob",
      },
    ];
    renderView(dataSource);
    await screen.findByText("feature/x");

    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | { applyFilters: (filters: BranchFilters) => void }
      | undefined;
    act(() => {
      apply?.applyFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["alice"],
      });
    });

    await waitFor(() =>
      expect(cohortAnalyticsMock).toHaveBeenCalledWith({
        branchIds: [wireRow.id],
      })
    );
  });

  it("uses exact producer spend for a 101-branch Desktop cohort", async () => {
    const aliceRows = makeDesktopCohortRows(101, "alice");
    listItems = [
      ...aliceRows,
      {
        ...wireRow,
        id: "owner%2Frepo::bob-only",
        branchName: "feature/bob-only",
        owner: "bob",
        sessionIds: ["session-bob-only"],
      },
    ];
    sessionCostUsd = Object.fromEntries(
      aliceRows.map((row) => [row.sessionIds[0] as string, 1])
    );
    cohortAnalyticsMock.mockImplementation(async (request) => ({
      matchedBranchIds: request.branchIds,
      canonicalMetrics: makeBranchListMetrics({
        cohortSize: request.branchIds.length,
        activeBranches: {
          current: {
            state: BranchMetricAvailability.Complete,
            value: request.branchIds.length,
          },
        },
        aiSpendUsd: {
          current: {
            state: BranchMetricAvailability.Complete,
            value: 321,
          },
        },
      }),
    }));

    renderView(dataSource);
    await screen.findByText("feature/cohort-1");
    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | { applyFilters: (filters: BranchFilters) => void }
      | undefined;
    act(() => {
      apply?.applyFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["alice"],
      });
    });

    await waitFor(() => {
      const request = cohortAnalyticsMock.mock.calls.findLast(
        ([candidate]) => candidate.branchIds.length === 101
      )?.[0];
      expect(request?.branchIds).toHaveLength(101);
      const props = summaryCardsPropsMock.mock.calls.at(-1)?.[0] as
        | { analytics?: BranchAnalytics }
        | undefined;
      expect(props?.analytics?.canonicalMetrics?.aiSpendUsd.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 321,
      });
      expect(
        props?.analytics?.canonicalMetrics?.activeBranches.current
      ).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 101,
      });
    });
  });

  it("marks the Desktop summary unavailable when cohort IPC rejects", async () => {
    listItems = [
      wireRow,
      {
        ...wireRow,
        id: "owner%2Frepo::other",
        branchName: "feature/other",
        owner: "bob",
      },
    ];
    cohortAnalyticsMock.mockRejectedValue(new Error("IPC unavailable"));

    renderView(dataSource);
    await screen.findByText("feature/x");
    const apply = savedViewsApplyMock.mock.calls.at(-1)?.[0] as
      | { applyFilters: (filters: BranchFilters) => void }
      | undefined;
    act(() => {
      apply?.applyFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["alice"],
      });
    });

    await waitFor(() => {
      const props = summaryCardsPropsMock.mock.calls.at(-1)?.[0] as
        | { isError?: boolean }
        | undefined;
      expect(props?.isError).toBe(true);
    });
    expect(screen.getByText(SUMMARY_METRICS_ERROR_PATTERN)).toBeDefined();
  });
});

function makeDesktopCohortRows(count: number, owner: string): WireBranchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ...wireRow,
    id: `owner%2Frepo::cohort-${index + 1}`,
    branchName: `feature/cohort-${index + 1}`,
    owner,
    sessionIds: [`session-${index + 1}`],
  }));
}

function makeNumberedBranchRows(count: number): WireBranchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ...wireRow,
    id: `owner%2Frepo::sort-${index + 1}`,
    branchName: `feature/sort-${String(index + 1).padStart(2, "0")}`,
    lastActivityAt: `2026-06-17T12:${String(index % 60).padStart(
      2,
      "0"
    )}:00.000Z`,
  }));
}

function makeServerListResult(items: WireBranchRow[]) {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Self,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: "2026-08-18T18:00:00.000Z",
    },
    facets: {
      names: {
        availability: BranchListFacetAvailability.Complete,
        options: items.map((item) => ({
          id: item.branchName,
          label: item.branchName,
          count: 1,
        })),
      },
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}
