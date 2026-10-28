/**
 * ISS-11927: the Desktop Dashboard when the selected range hides sessions the
 * install has.
 *
 * The shipped defect: `sessionsTotal` is an ALL-TIME count, so a reader whose
 * sessions all predate the default 7d range never reached the empty branch and
 * got "Ready" with every tile zeroed (0 sessions / $0 / "No data") and no hint
 * that older data existed (onboarding test, 2026-10-01). The page now draws the
 * shared date-range empty (`DashboardRangeEmptyBody`, the Sessions list's
 * ISS-11913 state) with "Show all time", the same body web draws.
 *
 * Mounts the page with the same seams as `dashboard-unsettled-zero.test.tsx`;
 * the decision itself is `dashboard-state.test.ts`'s, this pins the wiring.
 */

import {
  InsightsScope,
  InsightsSection,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

// The Sessions list's date-range empty (ISS-11913), reused verbatim.
const RANGE_EMPTY_TITLE = "No matching sessions";
const SHOW_ALL_TIME = "Show all time";
const NEVER_SYNCED_TITLE = "No agent sessions yet";

const hooks = vi.hoisted(() => ({
  Tour: vi.fn<(props: { active: boolean }) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  // What the local session source reports. Mutable so a test can hold the store
  // closed, or report it terminally unavailable.
  sessionSource: {
    value: { ready: true, importInProgress: false, unavailable: false },
  },
}));

const appCoreMode = vi.hoisted(() => ({ value: "local" }));
const allTimeUtilization = { sessions: 0 };
vi.mock(
  "../../../shared-agent-sessions/desktop-app-core-provider",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../shared-agent-sessions/desktop-app-core-provider")
    >()),
    useDesktopAppCoreMode: () => appCoreMode.value,
  })
);

const authState = vi.hoisted(() => ({ status: "" as string }));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
// The source probe is the seam, not the subject — it reaches the local
// agent-monitor over IPC and the app-core mode context. Stub ONLY that hook and
// keep the real `resolveDashboardState` / `useSessionsCountFresh` /
// `useBackfillSettleDetection`, so what this suite asserts on is the shipped
// decision, not a re-statement of it.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => hooks.sessionSource.value,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    }),
  };
});
const range = vi.hoisted(() => ({
  value: "7d" as string,
  setDateRange: vi.fn<(next: string) => void>(),
}));
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: range.value,
    setDateRange: range.setDateRange,
    period: range.value === "all" ? "all" : "7",
    periodLabel: "Last 7 days",
    deltaLabel: "WoW",
  }),
}));
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: () => <div data-testid="dashboard-row" />,
}));
vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));
vi.mock("../dashboard-loading", () => ({
  DashboardLoading: () => <div data-testid="dashboard-loading" />,
}));
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  () => ({
    Tour: (props: { active: boolean }) => {
      hooks.Tour(props);
      return null;
    },
  })
);
vi.mock("../layout/page-shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../layout/page-shell")>()),
  PageShell: ({
    actions,
    children,
  }: {
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));

// PLN-1875 Step 9: the page now reads the guided-onboarding run to reconcile the
// two tour-seen records. The real `useGuidedDashboardTour` stays in the render
// path; only its API client, auth adapter and QueryClient are stubbed out.
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", async () => {
  const { guidedOnboardingStubModule } = await import(
    "./guided-onboarding-stub"
  );
  return guidedOnboardingStubModule();
});
function insightResult(data: unknown) {
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    data,
    // The local verdict re-reads a cached zero before trusting it.
    refetch: vi.fn(() => Promise.resolve({ isSuccess: true, data })),
  };
}

/** Every section loaded; utilization carries the selected range's sessions KPI. */
function insightsWithWindowSessions(windowSessions: number | null) {
  const loaded = { kpis: [], charts: { modelBreakdown: [] } };
  hooks.useDeliveryInsights.mockReturnValue(insightResult(loaded));
  hooks.useAgentsInsights.mockReturnValue(insightResult(loaded));
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({
      ...loaded,
      kpis:
        windowSessions === null
          ? []
          : [{ key: "sessions", value: windowSessions }],
    })
  );
}

