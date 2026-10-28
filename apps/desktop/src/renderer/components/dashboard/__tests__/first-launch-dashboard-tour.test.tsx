// Tour lifecycle for the first-launch dashboard: when the guided tour is armed
// and opened (FEA-2737), and what happens to the hint timer the skip path
// schedules (ISS-7602). Split out of first-launch-dashboard.test.tsx, which owns
// the view-state machine — `vi.mock` is file-scoped, so the page harness below is
// stood up per file rather than shared.

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import type { InsightsTileAvailability } from "@repo/app/insights/lib/tile-availability";
import type { TileDescriptor } from "@repo/app/insights/lib/tile-catalog";
import { stubMeasuredSize } from "@repo/app/onboarding/components/dashboard-tour/__tests__/dashboard-tour.test-helpers";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  publishRecordingGuestRun,
  type RecordingGuestRun,
} from "../../onboarding/__tests__/published-guest-run-fixture";
import { tourCompleteLabel } from "../../onboarding/use-guest-onboarding";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../dashboard-storage-keys";
import { FirstLaunchDashboard } from "../first-launch-dashboard";
import { resetGuidedOnboardingStub } from "./guided-onboarding-stub";

// FEA-4020: the single header "Refreshing" indicator's copy.
const _REFRESHING_RE = /refreshing/i;

type DashboardRowContentPropsForTest = {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  modelSeries?: unknown;
  modelTokenSeries?: unknown;
  frustrationSeries?: unknown;
  row: { tour: string };
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
    data: unknown;
  }> = {}
) {
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
// leaves the loading treatment. agents.data must carry the minimal shape
// buildTourIntroStep reads (kpis + modelBreakdown).
function allInsightsLoaded() {
  hooks.useDeliveryInsights.mockReturnValue(
    insightResult({ isSuccess: true, data: { kpis: [], charts: {} } })
  );
  // The desktop's local engine always returns the heatmap and the autonomy
  // trend, even when empty. ISS-9993 drops a row whose data is absent, so
  // without them this fixture would lose the `activity` anchor for a reason no
  // real install produces.
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
  resetGuidedOnboardingStub();
});

