import type { KpiStat } from "@repo/api/src/types/insights";
import {
  InsightsSection,
  KpiDeltaBasis,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KPI_NOT_COMPUTED_REASON } from "../../../lib/kpi-no-comparison-copy";
import {
  makeDeliveryResponse,
  makeTimeSeries,
} from "../../insights-section-fixtures";
import { NO_COMPARISON_LABEL } from "../../kpi-delta-placeholder";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";

/**
 * ISS-4995 — a KPI whose producer computes no comparison must not inherit the
 * range-based "No comparison" sentence, which points the reader at the range
 * control and at how much history their org has. Sibling of `dashboard-rows.tsx`
 * rather than another cluster inside the 800-line `dashboard-rows.test.tsx`.
 *
 * The Cost card gets its own cases because it renders through `CostMetricCard`,
 * a different component from its four rowmates' `MetricCard` — the surface where
 * a reason threaded through only one branch would silently go missing.
 */

const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");

function kpiStat(overrides: Partial<KpiStat> & Pick<KpiStat, "key">): KpiStat {
  return {
    label: "KLOC merged",
    value: 863.5,
    format: KpiFormat.Number,
    sub: "thousand lines landed",
    deltaPct: null,
    ...overrides,
  };
}

function sectionsWith(kpis: KpiStat[]): InsightsSectionData {
  const delivery = makeDeliveryResponse(makeTimeSeries([["2026-08-03", 4]]));
  return {
    [InsightsSection.Delivery]: { ...delivery, kpis },
  };
}

function renderStatsRow(kpis: KpiStat[]) {
  if (!statsRow) {
    throw new Error("stats row fixture is missing");
  }
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        gates={{ agentCollaborationNetwork: true }}
        getTileAvailability={undefined}
        heatmap={undefined}
        modelSeries={undefined}
        row={statsRow}
        sections={sectionsWith(kpis)}
      />
    </FeatureFlagAdapterProvider>
  );
}

function placeholderFor(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!card) {
    throw new Error(`no card rendered for ${label}`);
  }
  const placeholder = card.querySelector<HTMLElement>(
    '[data-testid="kpi-delta-placeholder"]'
  );
  if (!placeholder) {
    throw new Error(`no delta placeholder rendered for ${label}`);
  }
  return placeholder;
}

describe("Dashboard KPI row no-comparison reason (ISS-4995)", () => {
  it("names our own gap for a metric the producer never compares", () => {
    renderStatsRow([
      kpiStat({ key: "kloc", deltaBasis: KpiDeltaBasis.NotComputed }),
    ]);

    const placeholder = placeholderFor("KLOC merged");
    expect(placeholder).toHaveTextContent(KPI_NOT_COMPUTED_REASON);
    expect(placeholder).not.toHaveTextContent(NO_COMPARISON_LABEL);
  });

  it("keeps the range copy for a compared metric with no prior period", () => {
    renderStatsRow([
      kpiStat({
        key: "merged",
        label: "Merged PRs",
        value: 422,
        deltaBasis: KpiDeltaBasis.Computed,
      }),
    ]);

    const placeholder = placeholderFor("Merged PRs");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("falls back to the range copy for a producer that sends no basis", () => {
    // Version skew: a peer built before ISS-4995 omits the field entirely, and
    // cannot tell us which of the two cases it is.
    renderStatsRow([kpiStat({ key: "kloc" })]);

    const placeholder = placeholderFor("KLOC merged");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("threads the reason through the Cost card's own delta slot", () => {
    renderStatsRow([
      kpiStat({
        key: "cost",
        label: "Cost",
        value: 22_989.88,
        format: KpiFormat.Currency,
        sub: "estimated cost in range",
        deltaBasis: KpiDeltaBasis.NotComputed,
      }),
    ]);

    expect(placeholderFor("Cost")).toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("keeps the range copy on the Cost card for a compared metric", () => {
    renderStatsRow([
      kpiStat({
        key: "cost",
        label: "Cost",
        value: 22_989.88,
        format: KpiFormat.Currency,
        sub: "estimated cost in range",
        deltaBasis: KpiDeltaBasis.Computed,
      }),
    ]);

    const placeholder = placeholderFor("Cost");
    expect(placeholder).toHaveTextContent(NO_COMPARISON_LABEL);
    expect(placeholder).not.toHaveTextContent(KPI_NOT_COMPUTED_REASON);
  });

  it("renders no placeholder at all once a compared metric has a delta", () => {
    renderStatsRow([
      kpiStat({
        key: "merged",
        label: "Merged PRs",
        value: 422,
        deltaPct: -29,
        deltaBasis: KpiDeltaBasis.Computed,
      }),
    ]);

    const card = screen.getByText("Merged PRs").closest('[data-slot="card"]');
    expect(
      card?.querySelector('[data-testid="kpi-delta-placeholder"]')
    ).toBeNull();
    expect(card).toHaveTextContent("29%");
  });
});
