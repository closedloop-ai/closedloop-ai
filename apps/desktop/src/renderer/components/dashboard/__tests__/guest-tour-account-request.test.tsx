/**
 * ISS-11480 (PLN-2126 Step 7): the tour's end, for a guest, resumes the guided
 * onboarding at its Account step. The contract moved here from the retired
 * `guest-tour-account-dialog.test.tsx`, which pinned the standalone offer this
 * replaces: which auth states end the tour in an account ask, and which do not.
 *
 * The guest run is published through the real run-override store, the way the
 * dialog host publishes it, and records what it is asked to apply.
 */

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type {
  TourCloseReason,
  TourStep,
} from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  publishRecordingGuestRun,
  RESUME_CREATE_ACCOUNT,
  type RecordingGuestRun,
} from "../../onboarding/__tests__/published-guest-run-fixture";
import { dashboardTourSeenStorageKey } from "../dashboard-storage-keys";
import { FirstLaunchDashboard } from "../first-launch-dashboard";

type TourProps = {
  active: boolean;
  resolveSteps: () => TourStep[];
  onClose: (reason: TourCloseReason) => void;
  completeLabel?: string;
};

const hooks = vi.hoisted(() => ({
  Tour: vi.fn<(props: TourProps) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
}));

const gate = vi.hoisted(() => ({ authStatus: "" as string }));

// Partial: the harness read keys its query off the real `agentSessionKeys`.
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
  useDashboardSessionSource: () => ({
    ready: true,
    importInProgress: false,
    unavailable: false,
  }),
  // ISS-6002 (review): a zero only counts once a read has landed WITH the
  // store up. This suite drives a single static query fixture, so stub the
  // freshness verdict too — it is subject-tested in dashboard-state.test.ts.
  useSessionsCountFresh: () => true,
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@repo/app/insights/hooks/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    dateRange: "30d",
    setDateRange: vi.fn(),
    period: "30d",
    periodLabel: "Last 30 days",
    deltaLabel: "vs. prior 30 days",
  }),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: gate.authStatus, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
// Presentational children the page routes to; out of scope here.
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: () => <div data-testid="dashboard-row" />,
}));
// ISS-10486: the shell mounts the SLOT, which owns the card's ready/degraded/
// loading verdict over its own sections — so this is the seam to stub, and
// stubbing the card underneath it would leave the slot's real resolution
// running over a module that no longer exports what it reads.
vi.mock("@repo/app/insights/components/overview/ai-impact-slot", () => ({
  AiImpactSlot: () => null,
}));
vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
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

// PLN-1875 Step 9: the page now reads the guided-onboarding run to reconcile the
// two tour-seen records. The real `useGuidedDashboardTour` stays in the render
// path; only its API client, auth adapter and QueryClient are stubbed out.
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", async () => {
  const { guidedOnboardingStubModule } = await import(
    "./guided-onboarding-stub"
  );
  return guidedOnboardingStubModule();
});
let guestRun: RecordingGuestRun | null = null;
const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type HarnessRow = { harness: string; sessionCount: number };

function installUsageBridge(byHarness: HarnessRow[]): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        usage: () =>
          Promise.resolve({
            byHarness: byHarness.map((row) => ({
              ...row,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0,
            })),
          }),
      },
    },
    writable: true,
  });
}

function stubReadyDashboard(): void {
  hooks.useAgentSessions.mockReturnValue({
    data: { total: 5, items: [] },
    isLoading: false,
    // ISS-6002: the page reads the session query's own status, so a resolved
    // mock has to report one — an absent `isSuccess` now means "not settled".
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 1,
  });
  const resolved = {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
  };
  hooks.useDeliveryInsights.mockReturnValue({ ...resolved, data: {} });
  hooks.useUtilizationInsights.mockReturnValue({
    ...resolved,
    data: { charts: {} },
  });
  hooks.useAgentsInsights.mockReturnValue({
    ...resolved,
    data: { kpis: [], charts: { modelBreakdown: [] } },
  });
}

function renderDashboard() {
  const source: InsightsDataSource = {
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsDataSourceProvider value={source}>
            {children}
          </InsightsDataSourceProvider>
        </FeatureFlagAdapterProvider>
      </QueryClientProvider>
    ),
  });
}

