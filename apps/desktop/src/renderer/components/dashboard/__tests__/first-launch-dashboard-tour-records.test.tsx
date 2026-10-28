/**
 * PLN-1875 Step 9 — the two tour-seen records, reconciled on desktop.
 *
 * Desktop's `dashboardTourSeenStorageKey` used to be the only record that could
 * suppress a re-show, so a reader who finished the tour in the web app met it
 * again the first time they opened this install — and a reader who finished it
 * here told the server nothing, so web kept offering it. Both directions are
 * pinned below, against the shared definition of done in `@repo/app`'s
 * `dashboard-tour-completion.ts`.
 *
 * The arm this feeds is unrecoverable in BOTH directions — it opens the tour, or
 * it writes the permanent `dashboardOnboardedStorageKey` latch — so the run's
 * THIRD answer is pinned here too: a read still in flight, and a run that has
 * not reached the tour phase, are each neither. Folding either into a two-valued
 * answer is what spends this install's one shot on a guess.
 *
 * Its own file, with its own page harness, for the reason the sibling tour suite
 * gives: `vi.mock` is file-scoped, so the harness is stood up per file rather
 * than shared — and folding these cases into that suite would push it past the
 * 1,000-line ceiling.
 */

import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { stubMeasuredSize } from "@repo/app/onboarding/components/dashboard-tour/__tests__/dashboard-tour.test-helpers";
import type { Tour } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour";
import { TourCloseReason } from "@repo/app/onboarding/components/dashboard-tour/dashboard-tour-types";
import {
  dashboardAvailableSnapshot,
  readySnapshot,
  tourSnapshot,
} from "@repo/app/onboarding/hooks/__tests__/guided-onboarding.test-helpers";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../dashboard-storage-keys";
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
   * The local store, proven up. Stubbed so a case can hand the page a REAL zero
   * — an install with no sessions — rather than the unprovable one an unopened
   * store reports, which `resolveDashboardState` correctly refuses to call empty.
   */
  sessionSource: { ready: true, importInProgress: false, unavailable: false },
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
// The source probe is the seam, not the subject — it reaches the local
// agent-monitor over IPC and the app-core mode context. Stub ONLY that hook and
// keep the real `resolveDashboardState` / `useSessionsCountFresh` /
// `useBackfillSettleDetection`, so what these cases exercise is the shipped
// loading/empty decision rather than a re-statement of it.
vi.mock("../dashboard-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dashboard-state")>()),
  useDashboardSessionSource: () => hooks.sessionSource,
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
// The real `useGuidedDashboardTour` stays in the render path — the
// reconciliation IS that hook, so the seam is the API client beneath it.
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

function sessionsResult(dataUpdatedAt: number, total = 5) {
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

function renderDashboard(
  /**
   * ISS-9728: `0` is a REAL empty install — the store is stubbed proven-up
   * above, so `resolveDashboardState` reaches its empty branch and the page
   * draws no rows and therefore no `[data-tour]` anchor.
   */
  sessionsTotal = 5
) {
  hooks.useAgentSessions.mockReturnValue(sessionsResult(1, sessionsTotal));
  const source = insightsSource();
  const result = render(<FirstLaunchDashboard />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsDataSourceProvider value={source}>
          {children}
        </InsightsDataSourceProvider>
      </FeatureFlagAdapterProvider>
    ),
  });
  driveToArmable(result.rerender, sessionsTotal);
  return result;
}

/**
 * Advance the page from mount to the commit the arming effect evaluates: run out
 * the first-launch reveal so `tick` reaches 100, then land enough no-growth
 * session polls for the backfill to settle.
 */
function driveToArmable(
  rerender: (ui: ReactElement) => void,
  sessionsTotal: number
) {
  act(() => {
    vi.advanceTimersByTime(REVEAL_DURATION_MS + 200);
  });
  for (let dataUpdatedAt = 2; dataUpdatedAt <= 4; dataUpdatedAt++) {
    hooks.useAgentSessions.mockReturnValue(
      sessionsResult(dataUpdatedAt, sessionsTotal)
    );
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });
  }
  act(() => {
    vi.advanceTimersByTime(ARM_DELAY_MS);
  });
}

function tourEverOpened(): boolean {
  return hooks.Tour.mock.calls.some(([props]) => props.active === true);
}

