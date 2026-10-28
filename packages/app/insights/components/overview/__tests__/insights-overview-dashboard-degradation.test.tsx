import { BranchKpiState } from "@repo/api/src/types/branch";
import { InsightsScope, InsightsSection } from "@repo/api/src/types/insights";
import {
  type InsightsDataSource,
  InsightsDataSourceProvider,
} from "@repo/app/insights/data/insights-data-source";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "../../../../onboarding/lib/desktop-download-copy";
import { DASHBOARD_ROW_LABELS, DashboardRowTour } from "../dashboard-tiles";
import { DashboardTourAnchor } from "../dashboard-tour-anchors";
import { InsightsOverviewDashboard } from "../insights-overview-dashboard";
import { withDashboardQueryClient } from "./dashboard-query-client";
import {
  AI_IMPACT_RE,
  AUTONOMY_DEGRADED_RE,
  DEGRADED_RE,
  errored,
  NO_SESSIONS_RE,
  pending,
  RETRY_BUSY_RE,
  RETRY_IDLE_RE,
  RETRY_RE,
  RETRYING_RE,
  ROW_DEGRADED_RE,
  retryNameFor,
  sessions,
  succeeded,
  webAgents,
  webDelivery,
  webUtilization,
} from "./dashboard-suite-fixtures";

/**
 * ISS-10486's own suite: what the overview dashboard does when SOME of its
 * three insights sections fail, and how a reader recovers the ones that did.
 *
 * Split out of `insights-overview-dashboard.test.tsx` when these cases took
 * that file past the 1,000-line ceiling. The seam is a real responsibility
 * boundary rather than a line count: everything here drives the section
 * error/degradation/retry axis, and nothing here is about the picker, the
 * pinned Recent Sessions window, the row-visibility gates, or the refreshing
 * indicator — which is what the parent file is left holding.
 */
const hooks = vi.hoisted(() => ({
  useDeliveryInsights: vi.fn(),
  useUtilizationInsights: vi.fn(),
  useAgentsInsights: vi.fn(),
  useAgentSessions: vi.fn(),
}));

// `importOriginal` so `insightsKeys` — the real query-key contract the retry
// invalidates against — and the scoped-retry hook the dashboard calls survive
// the mock. A hand-written copy here would agree with itself if the production
// key ever changed.
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
  DashboardRowContent: ({ row }: { row: { tour: string } }) => (
    <div data-testid={`row-${row.tour}`} />
  ),
}));

// The Recent Sessions table renders `Link`, which needs a navigation provider
// this suite has no reason to mount: nothing here is about the sessions card.
vi.mock("@repo/app/agents/components/sessions/synced-sessions-table", () => ({
  SyncedSessionsTable: () => <div data-testid="synced-sessions-table" />,
}));

function setInsights(state: {
  delivery?: ReturnType<typeof succeeded>;
  utilization?: ReturnType<typeof succeeded>;
  agents?: ReturnType<typeof succeeded>;
}) {
  hooks.useDeliveryInsights.mockReturnValue(
    state.delivery ?? succeeded(webDelivery)
  );
  hooks.useUtilizationInsights.mockReturnValue(
    state.utilization ?? succeeded(webUtilization)
  );
  hooks.useAgentsInsights.mockReturnValue(state.agents ?? succeeded(webAgents));
}

const renderDashboard = (queryClient?: QueryClient) =>
  render(
    withDashboardQueryClient(
      <InsightsDataSourceProvider value={createInsightsDataSource()}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <InsightsOverviewDashboard
            emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
            getSessionHref={() => "/x"}
          />
        </FeatureFlagAdapterProvider>
      </InsightsDataSourceProvider>,
      queryClient
    )
  );

// The key a section's query actually registered under, rebuilt from the real
// `insightsKeys` (kept through the mock by `importOriginal`) and the arguments
// the component drove the hooks with — never re-typed here, or the assertion
// would agree with a production key that had drifted.
const sectionKey = (section: InsightsSection) =>
  insightsKeys.section(
    section,
    hooks.useDeliveryInsights.mock.calls.at(-1)?.[0],
    hooks.useDeliveryInsights.mock.calls.at(-1)?.[1],
    hooks.useDeliveryInsights.mock.calls.at(-1)?.[2]
  );
