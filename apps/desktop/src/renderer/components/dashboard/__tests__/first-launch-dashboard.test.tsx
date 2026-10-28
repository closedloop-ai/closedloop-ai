// The real row catalog drives how many row bodies the ready state renders — keep
// it unmocked so the "renders every row" assertion stays honest if rows change.

import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import {
  ALL_ROW_DATA,
  expectedRowTours,
  NO_ROW_DATA,
  renderedRowTours,
} from "@repo/app/insights/components/overview/__tests__/dashboard-row-visibility-contract";
import { DASHBOARD_ROWS } from "@repo/app/insights/components/overview/dashboard-tiles";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import {
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { getTile } from "@repo/app/insights/lib/tile-catalog";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

// Two cards only the promoted empty surface draws. Spelled as literals rather
// than imported from the component: a fixture built from the thing under test
// agrees with the thing under test when it is renamed away.
const PROMOTED_SKELETON_ACTIVITY_EMPTY = "No activity yet";
const PROMOTED_SKELETON_PR_THROUGHPUT = "PR throughput";
// FEA-4020: the single header "Refreshing" indicator's copy.
const _REFRESHING_RE = /refreshing/i;

/** ISS-10486: the three section records the shared slot resolves its state from. */
type AiImpactSlotPropsForTest = {
  sectionLoading: Record<string, boolean>;
  sectionFailed: Record<string, boolean>;
  sectionStale: Record<string, boolean>;
};

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
  AiImpactSlot: vi.fn<(props: AiImpactSlotPropsForTest) => void>(),
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
// ISS-10486: observed, NOT stubbed. The shell hands the shared slot the three
// section records, and that handoff is the only thing that can make the two
// shells disagree about a card whose own verdict is shared code — but the real
// slot still renders underneath, so the case below asserting the card mounts on
// desktop keeps exercising its full derive-and-render path.
vi.mock(
  "@repo/app/insights/components/overview/ai-impact-slot",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/insights/components/overview/ai-impact-slot")
      >();
    return {
      ...actual,
      AiImpactSlot: (props: AiImpactSlotPropsForTest) => {
        hooks.AiImpactSlot(props);
        return actual.AiImpactSlot(
          props as Parameters<typeof actual.AiImpactSlot>[0]
        );
      },
    };
  }
);
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

