/**
 * ISS-9969 / ISS-9971, unconditional since ISS-10636 — the Sessions Cost card:
 * one basis (the subscription-inclusive total), one tooltip, and the same figure
 * the Dashboard KPI renders on the same fixture.
 *
 * NOT one phrase, since the operator ruling of 2026-09-20: this card's own label
 * is ruling 7's alias "Cost", because the canonical phrase plus its info trigger
 * does not fit one line at the strip's card widths. What the two surfaces still
 * share — and what the cross-surface case below pins — is the FIGURE and the
 * tooltip. The alias never travels alone: opening the card's own info control
 * states the canonical what/how, which is asserted here on both surfaces.
 *
 * ISS-10636 AC-5: every case here mounts with NO flag seeded, because that is
 * the state every real user is in. The suite used to seed
 * `total-estimated-cost-metrics` to reach this surface, which proved only that
 * the gate-ON path worked while the whole population sat on the closed default —
 * and on desktop, where a signed-out account resolves every PostHog key `false`
 * by construction, no configuration could have opened it.
 *
 * The Sessions cases mount with no provider AT ALL; the Dashboard row needs one
 * and gets an EMPTY one. Between them a reintroduced gate cannot pass: it would
 * resolve closed in both.
 */
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import {
  TOTAL_ESTIMATED_COST_ALIAS_LABEL,
  TOTAL_ESTIMATED_COST_COPY,
} from "@repo/api/src/types/total-estimated-cost-copy";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import {
  makeDeliveryResponse,
  makeTimeSeries,
} from "@repo/app/insights/components/insights-section-fixtures";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import {
  DASHBOARD_ROWS,
  DashboardRowTour,
} from "@repo/app/insights/components/overview/dashboard-tiles";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

const IF_BILLED_TO_API_PATTERN = /\+\$\d[\d,]* if billed to API/;
const DOLLAR_FIGURE_PATTERN = /\$[\d,.]+/;

/** Reconciles (2030 + 42 + 16,783 = 18,855), so breakdown is granted. */
function splitUsageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 18_855,
      subscriptionEstimatedCost: 2030,
      apiEstimatedCost: 16_825,
      meteredEstimatedCost: 42,
      unknownEstimatedCost: 16_783,
      ...overrides,
    }
  );
}

/** A producer that cannot stand behind a partition: a negative lane. */
function unsplittableUsageFixture(): AgentSessionUsageSummary {
  return splitUsageFixture({ subscriptionEstimatedCost: -1 });
}

/** An adapter with NOTHING enabled — the state every real account resolves to. */
function withNoFlagsSeeded(children: ReactNode) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/** No provider at all, which is stronger than an empty one. */
function renderSessionsStrip(usage: AgentSessionUsageSummary) {
  return render(<SessionsSummaryCards isLoading={false} usage={usage} />);
}

function renderDashboardStatsRow(costValue: number) {
  const statsRow = DASHBOARD_ROWS.find(
    (row) => row.tour === DashboardRowTour.Stats
  );
  if (!statsRow) {
    throw new Error("stats row fixture is missing");
  }
  const delivery = makeDeliveryResponse(makeTimeSeries([]));
  return render(
    withNoFlagsSeeded(
      <DashboardRowContent
        autonomySeries={undefined}
        gates={{ agentCollaborationNetwork: true }}
        githubConnect={{
          action: GitHubConnectAction.Connect,
          onConnect: vi.fn(),
        }}
        heatmap={undefined}
        modelSeries={undefined}
        row={statsRow}
        sections={{
          [InsightsSection.Delivery]: {
            ...delivery,
            kpis: [
              ...delivery.kpis,
              {
                key: InsightsKpiKey.Cost,
                label: "Cost",
                value: costValue,
                format: KpiFormat.Currency,
                sub: "subscription-inclusive",
                deltaPct: null,
              },
            ],
          },
        }}
      />
    )
  );
}

