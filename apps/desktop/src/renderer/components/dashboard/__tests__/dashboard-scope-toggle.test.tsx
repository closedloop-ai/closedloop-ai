import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainedCutover } from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DashboardPage } from "../DashboardPage";

// PLN-1138: the desktop Dashboard exposes a me/org scope toggle in Cloud mode
// (authenticated + online) and is personal-scope only in Local mode. This
// renders the REAL DesktopInsightsProvider so availableScopes is derived from
// the mocked app-core mode; only the leaf insights/session hooks are stubbed so
// the dashboard reaches a ready state without a live backend.
const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useDesktopAuth: vi.fn(),
  useApiClient: vi.fn(),
  useDesktopAppCoreMode: vi.fn(),
  useDesktopCloudReadCutover: vi.fn(),
}));

// Partial: ISS-5112's harness read keys its query off the real
// `agentSessionKeys`, so only the hook is replaced.
vi.mock("@repo/app/agents/hooks/use-agent-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/agents/hooks/use-agent-sessions")
    >();
  return { ...actual, useAgentSessions: hooks.useAgentSessions };
});
// ISS-6002: the local-store readiness probe reaches the agent-monitor over IPC,
// which this suite's partial `window.desktopApi` stub does not provide. Stub ONLY
// that hook; the real dashboard state machine still runs.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => ({ ready: true, unavailable: false }),
  // ISS-6002 (review): a zero only counts once a read has landed WITH the
  // store up. This suite drives a single static query fixture, so stub the
  // freshness verdict too — it is subject-tested in dashboard-state.test.ts.
  useSessionsCountFresh: () => true,
}));
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/insights/hooks/use-insights")
    >();
  return {
    ...actual,
    useDeliveryInsights: hooks.useDeliveryInsights,
    useUtilizationInsights: hooks.useUtilizationInsights,
    useAgentsInsights: hooks.useAgentsInsights,
  };
});
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: hooks.useDesktopAuth,
}));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: hooks.useApiClient,
}));
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: hooks.useDesktopAppCoreMode,
  // ISS-5477: the read-source badge under this tree also asks WHY the active
  // source is in play. Neither suite exercises that, so it gets the drained
  // decision (no explanatory detail rendered).
  useDesktopCloudReadCutover: hooks.useDesktopCloudReadCutover,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function scopeArgsFor(mock: ReturnType<typeof vi.fn>): InsightsScope[] {
  return mock.mock.calls.map((call) => call[1] as InsightsScope);
}

describe("desktop Dashboard scope toggle (PLN-1138 Phase 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopCloudReadCutover.mockReturnValue(drainedCutover());
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    hooks.useDesktopAuth.mockReturnValue({
      beginSignIn: vi.fn(async () => ({ ok: true })),
      state: { status: "authenticated" },
    });
    hooks.useApiClient.mockReturnValue({ get: vi.fn() });
    installDesktopApi();
    stubAnalyticsLoaded();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("Cloud mode shows a me/org toggle and switching to Organization reads org insights", async () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);

    renderDashboard();

    const orgToggle = await screen.findByText("Organization");
    // Initial reads are personal scope.
    expect(scopeArgsFor(hooks.useDeliveryInsights)).toContain(InsightsScope.Me);
    expect(scopeArgsFor(hooks.useDeliveryInsights)).not.toContain(
      InsightsScope.Org
    );

    fireEvent.click(orgToggle);

    await waitFor(() =>
      expect(scopeArgsFor(hooks.useDeliveryInsights)).toContain(
        InsightsScope.Org
      )
    );
    // All three sections follow the selected scope.
    expect(scopeArgsFor(hooks.useUtilizationInsights)).toContain(
      InsightsScope.Org
    );
    expect(scopeArgsFor(hooks.useAgentsInsights)).toContain(InsightsScope.Org);
    // Cloud mode reads the org cloud API — the unified read-source badge shows
    // "Cloud".
    expect(screen.getByTestId("read-source-badge").textContent).toContain(
      "Cloud"
    );
  });

  it("Local mode shows no scope toggle and reads only personal insights", async () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);

    renderDashboard();

    // Wait for the actions bar (always-present Tour button) before asserting the
    // toggle's absence.
    await screen.findByText("Tour");
    expect(screen.queryByText("Organization")).toBeNull();
    expect(scopeArgsFor(hooks.useDeliveryInsights)).not.toContain(
      InsightsScope.Org
    );
    expect(scopeArgsFor(hooks.useDeliveryInsights)).toContain(InsightsScope.Me);
    // Wiring guard: Local mode reads this machine's SQLite own-data, so the
    // dashboard must render the unified read-source badge showing "Local" in
    // PageShell.actions — proves it is actually mounted, not just unit-tested in
    // isolation. (Authenticated in Local mode is the AC-3.3 offline degradation.)
    expect(screen.getByTestId("read-source-badge").textContent).toContain(
      "Local"
    );
  });
});

function insightResult(data: unknown) {
  return { isSuccess: true, isLoading: false, isError: false, data };
}

function stubAnalyticsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { prTrend: { points: [] } } })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { eventActivity: { points: [] } } })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({ kpis: [], charts: { modelBreakdown: [] } })
  );
  hooks.useAgentSessions.mockReturnValue({
    data: { total: 12, items: [] },
    isLoading: false,
    // ISS-6002: the page reads the session query's own status, so a resolved
    // mock has to report one — an absent `isSuccess` now means "not settled".
    isSuccess: true,
    isError: false,
    dataUpdatedAt: 1,
  });
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: {
        getInsights: vi.fn(async () => ({ charts: {}, kpis: [] })),
      },
      getGitHubIntegrationStatus: vi.fn(async () => ({ connected: true })),
      openGitHubConnect: vi.fn(async () => ({ ok: true })),
    },
  });
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const memory = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={memory.adapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <DashboardPage />
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}
