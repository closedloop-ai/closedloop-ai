import {
  type BranchAnalytics,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BranchesPage from "../page";

const {
  apiPostMock,
  headerMock,
  searchParamsMock,
  useBranchAnalyticsMock,
  useBranchesMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchAnalyticsMock: vi.fn(),
  useBranchesMock: vi.fn(),
}));

const { invalidateQueriesMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
}));
const REFRESH_BUTTON_NAME_PATTERN = /refresh/i;
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

// The page defaults to the "7d" time window, whose start is computed from the
// real clock (`getStartDateForRange("7d")` → now − 7 days) and filters rows by
// `lastActivityAt`. Freeze the clock a few days after the fixture's activity
// timestamp (see `makeBranchRow`) so the row deterministically stays inside the
// default window; otherwise the test starts failing once wall-clock time drifts
// more than 7 days past the fixture.
const FROZEN_NOW = new Date("2026-07-05T12:00:00.000Z");

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    lists: () => ["branches", "list"],
    analyticsRoot: () => ["branches", "analytics"],
  },
  useBranchAnalytics: useBranchAnalyticsMock,
  useBranches: useBranchesMock,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post: apiPostMock }),
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"] },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@/components/feature-flag-gate", () => ({
  FeatureFlagGate: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

// FEA-3120: the BranchesToolbar reads the read-source-indicator flag; this page
// test renders it without a FeatureFlagAdapterProvider, so stub the flag hook to
// its default-off state (the badge stays hidden — matching the default rollout).
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("BranchesPage", () => {
  beforeEach(() => {
    // Fake only `Date` so the window filter is deterministic while the async
    // timers used by `waitFor`/`act` keep running on the real clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    headerMock.mockReset();
    apiPostMock.mockReset();
    searchParamsMock.mockReset();
    useBranchAnalyticsMock.mockReset();
    useBranchesMock.mockReset();
    headerMock.mockImplementation(({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "header" }, children)
    );
    useBranchAnalyticsMock.mockReturnValue({ data: makeAnalytics() });
    useBranchesMock.mockReturnValue({
      data: makeListResponse([makeBranchRow()]),
      isError: false,
      isFetching: false,
      isPending: false,
    });
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders HTTP-backed rows through the shared adapter and links to detail", () => {
    render(<BranchesPage />);

    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(
      screen.getByText("feature/web-branches").closest("a")
    ).toHaveAttribute("href", "/acme/branches/branch-1");
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("Active branches")).toBeInTheDocument();
    expect(useBranchesMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 90_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(useBranchAnalyticsMock).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: expect.any(String) }),
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(
      screen.getByText("feature/web-branches").closest("[data-feature-flag]")
    ).toHaveAttribute("data-feature-flag", ArtifactFlag.Branches);
  });

  it("uses the narrow-safe five-card summary grid on the web route", () => {
    const { container } = render(<BranchesPage />);
    const grid = container.querySelector('[class~="xl:grid-cols-5"]');

    expect(grid).not.toBeNull();
    expect(grid).toHaveClass("grid-cols-1", "lg:grid-cols-3", "xl:grid-cols-5");
    expect(grid).not.toHaveClass("grid-cols-2");
  });

  it("bounds pagination inside a horizontal overflow owner", () => {
    useBranchesMock.mockReturnValue({
      data: makeListResponse(
        Array.from({ length: 30 }, (_value, index) =>
          makeBranchRow({
            id: `branch-${index}`,
            branchName: `feature/web-branches-${index}`,
          })
        )
      ),
      isError: false,
      isFetching: false,
      isPending: false,
    });

    render(<BranchesPage />);

    const pagination = screen.getByRole("navigation", { name: "pagination" });
    expect(pagination).toHaveClass("min-w-max");
    expect(pagination.parentElement).toHaveClass("overflow-x-auto");
  });

  it("keeps loading, error, empty, and filtered-empty states distinct", () => {
    useBranchesMock.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      isPending: true,
    });
    const { rerender } = render(<BranchesPage />);

    expect(screen.getByText("Loading branches…")).toBeInTheDocument();

    useBranchesMock.mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: false,
      isPending: false,
    });
    rerender(<BranchesPage />);
    expect(
      screen.getByText("Could not load branches right now.")
    ).toBeInTheDocument();

    useBranchesMock.mockReturnValue({
      data: makeListResponse([]),
      isError: false,
      isFetching: false,
      isPending: false,
    });
    rerender(<BranchesPage />);
    expect(screen.getByText("No branches yet.")).toBeInTheDocument();
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps branches route critical a11y and contrast clean in %s theme", async (theme) => {
    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <BranchesPage />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Active branches"), {
      background: themeBackground(theme),
      label: `branches populated row ${theme}`,
    });
  });

  it.each([
    [
      "loading",
      () =>
        useBranchesMock.mockReturnValue({
          data: undefined,
          isError: false,
          isFetching: true,
          isPending: true,
        }),
      "Loading branches…",
    ],
    [
      "error",
      () =>
        useBranchesMock.mockReturnValue({
          data: undefined,
          isError: true,
          isFetching: false,
          isPending: false,
        }),
      "Could not load branches right now.",
    ],
    [
      "empty",
      () =>
        useBranchesMock.mockReturnValue({
          data: makeListResponse([]),
          isError: false,
          isFetching: false,
          isPending: false,
        }),
      "No branches yet.",
    ],
    [
      "filtered-empty",
      () =>
        useBranchesMock.mockReturnValue({
          data: makeListResponse([
            makeBranchRow({ lastActivityAt: "2026-01-01T00:00:00.000Z" }),
          ]),
          isError: false,
          isFetching: false,
          isPending: false,
        }),
      "No branches match the current filters.",
    ],
    ["populated", () => undefined, "Active branches"],
  ])("keeps branches %s state a11y and contrast clean", async (_state, setup, expectedText) => {
    for (const theme of A11Y_THEMES) {
      setup();

      const { container, unmount } = render(
        <A11yThemeRoot theme={theme}>
          <BranchesPage />
        </A11yThemeRoot>
      );

      const target = screen.getByText(expectedText);
      await expectCriticalAxeClean(container);
      expectElementContrast(target, {
        background: themeBackground(theme),
        label: `branches ${expectedText} ${theme}`,
      });
      unmount();
    }
  });

  it("renders retryable refresh errors while preserving stale branch rows", async () => {
    invalidateQueriesMock.mockRejectedValue(new Error("provider down"));

    render(<BranchesPage />);

    await clickRefreshButton();

    expect(
      screen.getByText("Branch refresh failed. Retry from the Refresh button.")
    ).toBeInTheDocument();
    expect(screen.getByText("feature/web-branches")).toBeInTheDocument();
    expect(invalidateQueriesMock).toHaveBeenCalledWith(
      { queryKey: ["branches", "list"] },
      { throwOnError: true }
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith(
      { queryKey: ["branches", "analytics"] },
      { throwOnError: true }
    );
  });

  it("renders successful refresh confirmations", async () => {
    invalidateQueriesMock.mockResolvedValue(undefined);

    render(<BranchesPage />);

    await clickRefreshButton();

    expect(screen.getByText("Branch data refreshed.")).toBeInTheDocument();
  });

  it("starts backfill and invalidates branches after a connected return", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));

    render(<BranchesPage />);

    expect(
      screen.getByText("GitHub is connected. Branch data is refreshing.")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/integrations/github/backfill",
        { mode: GitHubBackfillMode.Apply }
      )
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["branches"],
    });
  });
});

