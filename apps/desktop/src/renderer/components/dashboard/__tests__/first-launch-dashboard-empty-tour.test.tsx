/**
 * ISS-9992 — the first-launch tour's arm over a dashboard with nothing on it.
 *
 * Arming gated on the reveal tick, the backfill settle, the insights read, the
 * harness read, the assignment, `firstLaunch` and the tour standing — and none
 * of those asked what the page had DRAWN. On an install with no sessions
 * `DashboardBody` returns `DashboardEmptySurface`, which replaces the body before any
 * row renders and so emits no `data-tour` anchor at all, while the on-screen
 * guard of the day was satisfied instead by the header's `[data-tour-btn]` — a
 * control ISS-10929 has since retired, leaving that guard reading the
 * `[data-tour]` anchor the empty branch never draws. So the arm fired,
 * wrote the permanent first-launch latch, opened a run whose beats each dimmed
 * the page and rang nothing, and `closeTour` then retired the tour for that
 * reader on every device. One shot, spent on a scrim over nothing, for the
 * exact cohort onboarding exists for.
 *
 * Its own file with its own page harness, for the reason both sibling tour
 * suites give in their own headers: `vi.mock` is file-scoped, so the harness is
 * stood up per file — and folding these cases into
 * `first-launch-dashboard-tour.test.tsx` would push it past the 1,000-line
 * ceiling it already sits on.
 */

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { tourSnapshot } from "@repo/app/onboarding/hooks/__tests__/guided-onboarding.test-helpers";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { dashboardOnboardedStorageKey } from "../dashboard-storage-keys";
import { FirstLaunchDashboard } from "../first-launch-dashboard";
import {
  guidedOnboardingStub,
  resetGuidedOnboardingStub,
} from "./guided-onboarding-stub";

type TourProps = Parameters<typeof Tour>[0];

const hooks = vi.hoisted(() => ({
  Tour: vi.fn<(props: TourProps) => void>(),
  useAgentSessions: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  /**
   * The live local-import signal, flippable per case. It is the second route to
   * `DesktopDashboardContent.Loading` — the one `analyticsLoaded` does not screen
   * — so it is how a case drives the page OFF a settled branch and back.
   */
  sessionImportInProgress: false,
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
vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));
// The source probe is the seam, not the subject: it reaches the local
// agent-monitor over IPC and the app-core mode context. Stub ONLY that hook and
// keep the real `resolveDashboardState` — the content member this suite turns
// on is derived there, so mocking it would test the fixture instead.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => ({
    ready: true,
    importInProgress: hooks.sessionImportInProgress,
    unavailable: false,
  }),
}));
vi.mock("@repo/app/insights/hooks/use-insights", () => ({
  insightsKeys: { all: ["insights"] },
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));
vi.mock("@tanstack/react-query", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  )),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
vi.mock("@repo/app/insights/components/overview/dashboard-rows", () => ({
  DashboardRowContent: () => <div data-testid="dashboard-row" />,
}));
vi.mock("@repo/app/shared/components/date-range-filter", () => ({
  DateRangeFilter: () => null,
}));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));
vi.mock("../dashboard-loading", () => ({ DashboardLoading: () => null }));
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  () => ({
    Tour: (props: TourProps) => {
      hooks.Tour(props);
      return null;
    },
  })
);
// NOT stubbed: `DashboardHeaderActions` and `DashboardEmptySurface`. The defect
// was precisely that the header's `[data-tour-btn]` satisfied the arm's
// on-screen guard over a body that drew no anchor, so both have to be the real
// ones — and the header one now renders no control at all, which is what the
// `tourControlCount` assertions below pin.
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

/** Mirrors REVEAL_DURATION_MS in first-launch-dashboard.tsx. */
const REVEAL_DURATION_MS = 3600;
/** The arm's own settle delay before it opens the callout. */
const ARM_DELAY_MS = 650;
/** An install whose dashboard has rows to tour. */
const POPULATED_TOTAL = 5;
/** The title only `DashboardEmptySurface`'s LOCAL branch draws. This fixture is local. */
const EMPTY_STATE_TITLE = "No agent sessions yet";
/** Short of the arm's settle delay: the timer that opens the tour is pending. */

function sessionsResult(total: number, dataUpdatedAt: number) {
  return {
    data: { total, items: [] },
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    dataUpdatedAt,
  };
}

function insightResult(data: unknown) {
  return {
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    data,
  };
}

