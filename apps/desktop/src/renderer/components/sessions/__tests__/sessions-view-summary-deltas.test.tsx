import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";

/**
 * ISS-6041 — the desktop Sessions cards' period-over-period chips.
 *
 * ISS-5809 moved the comparison to the producer behind a `comparison=prior`
 * opt-in, and the web page adopted it. Desktop could not: the combined `pageData`
 * port took the base filter shape, so this view had no field to ask through —
 * even in Cloud mode, where it reads the SAME `createHttpAgentSessionsDataSource`
 * the web page uses. One shared card component therefore chipped its deltas on
 * one surface and showed nothing on the other.
 *
 * These assertions pin the three states that distinction produces, because the
 * decision is the DESKTOP ADAPTER's and cannot be covered by a shared-component
 * test: the mode picks the producer, and the Labs gate picks the rollout.
 */

const hooks = vi.hoisted(() => ({
  useAgentSessionAnalytics: vi.fn(),
  useAgentSessionsPageData: vi.fn(),
  useAgentSessionUsage: vi.fn(),
  useLocalAgentSessionUsage: vi.fn(),
  useIngestProgress: vi.fn(),
  useSessionsViewState: vi.fn(),
  useSharedDateRange: vi.fn(),
  useSearchParamsValue: vi.fn(),
}));

const surface = vi.hoisted(() => ({
  mode: "cloud" as string,
  enabledFlags: new Set<string>(),
}));

const DELTA_CHIP = "metric-delta-chip";
const NO_PRIOR_PERIOD = "No prior period";

let desktopApiDescriptor: PropertyDescriptor | undefined;

vi.mock("@repo/app/agents/components/sessions/agent-sessions-list", () => ({
  AgentSessionsListContent: () => <div data-testid="sessions-table-body" />,
}));

vi.mock("@repo/app/agents/components/sessions/sessions-toolbar", () => ({
  SessionsToolbar: () => <div data-testid="sessions-toolbar" />,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useFileAccessBlocks: () => [],
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

// The one mock that differs from the sibling SessionsView suites: this one
// RESOLVES a key against a per-test set, because the Labs gate under test is the
// thing being varied.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => surface.enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => surface.enabledFlags.has(key),
}));

vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: hooks.useSharedDateRange,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions",
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: hooks.useSearchParamsValue,
}));

