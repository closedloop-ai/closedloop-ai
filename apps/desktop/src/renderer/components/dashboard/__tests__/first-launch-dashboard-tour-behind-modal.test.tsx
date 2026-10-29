// ISS-11204: the spotlight starts only after onboarding closes, using available data.
//
// THE FILENAME IS HISTORICAL. "behind-modal" names the defect this suite was
// opened for, not a behavior it still asserts: the tour does not open behind the
// blocking modal any more, and no case below asserts that it does. That is the
// honest claim — several cases assert nothing at all about the run while the
// takeover is up (they pin the latch, a timer count, or the state after the
// exit), so this is not a per-case ledger. Said here because the stale reading
// has already cost a ticket — ISS-11150 was filed against a docstring in
// `use-tour-arming.ts` claiming the tour opened behind the modal deliberately,
// after #7930/#7955/#7959 had already changed it. The contract itself is pinned
// in `../tour/__tests__/tour-arming-modal-exclusion.test.tsx`.

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
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
import { act, render, screen } from "@testing-library/react";
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
  DashboardLoading: ({ analyticsPct }: { analyticsPct: number }) => (
    <div data-analytics-pct={analyticsPct} data-testid="dashboard-loading" />
  ),
}));
vi.mock(
  "@repo/app/onboarding/components/dashboard-tour/dashboard-tour",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/onboarding/components/dashboard-tour/dashboard-tour")
      >();
    return {
      Tour: (props: TourProps) => {
        hooks.Tour(props);
        return <actual.Tour {...props} />;
      },
    };
  }
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

beforeEach(() => {
  authState.status = DesktopAuthStatus.SignedOut;
  resetGuidedOnboardingStub();
});

/**
 * The takeover, built from the primitive `GuidedOnboardingDialog` itself uses
 * and configured the way it configures it — non-dismissible, no close control.
 *
 * The real primitive rather than a stand-in `<div>` because the arm's existing
 * "can the reader reach this?" gates are DOM reads, and Radix's modal behaviour
 * is what they are read against: with this open, the dashboard's own container
 * carries `aria-hidden="true"` and yet the `[data-tour]` anchor the arm reads
 * still reports an `offsetParent`, which is exactly why neither gate could see
 * the cover.
 */
