/**
 * PLN-1875 Step 8: what the overview dashboard tells the surface around it.
 *
 * The spotlight tour anchors to this dashboard's rows and cannot tell its
 * render outcomes apart by measuring the DOM — `stats` / `models` / `prs` are
 * emitted around their skeletons, and the degraded and empty branches emit no
 * anchor at all, which looks exactly like a page that is merely early. So the
 * dashboard says which one it is, and this drives the REAL component so the
 * report is computed from the same inputs the render branches on.
 *
 * WHAT IS HELD AGAINST THE RENDER, and what is not. The two branches that
 * REPLACE the body — degraded and empty — also assert the replacement is on
 * screen and that no anchor was emitted, so a report of `Unavailable` over a
 * page still drawing rows fails here, and a report of anything else over a
 * page with no anchor on it fails here too. `Ready` asserts the converse, that
 * the page it describes has an anchor to ring. `Loading` is pinned as a report
 * only: it draws every row wrapper around its skeleton, so the render has no
 * branch to hold it against.
 *
 * A failed SESSION read is `Ready` here, not a refusal. It draws the whole
 * dashboard with `RecentSessions` showing its own error treatment, and the beat
 * that would have pointed at it is dropped by withholding that one anchor —
 * which is `dashboard-tour-anchors.test.tsx`'s contract, not this suite's.
 */

import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import { DashboardContentState } from "../dashboard-content-state";
import { DashboardTourAnchor } from "../dashboard-tour-anchors";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";
import { withDashboardQueryClient } from "./dashboard-query-client";

const hooks = vi.hoisted(() => ({
  useAgentSessions: vi.fn(),
  useAgentsInsights: vi.fn(),
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
}));

// `importOriginal` so every OTHER export of this module — `insightsKeys` and
// the scoped-retry hook the dashboard calls — survives the mock. A factory that
// enumerates only the three section hooks replaces the module wholesale, so the
// next export added there breaks this file with a mock error that says nothing
// about the change that caused it (ISS-10486 review).
vi.mock("@repo/app/insights/hooks/use-insights", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/app/insights/hooks/use-insights")
  >()),
  useDeliveryInsights: hooks.useDeliveryInsights,
  useUtilizationInsights: hooks.useUtilizationInsights,
  useAgentsInsights: hooks.useAgentsInsights,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: hooks.useAgentSessions,
}));

// The row bodies and the sessions table are stubbed the same way the sibling
// anchor suite stubs them; every state reported below is still computed by the
// production `InsightsOverviewDashboard`.
vi.mock("../dashboard-rows", () => ({ DashboardRowContent: () => null }));
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));

// What each replaced body puts on screen, so "the report matches the render"
// is an assertion rather than a claim in the docstring.
const DEGRADED_COPY =
  "Dashboard metrics are temporarily unavailable. Refresh to try again.";
const EMPTY_TITLE = "No agent sessions yet";
// ISS-11927: the Sessions list's date-range empty (ISS-11913), reused verbatim.
const RANGE_EMPTY_TITLE = "No matching sessions";
const RANGE_EMPTY_DESCRIPTION =
  "No sessions were active in the selected date range.";
const SHOW_ALL_TIME = "Show all time";
/**
 * EVERY anchor an empty page must never carry (ISS-9727) — the whole vocabulary
 * except `getting-started`, which is the empty branch's own.
 *
 * Written out rather than derived from `DashboardTourAnchor`, so a member added
 * to the vocabulary widens what must be proven absent only when someone decides
 * it should: this list is the spec the empty branch is held to, not a copy of
 * what it does.
 *
 * ALL TEN, not the six the tour happens to ring today. The four extra
 * (`agent-pipeline`, `autonomy`, `frustration`, `distribution`) are emitted by
 * the same `visibleRows` loop as the other row anchors, so a regression that
 * leaked a row into the empty branch could just as easily leak one of those —
 * and a check that named only the tour's six would stay green through it. That
 * is the coverage the blanket `[data-tour]` assertion this replaced used to give
 * for free.
 */
