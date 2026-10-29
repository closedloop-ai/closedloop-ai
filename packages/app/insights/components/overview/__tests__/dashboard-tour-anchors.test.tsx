import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import { DashboardTourAnchor } from "../dashboard-tour-anchors";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";
import { withDashboardQueryClient } from "./dashboard-query-client";

// The anchors under test are emitted by the shell itself, not by a row body, so
// the heavy row renderer and sessions table are stubbed exactly as the sibling
// orchestration suite stubs them — every `data-tour` asserted below still comes
// from the production `InsightsOverviewDashboard`.
const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
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

vi.mock("../dashboard-rows", () => ({
  DashboardRowContent: () => null,
}));

vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));

const emptySeries = { series: [], points: [] };
const delivery = { kpis: [], charts: {} };
const agents = {
  kpis: [],
  charts: { modelUsageOverTime: emptySeries, modelBreakdown: [] },
};
// The cloud Insights API omits the activity heatmap today, which is what makes
// `recentSessionsAnchor` fall back to the stats row.
const utilizationWithoutHeatmap = {
  kpis: [],
  charts: { eventActivity: emptySeries },
};
const utilizationWithHeatmap = {
  kpis: [],
  charts: {
    eventActivity: emptySeries,
    activityHeatmap: { cells: [], maxValue: 0 },
  },
};

// The six anchors the ISS-8351 tour rings. Web mounts the tour as of PLN-1875
// Step 8 (`DashboardTourHost` renders `Tour` for a settled v2 reader), and
// `dashboard-tour-steps.ts` defines a beat for all six — so these are the
// elements the spotlight lands on, not inert selectors. What this suite pins is
// WHICH element carries each anchor; the step set itself is
// `dashboard-tour-host.test.tsx`.
const EXPECTED_ANCHORS = [
  DashboardTourAnchor.Stats,
  DashboardTourAnchor.Impact,
  DashboardTourAnchor.Activity,
  DashboardTourAnchor.Sessions,
  DashboardTourAnchor.Models,
  DashboardTourAnchor.Prs,
] as const;

/** What `RecentSessions` puts on screen in place of the table on a failed read. */
const SESSIONS_ERROR_COPY = "Recent sessions are temporarily unavailable.";

/** The empty branch's heading — an independent literal, not read off the shell. */
const EMPTY_STATE_TITLE = "No agent sessions yet";

/** A stand-in for whatever control the route hands down; the label is arbitrary. */
const EMPTY_ACTION_LABEL = "Connect something";