function GuidedOnboardingTakeover({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle>{TAKEOVER_TITLE}</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

describe("FirstLaunchDashboard tour under the guided-onboarding takeover (ISS-10570)", () => {
  // Mirrors REVEAL_DURATION_MS in first-launch-dashboard.tsx (the reveal scan
  // length); the constant is module-private, so keep this in sync with it.
  const REVEAL_DURATION_MS = 3600;
  // The arm's own delay between committing and opening.
  const ARM_DELAY_MS = 650;

  let visibility: DocumentVisibilityState;
  let takeoverOpen: boolean;
  let mountGeneration: number;
  let rerenderPage: (open: boolean) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stubLocalStorage();
    setBlockingOnboardingModalOpen(false);
    takeoverOpen = false;
    mountGeneration = 1;
    // Full motion, so the reveal scan actually runs and `tick` climbs to 100
    // under fake timers — the arm waits on that completion.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    // jsdom lays nothing out, so `offsetParent` is always null and the
    // `[data-tour]` anchor the arm's on-screen guard reads would never be laid
    // out. Answering `document.body` is the honest model of the situation under
    // test: the dashboard IS laid out, it is merely covered.
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
      () => document.body
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 120,
      width: 400,
      height: 120,
      toJSON: () => ({}),
    });
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    hooks.sessionSource.value = {
      ready: true,
      importInProgress: false,
      unavailable: false,
    };
    allInsightsLoaded();
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 5, items: [] } })
    );
  });

  afterEach(() => {
    // Drop pending timers WITHOUT running them — a leftover arm timer fired here
    // would call setTourActive outside act() and warn.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setBlockingOnboardingModalOpen(false);
    Reflect.deleteProperty(document, "visibilityState");
  });

  /**
   * The production shape: the takeover and the dashboard as siblings.
   *
   * The ready-state dashboard renders insights tiles gated by `<FeatureFlagged>`,
   * which need a `FeatureFlagAdapterProvider` ancestor (the real app mounts one
   * via `DesktopAppCoreProvider`), so a static adapter stands in for a live
   * PostHog surface.
   */
  function page(open: boolean) {
    return (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={createInsightsSource()}>
          <GuidedOnboardingTakeover open={open} />
          {/*
            Keyed so a test can model the page going away and coming back —
            a route change mid-walkthrough, or a relaunch. The tour's open state
            is component state and does not survive that; only the permanent
            latch does, which is the whole asymmetry this suite is about.
          */}
          <FirstLaunchDashboard key={mountGeneration} />
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    );
  }

  /** Open or exit the takeover, reporting it exactly as the real host does. */
  function setTakeover(open: boolean) {
    takeoverOpen = open;
    act(() => {
      setBlockingOnboardingModalOpen(open);
      rerenderPage(open);
    });
  }

  function renderPage() {
    const result = render(page(takeoverOpen));
    rerenderPage = (open: boolean) => result.rerender(page(open));
    // The page distrusts a result that predates the local store proving it can
    // serve rows, so the read that landed at mount is not yet a known count.
    // Advancing `dataUpdatedAt` and re-rendering is what the real poll does.
    currentSessionsFixture = {
      ...currentSessionsFixture,
      dataUpdatedAt: currentSessionsFixture.dataUpdatedAt + 1,
    };
    hooks.useAgentSessions.mockReturnValue(currentSessionsFixture);
    act(() => {
      rerenderPage(takeoverOpen);
    });
    return result;
  }

  /** Feed consecutive no-growth session polls so the backfill settles. */
  function driveToSettled() {
    for (let dataUpdatedAt = 2; dataUpdatedAt <= 4; dataUpdatedAt++) {
      hooks.useAgentSessions.mockReturnValue(
        sessionsResult({ data: { total: 5, items: [] }, dataUpdatedAt })
      );
      act(() => {
        rerenderPage(takeoverOpen);
      });
    }
  }

  /**
   * Run the reveal scan out, settle the backfill, give the rendered anchors real
   * area, then let the arm's delay elapse.
   *
   * jsdom lays nothing out, so every `data-tour` element measures 0x0 and
   * `resolveDashboardTourSteps` would read all of them as absent — an assertion
   * without this passes against an empty run and proves nothing.
   */
  function driveToArmed() {
    driveToSettledWithMeasuredAnchors();
    act(() => {
      vi.advanceTimersByTime(ARM_DELAY_MS);
    });
  }

  /** Everything `driveToArmed` does except letting the arm's delay elapse. */
  function driveToSettledWithMeasuredAnchors() {
    act(() => {
      vi.advanceTimersByTime(REVEAL_DURATION_MS + 200);
    });
    driveToSettled();
    const anchors = document.querySelectorAll<HTMLElement>("[data-tour]");
    if (anchors.length === 0) {
      throw new Error(
        "the page rendered no [data-tour] anchors, so the run below would be empty"
      );
    }
    for (const anchor of anchors) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
  }

  function tourIsOpen(): boolean {
    return hooks.Tour.mock.calls.at(-1)?.[0].active === true;
  }

  // ISS-12110 (Marisol Ashgrove, 2026-10-07) narrowed what "partial data" may mean
  // here: the tour may start while the import and the Agents read are still
  // running, because the headline row has its data. Its sibling below pins the
  // other half.
  it("starts on modal close with one parsed session while import and the Agents read are pending", () => {
    hooks.sessionSource.value = {
      ready: true,
      importInProgress: true,
      unavailable: false,
    };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 1, items: [] } })
    );
    hooks.useAgentsInsights.mockReturnValue(insightResult());
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    for (const anchor of document.querySelectorAll<HTMLElement>(
      "[data-tour]"
    )) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
    expect(tourIsOpen()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
    setTakeover(false);
    expect(tourIsOpen()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  // The counterfactual of the case above, and the behaviour the ruling replaced:
  // this page draws its rows as soon as one session is parsed, so the tour used
  // to open on modal close over a headline row whose reads had not answered.
  it("does not start on modal close until the headline row's reads land", () => {
    hooks.sessionSource.value = {
      ready: true,
      importInProgress: true,
      unavailable: false,
    };
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult({ data: { total: 1, items: [] } })
    );
    hooks.useDeliveryInsights.mockReturnValue(insightResult());
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    for (const anchor of document.querySelectorAll<HTMLElement>(
      "[data-tour]"
    )) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
    setTakeover(false);

    expect(tourIsOpen()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    allInsightsLoaded();
    act(() => {
      rerenderPage(takeoverOpen);
    });

    expect(tourIsOpen()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  // THE TICKET. The takeover covers the dashboard for as long as the
  // walkthrough lasts, and the walkthrough routes: the run navigates on
  // `onDashboardAvailable`, and a reader who leaves the dashboard and comes back
  // remounts this page. The tour's open state does not survive that — only the
  // permanent latch does — so a shot spent under the cover is a tour the reader
  // never sees and can never get back.
  //
  // Fails before the change with `active` false: the arm wrote
  // `dashboardOnboardedStorageKey` while the takeover was up, so the remount
  // read `firstLaunch` as false and refused to arm at all.
  it("opens immediately on exit, even after the covered dashboard remounted", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    expect(tourIsOpen()).toBe(false);

    // The walkthrough routes away and back.
    mountGeneration = 2;
    act(() => {
      rerenderPage(takeoverOpen);
    });
    expect(tourIsOpen()).toBe(false);

    // The reader finishes the walkthrough and the takeover is exited.
    // Layout belongs to the remounted DOM. Closing itself must open the tour.
    for (const anchor of document.querySelectorAll<HTMLElement>(
      "[data-tour]"
    )) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
    setTakeover(false);
    expect(tourIsOpen()).toBe(true);
  });

  /**
   * ISS-11315 Defect 4. Pressing Create account CLOSES the takeover to open the
   * system browser, so the falling edge fired and the tour's opening animation
   * played while the reader was being redirected away — the operator saw it
   * happen. The gate could not tell "onboarding finished" from "mid-handoff and
   * coming back"; the auth state machine already could.
   *
   * Both halves, because a hold that never releases would satisfy the first on
   * its own — and would be worse than the animation, since the reader would
   * come back to a dashboard with no tour.
   */
  it("holds the tour through a browser handoff and opens it when the handoff settles", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();
    expect(tourIsOpen()).toBe(false);

    // The account run hands off: the takeover closes to open the browser.
    authState.status = DesktopAuthStatus.OpeningBrowser;
    for (const anchor of document.querySelectorAll<HTMLElement>(
      "[data-tour]"
    )) {
      stubMeasuredSize(anchor, { width: 400, height: 120 });
    }
    setTakeover(false);
    expect(tourIsOpen()).toBe(false);
    // And the shot is not spent while it is held, or the reader would return to
    // a dashboard that can never show them the tour.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    // The browser comes back and the run settles.
    act(() => {
      authState.status = DesktopAuthStatus.Authenticated;
      rerenderPage(takeoverOpen);
    });
    expect(tourIsOpen()).toBe(true);
  });

  // The mechanism behind the case above, asserted where it is readable: the one
  // shot is not SPENT under the cover. Both halves, because a latch that is
  // simply never written would satisfy the first one on its own.
  it("holds the permanent first-launch latch unwritten while the takeover covers the page, and writes it once the takeover is exited", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    setTakeover(false);
    driveToArmed();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  // THE LATCH IS NOT ALWAYS UNWRITTEN WHEN THE TAKEOVER EXITS, which is what the
  // two cases above cannot cover: they both start from a genuine first launch.
  // A reader who quits mid-onboarding and relaunches, or whose shot was spent in
  // a commit before the store had been told the takeover was up, reaches the end
  // of the walkthrough on an install whose permanent latch is already written —
  // and `firstLaunch` is read once at mount, so it says "not first launch" for
  // the whole session. That reader was shown nothing, so the takeover's exit
  // releases the shot regardless of the latch; `tourStanding` still decides
  // whether anything opens, which the `Done` case below pins.
  it("opens on takeover exit for an install whose first-launch latch was already written", () => {
    localStorage.setItem(dashboardOnboardedStorageKey, "1");
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    expect(tourIsOpen()).toBe(false);

    setTakeover(false);
    driveToArmed();

    expect(tourIsOpen()).toBe(true);
  });

  // THE COMPLETION LATCH CAN ALREADY BE SET WHEN THE TAKEOVER GOES UP, which is
  // the half of the release the case above cannot reach: there the store
  // reports the takeover from before the first commit, so the effect is held
  // and `completedRef` is never written. Mount one commit earlier — the page is
  // up, the store has not been told yet — and the `!firstLaunch` gate latches
  // the ref shut for the rest of the session. The takeover's exit has to clear
  // that ref as well as the `firstLaunch` read, or this reader is held behind
  // the ref forever and the tour never opens.
  it("clears a completion latch set before the store was told the takeover was up", () => {
    localStorage.setItem(dashboardOnboardedStorageKey, "1");
    renderPage();

    expect(tourIsOpen()).toBe(false);

    setTakeover(true);
    setTakeover(false);
    driveToArmed();

    expect(tourIsOpen()).toBe(true);
  });

  // The same install, with the tour already seen: the exit releases the shot and
  // the standing declines to spend it. Without this the case above would be
  // satisfied by an edge that opens the tour for everyone who finishes
  // onboarding, including a reader who has already walked it.
  it("opens nothing on takeover exit when that reader has already seen the tour", () => {
    localStorage.setItem(dashboardOnboardedStorageKey, "1");
    localStorage.setItem(dashboardTourSeenStorageKey, "1");
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    setTakeover(false);
    driveToArmed();

    expect(tourIsOpen()).toBe(false);
  });

  // ISS-11480: the tour's end reopens onboarding at its Account step, so the
  // takeover can come up and go down over a page whose tour was walked in this
  // same mount. That exit must not replay it.
  it("does not replay a tour finished on this page when a later takeover exits", () => {
    renderPage();
    driveToArmed();
    expect(tourIsOpen()).toBe(true);
    const finished = hooks.Tour.mock.calls.at(-1)?.[0];
    act(() => finished?.onClose("done"));
    expect(tourIsOpen()).toBe(false);

    setTakeover(true);
    setTakeover(false);
    driveToArmed();

    expect(tourIsOpen()).toBe(false);
  });

  // The OTHER standing. `Done` fires the arm but opens nothing, so there is no
  // covered run to protect — and writing the permanent latch under the takeover
  // would still retire first launch for a page nobody has met, which is the same
  // loss by a quieter road. Held on the same edge and released by the same
  // dependency, and asserted here because the `Owed` cases above cannot reach
  // this branch at all.
  it("holds the latch under the takeover for a reader whose tour is already done, and writes it on exit", () => {
    localStorage.setItem(dashboardTourSeenStorageKey, "1");
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    // No tour: this standing writes the latch and opens nothing. Stated so the
    // latch assertions below cannot be read as an `Owed` run in disguise.
    expect(tourIsOpen()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    setTakeover(false);
    driveToArmed();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(tourIsOpen()).toBe(false);
  });

  // The arm's delay is superseded, not stacked. Reachable only under the
  // takeover: an uncovered arm sets `completedRef` and drops the
  // `visibilitychange` listener on its first success, so it cannot run twice,
  // while a covered one leaves both in place so it can commit later. An
  // orphaned timeout here outlives the cleanup that can no longer cancel it and
  // fires `setTourActive` after the page is gone.
  //
  // Counted rather than timed: the subject is how many delays are outstanding,
  // and a clock-based proof would be a timing assertion.
  it("supersedes its pending delay when the page is re-armed under the takeover", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToSettledWithMeasuredAnchors();

    const pendingAfterFirstArm = vi.getTimerCount();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(vi.getTimerCount()).toBe(pendingAfterFirstArm);
  });

  // MARISOL'S RULING, 2026-09-17: "you can't get to interacting w/ it until you're
  // out of the modal UX." ISS-11204's 2026-09-25 ruling settled WHICH WAY that
  // is served: the tour never starts while the modal is visible, so there is no
  // control here to refuse focus to — the assertions below read as absent, not
  // as unfocusable, and this title used to claim the latter.
  //
  // Both directions still, because an absent control and a broken fixture look
  // identical from one side: the grant after the exit is what proves this
  // fixture could have rendered one at all.
  it("renders no tour control while the takeover is up, and grants it focus once the takeover is exited", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    expect(document.querySelector(`[aria-label="${SKIP_LABEL}"]`)).toBeNull();
    // Absent from the accessibility tree for the same reason it is absent from
    // the DOM — the run never opened, so there is no node to announce. NOT
    // because the takeover's `aria-hidden` subtree hides it: that was the
    // subordinated design's reason, and the assertion above proves the element
    // does not exist at all. Kept as the a11y-tree half of the same absence.
    expect(screen.queryAllByRole("button", { name: SKIP_LABEL })).toHaveLength(
      0
    );

    setTakeover(false);

    const skipAfterExit = skipControl();
    expect(screen.queryAllByRole("button", { name: SKIP_LABEL })).toContain(
      skipAfterExit
    );
    act(() => skipAfterExit.focus());

    expect(document.activeElement).toBe(skipAfterExit);
  });

  // ISS-11150: stacking order is no longer what keeps the tour out of a reader's
  // way while the modal is up — not opening is (the first assertion below). What
  // the layer still owes is containment: `Tour` paints its own fixed layers at
  // 60-62, and holding them strictly below the design system's dialog layer is
  // what keeps a dialog opened LATER over the running tour. Asserted
  // structurally because jsdom performs no layout and hit-tests nothing.
  //
  // The expected numbers are written out here rather than imported from the
  // modules under test: re-deriving them from the same constants would agree
  // with a change that raised the tour back over the dialog.
  it("opens no run under the takeover, and confines the run it opens after to a layer below the dialog layer", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    expect(tourIsOpen()).toBe(false);
    expect(takeoverOverlayClassName()).toContain(EXPECTED_DIALOG_OVERLAY_SPAN);
    setTakeover(false);

    // From the PARENT: the tour's own layers carry inline `z-index` values, so
    // `closest` would answer with the control itself.
    const tourLayer =
      skipControl().parentElement?.closest<HTMLElement>("[style*='z-index']");
    if (!tourLayer) {
      throw new Error("the tour rendered outside any stacking layer");
    }

    expect(Number(tourLayer.style.zIndex)).toBe(EXPECTED_TOUR_LAYER_Z);
    expect(EXPECTED_TOUR_LAYER_Z).toBeLessThan(EXPECTED_DIALOG_LAYER_Z);
    // ...and the dialog layer really does cover every pixel of the one below it,
    // which is what "below" is worth once a dialog is up over a running tour.
  });

  // The layer's `pointer-events: none` is load-bearing — an empty layer spans the
  // viewport and would otherwise swallow every click on the page — and
  // `pointer-events` INHERITS, so every child that must stay hit-testable has to
  // declare its own. The skip blocker is the one that relied on the default, and
  // it is the element that makes a run modal: without it the dashboard behind
  // the scrim stays clickable and the Skip label answers the keyboard while
  // ignoring the mouse.
  //
  // The DECLARATIONS are what is asserted, not a click: jsdom dispatches a click
  // to a handler whether or not `pointer-events` would have allowed it, so a
  // `fireEvent` here would pass just as well with the blocker disabled.
  it("keeps the skip blocker hit-testable inside a layer that disables pointer events", () => {
    setBlockingOnboardingModalOpen(true);
    takeoverOpen = true;
    renderPage();
    driveToArmed();

    setTakeover(false);
    const blocker = skipControl();
    const tourLayer =
      blocker.parentElement?.closest<HTMLElement>("[style*='z-index']");

    expect(tourLayer?.className).toContain(LAYER_POINTER_EVENTS_OFF);
    expect(blocker.style.pointerEvents).toBe(CHILD_POINTER_EVENTS_ON);
  });

  // The counterfactual for the pair above: with no takeover the arm is unchanged
  // — it commits on the spot. Without this, every assertion above would pass
  // just as well against an arm that had simply stopped working.
  it("spends the shot immediately when no takeover is covering the page", () => {
    renderPage();
    driveToArmed();

    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
    expect(tourIsOpen()).toBe(true);
  });
});

