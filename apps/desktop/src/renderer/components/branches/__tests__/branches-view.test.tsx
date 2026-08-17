import {
  type BranchAnalytics,
  BranchCloudHydrationStatus,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import {
  type BranchFilters,
  DEFAULT_BRANCH_FILTERS,
} from "@repo/app/branches/lib/branch-row";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderView, wireRow } from "./test-helpers";

const {
  beginSignInMock,
  openGitHubConnectMock,
  useDesktopAuthMock,
  summaryCardsPropsMock,
  applyArrangementMock,
  setSharedDateRangeMock,
  savedViewsApplyMock,
  savedViewsPropMock,
  cohortAnalyticsMock,
  useSharedDateRangeMock,
} = vi.hoisted(() => ({
  beginSignInMock: vi.fn(),
  openGitHubConnectMock: vi.fn(),
  useDesktopAuthMock: vi.fn(),
  summaryCardsPropsMock: vi.fn(),
  // FEA-4180 (wongk review): the two live-state setters a switched saved view
  // must drive TOGETHER on desktop — sort/columns/order through the view-state
  // hook's `applyArrangement`, and the time window through the SHARED
  // date-range store's `setDateRange` (desktop keeps the window out of
  // view-state extras). The shared hook test can't cover this desktop-only
  // split, so we capture the `apply` bundle the desktop adapter hands
  // `useBranchSavedViews` and assert both setters fire on a select.
  applyArrangementMock: vi.fn(),
  setSharedDateRangeMock: vi.fn(),
  savedViewsApplyMock: vi.fn(),
  savedViewsPropMock: vi.fn(),
  cohortAnalyticsMock: vi.fn(),
  useSharedDateRangeMock: vi.fn(),
}));

// Only the table is under test here, so the data-fetching siblings (summary
// cards) and the controlled toolbar are stubbed to markers. The view now
// fetches list + analytics together via `pageData` (FEA-3056 follow-up), so
// the fake source's `pageData` wraps `listMock` and pairs it with a neutral
// analytics fixture that summary cards (mocked out) never reads.
// Mirrors the marker-mock style in app-shell.test.tsx. The summary-cards marker
// records its props so we can assert the view wires the GitHub-connect handler
// into the gated KPI cards (FEA-3273).
vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: {
    onConnectGitHub?: () => void | Promise<void>;
  }) => {
    summaryCardsPropsMock(props);
    return null;
  },
}));
vi.mock("@repo/app/branches/components/branches-toolbar", () => ({
  // Capture the savedViews prop the desktop view wires in so the FEA-4180 test
  // below can drive its handlers without needing a Radix menu in jsdom.
  BranchesToolbar: (props: { savedViews?: unknown }) => {
    savedViewsPropMock(props.savedViews);
    return null;
  },
}));

// FEA-4180 (wongk review): mock the shared saved-views hook so the desktop
// adapter's `apply` bundle (built from the view-state `applyArrangement` + the
// SHARED `setDateRange`) is captured here. The real hook is exercised by its
// own package tests; this desktop test proves the Electron-surface wiring that
// routes the window through the shared store while sort/columns go through
// view-state.
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  useBranchSavedViews: (
    _persistKey: string | undefined,
    _snapshot: unknown,
    apply: {
      applyArrangement: (a: {
        sortKey: string;
        sortDir: string;
        dateRange: string;
        hiddenColumns: string[];
        columnOrder: string[];
      }) => void;
      applyFilters: (f: unknown) => void;
    }
  ) => {
    savedViewsApplyMock(apply);
    return {
      views: [],
      activeViewId: null,
      modified: false,
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
// defaults to "90d". Mock to "all" so the fixed-date fixture row isn't filtered
// by the client-side time window (this test asserts row → detail links, not
// windowing).
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: useSharedDateRangeMock,
}));

// The renderer jsdom env has no localStorage, so the real hook's saved-view
// seeding is a no-op — mock the hook to a deterministic view state.
vi.mock("@repo/app/branches/hooks/use-branch-view-state", () => ({
  useBranchViewState: (_persistKey: string, approved = false) => ({
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
    // Approved List columns are fixed-order; legacy state remains reorderable.
    columnOrder: approved
      ? []
      : ["repo", "owner", "status", "lastActivity", "sessions", "changes"],
    setColumnOrder: vi.fn(),
    setSort: vi.fn(),
    toggleSortDir: vi.fn(),
    setDateRange: vi.fn(),
    toggleColumn: vi.fn(),
    resetColumns: vi.fn(),
    // FEA-4180: the combined sort/window/columns/order setter a switched saved
    // view drives on desktop. Hoisted so the wiring test can assert it fires.
    applyArrangement: applyArrangementMock,
  }),
}));

// A link wrapping the Name lead resolves to the org-relative /branches/:id
// path (FEA-4051: the row anchor now feeds the navigation-port Link the
// UNPREFIXED path so ordinary left-clicks navigate; the desktop hash-store
// adapter renders the `#`-prefixed anchor href in production, but this test
// mounts the memory adapter, whose identity `renderHref` leaves the path bare).
// The prefix is enough to assert "this row routes into the detail page"
// regardless of how the composite id is encoded.
const BRANCH_DETAIL_LINK_SELECTOR = 'a[href^="/branches/"]';
const CONNECT_GITHUB_BUTTON_NAME_PATTERN = /connect github/i;
const CONNECT_OPENED_MESSAGE_PATTERN = /continue in the browser/i;
const CONNECT_FAILED_MESSAGE_PATTERN = /local branch data remains available/i;
const CLOUD_REFRESH_FAILED_MESSAGE_PATTERN = /github cloud refresh failed/i;
const SUMMARY_METRICS_ERROR_PATTERN = /couldn't load the summary metrics/i;
const HIDDEN_REVEAL_TEXT_PATTERN = /hidden/;
// FEA-4004 retired this flag; the string is kept only so the regression below
// can force the pre-PR default-hide branch on. If the removal ever regressed,
// the old code would still gate on this key and hide the merged/agent rows,
// failing the assertions (wongk review).
const RETIRED_BRANCHES_HIDE_CRUFT_FLAG = "branches-hide-cruft";