/** The dollar figure a card headlines, read off the card carrying `label`. */
function headlineFigure(label: string): string {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!card) {
    throw new Error(`card for ${label} is missing`);
  }
  const match = card.textContent?.match(DOLLAR_FIGURE_PATTERN);
  if (!match) {
    throw new Error(`card for ${label} renders no dollar figure`);
  }
  return match[0];
}

describe("the Sessions Cost card, with no flag seeded (ISS-10636 AC-5)", () => {
  it("headlines the subscription-inclusive total under the card's alias when the partition reconciles", () => {
    renderSessionsStrip(splitUsageFixture());

    expect(
      screen.getByText(TOTAL_ESTIMATED_COST_ALIAS_LABEL)
    ).toBeInTheDocument();
    // The canonical phrase is NOT what this card's face says. Asserted as an
    // absence so a revert to it fails here rather than passing quietly on a
    // strip whose whole rank then grows a blank label line.
    expect(screen.queryByText(TOTAL_ESTIMATED_COST_COPY.label)).toBeNull();
    expect(headlineFigure(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBe("$18,855");
  });

  // The arm the retired gate used to govern, and the one ISS-10597's ruling is
  // really about: a producer that cannot substantiate a partition still headlines
  // the TOTAL. `apiEstimatedCost` ($16,825) backs no headline anywhere now, so a
  // card that fell back to it would render a figure excluding subscription spend
  // under a phrase promising "every billing type included".
  it("keeps the total and the label when the producer cannot split", () => {
    renderSessionsStrip(unsplittableUsageFixture());

    expect(headlineFigure(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).toBe("$18,855");
    expect(headlineFigure(TOTAL_ESTIMATED_COST_ALIAS_LABEL)).not.toBe(
      "$16,825"
    );
    // That caption named the share sitting OUTSIDE an `apiEstimatedCost`
    // headline; under a total headline it would double-state money the figure
    // already holds.
    expect(screen.queryByText(IF_BILLED_TO_API_PATTERN)).toBeNull();
  });

  it("explains the figure from the one canonical map", async () => {
    const user = userEvent.setup();
    renderSessionsStrip(splitUsageFixture());

    await user.click(
      screen.getByRole("button", {
        name: `About ${TOTAL_ESTIMATED_COST_ALIAS_LABEL}`,
      })
    );
    const dialog = await screen.findByRole("dialog", {
      name: `About ${TOTAL_ESTIMATED_COST_ALIAS_LABEL}`,
    });
    // The alias is on the card's FACE only. What it opens is the canonical
    // explanation, unchanged — which is the condition ruling 7 attaches to the
    // short form.
    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);
    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.how);
  });
});

describe("Dashboard and Sessions on one fixture, with no flag seeded", () => {
  it("render the same dollar figure and tooltip, each under its own label", async () => {
    const user = userEvent.setup();
    const usage = splitUsageFixture();
    const sessions = renderSessionsStrip(usage);
    // The Sessions card is read by its ALIAS and the Dashboard tile by the
    // canonical phrase — the two labels diverged with the 2026-09-20 ruling, and
    // reading each surface by the label it actually renders is what keeps this
    // case about the FIGURE.
    const sessionsFigure = headlineFigure(TOTAL_ESTIMATED_COST_ALIAS_LABEL);
    sessions.unmount();

    renderDashboardStatsRow(usage.totalEstimatedCost);
    expect(headlineFigure(TOTAL_ESTIMATED_COST_COPY.label)).toBe(
      sessionsFigure
    );
    // The producer's own "Cost" label and `sub` are not what this tile renders.
    expect(screen.queryByText("Cost")).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
      })
    );
    const dialog = await screen.findByRole("dialog", {
      name: `About ${TOTAL_ESTIMATED_COST_COPY.label}`,
    });
    expect(dialog).toHaveTextContent(TOTAL_ESTIMATED_COST_COPY.info.what);
    expect(dialog).not.toHaveTextContent("subscription-inclusive");
  });
});