const ANCHORS_ABSENT_WHEN_EMPTY = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.AgentPipeline,
  DashboardTourAnchor.Autonomy,
  DashboardTourAnchor.Frustration,
  DashboardTourAnchor.Prs,
  DashboardTourAnchor.Distribution,
];

const EMPTY_SERIES = { points: [], series: [] };
const DELIVERY = { charts: {}, kpis: [] };
const UTILIZATION = { charts: { eventActivity: EMPTY_SERIES }, kpis: [] };
const AGENTS = {
  charts: { modelBreakdown: [], modelUsageOverTime: EMPTY_SERIES },
  kpis: [],
};

function succeeded(data: unknown) {
  return {
    // ISS-10414: settled AND answering for the key that was asked for.
    isPlaceholderData: false,
    data,
    isError: false,
    isFetching: false,
    isLoading: false,
    isSuccess: true,
  };
}

function pending() {
  return {
    // No data for this key at all — loading/failed, never stale.
    isPlaceholderData: false,
    data: undefined,
    isError: false,
    isFetching: true,
    isLoading: true,
    isSuccess: false,
  };
}

function failed() {
  return {
    // No data for this key at all — loading/failed, never stale.
    isPlaceholderData: false,
    data: undefined,
    isError: true,
    isFetching: false,
    isLoading: false,
    isSuccess: false,
  };
}

function createInsightsDataSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getAgents: () => Promise.reject(new Error("mocked by hook")),
    getDelivery: () => Promise.reject(new Error("mocked by hook")),
    getTileAvailability: () => ({ state: BranchKpiState.Available }),
    getUtilization: () => Promise.reject(new Error("mocked by hook")),
  };
}

/**
 * The dashboard under a listener, with a FRESH inline callback per call — the
 * shape a caller that is not a `setState` passes.
 */
// One client per case (reset in `beforeEach`), so a rerender below changes only
// the query statuses under test.
let queryClient = createTestQueryClient();

function dashboardTree(reported: DashboardContentState[]) {
  return withDashboardQueryClient(
    <InsightsDataSourceProvider value={createInsightsDataSource()}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <InsightsOverviewDashboard
          emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
          getSessionHref={() => "/x"}
          onContentStateChange={(state) => reported.push(state)}
        />
      </FeatureFlagAdapterProvider>
    </InsightsDataSourceProvider>,
    queryClient
  );
}

/** Every state the dashboard reported, oldest first. */
function renderDashboard(): DashboardContentState[] {
  const reported: DashboardContentState[] = [];
  render(dashboardTree(reported));
  return reported;
}

function anchor(key: DashboardTourAnchor): Element | null {
  return document.querySelector(`[data-tour="${key}"]`);
}

/**
 * The two session reads this dashboard makes, answered independently.
 *
 * They describe DIFFERENT POPULATIONS — one the pinned seven-day window, one the
 * org's whole history — and the split below is keyed on the count-only hint that
 * only the all-time read carries. A double that answered both from one fixture
 * is exactly the conflation these cases exist to catch, so it could not express
 * the org this suite is about (ISS-9727 review).
 */
function mockSessionReads({
  window: windowRead,
  allTime,
}: {
  window: ReturnType<typeof succeeded>;
  allTime: ReturnType<typeof succeeded>;
}): void {
  hooks.useAgentSessions.mockImplementation(
    (filters: { countOnly?: boolean }) =>
      filters.countOnly === true ? allTime : windowRead
  );
}

/** The options the all-time read was issued under, one entry per render. */
function allTimeReadOptions(): { enabled?: boolean }[] {
  return hooks.useAgentSessions.mock.calls
    .filter(([filters]) => filters?.countOnly === true)
    .map(([, options]) => options ?? {});
}

/**
 * Every insights section terminally failed — the only shape the whole-body
 * degraded branch describes since ISS-10486.
 */
function failEverySection(): void {
  hooks.useDeliveryInsights.mockReturnValue(failed());
  hooks.useUtilizationInsights.mockReturnValue(failed());
  hooks.useAgentsInsights.mockReturnValue(failed());
}