describe("FirstLaunchDashboard view-state machine", () => {
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

  it("holds the loading treatment until every insights section resolves", () => {
    allInsightsLoaded();
    // One section still pending → analyticsLoaded false → loading branch.
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );

    renderDashboard();

    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
  });

  // ISS-10930: the page header is the prototype's title and description, read
  // from the same module the Suspense fallback and the web page use.
  it("renders the shared dashboard title and description in the page header", () => {
    allInsightsLoaded();

    renderDashboard();

    expect(
      screen.getByRole("heading", { level: 1, name: DASHBOARD_PAGE_TITLE })
    ).toBeDefined();
    expect(screen.getByText(DASHBOARD_PAGE_DESCRIPTION)).toBeDefined();
  });

  it("renders the empty state once analytics load with no local sessions", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText("No agent sessions yet")).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
    expect(screen.queryByText("Computed on this device")).toBeNull();
  });

  // ISS-10567: the empty branch draws the PROMOTED dashboard skeleton, not a
  // blank slate. Located on a card only that skeleton emits — "No agent sessions
  // yet" alone would not do it, because the blank slate this replaced drew
  // exactly that string and nothing else. Delete the mount and the page falls to
  // the row body, which draws neither of these.
  it("mounts the promoted dashboard skeleton on the empty branch", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText(PROMOTED_SKELETON_ACTIVITY_EMPTY)).toBeDefined();
    expect(screen.getByText(PROMOTED_SKELETON_PR_THROUGHPUT)).toBeDefined();
    expect(screen.getByText("No agent sessions yet")).toBeDefined();
    expect(screen.queryByTestId("dashboard-row")).toBeNull();
  });

  // ISS-6002: what the page may CLAIM about a count it does not have — an
  // unsettled or unserviceable zero, on the body and in the header — is its own
  // suite: dashboard-unsettled-zero.test.tsx.

  it("renders every dashboard row once analytics load and sessions exist", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: seed the Agent Collaboration Network toggle ON so this
    // still means "every row". With it off that row is absent by design, which
    // is covered by its own gate-off test below.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    // Guard against a vacuous match if the catalog were ever empty.
    expect(DASHBOARD_ROWS.length).toBeGreaterThan(0);
    // FEA-4022 (T5/T20): the frustration row is dropped once the Agents section
    // resolves WITHOUT a frustrationTrend (allInsightsLoaded seeds no series),
    // so it never renders a permanent skeleton on desktop. Every other row
    // renders.
    const frustrationRows = DASHBOARD_ROWS.filter(
      (row) => row.tour === "frustration"
    ).length;
    expect(frustrationRows).toBe(1);
    expect(screen.getAllByTestId("dashboard-row")).toHaveLength(
      DASHBOARD_ROWS.length - frustrationRows
    );
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText("No agent sessions yet")).toBeNull();
  });

  // ISS-8351: the guided tour resolves a step by `[data-tour="<key>"]`, so an
  // anchor this shell stops emitting drops that step at runtime with nothing to
  // fail. All six are now named by a tour step: the four in
  // `LEGACY_ANCHORED_TOUR_STEPS` on the gate-off branch, and all six from the
  // shared canonical list once the program enrols the account (PLN-1875 step 5).
  // Two of the six hang off cards rather than rows — `impact` on the AI Impact
  // card, `sessions` on Recent Sessions — so an anchor regression there breaks
  // only the enrolled branch, which is why they are asserted here rather than
  // left to the tour suites.
  //
  // Scope: the SIX anchors the tour steps address, not the full ten-member
  // vocabulary. `agent-pipeline`, `autonomy`, `frustration` and `distribution`
  // are emitted by rows that are flag-gated or data-conditional, so asserting
  // them here would mean forcing gates this suite does not own; no tour step
  // names them either.
  it("emits the six tour-step anchors once analytics load and sessions exist", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    for (const anchor of [
      DashboardTourAnchor.Stats,
      DashboardTourAnchor.Impact,
      DashboardTourAnchor.Activity,
      DashboardTourAnchor.Sessions,
      DashboardTourAnchor.Models,
      DashboardTourAnchor.Prs,
    ]) {
      expect(document.querySelector(`[data-tour="${anchor}"]`)).not.toBeNull();
    }
  });

  // ISS-5061 re-gate (reverses ISS-5280 for this one flag): the Agent
  // Collaboration Network row is closed-by-default on desktop again.
  // `renderDashboard` seeds NO enabled flags, so this is the gate-OFF case —
  // the row must be ABSENT, not an empty card. Driven with the Agents section
  // RESOLVED and WITH pipeline nodes, so the absence can only come from the
  // gate and not from the row's separate absent-data filter.
  it("omits the agent-collaboration row on desktop when the Labs toggle is off", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(false);
  });

  // Gate-ON counterpart. Same resolved data as above, so the ONLY difference is
  // the seeded Labs flag — without the gate wiring this pair cannot both pass.
  it("renders the agent-collaboration row on desktop when the Labs toggle is on", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(true);
  });

  // ISS-5280 (review): the same absent-data filter the frustration row has.
  // A Local-mode install whose sessions spawn no subagents resolves the Agents
  // section without pipeline nodes; without this the row would draw a permanent
  // empty 340px card. Desktop must match the web shell here.
  it("drops the agent-collaboration row when Agents resolves without nodes", () => {
    allInsightsLoaded();
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { kpis: [], charts: { modelBreakdown: [] } },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: the toggle is seeded ON deliberately, so the row is
    // dropped by the ABSENT-DATA filter and not by the gate. Without this the
    // assertion below would pass for the wrong reason and stop covering the
    // filter it names.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "agent-pipeline"
      )
    ).toBe(false);
    // A rowmate that does not depend on pipeline data still renders, so this is
    // a targeted drop rather than the whole dashboard failing to mount.
    expect(
      hooks.DashboardRowContent.mock.calls.some(
        ([props]) => props.row.tour === "models"
      )
    ).toBe(true);
  });

  // ISS-9993: the same contract the web suite runs against
  // `InsightsOverviewDashboard`. This host decides which rows exist through the
  // shared `visibleDashboardRows` and nothing else, so a row filtered here by
  // hand, or a row drawn here that the shared rule drops, fails.
  it.each([
    ["none", NO_ROW_DATA],
    ["all", ALL_ROW_DATA],
  ])(
    "renders exactly the rows the shared rule keeps when %s of the row data is present",
    (_label, payloads) => {
      hooks.useDeliveryInsights.mockReturnValue(
        insightResult({ isSuccess: true, data: payloads.delivery })
      );
      hooks.useUtilizationInsights.mockReturnValue(
        insightResult({ isSuccess: true, data: payloads.utilization })
      );
      hooks.useAgentsInsights.mockReturnValue(
        insightResult({ isSuccess: true, data: payloads.agents })
      );
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] } })
      );

      renderDashboard({}, [
        DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
      ]);

      expect(renderedRowTours(document)).toEqual(expectedRowTours(payloads));
    }
  );

  // ISS-9993: Recent Sessions was hard-wired under the activity row, so dropping
  // that row for lack of a heatmap would have taken the card with it. It now
  // moves under the headline stats row, as it does on web.
  it("keeps Recent Sessions when the activity row is dropped for lack of a heatmap", () => {
    allInsightsLoaded();
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Activity}"]`)
    ).toBeNull();
    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Sessions}"]`)
    ).not.toBeNull();
  });

  // FEA-4000: the AI Impact card graduated off its `aiImpactCardEnabled` Labs flag
  // and now mounts unconditionally. `renderDashboard` seeds NO enabled flags, so
  // this asserts the real (unmocked) card renders on desktop with an empty flag
  // set — a regression guard against the Labs gate silently returning. The card is
  // imported unmocked here, so this also exercises its full derive-and-render path
  // (deriveAiImpact over the resolved sections) rather than a null stub.
  it("mounts the AI Impact card with no feature flags enabled", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText("AI Impact")).toBeDefined();
  });

  it("renders the frustration row (with its series) once the Agents section returns a frustrationTrend (T5/T20)", () => {
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: true, data: {} })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: { charts: { activityHeatmap: LOCAL_HEATMAP } },
      })
    );
    const frustrationTrend = {
      series: [{ key: "frustration", label: "Frustration" }],
      points: [{ date: "2026-06-08", values: { frustration: 42 } }],
    };
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: {
          kpis: [],
          charts: {
            modelBreakdown: [],
            autonomyTrend: LOCAL_AUTONOMY_TREND,
            frustrationTrend,
            // Seeded so the full-count assertion below measures the frustration
            // row landing, not the agent-pipeline row dropping for absent nodes.
            agentPipeline: {
              nodes: [{ id: "researcher", label: "researcher", value: 4 }],
              edges: [],
            },
          },
        },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    // ISS-5061 re-gate: the agent-collaboration toggle is seeded ON so the
    // full-count assertion below still measures the frustration row landing,
    // rather than that row dropping for its gate.
    renderDashboard({}, [DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY]);

    // The frustration row now renders, and it is passed the series (not the
    // undefined that caused the permanent skeleton). With both data-dependent
    // rows populated and the agent-collaboration gate open, EVERY row draws.
    expect(screen.getAllByTestId("dashboard-row")).toHaveLength(
      DASHBOARD_ROWS.length
    );
    const frustrationProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "frustration"
    )?.[0];
    expect(frustrationProps?.frustrationSeries).toEqual(frustrationTrend);
  });

  // ISS-10567 (whitlockk): the EMPTY branch reads the same provider-owned gating the
  // populated row does. Without the host threading it in, the skeleton captions
  // three GitHub-truth tiles with a completed lookup that never ran — and no
  // assertion inside `packages/app` can see a prop this page forgot to pass.
  it("threads provider-owned GitHub gating into the empty skeleton", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard({
      getTileAvailability: () => ({ state: BranchKpiState.Gated }),
      githubConnect: {
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      },
    });

    expect(screen.getByText(PROMOTED_SKELETON_ACTIVITY_EMPTY)).toBeDefined();
    expect(
      screen.getAllByText(
        GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel ??
          GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel
      ).length
    ).toBeGreaterThan(0);
  });

  it("passes provider-owned GitHub gating and connect action to dashboard rows", () => {
    const onConnectGitHub = vi.fn();
    const getTileAvailability = vi.fn(() => ({
      state: BranchKpiState.Gated,
    }));
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard({
      getTileAvailability,
      githubConnect: {
        action: GitHubConnectAction.Connect,
        onConnect: onConnectGitHub,
      },
    });

    const statsProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "stats"
    )?.[0];
    const mergedTile = getTile("kpi:merged");
    if (!(statsProps && mergedTile)) {
      throw new Error("Expected stats row props and merged KPI tile");
    }
    expect(statsProps.getTileAvailability?.(mergedTile)).toEqual({
      state: BranchKpiState.Gated,
    });
    expect(getTileAvailability).toHaveBeenCalledWith({
      tileId: mergedTile.id,
      section: InsightsSection.Delivery,
      scope: InsightsScope.Me,
    });

    statsProps.githubConnect?.onConnect?.();

    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
  });

  it("threads both model spend and token series into the Model Usage row (FEA-3497)", () => {
    // The $/# toggle needs BOTH series: forwarding only `modelUsageOverTime`
    // left `modelTokenSeries` undefined, so switching to `#` on desktop showed
    // the skeleton instead of the token chart. Assert the desktop caller passes
    // `modelTokensOverTime` through alongside the spend series.
    const modelUsageOverTime = { points: [], series: [] };
    const modelTokensOverTime = { points: [], series: [] };
    allInsightsLoaded();
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({
        isSuccess: true,
        data: {
          kpis: [],
          charts: {
            modelBreakdown: [],
            modelUsageOverTime,
            modelTokensOverTime,
          },
        },
      })
    );
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    const modelsProps = hooks.DashboardRowContent.mock.calls.find(
      ([props]) => props.row.tour === "models"
    )?.[0];
    if (!modelsProps) {
      throw new Error("Expected a Model Usage (models) dashboard row");
    }
    expect(modelsProps.modelSeries).toBe(modelUsageOverTime);
    expect(modelsProps.modelTokenSeries).toBe(modelTokensOverTime);
  });

  it("shows the analyzing scan status while the session feed is loading", () => {
    // Sessions still loading and analytics unresolved → analyzing indicator.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: undefined, isLoading: true })
    );
    hooks.useDeliveryInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );
    hooks.useUtilizationInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );
    hooks.useAgentsInsights.mockReturnValue(
      insightResult({ isSuccess: false })
    );

    renderDashboard();

    expect(screen.queryByText("Computed on this device")).toBeNull();
  });

  it("omits the settled local-computation badge in the ready state", () => {
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByText("Computed on this device")).toBeNull();
  });

  it("surfaces the recent-sessions error fallback inside the ready state", () => {
    allInsightsLoaded();
    // Ready (data present) but the session feed errored on refetch.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] }, isError: true })
    );

    renderDashboard();

    expect(
      screen.getByText("Recent sessions are temporarily unavailable.")
    ).toBeDefined();
    expect(screen.queryByTestId("synced-sessions-table")).toBeNull();
  });
});

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