/**
 * Give the anchors this page actually rendered real area.
 *
 * jsdom lays nothing out, so every `data-tour` element measures 0x0 and
 * `resolveDashboardTourSteps` reads all six as absent — a run assertion without
 * this passes against an intro-only list and proves nothing about which tour
 * opened.
 */
function measureRenderedAnchors(): number {
  const anchors = document.querySelectorAll<HTMLElement>("[data-tour]");
  for (const anchor of anchors) {
    stubMeasuredSize(anchor, { width: 400, height: 120 });
  }
  return anchors.length;
}

/** The run the tour was opened on, as step keys. */
function openedStepKeys(): string[] {
  const opened = hooks.Tour.mock.calls.at(-1)?.[0];
  return (opened?.resolveSteps() ?? []).map((step) => step.sel);
}

beforeEach(() => {
  vi.clearAllMocks();
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
  // jsdom performs no layout, so the tour button would never read as on screen.
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
  hooks.useAgentSessions.mockReturnValue(sessionsResult(1));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("FirstLaunchDashboard — reconciling the two tour-seen records", () => {
  it("does not re-open a tour the reader already finished on another device", () => {
    // No local flag on this install at all, so the server record is the only
    // thing that can keep the tour shut — which is the whole point.
    guidedOnboardingStub.snapshot = readySnapshot({ tourCompleted: true });

    renderDashboard();

    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBeNull();
    expect(tourEverOpened()).toBe(false);
    // The first-launch reveal still latches: suppressing the tour is not the
    // same as leaving the install in a permanent first-run state.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("still opens for a run that has not recorded the tour", () => {
    // The same run in the same phase; `tourCompleted` is the only field that
    // moved, so nothing but the completion record can separate these two.
    guidedOnboardingStub.snapshot = readySnapshot({ tourCompleted: false });

    renderDashboard();

    expect(tourEverOpened()).toBe(true);
  });

  it("suppresses locally with no run to read at all", () => {
    // Offline, gated off, or a failed read all arrive as no snapshot, and this
    // install's own flag still has to answer without one.
    guidedOnboardingStub.snapshot = undefined;
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    renderDashboard();

    expect(tourEverOpened()).toBe(false);
    // Follows from the line above rather than pinning anything of its own: with
    // the tour never opened there is no `closeTour` to reach a write, so no
    // mutation of the write path could redden this. The guard that refuses a
    // write against an unread run belongs to `useGuidedDashboardTour`, and its
    // coverage is `starts no write at all before a run has been read` in
    // packages/app/onboarding/hooks/__tests__/use-guided-dashboard-tour.test.tsx.
    expect(guidedOnboardingStub.transitions).toEqual([]);
  });

  it("still runs its own tour when nothing has said the tour is over", () => {
    // The legacy and offline branch, and the reason an unread run must not read
    // as "already seen": same absent snapshot as the case above, no local flag.
    guidedOnboardingStub.snapshot = undefined;

    renderDashboard();

    expect(tourEverOpened()).toBe(true);
  });

  it("still runs its own tour for a run parked short of the tour phase", () => {
    // Where a finished blocking flow actually rests: nothing posts
    // `dashboard_entered`, so `DashboardAvailable` is not transient in practice.
    // The run is not ASKING for the tour from there — web stays shut — but it has
    // recorded no completion either, and desktop's trigger is its own first
    // launch, not the run. Reading "not asking" as "done" retired this install's
    // tour for good.
    guidedOnboardingStub.snapshot = dashboardAvailableSnapshot();

    renderDashboard();

    expect(tourEverOpened()).toBe(true);
  });

  it("waits out a read still in flight rather than guessing either way", () => {
    // The arm and the snapshot request start together, and with reduced motion
    // only the 650ms settle separates them. This reader HAS finished the tour
    // elsewhere; their answer is simply late.
    guidedOnboardingStub.read = false;
    guidedOnboardingStub.snapshot = readySnapshot({ tourCompleted: true });

    const { rerender } = renderDashboard();

    // Neither half of the arm has fired: no tour, and no permanent latch. A
    // two-valued standing has to pick one of those here, and both are wrong.
    expect(tourEverOpened()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();

    // The same read, landing after the window it would have raced.
    guidedOnboardingStub.read = true;
    act(() => {
      rerender(<FirstLaunchDashboard />);
    });
    act(() => {
      vi.advanceTimersByTime(ARM_DELAY_MS);
    });

    expect(tourEverOpened()).toBe(false);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("runs its own tour when the read was never issued at all", () => {
    // The other side of the gate the case above pins, and the reason a single
    // "still pending" flag cannot carry it. Same settled-v2 tree, same run on the
    // shelf, same commit — but this tree has no identity, so the snapshot query
    // is never issued. Nothing will resolve it and nothing will fail it, so
    // waiting is waiting forever: no tour, and no permanent latch, for the life
    // of the install. `identityReady` is a separate fixture value from `read`
    // for exactly that reason.
    guidedOnboardingStub.identityReady = false;
    guidedOnboardingStub.snapshot = readySnapshot({ tourCompleted: true });

    renderDashboard();

    // The run says finished, and it is deliberately not consulted: an unissued
    // read has no record to give, and this install's own `localSeen` is the only
    // thing that may suppress without one.
    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe("1");
  });

  it("tells the server when the reader finishes the tour on this device", () => {
    // The other direction: without this write the completion stays local and web
    // offers the tour again on the reader's next visit there.
    guidedOnboardingStub.snapshot = tourSnapshot();

    renderDashboard();
    const opened = hooks.Tour.mock.calls.at(-1)?.[0];
    expect(opened?.active).toBe(true);
    act(() => {
      opened?.onClose(TourCloseReason.Done);
    });

    // Both records, written together: the local flag is still this device's fast
    // path, and the transition is what the other device reads.
    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBe("1");
    expect(
      guidedOnboardingStub.transitions.map((entry) => entry.event)
    ).toEqual([{ type: OnboardingEvent.FinishTour }]);
  });

  it("tells the server even though the run never routed the reader to the tour", () => {
    // The case above is the only run shape that USED to record: the write guard
    // asked whether the run was ASKING for the tour, and only `dashboard_tour`
    // and the `Ready` a deferral left answer yes. This is where a real desktop
    // reader's run sits — nothing posts `dashboard_entered` — so the completion
    // they gave was dropped with no signal, the local flag latched anyway, and
    // web kept offering a tour they had already finished. Same fixture as
    // `still runs its own tour for a run parked short of the tour phase` above,
    // driven one step further to the close that had nowhere to go.
    guidedOnboardingStub.snapshot = dashboardAvailableSnapshot();

    renderDashboard();
    const opened = hooks.Tour.mock.calls.at(-1)?.[0];
    expect(opened?.active).toBe(true);
    act(() => {
      opened?.onClose(TourCloseReason.Done);
    });

    expect(
      guidedOnboardingStub.transitions.map((entry) => entry.event)
    ).toEqual([{ type: OnboardingEvent.FinishTour }]);
    // The run this was recorded against, so the case cannot pass on a write that
    // went out under some other phase's snapshot.
    expect(guidedOnboardingStub.transitions[0]?.snapshot.state.phase).toBe(
      OnboardingPhase.DashboardAvailable
    );
  });
});

/**
 * ISS-9728 — a first launch with no account, where this install's own record is
 * the WHOLE decision.
 *
 * The assignment is evaluated for a signed-in account, so a guest launch settles
 * `Unavailable` and no server record can ever arrive to correct a wrong answer
 * here. Two things are pinned as a PAIR, and either alone is worthless: a guest
 * with no record IS offered the tour, and a guest whose record says they
 * dismissed it is NOT. A page that always opened it passes the second only by
 * failing the first, and vice versa.
 *
 * `authState.status` is signed out for the whole file (see `beforeEach`), which
 * is what makes these guests rather than accounts.
 */
describe("FirstLaunchDashboard — a guest first launch (ISS-9728)", () => {
  it("offers a guest with no record the canonical anchored beats", () => {
    renderDashboard();

    // Every anchor the page rendered is measurable, so the run is the canonical
    // list narrowed to what this fixture lays out — `activity` is the one beat
    // it does not draw. ISS-10546 took the leading `intro` card off the front:
    // the run is now anchors and nothing else, exactly as web's is.
    expect(measureRenderedAnchors()).toBeGreaterThan(0);
    expect(tourEverOpened()).toBe(true);
    expect(openedStepKeys()).toEqual([
      "stats",
      "impact",
      "sessions",
      "models",
      "prs",
    ]);
  });

  it("does not offer it to a guest whose record says they dismissed it", () => {
    localStorage.setItem(dashboardTourSeenStorageKey, DASHBOARD_FLAG_SET);

    renderDashboard();

    expect(tourEverOpened()).toBe(false);
    // The reveal still latches: suppressing the tour is not the same as leaving
    // the install permanently in a first-run state. A second witness that the
    // arming pass ran at all, rather than being held by some unrelated gate.
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBe(
      DASHBOARD_FLAG_SET
    );
  });

  it("treats a record it cannot read as a first run, and leaves it alone", () => {
    // The trap the ruling names: a cleared store, an older or newer build's
    // spelling, or a hand edit must not be mistaken for a reader who actively
    // dismissed the tour — there is no server record to overrule that mistake,
    // and the arm spends this install's one shot on it.
    localStorage.setItem(dashboardTourSeenStorageKey, '{"seen":true}');

    renderDashboard();

    expect(tourEverOpened()).toBe(true);
    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBe(
      '{"seen":true}'
    );
  });

  it("defers rather than spending the tour on a guest whose dashboard drew no rows", () => {
    // The profile the review named (davetho): a normal first launch, no
    // sessions of any kind, so the dashboard draws "No agent sessions yet" and
    // NOT one canonical anchor exists. The run would be Desktop's intro card
    // alone, whose own "Take a quick tour" is then its LAST press — closing it
    // writes the tour-seen flag, and for a guest nothing can ever arrive to
    // correct that. Deferring is the ISS-8351 guarantee spent correctly.
    renderDashboard(0);

    expect(measureRenderedAnchors()).toBe(0);
    expect(tourEverOpened()).toBe(false);
    // Neither permanent write happened, which is what makes this a DEFERRAL and
    // not a silent loss: the seen flag would retire the tour, and the
    // first-launch latch would stop the arm from ever running again.
    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBeNull();
    expect(localStorage.getItem(dashboardOnboardedStorageKey)).toBeNull();
  });

  it("records a beat-less run's close as deferred, never as the tour", () => {
    // `closeTour`'s `!runHasAnchoredBeat` guard, driven through the production
    // callback the tour actually closes with.
    //
    // ISS-10546 closed the road this case used to take. It clicked the header's
    // replay control, which did not go through the arm and so could put a run on
    // screen the arm had refused; that control is now omitted outright when the
    // run rings nothing, so the click is no longer expressible. The guard is NOT
    // dead with it: `runHasAnchoredBeat` follows the page's content state, so a
    // dashboard that leaves Ready underneath an already-open tour reaches this
    // close with no beats left — which is the shape asserted here.
    //
    // Driven as an ENROLLED reader on purpose, and it is not a detour from the
    // guest: the refusal follows the RUN, which is measured the same way for
    // both, and only a settled v2 reads the guided snapshot at all — so this is
    // the one shape where `defer_tour` versus `finish_tour` is observable
    // rather than a no-op. The guest's half of the same gate is the local flag,
    // asserted below and in the deferral case above.
    //
    // `tourSnapshot` because a DEFERRAL is only recordable from the tour phase
    // (`canRecordDashboardTourDeferral`) — from anywhere else it spends a
    // revision to move nowhere and the machine refuses it, which would make this
    // assertion pass on silence.
    guidedOnboardingStub.snapshot = tourSnapshot();

    renderDashboard(0);

    expect(measureRenderedAnchors()).toBe(0);
    const rendered = hooks.Tour.mock.calls.at(-1)?.[0];
    if (!rendered) {
      throw new Error("Expected the dashboard to render the Tour");
    }
    act(() => {
      rendered.onClose(TourCloseReason.Done);
    });

    // The same close on a dashboard WITH rows records `finish_tour` and writes
    // this flag — see `tells the server even though the run never routed the
    // reader to the tour` above, which is this case with the rows put back.
    expect(
      guidedOnboardingStub.transitions.map((entry) => entry.event)
    ).toEqual([
      { type: OnboardingEvent.DeferTour },
      { type: OnboardingEvent.DeferTour },
    ]);
    expect(localStorage.getItem(dashboardTourSeenStorageKey)).toBeNull();
  });
});
