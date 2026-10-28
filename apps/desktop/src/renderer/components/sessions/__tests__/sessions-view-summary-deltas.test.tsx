import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { SessionsView } from "../SessionsView";
import { SessionsViewTestProviders } from "./fixtures/sessions-view-render-fixture";

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
 * These assertions pin the states that distinction produces, because the
 * decision is the DESKTOP ADAPTER's and cannot be covered by a shared-component
 * test: the mode picks the producer, and the producer is the whole decision.
 *
 * ISS-8909 retired the second axis. The chips used to ride the shared Grid
 * Parity gate (`grid-table-v2`) as well, so a cloud-mode reader with that flag
 * off got no comparison; retiring the v1 desktop stack settled that rollout and
 * `isSessionComparisonEnabled` now reads the mode alone. The case that pinned
 * the flag-off arm went with it — cloud mode is covered by the first case here
 * and the negative by the Local-mode case.
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

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: hooks.useAgentSessionAnalytics,
  useAgentSessionsPageData: hooks.useAgentSessionsPageData,
  useAgentSessionUsage: hooks.useAgentSessionUsage,
  // ISS-7249: Retry cancels the exact list read before refetching it.
  useCancelAgentSessionsPageData: () => () => undefined,
}));

vi.mock("../use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: hooks.useLocalAgentSessionUsage,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

vi.mock("../../../hooks/use-file-access-blocks", () => ({
  useFileAccessBlocks: () => [],
}));

vi.mock("@repo/app/agents/hooks/use-has-connected-agent", () => ({
  useHasConnectedAgent: () => ({ data: undefined }),
}));

vi.mock("@repo/app/agents/hooks/use-sessions-view-state", () => ({
  useSessionsViewState: hooks.useSessionsViewState,
}));

// Resolves each key against a set this suite holds empty: the comparison no
// longer rides a flag (ISS-8909), so every gate this view reads answers from its
// closed-by-default state while the MODE is what varies per case.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => surface.enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => surface.enabledFlags.has(key),
  // FEA-4201: the readiness-carrying read. `isReady` is settled-ness, not
  // enabled-ness, and the real desktop port settles ASYNCHRONOUSLY — the
  // signed-in account's PostHog assignment arrives over the IPC bridge. This
  // mock pins it settled so the suites exercise the resolved state; `enabled`
  // mirrors this suite's own set.
  useFeatureFlagGate: (key: string) => ({
    enabled: surface.enabledFlags.has(key),
    isReady: true,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: surface.enabledFlags.has(key),
    isReady: true,
  }),
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
  useDesktopLocalReadReason: () => undefined,
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
      isViewReady: true,
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
    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

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

  // Local mode is the case the original deferral actually covered, and since
  // ISS-8909 it is the ONLY thing that withholds the comparison: the local
  // SQLite producer has no prior-window read, so asking for one would earn a
  // permanent "No prior period" under figures that are never going to be graded.
  it("requests no comparison in Local mode", async () => {
    surface.mode = DesktopAppCoreMode.Local;

    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

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
    hooks.useAgentSessionsPageData.mockReturnValue({
      ...settledPageDataWithComparison(),
      data: undefined,
      isLoading: true,
      isFetching: true,
    });

    render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });

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
    const { rerender } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
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
    const { rerender } = render(<SessionsView />, {
      wrapper: SessionsViewTestProviders,
    });
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
