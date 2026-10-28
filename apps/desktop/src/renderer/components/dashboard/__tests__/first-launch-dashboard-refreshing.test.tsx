/**
 * ISS-10414 / FEA-4020 — the desktop shell's REFRESH DISCLOSURE, split out of
 * `first-launch-dashboard.test.tsx` when that file reached the 1000-line
 * ceiling. One responsibility: what the page says while a section is in flight
 * or still answering for the previous request key. The view-state machine's own
 * cases (which rows render, which are dropped, the empty and error branches)
 * stay in the sibling. The mock scaffolding is duplicated rather than shared
 * because `vi.mock` hoisting is per module graph, which is the same reason every
 * other `first-launch-dashboard-*` sibling carries its own.
 */

// The real row catalog drives how many row bodies the ready state renders — keep
// it unmocked so the "renders every row" assertion stays honest if rows change.

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { REFRESHING_ONSET_MS } from "@repo/app/insights/components/overview/dashboard-refreshing";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

// FEA-4020: the single header "Refreshing" indicator's copy.
const REFRESHING_RE = /refreshing/i;

type DashboardRowContentPropsForTest = {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  modelSeries?: unknown;
  modelTokenSeries?: unknown;
  frustrationSeries?: unknown;
  row: { tour: string };
  stale?: boolean;
};

// The view-state machine is fed entirely by these data hooks; drive them
// directly so each branch (loading / empty / ready / analyzing / error) is
// reachable without a live SQLite-backed insights provider.
const hooks = vi.hoisted(() => ({
  DashboardRowContent:
    vi.fn<(props: DashboardRowContentPropsForTest) => void>(),
  Tour: vi.fn<(props: TourProps) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  // ISS-6002: what the local session source reports. Mutable so a test can hold
  // the store closed and assert the page does NOT claim an empty install, or
  // report it terminally unavailable and assert the skeleton clears.
  sessionSource: {
    value: { ready: true, importInProgress: false, unavailable: false },
  },
}));

// ISS-5112: the page reads desktop auth to decide whether finishing the tour
// offers an account. That is not this suite's subject (see
// guest-tour-account-request.test.tsx), but `useDesktopAuth` throws without its
// provider, so stub it at a signed-out default. Set from the enum in
// `beforeEach` rather than inside the factory: a `vi.mock` factory is evaluated
// during the import phase, before this file's own imports are initialized.
const authState = vi.hoisted(() => ({ status: "" as string }));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
// The harness row's local SQLite read needs a QueryClient, which this suite does
// not stand up; stub the hook to a settled empty answer instead.

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
// ISS-6002: the source probe is the seam, not the subject — it reaches the local
// agent-monitor over IPC and the app-core mode context. Stub ONLY that hook and
// keep the real `resolveDashboardState` / `useSessionsCountFresh` /
// `useBackfillSettleDetection`, so the state machine this suite asserts on — and
// the freshness rule the count is gated by — is the shipped one.
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
// Mutable so a test can flip the selected range between renders — the FEA-4020
// header "Refreshing" indicator is gated on this user-driven period changing.
const dashboardRange = { period: "30d" };
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: dashboardRange.period,
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));