describe("InsightsOverviewDashboard tour anchors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    hooks.useDeliveryInsights.mockReturnValue(succeeded(delivery));
    hooks.useUtilizationInsights.mockReturnValue(
      succeeded(utilizationWithoutHeatmap)
    );
    hooks.useAgentsInsights.mockReturnValue(succeeded(agents));
    hooks.useAgentSessions.mockReturnValue(
      succeeded({ total: 3, items: [{ id: "s0" }] })
    );
  });

  it("resolves the six tour-step anchors when the activity heatmap is present", () => {
    hooks.useUtilizationInsights.mockReturnValue(
      succeeded(utilizationWithHeatmap)
    );

    renderDashboard();

    for (const anchor of EXPECTED_ANCHORS) {
      expect(anchorElement(anchor)).not.toBeNull();
    }
  });

  // Both `recentSessionsAnchor` branches, because the row Recent Sessions hangs
  // under is resolved at runtime: `activity` while the heatmap exists (or
  // Utilization is still loading), `stats` otherwise. Anchoring `sessions` on
  // either row would therefore lose the anchor in the other branch, so each case
  // asserts WHICH row carries it rather than only that it exists somewhere.
  it("anchors recent sessions under the activity row when the heatmap is present", () => {
    hooks.useUtilizationInsights.mockReturnValue(
      succeeded(utilizationWithHeatmap)
    );

    renderDashboard();

    expect(siblingSessionsAnchor(DashboardTourAnchor.Activity)).not.toBeNull();
    expect(siblingSessionsAnchor(DashboardTourAnchor.Stats)).toBeNull();
  });

  // Each of the six beats must ring its own section. The row anchor used to be
  // the keyed block, which made the impact card and the session table its
  // CHILDREN — so `stats` measured all three, steps 2 and 4 re-lit what step 1
  // had already lit, and the resulting hole was tall enough that the scrim
  // (an outset box-shadow around it) dimmed almost nothing.
  it("rings the metrics row alone, not the cards stacked beneath it", () => {
    renderDashboard();

    const statsAnchor = anchorElement(DashboardTourAnchor.Stats);

    expect(statsAnchor).not.toBeNull();
    expect(
      statsAnchor?.querySelector(`[data-tour="${DashboardTourAnchor.Impact}"]`)
    ).toBeNull();
    expect(
      statsAnchor?.querySelector(
        `[data-tour="${DashboardTourAnchor.Sessions}"]`
      )
    ).toBeNull();
  });

  it("keeps the recent-sessions anchor when the heatmap is absent and the activity row is dropped", () => {
    renderDashboard();

    expect(anchorElement(DashboardTourAnchor.Activity)).toBeNull();
    expect(anchorElement(DashboardTourAnchor.Sessions)).not.toBeNull();
    expect(siblingSessionsAnchor(DashboardTourAnchor.Stats)).not.toBeNull();
  });

  it("withholds the recent-sessions anchor when that read failed, and keeps every other one", () => {
    // The beat behind this anchor promises the reader the full story of any
    // session; a failed read draws an error treatment where the table would be.
    // `resolveDashboardTourSteps` consults nothing but the DOM, so withholding
    // the anchor is what drops that one step — and the reason the content-state
    // report can call this page READY instead of cancelling the run over it.
    hooks.useAgentSessions.mockReturnValue(failed());

    renderDashboard();

    expect(anchorElement(DashboardTourAnchor.Sessions)).toBeNull();
    // The card itself still renders, so this is the anchor being withheld and
    // not the whole block disappearing.
    expect(document.body.textContent).toContain(SESSIONS_ERROR_COPY);
    expect(anchorElement(DashboardTourAnchor.Stats)).not.toBeNull();
    expect(anchorElement(DashboardTourAnchor.Impact)).not.toBeNull();
    expect(anchorElement(DashboardTourAnchor.Models)).not.toBeNull();
    expect(anchorElement(DashboardTourAnchor.Prs)).not.toBeNull();
  });

  it("anchors the empty state so a zero-session org has something to ring", () => {
    // ISS-9727. The empty branch REPLACES the body, so a brand-new org used to
    // be the one page the tour could measure nothing on — and the tour host,
    // reading a page with no anchor, ended the run without ever opening it. The
    // cohort onboarding exists for was the cohort it never reached.
    hooks.useAgentSessions.mockReturnValue(succeeded({ total: 0, items: [] }));

    renderDashboard();

    expect(anchorElement(DashboardTourAnchor.GettingStarted)).not.toBeNull();
    // It IS the empty state and not an inert wrapper elsewhere on the page: the
    // copy the reader sees is inside the ringed element, which is what the
    // spotlight will actually cut a hole around.
    expect(
      anchorElement(DashboardTourAnchor.GettingStarted)?.textContent
    ).toContain(EMPTY_STATE_TITLE);
    // And the canonical six are gone with the body, so the reduced run is the
    // only one this page could have opened.
    for (const anchor of EXPECTED_ANCHORS) {
      expect(anchorElement(anchor)).toBeNull();
    }
  });

  it("puts the surface's own action inside the ringed empty state", () => {
    // ISS-9727: the beat that rings this anchor asks the reader to download
    // Desktop (PLN-2216 R5), so the control that does it has to be INSIDE the
    // hole the spotlight cuts — a control the scrim dims is a beat asking for
    // something the reader cannot reach. The route supplies the node; what this
    // pins is that the dashboard renders it, and renders it there.
    hooks.useAgentSessions.mockReturnValue(succeeded({ total: 0, items: [] }));

    renderDashboard(<button type="button">{EMPTY_ACTION_LABEL}</button>);

    expect(
      anchorElement(DashboardTourAnchor.GettingStarted)?.querySelector("button")
        ?.textContent
    ).toBe(EMPTY_ACTION_LABEL);
  });

  it("emits no action SLOT at all when the surface supplies none", () => {
    // The sibling, and the ISS-7866 shape this must preserve: a surface with no
    // honest destination gets the ask alone rather than a control that goes
    // nowhere. Without this, the case above passes for a dashboard that renders
    // some button of its own.
    //
    // THE SLOT, not just the control inside it, and that distinction is the bug
    // this pins. `EmptyState` keys its action slot on the PROP being truthy, and
    // a React element is truthy however it renders — so a caller that gated by
    // passing a component which returns `null` still emitted an `EmptyContent`
    // node, and `Empty`'s `gap-6` put visible space under the description for
    // every reader the program has not enrolled. Asserting only "no button"
    // stays green through exactly that leak, because the leaked node is empty.
    hooks.useAgentSessions.mockReturnValue(succeeded({ total: 0, items: [] }));

    renderDashboard();

    const ringed = anchorElement(DashboardTourAnchor.GettingStarted);
    expect(ringed?.querySelector("[data-slot='empty-content']")).toBeNull();
    expect(ringed?.querySelector("button")).toBeNull();
  });

  it("emits no getting-started anchor on a dashboard that drew its rows", () => {
    // The sibling of the case above, and what stops it being satisfied by an
    // anchor emitted unconditionally. A drawn dashboard that also carried this
    // anchor would let the reduced beat ring a page full of data — and, since
    // `querySelector` takes whichever comes first in document order, could
    // shadow a real row's anchor.
    renderDashboard();

    expect(anchorElement(DashboardTourAnchor.GettingStarted)).toBeNull();
    expect(anchorElement(DashboardTourAnchor.Stats)).not.toBeNull();
  });
});

