/**
 * ISS-6002: the Dashboard must not read an unsettled zero as an empty install.
 *
 * The shipped defect: `empty` came from the session COUNT alone, and that count
 * is the `data?.total ?? 0` fallback for a pending read, a failed read, and a
 * read taken before the local SQLite store opened. All three rendered
 * "No agent sessions yet" — measured on a profile holding 1,014 sessions.
 *
 * A focused sibling of `first-launch-dashboard.test.tsx` (which owns the general
 * view-state machine and is at its line ceiling): everything here is about what
 * the page is allowed to CLAIM about a count it does not have. The state machine
 * itself is exercised directly in `dashboard-state.test.ts`; this suite mounts
 * the page, so it also covers the wiring — which prop each verdict reaches.
 */

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

const EMPTY_STATE_TEXT = "No agent sessions yet";
const RECENT_SESSIONS_FAILURE_TEXT =
  "Recent sessions are temporarily unavailable.";
const RECENT_SESSIONS_READY_CAPTION = "Every agent run found on this device";
const ANALYZING_TEXT = /Analyzing locally/;
// The header's session-count clause, which must not claim a zero.
const ZERO_SESSIONS_RE = /0 sessions/;

const hooks = vi.hoisted(() => ({
  Tour: vi.fn<(props: { active: boolean }) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  // What the local session source reports. Mutable so a test can hold the store
  // closed, or report it terminally unavailable.
  sessionSource: { value: { ready: true, unavailable: false } },
}));

const authState = vi.hoisted(() => ({ status: "" as string }));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("../tour/use-tour-harnesses", () => ({
  useTourHarnesses: () => ({ harnesses: [], ready: true }),
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
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30d",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
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
vi.mock("../tour/tour", () => ({
  Tour: (props: { active: boolean }) => {
    hooks.Tour(props);
    return null;
  },
}));
vi.mock("../tour/tour-hint", () => ({ TourHint: () => null }));
vi.mock("../dashboard-read-source-badge", () => ({
  DashboardReadSourceBadge: () => null,
}));
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
  DashboardCard: ({
    children,
    description,
  }: {
    children: ReactNode;
    description: ReactNode;
  }) => (
    <div>
      {description}
      {children}
    </div>
  ),
}));

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
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
    ...overrides,
  };
  return currentSessionsFixture;
}

function insightResult(overrides: Record<string, unknown> = {}) {
  return {
    isSuccess: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    data: undefined,
    ...overrides,
  };
}

// All three insights sections resolved — `analyticsLoaded` is true, so the page
// has left the loading treatment for every reason EXCEPT the session read. That
// is the decision point the shipped bug got wrong.
function allInsightsLoaded() {
  const loaded = { kpis: [], charts: { modelBreakdown: [] } };
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: loaded })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: loaded })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: loaded })
  );
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
    getUtilization: vi.fn(),
  };
}

/**
 * Land one more poll on the mocked read (review cid 3761648058).
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

function renderDashboard() {
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
  landFreshSessionsPoll(result.rerender);
  return result;
}

describe("FirstLaunchDashboard unsettled zero (ISS-6002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.status = DesktopAuthStatus.SignedOut;
    // Reduced motion: the first-launch reveal scan is skipped (tick starts at
    // 100) so the state machine is the only thing driving the render.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(sessionsResult());
    hooks.sessionSource.value = { ready: true, unavailable: false };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not claim an empty install while the local store is still opening", () => {
    // The measured boot race: the read SUCCEEDED and honestly returned 0,
    // because the SQLite store had not begun serving yet (0 until ~+10.6s,
    // 1018 after). The dashboard latched that zero and never asked again.
    hooks.sessionSource.value = { ready: false, unavailable: false };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
  });

  it("does not claim an empty install while the session read is still in flight", () => {
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: undefined, isLoading: true, isSuccess: false })
    );

    renderDashboard();

    expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    expect(screen.getByTestId("dashboard-loading")).toBeDefined();
  });

  it("shows the recent-sessions failure, not an empty install, when the session read fails", () => {
    // A failed read is not evidence of an empty Mac either — but it must not
    // blank the page: the insights tiles resolved, and the Recent Sessions card
    // owns the localized "temporarily unavailable" treatment.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: undefined, isError: true, isSuccess: false })
    );

    renderDashboard();

    expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    expect(screen.getByText(RECENT_SESSIONS_FAILURE_TEXT)).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
  });

  it("clears the skeleton when the local session source is unavailable", () => {
    // Review cid 3761648077: the unavailable source's responder answers
    // `{ total: 0 }` SUCCESSFULLY — no error to settle on, no readiness coming.
    // Collapsing the status to a bare "not ready" held the skeleton for the life
    // of the window; the failure belongs on the Recent Sessions card.
    hooks.sessionSource.value = { ready: false, unavailable: true };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
    expect(screen.getByText(RECENT_SESSIONS_FAILURE_TEXT)).toBeDefined();
  });

  it("reports the empty state once a fresh read on a proven-up store returns zero", () => {
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText(EMPTY_STATE_TEXT)).toBeDefined();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
  });

  it("does not announce a session count before one is known", () => {
    // "Analyzing locally · 0 sessions" was the same zero, in the header.
    hooks.sessionSource.value = { ready: false, unavailable: false };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 0, items: [] } })
    );

    renderDashboard();

    expect(screen.getByText(ANALYZING_TEXT)).toBeDefined();
    expect(screen.queryByText(ZERO_SESSIONS_RE)).toBeNull();
  });

  it("does not announce a session count when the first read failed on a ready source", () => {
    // Review cid 3761648086: a settled read is not a MEASURED one. The source is
    // up and the read is over — and it errored, so there is no total. Announcing
    // the `?? 0` fallback here is the same lie, in the header.
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: undefined, isError: true, isSuccess: false })
    );

    renderDashboard();

    expect(screen.queryByText(ZERO_SESSIONS_RE)).toBeNull();
  });

  it("stops analyzing once rows are in hand, even if the readiness probe latches", () => {
    // Review cid 3761648082: `analyzing` drives the header caption, the progress
    // bar and the Recent Sessions "Parsing…" copy. Derived from raw readiness, a
    // stuck ISS-4772 probe left all three saying "analyzing" forever over rows
    // the page was already rendering.
    hooks.sessionSource.value = { ready: false, unavailable: false };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 12, items: [] } })
    );

    renderDashboard();

    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    expect(screen.queryByText(ANALYZING_TEXT)).toBeNull();
    expect(screen.getByText(RECENT_SESSIONS_READY_CAPTION)).toBeDefined();
  });
});