describe("InsightsOverviewDashboard content-state report (PLN-1875 Step 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    queryClient = createTestQueryClient();
    hooks.useDeliveryInsights.mockReturnValue(succeeded(DELIVERY));
    hooks.useUtilizationInsights.mockReturnValue(succeeded(UTILIZATION));
    hooks.useAgentsInsights.mockReturnValue(succeeded(AGENTS));
    hooks.useAgentSessions.mockReturnValue(
      succeeded({ items: [{ id: "s0" }], total: 3 })
    );
  });

  it("reports ready once every section and the session list have settled, over a page with an anchor on it", () => {
    // The tour host arms on READY without measuring first, so the report has to
    // carry the guarantee that there is something to ring. `stats` is the
    // ungated row that supplies it: it is in every row order, and READY means no
    // row is still drawing a skeleton.
    expect(renderDashboard()).toEqual([DashboardContentState.Ready]);
    expect(anchor(DashboardTourAnchor.Stats)).not.toBeNull();
  });

  it("publishes once per change of state, not once per render of the listener", () => {
    // `onContentStateChange` is a public prop of a shared component, and the
    // only caller today passes a stable `setState`. With the callback in the
    // effect's deps, a caller passing an inline arrow — the shape the next one
    // will pass — re-published an unchanged state on every render of its own.
    const reported: DashboardContentState[] = [];
    const { rerender } = render(dashboardTree(reported));

    rerender(dashboardTree(reported));

    expect(reported).toEqual([DashboardContentState.Ready]);
  });

  it("reports loading while a section is still in flight", () => {
    // The rows this dashboard draws around skeletons still emit their
    // `[data-tour]` wrappers, so a listener that measured the DOM here would see
    // a page worth touring and ring placeholders.
    hooks.useDeliveryInsights.mockReturnValue(pending());

    expect(renderDashboard()).toEqual([DashboardContentState.Loading]);
  });

  it("reports loading while the session list has not settled, with every section in", () => {
    // `sessions` wraps `RecentSessions` whether or not its query has landed, so
    // a report that only weighed the insights sections would call this ready and
    // point one beat at a skeleton table.
    hooks.useAgentSessions.mockReturnValue(pending());

    expect(renderDashboard()).toEqual([DashboardContentState.Loading]);
  });

  it("reports degraded for the failed branch, which draws no row at all", () => {
    // DEGRADED, not the empty state below it. The two render alike and mean the
    // opposite — "we could not show it" against "there was nothing to show" — and
    // a consumer that RECORDS an outcome cannot use one for the other: the tour
    // host abandons a degraded run and defers an empty one, and only this report
    // can tell it which it has, since neither state emits an anchor and the wire
    // carries no reason the server could read instead (ISS-8351).
    //
    // EXPECTATION CHANGED HERE (ISS-10486): this case used to fail ONE section.
    // It now fails all three, because one failed section no longer replaces the
    // body — the branch this state describes is reached only when there is
    // nothing at all to draw. Its sibling below holds the partial case.
    failEverySection();

    expect(renderDashboard()).toEqual([DashboardContentState.Degraded]);
    expect(screen.getByText(DEGRADED_COPY)).toBeDefined();
    expect(document.querySelector("[data-tour]")).toBeNull();
  });

  it("reports ready, not degraded, when one section failed and the others resolved", () => {
    // ISS-10486. A partially failed page still DRAWS: the rows that read the
    // failed section carry their own degraded treatment and everything else
    // carries its data, so the page has anchors and the READY guarantee holds.
    // Reported as `Degraded`, the tour host would abandon the run over a page it
    // could perfectly well have rung — and the whole-body copy asserted absent
    // here is what that report used to describe.
    hooks.useUtilizationInsights.mockReturnValue(failed());

    expect(renderDashboard()).toEqual([DashboardContentState.Ready]);
    expect(screen.queryByText(DEGRADED_COPY)).toBeNull();
    // `prs` reads Delivery, which answered. The anchor on a row that DID fail is
    // withheld — `stats` reads Utilization — so the tour never rings an error
    // card; `dashboard-tour-anchors.test.tsx` owns that half.
    expect(anchor(DashboardTourAnchor.Prs)).not.toBeNull();
  });

  it("reports ready when the session list came back an error", () => {
    // A failed read costs its own beat, not the run (ISS-8351 review). Every
    // other row is drawn with its own data, so refusing the whole page here
    // latched the tour host Closed over five healthy beats — and the host does
    // not write `finish_tour` for a run it closed, so that reader was parked in
    // the tour phase on every later visit. What suppresses the sixth beat is the
    // withheld `sessions` anchor, pinned by `dashboard-tour-anchors.test.tsx`.
    hooks.useAgentSessions.mockReturnValue(failed());

    expect(renderDashboard()).toEqual([DashboardContentState.Ready]);
  });

  it("reports empty for a freshly-onboarded org with nothing synced", () => {
    // The cohort the tour exists for. Its dashboard is the empty state, which
    // draws none of the ROWS — indistinguishable from a page mid-load by
    // measuring them, and the reason this is a report rather than a DOM read.
    // Every read here SUCCEEDED, which is the only thing separating this from
    // the degraded case above: same absent rows, opposite meaning.
    //
    // EXPECTATION CHANGED HERE (ISS-9727). This case used to require the page to
    // carry NO `[data-tour]` at all, which was true and was the defect: the one
    // page the onboarding tour exists for was the one page it could measure
    // nothing on. The empty branch now emits its own `getting-started` anchor so
    // the reduced run has a target. What the case still owes — and what actually
    // separates empty from mid-load and from degraded — is that no OTHER anchor
    // is here, so the reported state remains the only way to tell them apart.
    // That is asserted below over the whole anchor vocabulary, not just the six
    // the tour rings, so the replacement is no narrower than the blanket check.
    // BOTH reads answered, and both zero — stated rather than inherited from
    // the shared default, because `Empty` is now the ALL-TIME claim and this is
    // the case that has to establish it (ISS-9727 review). Its sibling below
    // moves only the all-time total and must land on `Quiet`.
    mockSessionReads({
      allTime: succeeded({ items: [], total: 0 }),
      window: succeeded({ items: [], total: 0 }),
    });

    expect(renderDashboard()).toEqual([DashboardContentState.Empty]);
    expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
    expect(anchor(DashboardTourAnchor.GettingStarted)).not.toBeNull();
    for (const absent of ANCHORS_ABSENT_WHEN_EMPTY) {
      expect(anchor(absent)).toBeNull();
    }
  });

  it("reports quiet, not empty, for an org whose sessions are older than the pinned window", () => {
    // THE DEFECT THIS SUITE EXISTS TO PIN (ISS-9727 review, whitlockk). Recent
    // Sessions is pinned to a fixed seven-day window, so an org that onboarded
    // three weeks ago and paused returns a zero total there and draws the exact
    // same empty body as an org that has never synced anything. Reported as
    // `Empty`, the tour host runs the reduced beat and stamps `finish_tour`,
    // which is PERMANENT — that org never sees the six-beat dashboard tour, on
    // the strength of a recency window nobody told it was load-bearing.
    //
    // The render is deliberately IDENTICAL to the case above, asserted rather
    // than assumed: same title, same anchor. That is the whole reason this is a
    // report and not a DOM read, and it is why a consumer may not re-derive the
    // population from what it can see.
    mockSessionReads({
      allTime: succeeded({ items: [{ id: "s-old" }], total: 12 }),
      window: succeeded({ items: [], total: 0 }),
    });

    expect(renderDashboard()).toEqual([DashboardContentState.Quiet]);
    expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
    expect(anchor(DashboardTourAnchor.GettingStarted)).not.toBeNull();
  });

  it("reports loading, not empty, while the all-time count is still in flight", () => {
    // The window has answered and the empty body is already on screen, so this
    // is the one page that looks settled and is not. Reporting `Empty` on the
    // strength of the window alone is the same conflation as the case above,
    // arriving one commit earlier: a consumer told `Empty` here acts
    // permanently on a population nothing has established yet.
    mockSessionReads({
      allTime: pending(),
      window: succeeded({ items: [], total: 0 }),
    });

    expect(renderDashboard()).toEqual([DashboardContentState.Loading]);
    expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
  });

  it("reports quiet, not empty, when the all-time count could not be read", () => {
    // A failed count establishes nothing, and `Empty` is the member that
    // licenses retiring something for good. Folding this to `Empty` would put
    // the defect back for every reader whose count read failed, and folding it
    // to `Degraded` would claim a broken dashboard on a page that drew fine.
    mockSessionReads({
      allTime: failed(),
      window: succeeded({ items: [], total: 0 }),
    });

    expect(renderDashboard()).toEqual([DashboardContentState.Quiet]);
    expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
  });

  it("asks for the all-time count only once the pinned window has come back empty", () => {
    // The cost gate that makes the read above affordable. A dashboard with rows
    // must not spend a request answering a question it is not asking, and the
    // `enabled` flag is the only thing that stops it — the hook is called on
    // every render either way, so a mutation that dropped the gate would leave
    // every other case in this suite green.
    renderDashboard();

    expect(allTimeReadOptions()).not.toHaveLength(0);
    for (const options of allTimeReadOptions()) {
      expect(options.enabled).toBe(false);
    }
  });

  it("issues the all-time count over the whole history, not the pinned window", () => {
    // The read has to be UNBOUNDED or it answers the same wrong question in a
    // second place: a `startDate` here would make "has this org ever synced"
    // mean "has it synced lately", and every case above would still pass.
    mockSessionReads({
      allTime: succeeded({ items: [], total: 0 }),
      window: succeeded({ items: [], total: 0 }),
    });

    renderDashboard();

    const [filters] = hooks.useAgentSessions.mock.calls.find(
      ([candidate]) => candidate?.countOnly === true
    ) as [{ startDate?: string; endDate?: string }];
    expect(filters.startDate).toBeUndefined();
    expect(filters.endDate).toBeUndefined();
  });

  it("reports degraded, not empty, when a failed read also has no sessions", () => {
    // Both preconditions at once, which is the ordinary shape of a broken first
    // visit: the insights reads failed AND the session list is empty. A page that
    // could not load is what this IS, so a consumer never records a measurement
    // it did not take.
    failEverySection();
    hooks.useAgentSessions.mockReturnValue(succeeded({ items: [], total: 0 }));

    expect(renderDashboard()).toEqual([DashboardContentState.Degraded]);
  });

  it("reports neither empty nor degraded when a PARTIAL failure meets a zero count", () => {
    // ISS-10486, and the half that is easy to lose: every other term of `empty`
    // is satisfied here, so a page that dropped the all-succeeded term would
    // report `Empty` — which the tour host acts on PERMANENTLY — off a fan-out
    // that never finished answering.
    hooks.useUtilizationInsights.mockReturnValue(failed());
    hooks.useAgentSessions.mockReturnValue(succeeded({ items: [], total: 0 }));

    expect(renderDashboard()).toEqual([DashboardContentState.Ready]);
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(DEGRADED_COPY)).toBeNull();
  });

  /**
   * ISS-11927. The shipped defect: an org whose sessions all predate the
   * default 7d range got the never-synced "No agent sessions yet" — false for a
   * reader who has synced — and kept getting it at every wider range, because
   * the body was chosen off the PINNED seven-day read alone.
   */
  describe("when the selected range hides sessions the org has (ISS-11927)", () => {
    /** The utilization payload with a sessions KPI per selected period. */
    function sessionsKpiByPeriod(byPeriod: Record<string, number>): void {
      hooks.useUtilizationInsights.mockImplementation((period: string) =>
        succeeded({
          ...UTILIZATION,
          kpis: [{ key: "sessions", value: byPeriod[period] ?? 0 }],
        })
      );
    }

    function dormantOrg(): void {
      mockSessionReads({
        allTime: succeeded({ items: [{ id: "s-old" }], total: 29 }),
        window: succeeded({ items: [], total: 0 }),
      });
    }

    it("draws the date-range empty with Show all time, never the never-synced body", () => {
      dormantOrg();
      sessionsKpiByPeriod({ "7": 0, all: 29 });

      expect(renderDashboard()).toEqual([DashboardContentState.Quiet]);
      expect(screen.getByText(RANGE_EMPTY_TITLE)).toBeDefined();
      expect(screen.getByText(RANGE_EMPTY_DESCRIPTION)).toBeDefined();
      expect(screen.getByRole("button", { name: SHOW_ALL_TIME })).toBeDefined();
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      for (const absent of ANCHORS_ABSENT_WHEN_EMPTY) {
        expect(anchor(absent)).toBeNull();
      }
    });

    it("widens to all time on Show all time and draws the rows it was hiding", () => {
      dormantOrg();
      sessionsKpiByPeriod({ "7": 0, all: 29 });
      const reported = renderDashboard();

      fireEvent.click(screen.getByRole("button", { name: SHOW_ALL_TIME }));

      expect(hooks.useUtilizationInsights).toHaveBeenLastCalledWith(
        "all",
        expect.anything(),
        undefined
      );
      expect(reported.at(-1)).toBe(DashboardContentState.Ready);
      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      expect(anchor(DashboardTourAnchor.Stats)).not.toBeNull();
    });

    /**
     * marisolashgrove, review of #8982: the frame between pressing Show all time
     * and the "all" read landing. `keepPreviousData` keeps utilization
     * isSuccess with the seven-day payload and `isPlaceholderData` true, so
     * the count cannot answer — and the page used to drop to "No agent
     * sessions yet" with the getting-started anchor until it did.
     */
    it("holds the date-range empty, never the never-synced body, while the all-time read is in flight", () => {
      dormantOrg();
      const sevenDay = {
        ...UTILIZATION,
        kpis: [{ key: "sessions", value: 0 }],
      };
      let allTimeLanded = false;
      hooks.useUtilizationInsights.mockImplementation((period: string) => {
        if (period !== "all") {
          return succeeded(sevenDay);
        }
        return allTimeLanded
          ? succeeded({
              ...UTILIZATION,
              kpis: [{ key: "sessions", value: 29 }],
            })
          : { ...succeeded(sevenDay), isPlaceholderData: true };
      });
      const reported: DashboardContentState[] = [];
      const { rerender } = render(dashboardTree(reported));

      fireEvent.click(screen.getByRole("button", { name: SHOW_ALL_TIME }));

      expect(hooks.useUtilizationInsights).toHaveBeenLastCalledWith(
        "all",
        expect.anything(),
        undefined
      );
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      expect(anchor(DashboardTourAnchor.GettingStarted)).toBeNull();
      expect(screen.getByText(RANGE_EMPTY_TITLE)).toBeDefined();
      expect(reported).not.toContain(DashboardContentState.Empty);

      allTimeLanded = true;
      rerender(dashboardTree(reported));

      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      expect(anchor(DashboardTourAnchor.Stats)).not.toBeNull();
      expect(reported.at(-1)).toBe(DashboardContentState.Ready);
    });

    it("draws the rows for a dormant org whose selected range does have sessions", () => {
      // The pinned seven-day read is empty, but the SELECTED range's own KPI
      // counts sessions: replacing those rows with any empty body is the lie.
      dormantOrg();
      sessionsKpiByPeriod({ "7": 4 });

      expect(renderDashboard()).toEqual([DashboardContentState.Ready]);
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
      expect(anchor(DashboardTourAnchor.Stats)).not.toBeNull();
    });

    it("keeps the never-synced body for an org with no sessions at all", () => {
      mockSessionReads({
        allTime: succeeded({ items: [], total: 0 }),
        window: succeeded({ items: [], total: 0 }),
      });
      sessionsKpiByPeriod({ "7": 0 });

      expect(renderDashboard()).toEqual([DashboardContentState.Empty]);
      expect(screen.getByText(EMPTY_TITLE)).toBeDefined();
      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
    });

    it("does not offer Show all time while the window's count is carried over from the previous range", () => {
      dormantOrg();
      hooks.useUtilizationInsights.mockReturnValue({
        ...succeeded({
          ...UTILIZATION,
          kpis: [{ key: "sessions", value: 0 }],
        }),
        isPlaceholderData: true,
      });

      renderDashboard();

      expect(screen.queryByText(RANGE_EMPTY_TITLE)).toBeNull();
      expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    });
  });
});