const disconnectedWireRow: WireBranchRow = {
  ...wireRow,
  id: "unknown::feature",
  repoFullName: null,
  prNumber: null,
  prTitle: null,
  prState: null,
  prUrl: null,
};

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

beforeEach(() => {
  vi.clearAllMocks();
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
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
});

describe("BranchesView row → detail links", () => {
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
      expect(Date.parse(filters?.endDate ?? "")).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the exact approved schema without a Desktop Labs flag", async () => {
    renderView(dataSource);

    const headings = await screen.findAllByRole("heading", {
      level: 1,
      name: "Branches",
    });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.classList.contains("sr-only")).toBe(true);
    const scrollRegion = screen.getByRole("region", { name: "Branches" });
    expect(scrollRegion.tagName).toBe("SECTION");
    expect(scrollRegion.tabIndex).toBe(0);
    expect([...scrollRegion.classList]).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-auto"])
    );
    await screen.findByText("feature/x");
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim())
    ).toEqual([
      "Name",
      "Owner",
      "Collaborators",
      "Linked sessions",
      "Changes",
      "Status",
      "Pull request",
      "Last active",
      "Repository",
      "Tags",
    ]);
  });

  it("links rows into the detail route", async () => {
    const { container } = renderView(dataSource);

    expect(await screen.findByText("feature/x")).toBeDefined();
    await waitFor(() =>
      expect(
        container.querySelector(BRANCH_DETAIL_LINK_SELECTOR)
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

  it("surfaces failed desktop cloud hydration while keeping local rows visible", async () => {
    listItems = [
      {
        ...wireRow,
        cloudHydrationStatus: BranchCloudHydrationStatus.Failed,
        cloudHydrationFailure: "cloud_pull_failed",
      },
    ];

    renderView(dataSource);

    expect(
      await screen.findByText(CLOUD_REFRESH_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
    expect(await screen.findByText("feature/x")).toBeDefined();
  });

  it("opens GitHub connect from the disconnected branches state", async () => {
    listItems = [disconnectedWireRow];
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    await waitFor(() =>
      expect(openGitHubConnectMock).toHaveBeenCalledWith({
        returnTo: "/branches",
      })
    );
    expect(screen.getByText(CONNECT_OPENED_MESSAGE_PATTERN)).toBeDefined();
  });

  it("wires the summary-card gated connect CTA to the same desktop GitHub connect flow (FEA-3273)", async () => {
    renderView(dataSource);
    await screen.findByText("feature/x");

    // The view threads its shared connect handler into the KPI summary cards, so
    // a gated card's "Connect GitHub" CTA runs the same sign-in → openGitHubConnect
    // flow as the standalone banner rather than doing nothing.
    const props = summaryCardsPropsMock.mock.calls.at(-1)?.[0] as
      | { onConnectGitHub?: () => void | Promise<void> }
      | undefined;
    expect(props?.onConnectGitHub).toBeTypeOf("function");

    await props?.onConnectGitHub?.();
    await waitFor(() =>
      expect(openGitHubConnectMock).toHaveBeenCalledWith({
        returnTo: "/branches",
      })
    );
  });

  it("routes signed-out users through desktop sign-in before connect", async () => {
    listItems = [disconnectedWireRow];
    useDesktopAuthMock.mockReturnValue({
      state: { status: "signed_out", userId: null, organizationId: null },
      beginSignIn: beginSignInMock,
    });
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    await waitFor(() => expect(beginSignInMock).toHaveBeenCalledTimes(1));
    expect(openGitHubConnectMock).toHaveBeenCalledWith({
      returnTo: "/branches",
    });
  });

  it("shows local fallback when GitHub connect cannot open", async () => {
    listItems = [disconnectedWireRow];
    openGitHubConnectMock.mockResolvedValue({
      ok: false,
      reason: "open_failed",
    });
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    expect(
      await screen.findByText(CONNECT_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
  });

  it("shows local fallback when GitHub connect IPC rejects (FEA-2782)", async () => {
    // A rejected (not resolved-false) IPC call must still flip to the Failed
    // banner instead of leaking an unhandled rejection and pinning Pending.
    listItems = [disconnectedWireRow];
    openGitHubConnectMock.mockRejectedValue(new Error("ipc channel closed"));
    renderView(dataSource);

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    expect(
      await screen.findByText(CONNECT_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
  });
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
    // it) rather than passing trivially with the flag off (wongk review).
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
  it("wires savedViews into the toolbar", async () => {
    renderView(dataSource);
    await screen.findByText("feature/x");

    // The desktop view supplies a savedViews bundle to the shared toolbar so the
    // switcher renders on this surface too.
    expect(savedViewsPropMock).toHaveBeenCalled();
    const savedViews = savedViewsPropMock.mock.calls.at(-1)?.[0] as
      | { onSelectView?: unknown }
      | undefined;
    expect(savedViews?.onSelectView).toBeTypeOf("function");
  });

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
    });

    // Sort/columns/order went through the view-state hook…
    expect(applyArrangementMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["repo"],
        columnOrder: ["status", "owner"],
      })
    );
    // …and the time window went through the SHARED date-range store, together.
    expect(setSharedDateRangeMock).toHaveBeenCalledWith("30d");
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