/** The all-time session read, settled on a proven-up store. */
function allTimeSessions(total: number) {
  allTimeUtilization.sessions = total;
  hooks.useAgentSessions.mockReturnValue({
    data: { total, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 2,
  });
}

function createInsightsSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: vi.fn(),
    getDelivery: vi.fn(),
    getUtilization: vi.fn(() =>
      Promise.resolve({
        charts: {},
        kpis: [{ key: "sessions", value: allTimeUtilization.sessions }],
      } as unknown as UtilizationInsightsResponse)
    ),
  };
}

function renderDashboard() {
  // The first read landed before the store proved itself; the second is the
  // fresh one `useSessionsCountFresh` waits for.
  hooks.useAgentSessions.mockReturnValueOnce({
    data: { total: 0, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
  });
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={createInsightsSource()}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  act(() => {
    result.rerender(<FirstLaunchDashboard />);
  });
  return result;
}

describe("FirstLaunchDashboard when the range hides sessions (ISS-11927)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appCoreMode.value = DesktopAppCoreMode.Local;
    authState.status = DesktopAuthStatus.SignedOut;
    range.value = "7d";
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.sessionSource.value = {
      ready: true,
      importInProgress: false,
      unavailable: false,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws the date-range empty instead of zeroed tiles", async () => {
    allTimeSessions(29);
    insightsWithWindowSessions(0);

    renderDashboard();

    expect(await screen.findByText(RANGE_EMPTY_TITLE)).toBeDefined();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
    expect(screen.queryByText(NEVER_SYNCED_TITLE)).toBeNull();
  });

  it("widens the range to all time from Show all time", async () => {
    allTimeSessions(29);
    insightsWithWindowSessions(0);
    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: SHOW_ALL_TIME }));

    expect(range.setDateRange).toHaveBeenCalledWith("all");
  });

  it("draws the rows on All time, where nothing is hidden", () => {
    range.value = "all";
    allTimeSessions(29);
    insightsWithWindowSessions(0);

    renderDashboard();

    expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
    expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
  });

  /**
   * whitlockk, review of #8982. Cloud mode: the page's session read has no viewer
   * scope, so it counts the whole org while the KPIs follow Me. The widen is
   * only offered on the viewer's OWN all-time history, read in the KPIs' scope.
   */
  describe("in cloud mode", () => {
    type SessionFilters = { countOnly?: boolean; viewerScope?: string };

    /** The org-wide page read, and the viewer-scoped all-time count. */
    function cloudSessions({
      org,
      viewer,
    }: {
      org: number;
      viewer: number;
    }): void {
      hooks.useAgentSessions.mockImplementation((filters: SessionFilters) => ({
        data: { total: filters.countOnly ? viewer : org, items: [] },
        isLoading: false,
        isSuccess: true,
        isError: false,
        isFetching: false,
        dataUpdatedAt: 2,
      }));
    }

    beforeEach(() => {
      appCoreMode.value = DesktopAppCoreMode.Cloud;
    });

    it("does not offer Show all time when only a teammate has sessions", () => {
      cloudSessions({ org: 29, viewer: 0 });
      insightsWithWindowSessions(0);

      renderDashboard();

      expect(hooks.useAgentSessions).toHaveBeenCalledWith(
        expect.objectContaining({ countOnly: true, viewerScope: "self" }),
        { enabled: true }
      );
      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
      expect(screen.queryByRole("button", { name: SHOW_ALL_TIME })).toBeNull();
    });

    it("offers it when the viewer's own sessions predate the range", () => {
      cloudSessions({ org: 29, viewer: 4 });
      insightsWithWindowSessions(0);

      renderDashboard();

      expect(screen.getByText(RANGE_EMPTY_TITLE)).toBeDefined();
    });
  });

  it("draws the rows when the selected range has sessions", () => {
    allTimeSessions(29);
    insightsWithWindowSessions(3);

    renderDashboard();

    expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
    expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
  });
});