function succeeded(data: unknown) {
  return {
    // ISS-10414: settled AND answering for the key that was asked for.
    isPlaceholderData: false,
    isSuccess: true,
    isError: false,
    isLoading: false,
    isFetching: false,
    data,
  };
}

function failed() {
  return {
    isSuccess: false,
    isError: true,
    isLoading: false,
    isFetching: false,
    data: undefined,
  };
}

function anchorElement(anchor: DashboardTourAnchor) {
  return document.querySelector(`[data-tour="${anchor}"]`);
}

/**
 * The recent-sessions anchor in the same row BLOCK as the named row's anchor.
 *
 * A sibling, not a descendant, since PLN-1875 Step 8 moved the row anchor onto
 * a child that wraps only the row itself: nesting the sessions table inside the
 * row's own anchor made the `stats` spotlight measure both at once, so a beat
 * about the headline metrics lit the session list too. The positional contract
 * the two cases below pin is unchanged — WHICH row the table hangs under — so
 * only how it is addressed moved.
 */
function siblingSessionsAnchor(row: DashboardTourAnchor): Element | null {
  const block = document.querySelector(`[data-tour="${row}"]`)?.parentElement;
  if (!block) {
    return null;
  }
  return (
    Array.from(block.children).find(
      (child) =>
        child.getAttribute("data-tour") === DashboardTourAnchor.Sessions
    ) ?? null
  );
}

function createInsightsDataSource(): InsightsDataSource {
  return {
    availableScopes: [InsightsScope.Me],
    availableSections: [
      InsightsSection.Delivery,
      InsightsSection.Utilization,
      InsightsSection.Agents,
    ],
    getTileAvailability: () => ({ state: BranchKpiState.Available }),
    getDelivery: () => Promise.reject(new Error("mocked by hook")),
    getUtilization: () => Promise.reject(new Error("mocked by hook")),
    getAgents: () => Promise.reject(new Error("mocked by hook")),
  };
}

function renderDashboard(emptyStateAction?: ReactNode) {
  return render(
    withDashboardQueryClient(
      <InsightsDataSourceProvider value={createInsightsDataSource()}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsOverviewDashboard
            emptyStateAction={emptyStateAction}
            emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
            getSessionHref={() => "/x"}
          />
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>
    )
  );
}
