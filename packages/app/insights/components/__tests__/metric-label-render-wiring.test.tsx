/**
 * ISS-10667 render-wiring proof for the Insights surfaces.
 *
 * A reviewer found the ISS-10667 suite was a false green: every component that
 * grew a `useFeatureFlagEnabledOptional(ONE_LABEL_PER_METRIC_FLAG_KEY)` read
 * could have that read deleted with the whole suite staying green, because
 * nothing rendered the REAL component through the REAL flag adapter and
 * asserted both arms. This file does that for each Insights site: the flag is
 * driven through `AppCoreStoryProviders`' `FeatureFlagAdapterProvider` (the
 * same port the production hook reads), and each gated case asserts the gate-ON
 * canonical label AND the gate-OFF legacy label, scoped to the one card/toggle
 * the label lives on — so deleting the flag read fails the ON case rather than
 * leaving a phrase floating anywhere on screen to satisfy a loose query.
 *
 * The two cost surfaces below are NO LONGER gated: ISS-10636 retired the basis
 * gate and the canonical dollar phrase is now what every reader gets, so their
 * cases pin the label with no flag enabled. `UsageGraphControls` is still gated
 * and keeps both arms.
 */
import type { KpiStat } from "@repo/api/src/types/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { TOTAL_TOKENS_LABEL } from "@repo/api/src/types/total-tokens-copy";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { INSIGHTS_COST_KPI_TILE_ID } from "../../lib/tile-catalog";
import { KpiMetricTile } from "../kpi-stat-tile";
import { OverviewCostKpiCard } from "../overview/overview-cost-kpi-card";
import {
  UsageGraphControls,
  UsageGrouping,
  UsageMetric,
} from "../overview/usage-graph-toggles";

/** The legacy words `ONE_LABEL_PER_METRIC_FLAG_KEY` retires on this surface. */
const LEGACY_COST_TOGGLE_LABEL = "Cost";
const LEGACY_TOKENS_TOGGLE_LABEL = "Tokens";
const ABOUT_BUTTON_NAME_RE = /^About /i;

function renderControls(enabledFlags?: readonly string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <UsageGraphControls
        grouping={UsageGrouping.Model}
        metric={UsageMetric.Cost}
        onGroupingChange={vi.fn()}
        onMetricChange={vi.fn()}
      />
    </AppCoreStoryProviders>
  );
}

describe("UsageGraphControls metric toggle labels (ISS-10667)", () => {
  it("names the toggles with the canonical vocabulary when the gate is on", () => {
    renderControls([ONE_LABEL_PER_METRIC_FLAG_KEY]);

    expect(
      screen.getByRole("radio", { name: TOTAL_ESTIMATED_COST_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: TOTAL_TOKENS_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: LEGACY_COST_TOGGLE_LABEL })
    ).not.toBeInTheDocument();
  });

  it("keeps the legacy toggle words when the gate is off", () => {
    renderControls();

    expect(
      screen.getByRole("radio", { name: LEGACY_COST_TOGGLE_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: LEGACY_TOKENS_TOGGLE_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: TOTAL_ESTIMATED_COST_LABEL })
    ).not.toBeInTheDocument();
  });
});

function costKpiCard(): HTMLElement {
  const card = screen
    .getByRole("button", { name: ABOUT_BUTTON_NAME_RE })
    .closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("cost KPI card is missing");
  }
  return card;
}

function renderCostKpiCard(
  enabledFlags: readonly string[] | undefined,
  kpi: KpiStat | undefined
) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <OverviewCostKpiCard
        deltaCapped={false}
        deltaLabel="vs. prior period"
        hasDelta={false}
        hidden={false}
        kpi={kpi}
        sparkline={undefined}
      />
    </AppCoreStoryProviders>
  );
}

const PRODUCER_COST_LABEL = "Total spend";

/** A settled cost KPI carrying the producer's own wording, so the gate-off arm has something distinct to render. */
function costKpi(): KpiStat {
  return {
    deltaPct: null,
    format: KpiFormat.Currency,
    key: "cost",
    label: PRODUCER_COST_LABEL,
    sub: "producer sub copy",
    value: 100,
  };
}

describe("OverviewCostKpiCard label (ISS-10636)", () => {
  it("renders the canonical label with no flag enabled", () => {
    renderCostKpiCard(undefined, costKpi());

    expect(
      within(costKpiCard()).getByText(TOTAL_ESTIMATED_COST_LABEL)
    ).toBeInTheDocument();
    expect(
      within(costKpiCard()).queryByText(PRODUCER_COST_LABEL)
    ).not.toBeInTheDocument();
  });
});

function renderCostTile(
  enabledFlags: readonly string[] | undefined,
  kpi: KpiStat
) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <KpiMetricTile
        kpi={kpi}
        pinned={false}
        polarity={MetricPolarity.LowerIsBetter}
        tileId={INSIGHTS_COST_KPI_TILE_ID}
        title="Cost"
      />
    </AppCoreStoryProviders>
  );
}

describe("KpiMetricTile cost tile label (ISS-10636)", () => {
  it("renders the canonical label with no flag enabled", () => {
    renderCostTile(undefined, costKpi());

    expect(screen.getByText(TOTAL_ESTIMATED_COST_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(PRODUCER_COST_LABEL)).not.toBeInTheDocument();
  });
});