async function clickRefreshButton() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: REFRESH_BUTTON_NAME_PATTERN })
    );
    await Promise.resolve();
  });
}

// One day ago, NOT a fixed ISO date: the page's default saved view windows
// rows to the last 7 days of activity (branch-saved-view.ts dateRange "7d"),
// so a pinned date silently ages out of the window and empties the table —
// this exact fixture went red on 2026-07-08 with zero code change.
const RECENT_ACTIVITY_AT = new Date(
  Date.now() - 24 * 60 * 60 * 1000
).toISOString();

function makeBranchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    additions: 42,
    ahead: null,
    baseBranch: "main",
    behind: null,
    branchName: "feature/web-branches",
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 8,
    estimatedCostUsd: 12.34,
    filesChanged: 5,
    id: "branch-1",
    lastActivityAt: RECENT_ACTIVITY_AT,
    multiPrWarning: false,
    owner: "Ada",
    prNumber: 123,
    prState: null,
    prTitle: "Wire web branches",
    prUrl: "https://github.com/acme/app/pull/123",
    repoFullName: "acme/app",
    reviewDecision: null,
    sessionIds: ["session-1"],
    status: BranchStatus.Open,
    ...overrides,
  };
}

function makeListResponse(items: BranchRow[]): BranchListResponse {
  return {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Organization,
  };
}

function makeAnalytics(): BranchAnalytics {
  const kpi = {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Available,
    value: 1,
  };
  return {
    activeBranchCount: kpi,
    activePrCount: kpi,
    buildVsReworkSplit: {
      buildPct: 100,
      reworkPct: 0,
      state: BranchKpiState.Available,
    },
    leadTimeForChangeMs: kpi,
    locPerDollar: kpi,
    medianPrSize: kpi,
    medianTimeToMergeMs: kpi,
    mergeRate: kpi,
    mergedCount: kpi,
    totalSpendUsd: kpi,
    viewerScope: BranchViewerScope.Organization,
  };
}