/**
 * ISS-10486: the AI Impact card's ready/degraded/loading verdict is shared code
 * (`AiImpactSlot`), and BOTH shells must resolve it from the same inputs — the
 * defect this ticket fixes on web is exactly a card whose availability was
 * decided by one shell and not the other.
 *
 * WHAT THESE CASES PIN IS THE HANDOFF'S SHAPE, AND NOTHING MORE. The desktop
 * shell still refuses the whole page on any errored section
 * (`showError = !loading && analyticsError` in `dashboard-state.ts`; ISS-10408
 * owns splitting that), so by the time this body renders every section has
 * SUCCEEDED and `sectionFailed` and `sectionLoading` are both all-false. A case
 * here therefore cannot tell one from the other, and none claims to: swapping
 * the two props would leave this suite green, which is a real limit of the
 * shell and not a gap to paper over with a wider test name.
 *
 * The verdict itself — failed draws the card with degraded tiles, in-flight
 * draws the placeholder — is pinned once, on the same component desktop mounts,
 * in `packages/app/insights/components/overview/__tests__/ai-impact-slot.test.tsx`.
 */
describe("FirstLaunchDashboard AI Impact handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardRange.period = "30d";
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 3, items: [{ id: "s0" }] } })
    );
    allInsightsLoaded();
  });

  it("hands the slot a sectionFailed record at all, keyed for every section", () => {
    // The prop this ticket adds. Without it the slot has no way to tell a failed
    // section from a pending one — `sectionLoading` is built as `!isSuccess`, so
    // a terminal error reads as in flight there — and deleting the prop makes
    // this RED. What its VALUES carry on a failed read is the shared slot
    // suite's, for the reason in this block's docstring.
    renderDashboard();

    const props = hooks.AiImpactSlot.mock.calls.at(-1)?.[0];
    expect(props?.sectionFailed).toEqual({
      [InsightsSection.Delivery]: false,
      [InsightsSection.Utilization]: false,
      [InsightsSection.Agents]: false,
    });
  });

  it("hands the slot loading and stale records keyed for every section too", () => {
    // Three records, every section keyed in each: a slot handed a partial record
    // reads a missing key as `undefined`, which `resolveInsightsSectionsState`
    // counts as NOT-settled — a card held behind a placeholder by a key nobody
    // wrote rather than by a query.
    renderDashboard();

    const props = hooks.AiImpactSlot.mock.calls.at(-1)?.[0];
    const allFalse = {
      [InsightsSection.Delivery]: false,
      [InsightsSection.Utilization]: false,
      [InsightsSection.Agents]: false,
    };
    expect(props?.sectionLoading).toEqual(allFalse);
    expect(props?.sectionStale).toEqual(allFalse);
  });
});
