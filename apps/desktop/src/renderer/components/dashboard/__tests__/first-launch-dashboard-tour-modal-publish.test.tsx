// ISS-10570 (review, thread 4047849542): the host -> store -> dashboard chain,
// end to end, with nothing between them stubbed.
//
// The sibling suite (first-launch-dashboard-tour-behind-modal.test.tsx) drives
// the store by hand and stands a bare `Dialog` in for the takeover, so it pins
// what the ARM does with an answer it is handed and says nothing about how that
// answer arrives. The arrival is its own defect: `blockingModalOpen` reaches the
// arm as a RENDER-TIME snapshot of a store in another component tree, so a
// commit in which the host's `open` flips to `true` alongside anything that
// re-renders the dashboard leaves the arm holding the previous `false`. On the
// `Done` standing that path writes `dashboardOnboardedStorageKey`
// SYNCHRONOUSLY — no delay to be superseded, no cleanup to cancel it — and the
// store update that follows cannot take it back.
//
// So this file mounts the REAL `GuidedOnboardingDialogHost` reporting through
// the REAL module store into the REAL dashboard, and drives both orders.

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "@repo/app/onboarding/components/guided-onboarding-dialog-host";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { setBlockingOnboardingModalOpen } from "../../onboarding/blocking-onboarding-modal-store";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../dashboard-storage-keys";
import { FirstLaunchDashboard } from "../first-launch-dashboard";
import { resetGuidedOnboardingStub } from "./guided-onboarding-stub";

type DashboardRowContentPropsForTest = {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  row: { tour: string };
};

const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  sessionSource: {
    value: { ready: true, importInProgress: false, unavailable: false },
  },
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
// Behind `useDesktopAppRunning`, which the host calls unconditionally so hook
// order cannot vary. Its read reaches `useApiClient` -> `useAuthSnapshot`, which
// throws without an `<AuthAdapterProvider>`; production mounts one at the
// renderer root (`DesktopAppCoreProvider` -> `DesktopAuthProvider`), this suite
// mounts the host bare. Same stub the `packages/app` host suites take.
vi.mock("@repo/app/compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
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
  DashboardRowContent: (_props: DashboardRowContentPropsForTest) => (
    <div data-testid="dashboard-row" />
  ),
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
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", async () => {
  const { guidedOnboardingStubModule } = await import(
    "./guided-onboarding-stub"
  );
  return guidedOnboardingStubModule();
});
// The host's own collaborators. Not the subject: what is under test is the one
// `open` the dialog is given reaching the arm, so everything the dialog needs to
// decide that is real and everything it needs to RENDER is stubbed thin.
vi.mock("@repo/app/onboarding/hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));
vi.mock(
  "@repo/app/onboarding/hooks/use-onboarding-organization-members",
  () => ({
    useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
  })
);
vi.mock("@repo/app/shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: {
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      status: "settled",
    },
    supported: true,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

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

function allInsightsPending() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isFetching: true })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ isFetching: true })
  );
  hooks.useAgentsInsights.mockReturnValue(insightResult({ isFetching: true }));
}

function allInsightsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: { kpis: [], charts: { activityHeatmap: { days: [], cells: [] } } },
    })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      isSuccess: true,
      data: {
        kpis: [],
        charts: {
          modelBreakdown: [],
          autonomyTrend: { series: [], points: [] },
          agentPipeline: {
            nodes: [{ id: "researcher", label: "researcher", value: 4 }],
            edges: [],
          },
        },
      },
    })
  );
}

function sessionsResult(dataUpdatedAt: number) {
  return {
    data: { total: 5, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt,
  };
}

function guestSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: null,
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.None,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Unknown,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Absent,
    revision: 0,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      history: [],
      phase: OnboardingPhase.Welcome,
    }),
  };
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