const agentsSectionKey = () => sectionKey(InsightsSection.Agents);

/**
 * The AI Impact slot, reached the way the shell renders it: the element
 * immediately after the stats row, which is the whole of
 * `{row.tour === Stats ? <div className="mt-5">…</div> : null}`. Walking the DOM
 * rather than matching its copy is what lets one locator address the card, the
 * placeholder and the tour anchor — three different renders of the same slot.
 */
const impactSlot = (container: HTMLElement) =>
  container.querySelector(`[data-tour="${DashboardTourAnchor.Stats}"]`)
    ?.nextElementSibling ?? null;

describe("InsightsOverviewDashboard section degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  /**
   * ISS-10486 — the headline defect, and the assertion that fails on the shipped
   * code. `analyticsError` was "ANY section errored" and it drove a whole-page
   * `DegradedState`, so one failed read replaced a body that still had two
   * sections' worth of data with a single page-level error.
   *
   * Both halves are asserted together on purpose. A case that only checked for
   * the surviving rows would pass over a page that had also lost its way to
   * recover the failed section, and a case that only checked for the degraded
   * row would pass over the whole-page blanking this exists to remove — the
   * degraded copy renders in both worlds, so `row-prs` being on screen beside it
   * is what tells them apart.
   *
   * `prs` reads Delivery and `models` reads Agents (`ROW_SECTIONS`), which is
   * why those two rows are the ones named here.
   */
  it("keeps every other section rendered when one insights section errors", () => {
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    // The sections that answered are still on screen, with their own data.
    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
    // The section that failed is not, and neither is a skeleton that can never
    // resolve: `sectionLoading` is `!isSuccess`, so a loading-first slot would
    // have drawn one here for the life of the window.
    expect(screen.queryByTestId("row-models")).not.toBeInTheDocument();
    // ...and the failed rows say so, with a recovery scoped to themselves.
    expect(screen.getAllByText(ROW_DEGRADED_RE).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: RETRY_RE }).length
    ).toBeGreaterThan(0);
  });

  it("replaces the whole body only once every insights section has failed", () => {
    // The one case the page-level degraded state honestly describes: nothing at
    // all to draw. The converse of the case above, so a fix that simply deleted
    // the page-level branch fails here.
    setInsights({
      agents: errored(),
      delivery: errored(),
      utilization: errored(),
    });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.getByText(DEGRADED_RE)).toBeInTheDocument();
    expect(screen.queryByTestId("row-stats")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-prs")).not.toBeInTheDocument();
  });

  it("keeps the rows standing when TWO of the three sections fail", () => {
    // ISS-10486 review (review-soul): `analyticsAllFailed` is a three-way AND,
    // and every other case here fails exactly one section or all three — so
    // dropping any single term from that chain survived the whole suite. Two
    // failed, one healthy is the shape that kills it.
    setInsights({ delivery: errored(), utilization: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.queryByText(DEGRADED_RE)).not.toBeInTheDocument();
    expect(screen.getByTestId("row-models")).toBeInTheDocument();
  });

  it("withholds the tour anchor from a degraded row, and keeps it on a healthy one", () => {
    // ISS-10486 review: the tour measures anchors, so an anchor left on an error
    // card rings a beat about data that is not there — and the host stamps that
    // run finished, permanently. `prs` reads Delivery (healthy) and `models`
    // reads Agents (failed), so both directions are pinned here.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Prs}"]`)
    ).not.toBeNull();
    expect(
      document.querySelector(`[data-tour="${DashboardTourAnchor.Models}"]`)
    ).toBeNull();
  });

  it("keeps the stats anchor on an Agents failure and withholds it on a Utilization one", () => {
    // The unit-level pin for what made the `e2e` red deterministic (ISS-10486
    // review). `ROW_SECTIONS.stats` is [Delivery, Utilization], and the guided
    // tour's FIRST beat — "Start with the headline metrics" — is addressed by
    // this anchor. So a Utilization failure degrades the row carrying it,
    // `resolveDashboardTourSteps` drops that step, and a spec waiting on that
    // callout waits out its timeout on a tour that DID open. Agents leaves
    // stats Ready and degrades the rows below it instead.
    //
    // Both directions in one case on purpose: an assertion that the anchor
    // survives an Agents failure is green on a page that never withholds it.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));
    const agentsFailed = renderDashboard();

    expect(
      agentsFailed.container.querySelector(
        `[data-tour="${DashboardTourAnchor.Stats}"]`
      )
    ).not.toBeNull();
    agentsFailed.unmount();

    vi.clearAllMocks();
    setInsights({ utilization: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));
    const utilizationFailed = renderDashboard();

    expect(
      utilizationFailed.container.querySelector(
        `[data-tour="${DashboardTourAnchor.Stats}"]`
      )
    ).toBeNull();
  });

  it("drops a data-conditional row whose section failed rather than claiming it broke", () => {
    // ISS-10486 review: the cloud route never serves `autonomyTrend`, so that row
    // does not exist on web. `isRowLoading` reads a failed section as pending, so
    // without the failure term the row survived the visibility filter and drew
    // "Autonomy Over Time is temporarily unavailable" — a section this surface
    // was never going to show.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.queryByText(AUTONOMY_DEGRADED_RE)).not.toBeInTheDocument();
    // ...while a row that always renders still degrades and still offers Retry.
    expect(screen.getAllByText(ROW_DEGRADED_RE).length).toBeGreaterThan(0);
  });

  it("keeps the AI Impact card when a section it never reads fails", () => {
    // ISS-10486 review (two reviewers): the card borrowed the stats row's
    // verdict, and `ROW_SECTIONS.stats` is [Delivery, Utilization] while
    // `deriveAiImpact` reads [Delivery, Agents]. A Utilization-only failure hid a
    // card every operand of which had arrived.
    setInsights({ utilization: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.getByText(AI_IMPACT_RE)).toBeInTheDocument();
  });

  it("keeps the AI Impact card when a section it DOES read fails", () => {
    // The operator's ruling, 2026-09-19. Two of this card's four metrics divide
    // Delivery by Delivery, so an Agents failure leaves every one of THEIR
    // operands present — withholding the card deletes two computable
    // capabilities, and it is a regression besides: at merge-base the gate was
    // loading-only over [Delivery, Utilization], so this card rendered through
    // an Agents failure on `main`. Which tiles degrade, and what their captions
    // may claim, is `ai-impact-slot.test.tsx`; this is the shell wiring.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    expect(screen.getByText(AI_IMPACT_RE)).toBeInTheDocument();
  });

  it("withholds the tour anchor over a card the failure emptied tiles of", () => {
    // `resolveDashboardTourSteps` MEASURES anchors and the host then stamps the
    // run finished, permanently — the same reason a degraded ROW drops its
    // anchor above. The card renders; the beat about how cost translates into
    // shipped value does not ring over two `—`s.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    const { container } = renderDashboard();

    expect(impactSlot(container)).toBeInTheDocument();
    expect(
      container.querySelector(`[data-tour="${DashboardTourAnchor.Impact}"]`)
    ).toBeNull();
  });

  it("draws the AI Impact placeholder while a section it reads is in flight", () => {
    // LOADING IS NOT FAILED. The `Ready`-only gate drew nothing at all here, so
    // a dashboard whose other rows had settled had a hole where this card sits
    // and in-flight read exactly like arrived-without-this. The stats row is
    // [Delivery, Utilization] and both are settled, so this placeholder is the
    // card's own verdict over [Delivery, Agents] and not the row's.
    setInsights({ agents: pending() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    const { container } = renderDashboard();

    expect(screen.queryByText(AI_IMPACT_RE)).not.toBeInTheDocument();
    expect(
      impactSlot(container)?.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument();
  });

  it("reports the retry in flight on the control that started it", () => {
    // An errored query keeps `status: "error"` while it refetches and flips only
    // `fetchStatus`, so the degraded card is byte-identical during the refetch —
    // the press produced no visible change at all.
    setInsights({ agents: { ...errored(), isFetching: true } });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    const retry = screen.getAllByRole("button", { name: RETRYING_RE })[0];
    expect(retry).toBeInTheDocument();
    expect(retry).toBeDisabled();
  });

  it("does not claim an empty dashboard while one section is still in flight", () => {
    // ISS-10408's first guard, carried over. A fan-out that has produced no rows
    // yet has not established that there are none: "No agent sessions yet" here
    // would be a zero nobody measured, and it would replace rows that are about
    // to arrive.
    setInsights({ agents: pending() });
    hooks.useAgentSessions.mockReturnValue(sessions(0));

    renderDashboard();

    expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.getByTestId("row-stats")).toBeInTheDocument();
  });

  it("does not call a partially failed dashboard empty on a settled zero count", () => {
    // ISS-10408's second guard. Every other term of `empty` is satisfied here —
    // the session read answered, and answered zero — so without the
    // all-succeeded term the empty state would replace the body, taking the
    // degraded row's Retry with it and leaving the reader nothing to press.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(0));

    renderDashboard();

    expect(screen.queryByText(NO_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.getByTestId("row-prs")).toBeInTheDocument();
    expect(screen.getAllByText(ROW_DEGRADED_RE).length).toBeGreaterThan(0);
  });

  it("recovers the failed section from its own row, without a page reload", () => {
    // AC2's recovery half: the press has to reach the insights queries, not just
    // render a button.
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard(queryClient);
    fireEvent.click(screen.getAllByRole("button", { name: RETRY_RE })[0]);

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentsSectionKey(),
    });
  });

  it("leaves the healthy sections alone when one row is retried", () => {
    // The ISS-10486 review's P1, and the half a "the failed section recovered"
    // assertion cannot see: the global `insightsKeys.all` invalidation this
    // replaced ALSO satisfied the case above, because the prefix matches the
    // failed section too. What separates them is the sections nobody asked to
    // recover — Delivery and Utilization are on screen with data, and throwing
    // them away can turn a dashboard with two good sections into one with none.
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard(queryClient);
    fireEvent.click(screen.getAllByRole("button", { name: RETRY_RE })[0]);

    const invalidated = invalidateQueries.mock.calls.map(
      (call) => call[0]?.queryKey
    );
    expect(invalidated).not.toContainEqual(insightsKeys.all);
    expect(invalidated).not.toContainEqual(
      sectionKey(InsightsSection.Delivery)
    );
    expect(invalidated).not.toContainEqual(
      sectionKey(InsightsSection.Utilization)
    );
  });

  it("gives every degraded row's Retry an accessible name of its own", () => {
    // ISS-10486 review. A bare "Retry" on each degraded row is one accessible
    // name repeated: a screen reader user tabbing the page hears "Retry, Retry,
    // Retry" with nothing to tell them apart, and any name-addressed locator
    // matches all of them. Agents degrades five rows at once, which is the
    // worst case this page can reach.
    //
    // THE ASSERTION IS DISTINCTNESS, not "a control named Retry exists" — that
    // one is green with every name identical, which is the defect itself. Each
    // name is held against the row's own canonical label rather than re-typed,
    // so a relabelled row moves both together.
    setInsights({ agents: errored() });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    const names = screen
      .getAllByRole("button", { name: RETRY_IDLE_RE })
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(
      retryNameFor(DASHBOARD_ROW_LABELS[DashboardRowTour.Models])
    );
  });

  it("reports only the retried row as retrying, not every degraded row", () => {
    // The busy flag's half of the same P1. Delivery and Agents both failed, so
    // two rows are degraded; a refetch of Agents alone must leave the Delivery
    // row's control pressable. Read off all three queries — which is what the
    // page-level error card could afford — this said "Retrying…" on a row whose
    // section nobody had touched, and disabled the only way to recover it.
    setInsights({
      agents: { ...errored(), isFetching: true },
      delivery: errored(),
    });
    hooks.useAgentSessions.mockReturnValue(sessions(5));

    renderDashboard();

    // `RETRY_RE` is a substring match and "Retrying…" contains "Retry", so the
    // two states are addressed by anchored patterns here — otherwise a count of
    // "Retry" buttons would include the busy ones and pass either way.
    const idle = screen.getAllByRole("button", { name: RETRY_IDLE_RE });
    const busy = screen.getAllByRole("button", { name: RETRY_BUSY_RE });
    expect(busy.length).toBeGreaterThan(0);
    expect(idle.length).toBeGreaterThan(0);
    for (const button of idle) {
      expect(button).toBeEnabled();
    }
  });
});

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