// Heavy presentational children are out of scope here — stub them to markers so
// the test isolates the page's routing logic, not the row/table/tour internals.
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: (props: DashboardRowContentPropsForTest) => {
    hooks.DashboardRowContent(props);
    return <div data-testid="dashboard-row" />;
  },
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
    Tour: (props: TourProps) => {
      hooks.Tour(props);
      return null;
    },
  })
);
vi.mock("../layout/page-shell", () => ({
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
  DashboardCard: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
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
type SessionsFixture = {
  data: { total: number; items: unknown[] } | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
};

// The fixture most recently built — `landFreshSessionsPoll` advances it rather
// than reading it back off the mock (calling `hooks.useAgentSessions()` from a
// plain function reads as a rules-of-hooks violation).
let currentSessionsFixture: SessionsFixture;

function sessionsResult(overrides: Partial<SessionsFixture> = {}) {
  currentSessionsFixture = {
    data: { total: 0, items: [] },
    isLoading: false,
    // ISS-6002: the page now reads this. A resolved read reports `isSuccess`;
    // the point of the fix is that a total without one is not a real zero.
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
    ...overrides,
  };
  return currentSessionsFixture;
}

function insightResult(
  overrides: Partial<{
    isSuccess: boolean;
    isError: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
    data: unknown;
  }> = {}
) {
  return {
    isSuccess: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    // ISS-10414: TanStack reports this true while a section answers with the
    // PREVIOUS request key's payload. Defaulted false so a fixture that does not
    // care reads as "this data is for the key I asked for".
    isPlaceholderData: false,
    data: undefined,
    ...overrides,
  };
}

// The desktop's local engine always returns the activity heatmap and the
// autonomy trend, even when they are empty. ISS-9993 drops a row whose data is
// absent, so a "loaded" fixture without them would count two rows fewer for a
// reason no real install produces.
const LOCAL_HEATMAP = { days: [], cells: [] };
const LOCAL_AUTONOMY_TREND = { series: [], points: [] };

// All three insights sections resolved — `analyticsLoaded` is true, so the page
// leaves the loading treatment. agents.data must carry the minimal shape
// buildTourIntroStep reads (kpis + modelBreakdown).
function allInsightsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: { kpis: [], charts: { activityHeatmap: LOCAL_HEATMAP } },
    })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: {
        kpis: [],
        charts: {
          modelBreakdown: [],
          autonomyTrend: LOCAL_AUTONOMY_TREND,
          // ISS-5280 (review): the agent-pipeline row is dropped when the Agents
          // section resolves without nodes, so the default "loaded" fixture
          // seeds a populated graph — otherwise every row-count assertion below
          // would silently be counting one row fewer for the wrong reason.
          agentPipeline: {
            nodes: [{ id: "researcher", label: "researcher", value: 4 }],
            edges: [],
          },
        },
      },
    })
  );
}

// The ready-state dashboard renders insights tiles gated by `<FeatureFlagged>`,
// which require a `FeatureFlagAdapterProvider` ancestor (the real app mounts one
// via DesktopAppCoreProvider). Wrap renders in a static adapter so the gated
// subtree resolves without a live PostHog surface.
/**
 * ISS-6002 (review cid 3761648058): land one more poll on the mocked read.
 *
 * The page distrusts a result that PREDATES the local store proving it can serve
 * rows, so a fixture whose only read landed at mount is not yet a known count —
 * that stale result is exactly the pre-store zero the fix exists to distrust.
 * Advancing `dataUpdatedAt` (which react-query moves only on a successful fetch)
 * and re-rendering is what the real 2.5s poll does. A no-op for a read that is
 * still pending or has errored: those hold no result to be fresh about.
 */
function landFreshSessionsPoll(rerender: (ui: ReactElement) => void) {
  currentSessionsFixture = {
    ...currentSessionsFixture,
    dataUpdatedAt: currentSessionsFixture.dataUpdatedAt + 1,
  };
  hooks.useAgentSessions.mockReturnValue(currentSessionsFixture);
  act(() => {
    rerender(<FirstLaunchDashboard />);
  });
}

function renderDashboard(
  sourceOverrides: Partial<InsightsDataSource> = {},
  enabledFlags: string[] = []
) {
  const source = createInsightsSource(sourceOverrides);
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <InsightsDataSourceProvider value={source}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  landFreshSessionsPoll(result.rerender);
  return { ...result, source };
}

beforeEach(() => {
  authState.status = DesktopAuthStatus.SignedOut;
});