const TAKEOVER_TITLE = "Discover how you (and your team) build with AI.";
/** The accessible name `Tour` gives its skip control. */
const SKIP_LABEL = "Skip tour";
/**
 * The layer the tour is confined to, and the one the design system's dialog
 * paints at. Independent literals on purpose — see the case that reads them.
 */
const EXPECTED_TOUR_LAYER_Z = 40;
const EXPECTED_DIALOG_LAYER_Z = 50;
/**
 * The layer opts every child out of hit-testing; a child that must stay
 * clickable opts itself back in. Independent literals, like the layer numbers.
 */
const LAYER_POINTER_EVENTS_OFF = "pointer-events-none";
const CHILD_POINTER_EVENTS_ON = "auto";

/** What makes the dialog layer cover every pixel of the one below it. */
const EXPECTED_DIALOG_OVERLAY_SPAN = "inset-0";

/**
 * The tour's skip control as a RAW NODE.
 *
 * A raw node rather than `getByRole` only because this helper predates the
 * non-overlap fix and every call site now runs after the takeover is exited, so
 * a role query would serve equally well. The old reason — that the takeover's
 * `aria-hidden` subtree put it out of a role query's reach — described a run
 * mounted UNDER the takeover, which no longer happens.
 */
function skipControl(): HTMLElement {
  const control = document.querySelector<HTMLElement>(
    `[aria-label="${SKIP_LABEL}"]`
  );
  if (!control) {
    throw new Error("the tour rendered no skip control");
  }
  return control;
}

/** The takeover's own full-viewport overlay, located the way Radix renders it. */
function takeoverOverlayClassName(): string {
  const overlay = document.querySelector<HTMLElement>(
    "[data-slot='dialog-overlay']"
  );
  if (!overlay) {
    throw new Error("the takeover rendered no overlay");
  }
  return overlay.className;
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

// The mocked Tour receives the real component's props; deriving them here keeps
// the spy honest about the contract the page actually renders against.
type TourProps = Parameters<typeof Tour>[0];