describe("FirstLaunchDashboard tour arming against the real takeover host (ISS-10570)", () => {
  let rerenderPage: (runActive: boolean) => void;
  /**
   * Whether the host is rendered before the dashboard, as `Sidebar.tsx` does.
   * A knob rather than a constant because that order is exactly what a PASSIVE
   * publish depended on — see the ordering case below.
   */
  let hostFirst: boolean;

  beforeEach(() => {
    hostFirst = true;
    vi.clearAllMocks();
    vi.useFakeTimers();
    stubLocalStorage();
    setBlockingOnboardingModalOpen(false);
    authState.status = DesktopAuthStatus.SignedOut;
    resetGuidedOnboardingStub();
    // Reduced motion, so `tick` starts at 100 and the reveal scan is not part of
    // what this file is timing.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => document.body
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible" as DocumentVisibilityState,
    });
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(sessionsResult(1));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setBlockingOnboardingModalOpen(false);
    Reflect.deleteProperty(document, "visibilityState");
  });

  /**
   * The production shape: the real host first (it is rendered before the shell
   * in `Sidebar.tsx`), the real dashboard second, and the real module store
   * between them. `run` supplies the snapshot so `open` is decided by the phase
   * rather than by a server read this suite does not stand up.
   */
  function page(runActive: boolean) {
    const host = (
      <GuidedOnboardingDialogHost
        analysisStarted={true}
        brand={<span>Closedloop.ai</span>}
        dashboardActive={false}
        desktopMode={true}
        host={OnboardingHost.Desktop}
        key="host"
        onBackFallback={NOOP}
        onDashboardAvailable={NOOP}
        onOpenChange={setBlockingOnboardingModalOpen}
        run={
          runActive
            ? { isLoading: false, postTransition: NOOP, snapshot: SNAPSHOT }
            : undefined
        }
      />
    );
    const dashboard = <FirstLaunchDashboard key="dashboard" />;
    return (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={createInsightsSource()}>
          {hostFirst ? [host, dashboard] : [dashboard, host]}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    );
  }

  function renderPage(runActive: boolean) {
    const result = render(page(runActive));
    rerenderPage = (next: boolean) => result.rerender(page(next));
    return result;
  }

  /** Feed consecutive no-growth session polls so the backfill settles. */
  function driveToSettled(runActive: boolean) {
    for (let dataUpdatedAt = 2; dataUpdatedAt <= 4; dataUpdatedAt++) {
      hooks.useAgentSessions.mockReturnValue(sessionsResult(dataUpdatedAt));
      act(() => {
        rerenderPage(runActive);
      });
    }
  }

  /**
   * The commit that first makes the page armable IS the commit the host's
   * takeover opens in — what a snapshot landing alongside an insights
   * resolution looks like. The host's report is correct and the store ends up
   * correct; what the arm holds is the value its own render read, one commit
   * stale.
   *
   * `Done` is the standing that cannot survive it: it writes the permanent
   * latch synchronously, with no delay for a later store update to supersede.
   */
  function driveWarmButUnarmed(): string | null {
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    // Insights held unresolved through the warm-up, so `analyticsLoaded` keeps
    // the arm shut while the backfill settles. Without this the page arms during
    // the polls below — correctly, the modal really is down there — and the
    // commit under test never gets to be the first armable one. Returned rather
    // than asserted here so the precondition is pinned inside each case.
    allInsightsPending();
    hooks.useAgentSessions.mockReturnValue({
      ...sessionsResult(1),
      data: { total: 0, items: [] },
    });
    renderPage(false);
    return localStorage.getItem(dashboardOnboardedStorageKey);
  }

  /** Resolve insights and open the takeover in ONE commit. */
  function openTakeoverOnTheArmingCommit() {
    hooks.useAgentSessions.mockReturnValue(sessionsResult(2));
    allInsightsLoaded();
    act(() => {
      rerenderPage(true);
    });
  }

  // THE RACE, on the shipped tree order. Caught by the live store read every
  // irreversible write takes: the host's passive publish happens to run before
  // the dashboard's arm here, so the store is already right by the time the arm
  // asks it.
  it("does not spend the permanent latch when the host's takeover opens in the same commit that makes the page armable", () => {
    expect(driveWarmButUnarmed()).toBeNull();

    openTakeoverOnTheArmingCommit();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  // THE SAME RACE with the two siblings swapped — the order `Sidebar.tsx` does
  // not use today, and the one the publish must not silently depend on. Passive
  // effects flush in tree order, so a passive publish reaches the store AFTER
  // the arm here and the live read above is asking a store nobody has written
  // yet. A layout-timed publish runs before every passive effect in the commit
  // whichever way round they are rendered, which is what this case pins and the
  // case above cannot.
  it("does not spend the permanent latch on that same commit when the dashboard is rendered before the host", () => {
    hostFirst = false;

    expect(driveWarmButUnarmed()).toBeNull();

    openTakeoverOnTheArmingCommit();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  // The publish, on the INITIAL mount: the host and the dashboard mount
  // together, so the dashboard's first render reads the store before the host
  // has reported anything into it. This one holds without either half of the
  // fix — the dashboard is not armable on that first commit, and by the commit
  // that is, the store has been told — and it is here because "the page does
  // not arm behind the takeover" is the behaviour, not "the page did not arm on
  // the commit we happened to look at".
  it("does not spend the permanent latch when host and dashboard mount together under an open takeover", () => {
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    renderPage(true);
    driveToSettled(true);

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  // The counterfactual: with no run holding the modal up, the real host reports
  // `false` through the real store and the arm commits exactly as it always did.
  // Without this, both cases above would pass against an arm that had simply
  // stopped writing the latch.
  it("spends the latch through the real host when no takeover is up", () => {
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    renderPage(false);
    driveToSettled(false);

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });
});

const SNAPSHOT = guestSnapshot();
function NOOP() {
  return undefined;
}