describe("FirstLaunchDashboard refresh disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardRange.period = "30d";
    // Force reduced-motion so `motion` is false: the first-launch reveal scan is
    // skipped (tick starts at 100) and the state machine is deterministic,
    // independent of localStorage onboarding flags.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useAgentSessions.mockReturnValue(sessionsResult());
    hooks.sessionSource.value = {
      ready: true,
      importInProgress: false,
      unavailable: false,
    };
  });

  afterEach(() => {
    // matchMedia is stubbed per-test above; restore it so the global doesn't
    // leak into other renderer suites.
    vi.unstubAllGlobals();
  });

  // FEA-4020: after the initial load, a user-driven range/scope change refetches
  // the section queries. Because `keepPreviousData` keeps each section
  // settled-success (so the page stays in the ready branch), the refresh is
  // signaled by a SINGLE header "Refreshing" indicator — not a dimmed overlay on
  // every row (which strobed on the ~2s Recent-Sessions poll and tore widget
  // subtrees down on the flip). It is gated on the range changing and debounced
  // past an onset delay.
  it("shows a single header 'Refreshing' indicator (no dimmed rows) on a user-driven range refresh", () => {
    vi.useFakeTimers();
    try {
      // First render: settled at the 30d range.
      allInsightsLoaded();
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] } })
      );
      const { container, rerender } = renderDashboard();
      expect(screen.queryByText(REFRESHING_RE)).toBeNull();

      // User switches the range → new request key, every section refetches over
      // its prior data.
      dashboardRange.period = "7d";
      hooks.useDeliveryInsights.mockReturnValue(
        insightResult({ isSuccess: true, isFetching: true, data: {} })
      );
      hooks.useUtilizationInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { charts: {} },
        })
      );
      hooks.useAgentsInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { kpis: [], charts: { modelBreakdown: [] } },
        })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });
      act(() => {
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      // The dashboard stays in the ready state (rows render, not loading)...
      expect(screen.queryByTestId("dashboard-loading")).toBeNull();
      expect(screen.getAllByTestId("dashboard-row").length).toBeGreaterThan(0);
      // ...one header "Refreshing" indicator shows...
      expect(screen.getAllByText(REFRESHING_RE)).toHaveLength(1);
      // ...and NO row is dimmed under an aria-busy overlay (the old per-row
      // treatment is gone).
      expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("marks only the rows whose section is still answering for the previous range", () => {
    // ISS-10413/ISS-10414, the recorded 7d dashboard: Delivery had landed the
    // new window (PR throughput spanned Sept 9-16) while Utilization and Agents
    // had not (the Sessions KPI still read 3,197, Event Activity still ran June
    // to September, model cost was still last quarter's). Every one of those
    // sections reports settled success under `keepPreviousData`, so the ONLY
    // thing separating the two halves is this flag — and the dashboard must
    // hand it to the rows that read from the lagging sections and to no others.
    allInsightsLoaded();
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: true, isPlaceholderData: false, data: {} })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        isPlaceholderData: true,
        data: { charts: { activityHeatmap: LOCAL_HEATMAP } },
      })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        isPlaceholderData: true,
        data: {
          kpis: [],
          charts: {
            modelBreakdown: [],
            autonomyTrend: LOCAL_AUTONOMY_TREND,
          },
        },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    // `prs` reads Delivery alone, which has landed — it must NOT be marked.
    expect(staleForRow("prs")).toBe(false);
    // `activity` reads Utilization, which has not.
    expect(staleForRow("activity")).toBe(true);
    // `models` reads Agents, which has not.
    expect(staleForRow("models")).toBe(true);
    // `stats` reads BOTH, and one lagging section is enough: the Sessions KPI
    // in that row is the Utilization value the ticket was filed over.
    expect(staleForRow("stats")).toBe(true);
  });

  it("does not flash the indicator for a background refetch at the SAME range (e.g. the ~2s Recent-Sessions poll)", () => {
    vi.useFakeTimers();
    try {
      allInsightsLoaded();
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] } })
      );
      const { rerender } = renderDashboard();

      // Sections refetch WITHOUT a range change (a db-change invalidation / poll):
      // isFetching flips true but the request key is unchanged.
      hooks.useDeliveryInsights.mockReturnValue(
        insightResult({ isSuccess: true, isFetching: true, data: {} })
      );
      hooks.useUtilizationInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { charts: {} },
        })
      );
      hooks.useAgentsInsights.mockReturnValue(
        insightResult({
          isSuccess: true,
          isFetching: true,
          data: { kpis: [], charts: { modelBreakdown: [] } },
        })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
        vi.advanceTimersByTime(REFRESHING_ONSET_MS + 50);
      });

      expect(screen.queryByText(REFRESHING_RE)).toBeNull();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("shows no refreshing indicator once every section has settled (not fetching)", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    const { container } = renderDashboard();

    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(0);
    expect(screen.queryByText(REFRESHING_RE)).toBeNull();
  });
});

/**
 * The `stale` prop the page handed the named row's content, from the last render.
 * Throws rather than defaulting when the row was not rendered at all, so a row
 * that silently stopped rendering cannot pass as "not stale".
 */
function staleForRow(tour: string): boolean {
  const call = hooks.DashboardRowContent.mock.calls.findLast(
    ([props]) => props.row.tour === tour
  );
  if (!call) {
    throw new Error(`row ${tour} was not rendered`);
  }
  return call[0].stale === true;
}

function createInsightsSource(
  overrides: Partial<InsightsDataSource> = {}
): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: vi.fn(),
    getDelivery: vi.fn(),
    getUtilization: vi.fn(),
    ...overrides,
  };
}

// The mocked Tour receives the real component's props; deriving them here keeps
// the `onClose` reason union owned by the component instead of restated.
type TourProps = Parameters<typeof Tour>[0];