function insightsSource(): InsightsDataSource {
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
 * Mount, then advance to the commit the arming effect evaluates: run out the
 * first-launch reveal so `tick` reaches 100, land enough no-growth session polls
 * for the backfill to settle at `total`, and run out the arm's settle delay.
 *
 * The polls advance `dataUpdatedAt` on every one, which is what the real 2.5s
 * poll does and what `useSessionsCountFresh` requires before a zero is allowed
 * to mean an empty install rather than a read taken before the store opened.
 */
function mountDashboard(total: number, armAdvanceMs: number = ARM_DELAY_MS) {
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={insightsSource()}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  act(() => {
    vi.advanceTimersByTime(REVEAL_DURATION_MS + 200);
  });
  landSessionPolls(result.rerender, total, 2, 4);
  act(() => {
    vi.advanceTimersByTime(armAdvanceMs);
  });
  return result;
}

function landSessionPolls(
  rerender: (ui: ReactElement) => void,
  total: number,
  from: number,
  to: number
) {
  for (let dataUpdatedAt = from; dataUpdatedAt <= to; dataUpdatedAt++) {
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult(total, dataUpdatedAt)
    );
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });
  }
}

function tourEverOpened(): boolean {
  return hooks.Tour.mock.calls.some(([props]) => props.active === true);
}

/**
 * The page really drew the EMPTY branch — its own title, which nothing else
 * renders.
 *
 * Deliberately not "no `[data-tour]` anchor exists": the loading branch emits
 * none either, so anchor-absence alone cannot tell the state under test from the
 * one immediately before it, and every assertion resting on it would hold over a
 * page that simply had not finished. The anchor count is asserted separately,
 * where it says something this does not.
 */
function emptyStateShown(): boolean {
  return screen.queryByText(EMPTY_STATE_TITLE) !== null;
}

/** How many beats the page laid out for the tour to ring. */
function tourAnchorCount(): number {
  return document.querySelectorAll("[data-tour]").length;
}