vi.mock("../agent-coaching-tips", () => ({
  AgentCoachingTips: () => <div data-testid="agent-coaching-tips" />,
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => surface.mode,
  useDesktopCloudReadCutover: () => drainedCutover(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.Authenticated },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("SessionsView summary deltas (ISS-6041)", () => {
  beforeEach(() => {
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
    vi.clearAllMocks();
    surface.mode = DesktopAppCoreMode.Cloud;
    surface.enabledFlags = new Set<string>();
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "30d",
      setDateRange: vi.fn(),
    });
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams());
    hooks.useSessionsViewState.mockReturnValue({
      sortKey: null,
      sortDir: "desc",
      visibleColumns: new Set<string>(["name"]),
      setSort: vi.fn(),
      toggleColumn: vi.fn(),
    });
    hooks.useAgentSessionsPageData.mockReturnValue(
      settledPageDataWithComparison()
    );
    hooks.useAgentSessionUsage.mockReturnValue({
      data: { totalSessions: 50, byRepository: [] },
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
    });
    hooks.useAgentSessionAnalytics.mockReturnValue({
      data: { byRepository: [] },
    });
    hooks.useLocalAgentSessionUsage.mockReturnValue({
      data: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        byRepository: [],
      },
      isError: false,
    });
    hooks.useIngestProgress.mockReturnValue(null);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentMonitorUrl: vi
          .fn()
          .mockRejectedValue(new Error("local monitor unavailable")),
        onDbChanged: vi.fn(() => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    desktopApiDescriptor = undefined;
  });

  it("asks the cloud producer for the prior-window comparison and chips it", async () => {
    surface.enabledFlags.add(DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY);

    render(<SessionsView />);

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(hooks.useAgentSessionsPageData).toHaveBeenCalledWith(
      expect.objectContaining({
        comparison: AgentSessionComparisonMode.Prior,
      }),
      expect.anything()
    );
    // The producer emitted one comparable percent, so exactly one card grades it
    // and the rest fall to the placeholder — never a fabricated 0%.
    expect(screen.getAllByTestId(DELTA_CHIP).length).toBeGreaterThan(0);
    expect(screen.getAllByText(NO_PRIOR_PERIOD).length).toBeGreaterThan(0);
  });

  // Closed-by-default (ISS-4779): with the shared Grid Parity gate off the
  // desktop strip must be byte-identical to before this change — no opt-in on the
  // wire, and no delta row at all (not even the placeholder, which would imply a
  // comparison this surface is not making).
  it("requests no comparison and renders no delta row with the Labs gate off", async () => {
    render(<SessionsView />);

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(
      hooks.useAgentSessionsPageData.mock.lastCall?.[0]
    ).not.toHaveProperty("comparison");
    expect(screen.queryByTestId(DELTA_CHIP)).toBeNull();
    expect(screen.queryByText(NO_PRIOR_PERIOD)).toBeNull();
  });

  // Local mode is the case the original deferral actually covered: the local
  // SQLite producer has no prior-window read, so asking for one would earn a
  // permanent "No prior period" under figures that are never going to be graded.
  it("requests no comparison in Local mode even with the Labs gate on", async () => {
    surface.mode = DesktopAppCoreMode.Local;
    surface.enabledFlags.add(DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY);

    render(<SessionsView />);

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(
      hooks.useAgentSessionsPageData.mock.lastCall?.[0]
    ).not.toHaveProperty("comparison");
    expect(screen.queryByTestId(DELTA_CHIP)).toBeNull();
    expect(screen.queryByText(NO_PRIOR_PERIOD)).toBeNull();
  });

  // A FIRST load has no settled snapshot at all, so there is nothing honest to
  // grade — the cards show the placeholder until the read lands.
  it("suppresses the chips while the first combined read is still loading", async () => {
    surface.enabledFlags.add(DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY);
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...settledPageDataWithComparison(),
      data: undefined,
      isLoading: true,
      isFetching: true,
    });

    render(<SessionsView />);

    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(screen.queryByTestId(DELTA_CHIP)).toBeNull();
  });

  // Desktop's combined query key carries `limit`/`offset`/`sortBy`, so a page
  // turn re-keys it and `keepPreviousData` hands back the previous response —
  // whose figures AND comparison are one coherent snapshot of the SAME summary
  // scope. Replacing the chips with "No prior period" there would claim the
  // prior period does not exist while the comparison for it is on screen.
  it("keeps the chips across a page turn", async () => {
    surface.enabledFlags.add(DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY);
    const { rerender } = render(<SessionsView />);
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(screen.getAllByTestId(DELTA_CHIP).length).toBeGreaterThan(0);

    // Page 2 in flight: same facets and window, new page — placeholder data.
    hooks.useSearchParamsValue.mockReturnValue(new URLSearchParams("page=2"));
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...settledPageDataWithComparison(),
      isPlaceholderData: true,
      isFetching: true,
    });
    rerender(<SessionsView />);

    expect(screen.getAllByTestId(DELTA_CHIP).length).toBeGreaterThan(0);
  });

  // A genuine scope change IS different in kind: the figures still on screen
  // describe the OLD window, so nothing may be graded until the new read lands.
  it("suppresses the chips across a time-window change", async () => {
    surface.enabledFlags.add(DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY);
    const { rerender } = render(<SessionsView />);
    await waitFor(() =>
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled()
    );
    expect(screen.getAllByTestId(DELTA_CHIP).length).toBeGreaterThan(0);

    // 30d → 7d moves `startDate`, so the usage aggregate and its prior window
    // both describe a different population than the one on screen.
    hooks.useSharedDateRange.mockReturnValue({
      dateRange: "7d",
      setDateRange: vi.fn(),
    });
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...settledPageDataWithComparison(),
      isPlaceholderData: true,
      isFetching: true,
    });
    rerender(<SessionsView />);

    expect(screen.queryByTestId(DELTA_CHIP)).toBeNull();
  });
});

/**
 * A settled combined read whose usage half carries the producer's comparison —
 * exactly what the HTTP source returns for `comparison=prior`. Only `sessions`
 * is graded, so any chip found in the strip is unambiguously that card's and the
 * remaining cards exercise the absent-entry placeholder in the same render.
 */
function settledPageDataWithComparison() {
  return {
    data: {
      list: { items: [{ id: "session-1" }], total: 50 },
      usage: {
        totalSessions: 50,
        totalInputTokens: 1000,
        totalOutputTokens: 250,
        byRepository: [],
        comparison: {
          priorStartDate: "2026-06-14T00:00:00.000Z",
          priorEndDate: "2026-07-13T23:59:59.999Z",
          deltas: { sessions: 25 },
        },
      },
    },
    isFetching: false,
    isPlaceholderData: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}