// FEA-2737: the first-launch tour must not be permanently suppressed when the
// window is backgrounded (or the dashboard is otherwise off screen) at the
// moment the reveal settles. The onboarded latch/flag may only be committed
// once the tour is actually armed, and arming must re-evaluate when the window
// returns to the foreground.
describe("FirstLaunchDashboard first-launch tour arming (FEA-2737)", () => {
  let visibility: DocumentVisibilityState;
  // Whether the tour button reports as laid out (`offsetParent != null`). jsdom
  // never lays anything out, so drive this explicitly to exercise BOTH halves
  // of the component's on-screen guard (window visibility AND button layout).
  let laidOut: boolean;
  // Mirrors REVEAL_DURATION_MS in first-launch-dashboard.tsx (the reveal scan
  // length); the constant is module-private, so keep this in sync with it.
  const REVEAL_DURATION_MS = 3600;

  function preferReducedMotion(reduced: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: reduced,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  }

  /**
   * `preferReducedMotion`'s live twin, returning a setter that flips the match
   * state AND notifies the `useMediaQuery` subscriber — which is what a reader
   * turning the OS setting on mid-session does. The static stub above cannot
   * model that: its `addEventListener` is a no-op, so nothing ever re-renders.
   */
  function preferReducedMotionLive(reduced: boolean): (next: boolean) => void {
    let matches = reduced;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_event: string, listener: () => void) =>
          listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) =>
          listeners.delete(listener),
      }))
    );
    return (next: boolean) => {
      matches = next;
      for (const listener of listeners) {
        listener();
      }
    };
  }

  // Feed consecutive no-growth session polls (advancing dataUpdatedAt, holding
  // the total) so the backfill "settles". Render-driven only: it advances no
  // timer, so the first-launch reveal scan stays exactly where the caller left
  // it — which is what lets the reduced-motion pair below differ.
  function driveToSettled(rerender: (ui: ReactElement) => void) {
    for (let dataUpdatedAt = 2; dataUpdatedAt <= 4; dataUpdatedAt++) {
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] }, dataUpdatedAt })
      );
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });
    }
  }

  // Advance the dashboard from mount to the point the arming effect evaluates:
  //   1. run out the first-launch reveal scan so `tick` reaches 100, then
  //   2. settle the backfill.
  // Both are driven under fake timers inside act() so state flushes.
  function driveToArmable(rerender: (ui: ReactElement) => void) {
    act(() => {
      // Reveal uses a Date.now()-based interval; fake timers advance the clock.
      vi.advanceTimersByTime(REVEAL_DURATION_MS + 200);
    });
    driveToSettled(rerender);
  }

  /**
   * Give the dashboard's OWN rendered anchors real area.
   *
   * jsdom lays nothing out, so every `data-tour` element the page rendered
   * measures 0x0 and `resolveDashboardTourSteps` reads all six as absent — a
   * an assertion without this passes against an empty run list and proves
   * nothing. Applied after the reveal has finished, because that is when the
   * rows exist to be measured.
   */
  function measureRenderedAnchors(): number {
    const anchors = document.querySelectorAll<HTMLElement>("[data-tour]");
    for (const anchor of anchors) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
    return anchors.length;
  }

  function stepKeys(props: TourProps | undefined): string[] {
    return (props?.resolveSteps() ?? []).map((step) => step.sel);
  }

  /** The six beats the run resolves to on this page. */
  const ENROLLED_STEP_KEYS = [
    "stats",
    "impact",
    "activity",
    "sessions",
    "models",
    "prs",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // The flags gate the whole first-launch flow (firstLaunch/onboarded/
    // tour-seen), and this env has no real localStorage to hold them.
    stubLocalStorage();
    // First-launch path: no onboarded flag → `firstLaunch` is true, and full
    // motion (NOT reduced) so the reveal scan actually runs and `tick` climbs
    // to 100 under fake timers — the arming effect waits on that completion.
    preferReducedMotion(false);
    // jsdom performs no layout, so `offsetParent` is always null and the tour
    // button would never read as "laid out". Drive it via `laidOut` so tests
    // can exercise the button-layout half of the on-screen guard independently.
    laidOut = true;
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => (laidOut ? document.body : null)
    );
    visibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );
  });

  afterEach(() => {
    // Drop any pending timers WITHOUT running them — a leftover 650ms arm timer
    // fired here would call setTourActive outside act() and warn.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Drop the own `visibilityState` override so the prototype getter is
    // restored (assigning `= undefined` would throw — it is getter-only).
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("defers arming (and the onboarded flag) while the window is hidden, then arms once it is foregrounded", () => {
    visibility = "hidden";

    const { rerender } = renderDashboard();
    driveToArmable(rerender);

    // Hidden at settle: the latch/flag must NOT be committed and the tour must
    // stay closed — the previous bug persisted the flag here, killing the tour
    // forever on the next launch.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
    const tourCallsWhileHidden = hooks.Tour.mock.calls;
    expect(
      tourCallsWhileHidden.every(([props]) => props.active === false)
    ).toBe(true);

    // Window returns to the foreground: arming re-evaluates and the tour opens.
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    const lastTourCall = hooks.Tour.mock.calls.at(-1);
    expect(lastTourCall?.[0].active).toBe(true);
  });

  it("arms immediately and persists the onboarded flag when on screen at settle", () => {
    visibility = "visible";

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    const lastTourCall = hooks.Tour.mock.calls.at(-1);
    expect(lastTourCall?.[0].active).toBe(true);
  });

  // ISS-8351: promoting `usePrefersReducedMotion` made it resolve on the FIRST
  // render, where the deleted local hook seeded `false` and corrected itself in
  // a mount effect. `tick` is seeded from that first-render value, so a
  // reduced-motion first launch used to start at 0, have its reveal interval
  // torn down by the corrected re-render, and sit at 0 forever — and arming
  // returns early below 100, so the tour never opened and the onboarded flag was
  // never written. Reduced motion drops the reveal ANIMATION, not the tour.
  //
  // This case and its full-motion twin below deliberately do NOT run the reveal
  // scan out: that is the whole observable difference between the two branches,
  // and driving it would make both halves arm identically — a reduced-motion
  // test that passes just as well with the preference off.
  it("arms the tour on a reduced-motion first launch with no reveal scan to wait on", () => {
    visibility = "visible";
    preferReducedMotion(true);

    const { rerender } = renderDashboard();
    driveToSettled(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(hooks.Tour.mock.calls.at(-1)?.[0].active).toBe(true);
  });

  it("opens immediately with available rows even when the reveal has not run", () => {
    visibility = "visible";
    preferReducedMotion(false);
    renderDashboard();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(hooks.Tour.mock.calls.at(-1)?.[0].active).toBe(true);
  });

  it("keeps the opened tour when reduced motion changes", () => {
    visibility = "visible";
    const setReducedMotion = preferReducedMotionLive(false);
    renderDashboard();
    expect(hooks.Tour.mock.calls.at(-1)?.[0].active).toBe(true);
    act(() => setReducedMotion(true));
    expect(hooks.Tour.mock.calls.at(-1)?.[0].active).toBe(true);
  });

  it("defers arming while the tour button is not laid out, even with a visible window", () => {
    // Window is visible, but the dashboard is behind the keep-alive map (its
    // subtree is display:none, so the tour button has no offsetParent). This
    // guards the layout half of the on-screen check — arming must NOT commit.
    visibility = "visible";
    laidOut = false;

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
    expect(
      hooks.Tour.mock.calls.every(([props]) => props.active === false)
    ).toBe(true);
  });

  it("keeps the staggered reveal for a first-launch reader with no tour standing", () => {
    // ISS-11204 (tamsinb review). The spotlight opens immediately on a run that
    // HAS a tour standing, which means the rows must be up front for that
    // reader. Gating that on `firstLaunch` instead would have deleted the
    // staggered reveal for everyone, including this reader — who gets no tour
    // and so gains nothing from the rows appearing at once.
    visibility = "visible";
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    const { rerender } = renderDashboard();

    // Mid-scan: the early row is in, the late one has not reached its beat yet.
    // Both asserted together — the presence is what stops the absence passing
    // on a page that rendered no rows at all.
    act(() => {
      vi.advanceTimersByTime(REVEAL_DURATION_MS / 4);
    });
    expect(document.querySelector('[data-tour="stats"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="distribution"]')).toBeNull();

    // ...and the scan still finishes, so nothing is withheld permanently.
    driveToArmable(rerender);
    expect(document.querySelector('[data-tour="distribution"]')).not.toBeNull();
  });

  it("does not re-open the tour once it has already been seen", () => {
    visibility = "visible";
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    const { rerender } = renderDashboard();
    driveToArmable(rerender);
    act(() => {
      vi.advanceTimersByTime(650);
    });

    // Onboarding still latches, but the guided tour stays closed on replay-only.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(
      hooks.Tour.mock.calls.every(([props]) => props.active === false)
    ).toBe(true);
  });

  /**
   * ISS-8351 / PLN-1875 Step 5: the step list the page hands the engine.
   *
   * This is the wiring half, and it is not a duplicate of
   * `tour/__tests__/use-dashboard-tour-steps.test.tsx`. That suite pins what the
   * hook returns; these pin that the page CALLS it and hands the result to the
   * engine, and — in the v2 case — that the anchors being measured are the real
   * ones this dashboard renders, not fixtures a test appended to the body.
   * Deleting the call site leaves the unit suite green and reddens both of these.
   *
   * WHAT THESE DO NOT PIN: that the engine OPENS on the list it was handed.
   * `Tour` is mocked in this file, and `stepKeys` calls `resolveSteps()` from the
   * test body, so the activation-edge freeze — the render-phase capture that
   * decides which run a started tour is stuck with — is never exercised here.
   * That contract is the engine's own and is covered where the real component is
   * rendered, in `packages/app/onboarding/components/dashboard-tour/__tests__/
   * dashboard-tour.test.tsx` ("Tour — the frame the run opens on").
   */
  describe("the step list the page hands the engine (ISS-8351)", () => {
    /** Arm the tour and hand back the props the engine was opened with. */
    function openTour() {
      const { rerender } = renderDashboard();
      driveToArmable(rerender);
      measureRenderedAnchors();
      act(() => {
        vi.advanceTimersByTime(650);
      });
      return hooks.Tour.mock.calls.at(-1)?.[0];
    }

    it("opens on the six canonical beats", () => {
      visibility = "visible";

      const opened = openTour();

      expect(opened?.active).toBe(true);
      // `impact` and `sessions` are the two beats Desktop gains, and both are
      // anchors this page emits from inside another row rather than as rows of
      // their own — so this also pins that those two wrappers survived.
      expect(stepKeys(opened)).toEqual(ENROLLED_STEP_KEYS);
    });

    it("keeps the guest account hand-off", () => {
      // `completeLabel` carries the guest account ask, and it is the capability
      // this rewire could plausibly have broken. Derived from the production
      // helper for a guest with a run to resume rather than restating
      // "Create account" — what it SAYS per auth state is
      // guest-tour-account-request.test.tsx's contract, and what this pins is
      // that retiring the intro card did not disturb it.
      //
      // ISS-10546 removed the second half of this case. It also pinned the
      // intro summary's rows, and that card is deliberately retired: the
      // normative prototype opens on the first spotlight and has no summary,
      // so there is no contract left to assert. The local read behind it
      // (`useTourHarnesses`) went with the only surface that consumed it.
      visibility = "visible";
      guestRun = publishRecordingGuestRun();

      const opened = openTour();

      expect(opened?.active).toBe(true);
      expect(opened?.completeLabel).toBe(tourCompleteLabel(true));
    });
  });

  /**
   * ISS-12110, Marisol Ashgrove's 2026-10-07 ruling: "We should not be starting the
   * tour until we have data available; we need a skeleton loading state for the
   * entire page before any widget loads; then for each widget as we get data
   * for it to populate. We can start the 1st beat as soon as the 1st row of
   * metrics cards is filled with data; then go to the next beat once the data
   * for that beat is ready."
   */
  describe("the tour waits for each beat's data (ISS-12110)", () => {
    function agentsPending() {
      hooks.useAgentsInsights.mockReturnValue(insightResult());
    }

    function lastTourProps(): TourProps | undefined {
      return hooks.Tour.mock.calls.at(-1)?.[0];
    }

    function renderedRowTours(): string[] {
      return hooks.DashboardRowContent.mock.calls.map(
        ([props]) => props.row.tour
      );
    }

    it("does not open while the headline row's reads are pending, and opens once they land", () => {
      visibility = "visible";
      hooks.useDeliveryInsights.mockReturnValue(insightResult());

      const { rerender } = renderDashboard();

      expect(
        document.querySelector(`[data-tour="${DashboardTourAnchor.Stats}"]`)
      ).not.toBeNull();
      expect(
        hooks.Tour.mock.calls.every(([props]) => props.active === false)
      ).toBe(true);
      expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

      allInsightsLoaded();
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });

      expect(lastTourProps()?.active).toBe(true);
      expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    });

    it("opens on the headline row while the Agents read is pending, holding the beats that read it", () => {
      visibility = "visible";
      agentsPending();

      const { rerender } = renderDashboard();
      const opened = lastTourProps();

      expect(opened?.active).toBe(true);
      const readiness = (props: TourProps | undefined) =>
        CANONICAL_BEATS.map((anchor) => props?.isStepReady?.(anchor));
      expect(readiness(opened)).toEqual([
        true, // stats
        false, // impact: reads Agents
        true, // activity
        true, // sessions
        false, // models: reads Agents
        true, // prs
      ]);

      allInsightsLoaded();
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });

      expect(readiness(lastTourProps())).toEqual(
        CANONICAL_BEATS.map(() => true)
      );
    });

    it("draws a loading row's skeleton inside its anchor, then the row once its read lands", () => {
      visibility = "visible";
      agentsPending();

      const { rerender } = renderDashboard();

      expect(
        document.querySelector(`[data-tour="${DashboardTourAnchor.Models}"]`)
      ).not.toBeNull();
      expect(renderedRowTours()).toContain(DashboardTourAnchor.Stats);
      expect(renderedRowTours()).not.toContain(DashboardTourAnchor.Models);

      allInsightsLoaded();
      hooks.DashboardRowContent.mockClear();
      act(() => {
        rerender(<FirstLaunchDashboard />);
      });

      expect(renderedRowTours()).toContain(DashboardTourAnchor.Models);
    });
  });
});

let guestRun: RecordingGuestRun | null = null;

afterEach(() => {
  guestRun?.withdraw();
  guestRun = null;
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

/** `DASHBOARD_TOUR_STEPS`' anchors, in run order. */
const CANONICAL_BEATS = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.Prs,
] as const;