/** The header's replay control — retired by ISS-10929, so this is now a zero. */
function tourControlCount(): number {
  return document.querySelectorAll("[data-tour-btn]").length;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A plain value, so `clearAllMocks` does not reach it.
  hooks.sessionImportInProgress = false;
  vi.useFakeTimers();
  stubLocalStorage();
  resetGuidedOnboardingStub();
  authState.status = DesktopAuthStatus.SignedOut;
  // Full motion, so the reveal scan runs and `tick` climbs to 100 under fake
  // timers — the arming effect waits on that completion.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
  // jsdom performs no layout, so the `[data-tour]` anchor the arm's on-screen
  // guard reads would never report an `offsetParent`.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    () => document.body
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible" as DocumentVisibilityState,
  });
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ kpis: [], charts: {} })
  );
  hooks.useUtilizationInsights.mockReturnValue(
    insightResult({ kpis: [], charts: {} })
  );
  hooks.useAgentsInsights.mockReturnValue(
    insightResult({
      kpis: [],
      charts: {
        modelBreakdown: [],
        agentPipeline: {
          nodes: [{ id: "researcher", label: "researcher", value: 4 }],
          edges: [],
        },
      },
    })
  );
  hooks.useAgentSessions.mockReturnValue(sessionsResult(0, 1));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("FirstLaunchDashboard — arming over an empty dashboard (ISS-9992)", () => {
  it("opens no tour and spends no shot when the dashboard drew the empty state", () => {
    const { rerender } = mountDashboard(0);

    // The page really is on the empty branch, not merely un-armed for some
    // unrelated reason — asserted from the title `DashboardEmptySurface` draws, because
    // a page still loading is also un-armed and also anchorless. And having
    // drawn it, there is not one `data-tour` anchor for a beat to ring.
    expect(emptyStateShown()).toBe(true);
    expect(tourAnchorCount()).toBe(0);
    expect(tourEverOpened()).toBe(false);
    // The shot is unspent. The latch is written by the arm at the moment it
    // opens the tour, so a branch that returns first leaves the install
    // first-launch — which is what lets every case below arm later.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    // Still nothing after further commits: a hold that armed on a later render
    // would spend the shot just as permanently, one poll late.
    landSessionPolls(rerender, 0, 5, 6);
    act(() => {
      vi.advanceTimersByTime(ARM_DELAY_MS);
    });

    expect(tourEverOpened()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  it("mounts no Tour control on the branch that has nothing to tour", () => {
    // ISS-10929 retired the header's Tour control outright, so the ISS-10546
    // refusal it used to carry has no subject. What replaces that pairing is the
    // arm's own gate: it now asks for the run's first `[data-tour]` anchor, and
    // the empty branch draws none — which is the fact the next case pins from
    // the other side.
    mountDashboard(0);

    expect(emptyStateShown()).toBe(true);
    expect(tourAnchorCount()).toBe(0);
    expect(tourControlCount()).toBe(0);
  });

  it("draws the anchors the arm gates on once the dashboard has rows", () => {
    // The other half, and the one that fails if the absence above were
    // unconditional: a page with beats to ring really does draw them — and
    // still mounts no control, because the control is gone from both branches.
    mountDashboard(POPULATED_TOTAL);

    expect(tourAnchorCount()).toBeGreaterThan(0);
    expect(tourControlCount()).toBe(0);
  });

  it("arms on a later launch of the same install once it has sessions", () => {
    // The whole point of not spending the shot. `firstLaunch` is read once at
    // mount from the latch the empty launch above declined to write, so this
    // second mount is still a first launch and the reader gets the real tour.
    const first = mountDashboard(0);
    expect(tourEverOpened()).toBe(false);
    first.unmount();

    mountDashboard(POPULATED_TOTAL);

    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("arms without a remount when sessions land mid-session", () => {
    // A first-launch import finishing while the reader watches. Nothing was
    // torn down and nothing re-mounted: `completedRef` was deliberately left
    // alone by the hold, so the effect re-running on the content dep can still
    // arm.
    const { rerender } = mountDashboard(0);
    expect(tourEverOpened()).toBe(false);

    landSessionPolls(rerender, POPULATED_TOTAL, 5, 5);
    act(() => {
      vi.advanceTimersByTime(ARM_DELAY_MS);
    });

    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("arms an install that has sessions exactly as it did before", () => {
    // The regression pin on the populated path: an install with rows to tour is
    // untouched by the gate this change adds. `content` goes Loading → Ready once
    // here and never leaves it, so this says nothing about an arm interrupted
    // mid-window — that is the case below.
    mountDashboard(POPULATED_TOTAL);

    expect(emptyStateShown()).toBe(false);
    expect(tourAnchorCount()).toBeGreaterThan(0);
    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("opens without a delay and keeps touring when more history starts importing", () => {
    const { rerender } = mountDashboard(POPULATED_TOTAL, 0);
    expect(tourEverOpened()).toBe(true);
    hooks.sessionImportInProgress = true;
    landSessionPolls(rerender, POPULATED_TOTAL, 5, 5);
    expect(emptyStateShown()).toBe(false);
    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("reports the deferral once for a run parked on the tour phase", () => {
    // The run this is worth telling: `canRecordDashboardTourDeferral` accepts a
    // deferral only from `dashboard_tour`, and a run left parked there has its
    // completion card withheld — the web symptom ISS-9727 fixed. Never
    // `finish_tour`, which would retire a tour the reader was never shown.
    guidedOnboardingStub.snapshot = tourSnapshot();

    const { rerender } = mountDashboard(0);

    expect(tourEverOpened()).toBe(false);
    expect(
      guidedOnboardingStub.transitions.map((entry) => entry.event)
    ).toEqual([{ type: OnboardingEvent.DeferTour }]);

    // Once per mount, not once per ENTRY into the branch. Re-rendering alone
    // cannot pin that and must not be mistaken for it: every dependency of the
    // arming effect is `Object.is`-stable across a poll, so the effect never
    // re-runs and the `deferredRef` guard is never reached — a suite that only
    // polled would stay green with the guard deleted. The page has to genuinely
    // LEAVE the empty branch and come back, which is an import starting under
    // the reader and finding nothing new.
    hooks.sessionImportInProgress = true;
    landSessionPolls(rerender, 0, 5, 5);
    expect(emptyStateShown()).toBe(false);

    hooks.sessionImportInProgress = false;
    landSessionPolls(rerender, 0, 6, 6);
    expect(emptyStateShown()).toBe(true);

    expect(guidedOnboardingStub.transitions).toHaveLength(1);
  });

  it("reports nothing at all while the page is still loading", () => {
    // The half `Hold` may not speak for. A deferral CLAIMS the run had nothing
    // to show, and an install whose boot import is still running has established
    // no such thing — the same line web draws between `Degraded` and `Empty`.
    // The claim is not lost, only held: it goes out from `Empty` below, once the
    // page has actually looked.
    guidedOnboardingStub.snapshot = tourSnapshot();
    hooks.sessionImportInProgress = true;

    const { rerender } = mountDashboard(0);

    expect(emptyStateShown()).toBe(false);
    expect(tourEverOpened()).toBe(false);
    expect(guidedOnboardingStub.transitions).toHaveLength(0);

    hooks.sessionImportInProgress = false;
    landSessionPolls(rerender, 0, 5, 5);

    expect(emptyStateShown()).toBe(true);
    expect(
      guidedOnboardingStub.transitions.map((entry) => entry.event)
    ).toEqual([{ type: OnboardingEvent.DeferTour }]);
  });
});