/** Drive the production `closeTour` the way the tour's own controls do. */
function closeTour(reason: TourCloseReason): void {
  act(() => latestTourProps().onClose(reason));
}

function latestTourProps(): TourProps {
  const call = hooks.Tour.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected the dashboard to render the Tour");
  }
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // This environment ships no real `localStorage`, so without a backing store
  // `writeFlag` silently no-ops through its own null guard and a case asserting
  // a flag is UNWRITTEN would pass against storage that was never available.
  stubLocalStorage();
  gate.authStatus = DesktopAuthStatus.SignedOut;
  installUsageBridge([]);
  // Reduced motion: the reveal scan is skipped so the page is deterministic.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
  stubReadyDashboard();
  guestRun = publishRecordingGuestRun();
});

afterEach(() => {
  guestRun?.withdraw();
  guestRun = null;
  vi.unstubAllGlobals();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("guest tour completion → Account step (ISS-11480)", () => {
  it("resumes the guest run at the Account step when a signed-out guest finishes the tour", () => {
    renderDashboard();

    closeTour("done");

    expect(postedEvents()).toEqual([RESUME_CREATE_ACCOUNT]);
    expect(guestRun?.posted[0]?.[0]).toBe(guestRun?.snapshot);
  });

  it("does not interrupt a signed-in replay of the tour", () => {
    gate.authStatus = DesktopAuthStatus.Authenticated;
    renderDashboard();

    closeTour("done");

    expect(postedEvents()).toEqual([]);
  });

  it("does not tell a lapsed session to create the account it already has", () => {
    // `refresh_failed` is an EXISTING user whose token expired, not a guest. A
    // plain not-authenticated test swept it into guest mode and offered them
    // sign-up; what they need is to sign back in.
    gate.authStatus = DesktopAuthStatus.RefreshFailed;
    renderDashboard();

    closeTour("done");

    expect(postedEvents()).toEqual([]);
  });

  it("does not stack a second prompt on a sign-in already in flight", () => {
    // A sign-in begun from Settings or the session-expired banner stays active
    // while the user navigates here, so finishing a replay mid-flight would put
    // the Account step on top of a browser round-trip already under way.
    gate.authStatus = DesktopAuthStatus.OpeningBrowser;
    renderDashboard();

    closeTour("done");

    expect(postedEvents()).toEqual([]);
  });

  it("labels the tour's last button for the handoff it is about to make", () => {
    renderDashboard();

    expect(latestTourProps().completeLabel).toBe(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount]
    );
  });

  it("leaves the last button as 'Done' for a signed-in replay", () => {
    // Nothing is handed off when there is no account to create, so the tour ends
    // on its own wording rather than the sign-up label.
    gate.authStatus = DesktopAuthStatus.Authenticated;
    renderDashboard();

    expect(latestTourProps().completeLabel).toBeUndefined();
  });

  it("leaves the last button as 'Done' while no guest run is published", () => {
    // Nothing can open the Account step without a run, so the label must not
    // promise it.
    guestRun?.withdraw();
    renderDashboard();

    expect(latestTourProps().completeLabel).toBeUndefined();
  });

  // ISS-10929 retired the Tour control, and the "the walkthrough lives in that
  // button" hint that a skip used to queue went with it. A skip now simply ends
  // the run — and, as before, never asks a guest for an account.
  it("asks for nothing on a skip", () => {
    renderDashboard();

    closeTour("skip");

    expect(postedEvents()).toEqual([]);
  });

  it("neither spends the tour nor asks for an account on a run with nothing to show", () => {
    renderDashboard();

    closeTour("empty");

    // `empty` is the engine reporting that the run it froze had no steps, so
    // nothing was ever shown. Retiring the tour for that reader, and asking a
    // guest to create an account over it, are both answers to something that
    // did not happen.
    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBeNull();
    expect(postedEvents()).toEqual([]);

    // Same harness, one reason later: both land. So their absence above is
    // this branch, and not a close that never reached the page.
    closeTour("done");

    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBe("1");
    expect(postedEvents()).toEqual([RESUME_CREATE_ACCOUNT]);
  });
});

function postedEvents() {
  return guestRun?.posted.map(([, event]) => event) ?? [];
}
