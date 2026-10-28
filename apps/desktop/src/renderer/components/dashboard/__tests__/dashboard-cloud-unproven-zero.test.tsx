/**
 * ISS-6972: a cloud zero may be shown, but it may not be CALLED an empty Mac.
 *
 * The shipped defect, reproduced on stage: a device that had just signed in read
 * a workspace holding nothing yet and rendered "No agent sessions yet … computed
 * locally, nothing uploaded" — over a local database holding 219 sessions. The
 * count was honestly zero; the sentence was about a store the page had not read.
 *
 * A separate file from `dashboard-unsettled-zero.test.tsx` deliberately: that
 * suite stubs `useDashboardSessionSource`, which is exactly the seam that hides
 * the cloud branch (`useSessionsReadGate` short-circuits on `isCloudMode`, so a
 * cloud zero is authoritative on its first successful read and no proof of a
 * filled cloud is ever required). Nothing here stubs the decision — the app-core
 * mode is the only seam, and it is an INPUT.
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
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

/** The claim only a LOCAL read can make. */
const LOCAL_EMPTY_TITLE = "No agent sessions yet";
const LOCAL_EMPTY_CLAIM = /computed locally, nothing uploaded/;
const WORKSPACE_EMPTY_TITLE = "No sessions in this workspace yet";

const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  mode: { value: "cloud" as string },
  localSourceStatus: { value: "ready" as string },
}));

// The local agent-monitor probe is an IPC seam, not the subject: stub only what
// it REPORTS and keep the real `useSessionsReadGate` / `useSessionsCountFresh` /
// `resolveDashboardState`, so the local arm below still runs the shipped
// ISS-6002 decision rather than a restatement of it.
vi.mock(
  "../../sessions/sessions-view-source-status",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../sessions/sessions-view-source-status")
    >()),
    useLocalSessionSourceStatus: () => ({
      status: hooks.localSourceStatus.value,
      recheck: vi.fn(),
    }),
  })
);

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => hooks.mode.value,
  useDesktopLocalReadReason: () => undefined,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: {
      status: DesktopAuthStatus.Authenticated,
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
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
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  () => ({ Tour: () => null })
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

let currentSessionsFixture: SessionsFixture;

/** A settled, successful read of an EMPTY store. */
function emptySessionsResult(): SessionsFixture {
  currentSessionsFixture = {
    data: { total: 0, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
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

function allInsightsLoaded() {
  const loaded = { kpis: [], charts: { modelBreakdown: [] } };
  for (const hook of [
    hooks.useDeliveryInsights,
    hooks.useUtilizationInsights,
    hooks.useAgentsInsights,
  ]) {
    hook.mockReturnValue(insightResult({ isSuccess: true, data: loaded }));
  }
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

/** One more successful poll, which is what promotes a zero to a known count. */
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

describe("FirstLaunchDashboard empty state names the store it read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.mode.value = DesktopAppCoreMode.Cloud;
    hooks.localSourceStatus.value = LOCAL_SESSION_SOURCE_STATUSES.ready;
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useAgentSessions.mockReturnValue(emptySessionsResult());
    allInsightsLoaded();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never tells a cloud reader that this Mac is empty", () => {
    renderDashboard();

    // The zero is shown — ISS-4429 settled that a confirmed cloud zero is not
    // withheld. What it may be CALLED is the subject here.
    expect(screen.getByText(WORKSPACE_EMPTY_TITLE)).toBeDefined();
    expect(screen.queryByText(LOCAL_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(LOCAL_EMPTY_CLAIM)).toBeNull();
  });

  it("keeps the local claim for a reader that actually read this device", () => {
    hooks.mode.value = DesktopAppCoreMode.Local;

    renderDashboard();

    expect(screen.getByText(LOCAL_EMPTY_TITLE)).toBeDefined();
    expect(screen.getByText(LOCAL_EMPTY_CLAIM)).toBeDefined();
  });
});
