import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import { BranchKpiState } from "@repo/api/src/types/branch";
import type { KpiStat } from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import {
  COST_METRIC_CARD_LABEL,
  DASHBOARD_COST_METRIC_CARD_INFO,
  SESSIONS_COST_METRIC_CARD_INFO,
} from "@repo/app/agents/components/sessions/cost-metric-card";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import goldenAggregates from "../../../__tests__/fixtures/golden-render-aggregates.json";
import { formatKpiTileValue } from "../../../lib/format";
import {
  getMetricValueRow,
  tabTo,
} from "../../__tests__/metric-card-test-utils";
import { NO_COMPARISON_CHIP_LABEL } from "../../kpi-delta-placeholder";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";

const PERCENT_REGEX = /[+-]?\d+%/;
// The two Sessions-specific phrases that must never reach the Dashboard tooltip:
// this surface has no session filter and renders no caption beneath the number
// (wongk review on #4905). Matched as patterns as well as by whole string so a
// reworded Sessions copy that keeps either idea still fails here.
const SESSIONS_FILTERED_COPY_PATTERN = /filtered sessions/i;
const SESSIONS_CAPTION_GLOSS_PATTERN = /caption beneath/i;
// Whole strings AND the two ideas, so a reworded Sessions copy that keeps either
// still fails rather than sliding onto the Dashboard unnoticed.
const SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD = [
  SESSIONS_COST_METRIC_CARD_INFO.what,
  SESSIONS_COST_METRIC_CARD_INFO.how,
  SESSIONS_FILTERED_COPY_PATTERN,
  SESSIONS_CAPTION_GLOSS_PATTERN,
];
const emptySeries = { series: [], points: [] };
const statsRow = DASHBOARD_ROWS.find((row) => row.tour === "stats");
const prsRow = DASHBOARD_ROWS.find((row) => row.tour === "prs");
const distributionRow = DASHBOARD_ROWS.find(
  (row) => row.tour === "distribution"
);
const medianPrSizeValuePattern = /^128\s*lines$/;
const klocMergedValuePattern = /^4.2\s*KLOC$/;
const missingPrSizeValuePattern = /^—$/;
const emptyDashCostValuePattern = /^—$/;
const dollarSignPattern = /\$/;

describe("DashboardRowContent", () => {
  it("uses source-owned KPI labels in the stats row", () => {
    renderStatsRow();

    expect(screen.getByText("Captured PRs")).toBeInTheDocument();
  });

  it("renders KPI unit labels in their scoped value rows", () => {
    renderStatsRow();

    expect(getMetricValueRow("Median PR size")).toHaveTextContent(
      medianPrSizeValuePattern
    );
    expect(
      within(getMetricValueRow("Median PR size")).getByText("lines")
    ).toBeInTheDocument();
    expect(getMetricValueRow("KLOC merged")).toHaveTextContent(
      klocMergedValuePattern
    );
    expect(
      within(getMetricValueRow("KLOC merged")).getByText("KLOC")
    ).toBeInTheDocument();
  });

  it("moves KPI descriptions behind accessible info controls", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    expect(
      screen.queryByText("PRs found in local sessions")
    ).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "About Captured PRs" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const contentId = trigger.getAttribute("aria-controls");
    const dialog = await screen.findByRole("dialog", {
      name: "About Captured PRs",
    });
    expect(contentId).toBeTruthy();
    expect(dialog).toHaveAttribute("id", contentId);
    expect(dialog).toHaveTextContent("PRs found in local sessions");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Captured PRs" })
    ).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About Captured PRs" })
    ).toHaveTextContent("PRs found in local sessions");

    await user.keyboard("{Escape}");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "About Captured PRs" })
    ).not.toBeInTheDocument();
  });

  it("opens KPI descriptions on hover and closes them on outside interaction", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    const trigger = screen.getByRole("button", {
      name: "About Median PR size",
    });

    await user.hover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toHaveTextContent("Median changed lines per merged PR");

    await user.unhover(trigger);

    expect(
      screen.queryByRole("dialog", { name: "About Median PR size" })
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toBeInTheDocument();

    await user.unhover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Median PR size" })
    ).toBeInTheDocument();

    await user.click(document.body);

    expect(
      screen.queryByRole("dialog", { name: "About Median PR size" })
    ).not.toBeInTheDocument();
  });

  it("keeps focus-opened KPI descriptions available through pointer movement", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    // FEA-3818: the Cost card (shared CostMetricCard) always renders its info
    // control, so it is the first tabbable KPI info button in the stats row.
    // ISS-4995 put the "No comparison" delta chip in the tab order too, so it is
    // no longer the first stop overall — walk to it rather than pinning a count.
    const trigger = screen.getByRole("button", { name: "About Cost" });

    await tabTo(user, trigger);

    expect(trigger).toHaveFocus();
    // FEA-3818: on the Dashboard the Cost card is fed the same single-line
    // `kpi.sub` info as its rowmates (one voice per screen), so the popover
    // reads the backend `sub` string, not a card-local subscription note.
    expect(
      await screen.findByRole("dialog", { name: "About Cost" })
    ).toHaveTextContent("estimated cost in range");

    await user.hover(trigger);
    await user.unhover(trigger);

    expect(
      await screen.findByRole("dialog", { name: "About Cost" })
    ).toBeInTheDocument();

    await user.tab();

    expect(
      screen.queryByRole("dialog", { name: "About Cost" })
    ).not.toBeInTheDocument();
  });

  it("opens KPI descriptions from a touch pointer", async () => {
    renderStatsRow();

    const trigger = screen.getByRole("button", { name: "About KLOC merged" });

    // A real tap fires pointerdown then a click; together they open it once.
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("dialog", { name: "About KLOC merged" })
    ).toHaveTextContent("Thousands of lines merged");
  });

  // The reachable gap (wongk review on #4905): `OverviewCostKpiCard` passes
  // `info={undefined}` when the Cost KPI or its `sub` is falsy, and
  // `CostMetricCard`'s `info` DEFAULT is the Sessions copy. Sessions itself
  // always passes `info` explicitly (from `resolveCostCardPresentation`), so
  // this is the ONLY production path that reaches that default.
  //
  // Both branches are driven, and both are type-legal: `sub` is a required
  // `string` on the wire contract, so the reachable falsy case is a BLANK one
  // from a version-skewed or incomplete producer, not `undefined`. The KPI going
  // missing entirely is the other.
  it("falls back to Dashboard Cost copy when the backend sends a blank `sub`", async () => {
    const dialog = await openDashboardCostInfoDialog((kpis) =>
      kpis.map((kpi) => (kpi.key === "cost" ? { ...kpi, sub: "" } : kpi))
    );

    // The Dashboard's own basis: the subscription-INCLUSIVE aggregate.
    expect(dialog).toHaveTextContent(DASHBOARD_COST_METRIC_CARD_INFO.what);
    for (const sessionsCopy of SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD) {
      expect(dialog).not.toHaveTextContent(sessionsCopy);
    }
  });

  it("falls back to Dashboard Cost copy when the Cost KPI is missing entirely", async () => {
    const dialog = await openDashboardCostInfoDialog((kpis) =>
      kpis.filter((kpi) => kpi.key !== "cost")
    );

    expect(dialog).toHaveTextContent(DASHBOARD_COST_METRIC_CARD_INFO.what);
    for (const sessionsCopy of SESSIONS_COPY_FORBIDDEN_ON_DASHBOARD) {
      expect(dialog).not.toHaveTextContent(sessionsCopy);
    }
  });

  it("omits KPI unit labels when the metric is missing", () => {
    const delivery = sections[InsightsSection.Delivery];
    if (!delivery) {
      throw new Error("delivery section fixture is missing");
    }

    renderStatsRow({
      sections: {
        ...sections,
        [InsightsSection.Delivery]: {
          ...delivery,
          kpis: delivery.kpis.filter((kpi) => kpi.key !== "pr-size"),
        },
      },
    });

    const valueRow = getMetricValueRow("Median PR size");
    expect(valueRow).toHaveTextContent(missingPrSizeValuePattern);
    expect(within(valueRow).queryByText("lines")).not.toBeInTheDocument();
  });

  it("renders availability overrides for gated stats-row tiles", () => {
    renderStatsRow({
      getTileAvailability: (tile) => ({
        state:
          tile.id === "kpi:merged"
            ? BranchKpiState.Gated
            : BranchKpiState.Available,
      }),
    });

    expect(
      screen.getByText("Connect GitHub to light up this metric.")
    ).toBeInTheDocument();
  });

  it("uses the narrow-safe five-card grid for stats row KPI cards", () => {
    const { container } = renderStatsRow();
    const grid = container.firstElementChild;

    expect(grid).toHaveClass("grid-cols-1", "lg:grid-cols-3", "xl:grid-cols-5");
    expect(grid).not.toHaveClass("grid-cols-2");
    expect(grid?.querySelectorAll('[data-slot="card"]')).toHaveLength(5);
  });

  it("renders the PR throughput row as a single full-width chart", () => {
    if (!prsRow) {
      throw new Error("prs row fixture is missing");
    }

    const { container } = renderDashboardRow(prsRow);
    const grid = container.firstElementChild;

    expect(prsRow.tileIds).toEqual(["chart:prTrend"]);
    expect(grid).toHaveClass("grid", "gap-3");
    expect(grid).not.toHaveClass("lg:grid-cols-3");
    expect(grid).not.toHaveClass("lg:grid-cols-2");
    expect(grid?.children).toHaveLength(1);
    expect(grid?.firstElementChild).not.toHaveClass("lg:col-span-2");
  });

  it("renders the Cost KPI via the shared CostMetricCard (FEA-3818): whole-dollar value + single-voice kpi.sub info", async () => {
    const user = userEvent.setup();
    renderStatsRow();

    // Whole-dollar headline (formatCurrencyWhole), same as the Sessions card.
    const costCard = screen.getByText("Cost").closest('[data-slot="card"]');
    expect(costCard).toBeTruthy();
    expect(
      costCard!.querySelector('[data-slot="card-title"]')!.textContent
    ).toContain("$9,061");

    // Info copy is the same single-line backend `kpi.sub` its four rowmates (and
    // the Insights stat tile) render, so the Cost metric reads one voice per
    // screen and its popover isn't twice as tall as its neighbors' (FEA-3818).
    await user.click(screen.getByRole("button", { name: "About Cost" }));
    expect(
      await screen.findByRole("dialog", { name: "About Cost" })
    ).toHaveTextContent("estimated cost in range");
  });

  it("renders the honest-empty '—' for the Cost KPI when its value is unavailable (FEA-3818)", () => {
    const delivery = sections[InsightsSection.Delivery];
    if (!delivery) {
      throw new Error("delivery section fixture is missing");
    }
    renderStatsRow({
      sections: {
        ...sections,
        [InsightsSection.Delivery]: {
          ...delivery,
          kpis: delivery.kpis.map((kpi) =>
            kpi.key === "cost" ? { ...kpi, value: null } : kpi
          ),
        },
      },
    });

    const valueRow = getMetricValueRow("Cost");
    expect(valueRow).toHaveTextContent(emptyDashCostValuePattern);
    expect(within(valueRow).queryByText(dollarSignPattern)).toBeNull();
  });

  it("renders model spend and PR repository breakdown as an even distribution row", () => {
    if (!distributionRow) {
      throw new Error("distribution row fixture is missing");
    }

    const { container } = renderDashboardRow(distributionRow);
    const grid = container.firstElementChild;

    expect(distributionRow.tileIds).toEqual([
      "chart:modelBreakdown",
      "chart:prByRepo",
    ]);
    expect(grid).toHaveClass("grid", "gap-3", "lg:grid-cols-2");
    expect(grid?.children).toHaveLength(2);
    expect(grid?.firstElementChild).not.toHaveClass("lg:col-span-2");
  });
});

function renderStatsRow({
  getTileAvailability,
  sections: renderSections = sections,
}: {
  getTileAvailability?: Parameters<
    typeof DashboardRowContent
  >[0]["getTileAvailability"];
  sections?: InsightsSectionData;
} = {}) {
  if (!statsRow) {
    throw new Error("stats row fixture is missing");
  }
  return render(
    <DashboardRowContent
      autonomySeries={undefined}
      gates={{ agentCollaborationNetwork: true }}
      getTileAvailability={getTileAvailability}
      heatmap={undefined}
      modelSeries={undefined}
      onConnectGitHub={vi.fn()}
      row={statsRow}
      sections={renderSections}
    />
  );
}

/**
 * Drives the Dashboard Cost card's fallback-`info` path and asserts it renders
 * THIS surface's copy (wongk review on #4905).
 *
 * The reachable gap: `OverviewCostKpiCard` passes `info={undefined}` when the
 * Cost KPI or its `sub` is falsy, and `CostMetricCard`'s `info` DEFAULT is the
 * Sessions copy. Sessions itself always passes `info` explicitly (from
 * `resolveCostCardPresentation`), so this is the ONLY production path that
 * reaches that default — and before the fix it rendered a Dashboard tooltip
 * about "filtered sessions" plus a caption this surface never draws.
 *
 * `mutateKpis` picks which falsy branch to drive. Both callers stay type-legal:
 * `sub` is a REQUIRED `string` on the wire contract, so the reachable blank case
 * is `""` from a version-skewed or incomplete producer, never `undefined`.
 *
 * Returns the opened info dialog so each caller asserts in its own test body —
 * `expect` inside this helper would be a misplaced assertion.
 */
async function openDashboardCostInfoDialog(
  mutateKpis: (kpis: KpiStat[]) => KpiStat[]
) {
  const user = userEvent.setup();
  const delivery = sections[InsightsSection.Delivery];
  if (!delivery) {
    throw new Error("delivery section fixture is missing");
  }

  renderStatsRow({
    sections: {
      ...sections,
      [InsightsSection.Delivery]: {
        ...delivery,
        kpis: mutateKpis(delivery.kpis),
      },
    },
  });

  const trigger = screen.getByRole("button", {
    name: `About ${COST_METRIC_CARD_LABEL}`,
  });
  await user.click(trigger);
  return await screen.findByRole("dialog", {
    name: `About ${COST_METRIC_CARD_LABEL}`,
  });
}

function renderDashboardRow(row: NonNullable<typeof statsRow>) {
  // The PR-by-repository tile now reads the `emergent` flag for its segment
  // drilldown (FEA-2993); mount a static adapter (flag off = prior rendering) so
  // the feature-flag hook resolves in this unit test.
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        gates={{ agentCollaborationNetwork: true }}
        getTileAvailability={undefined}
        heatmap={undefined}
        modelSeries={undefined}
        row={row}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

const FORMAT_MAP: Record<string, KpiFormat> = {
  number: KpiFormat.Number,
  currency: KpiFormat.Currency,
  percent: KpiFormat.Percent,
  duration: KpiFormat.Duration,
  tokens: KpiFormat.Tokens,
};

// JSON imports infer structurally-narrow literal types (per-point optional
// value keys) that never "sufficiently overlap" with Record<string, number>
// series points, so each charts block crosses one explicit unknown boundary.
// The fixture IS the frozen runtime shape of the three section responses —
// the desktop golden-layer4 UTC suite deep-equals it against live getInsights
// output, which is what keeps this cast honest.
type SectionCharts<S extends keyof InsightsSectionData> = NonNullable<
  InsightsSectionData[S]
>["charts"];

function goldenSections(): InsightsSectionData {
  const g = goldenAggregates.sections;
  return {
    [InsightsSection.Delivery]: {
      kpis: g.delivery.kpis.map((k) => ({
        ...k,
        format: FORMAT_MAP[k.format] ?? KpiFormat.Number,
      })) as KpiStat[],
      charts: g.delivery.charts as unknown as SectionCharts<
        typeof InsightsSection.Delivery
      >,
    },
    [InsightsSection.Utilization]: {
      kpis: g.utilization.kpis.map((k) => ({
        ...k,
        format: FORMAT_MAP[k.format] ?? KpiFormat.Number,
      })) as KpiStat[],
      charts: g.utilization.charts as unknown as SectionCharts<
        typeof InsightsSection.Utilization
      >,
    },
    [InsightsSection.Agents]: {
      kpis: g.agents.kpis.map((k) => ({
        ...k,
        format: FORMAT_MAP[k.format] ?? KpiFormat.Number,
      })) as KpiStat[],
      charts: g.agents.charts as unknown as SectionCharts<
        typeof InsightsSection.Agents
      >,
    },
  };
}

const HEADLINE_KPIS: {
  tileId: string;
  section: typeof InsightsSection.Delivery | typeof InsightsSection.Utilization;
  dataKey: string;
}[] = [
  {
    tileId: "kpi:sessions",
    section: InsightsSection.Utilization,
    dataKey: "sessions",
  },
  { tileId: "kpi:cost", section: InsightsSection.Delivery, dataKey: "cost" },
  {
    tileId: "kpi:merged",
    section: InsightsSection.Delivery,
    dataKey: "merged",
  },
  {
    tileId: "kpi:pr-size",
    section: InsightsSection.Delivery,
    dataKey: "pr-size",
  },
  { tileId: "kpi:kloc", section: InsightsSection.Delivery, dataKey: "kloc" },
];

describe("dashboard rows over golden corpus aggregates (FEA-2650)", () => {
  const gSections = goldenSections();
  const goldenStatsRow = DASHBOARD_ROWS.find((r) => r.tour === "stats");

  function renderGoldenStatsRow(overrideSections?: InsightsSectionData) {
    if (!goldenStatsRow) {
      throw new Error("stats row not found in DASHBOARD_ROWS");
    }
    return render(
      <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
        <DashboardRowContent
          autonomySeries={undefined}
          gates={{ agentCollaborationNetwork: true }}
          getTileAvailability={undefined}
          heatmap={undefined}
          modelSeries={undefined}
          row={goldenStatsRow}
          sections={overrideSections ?? gSections}
        />
      </FeatureFlagAdapterProvider>
    );
  }

  it("renders every DASHBOARD_ROWS row without NaN, undefined, or Infinity in the DOM", () => {
    for (const row of DASHBOARD_ROWS) {
      const { container, unmount } = render(
        <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
          <DashboardRowContent
            autonomySeries={undefined}
            gates={{ agentCollaborationNetwork: true }}
            getTileAvailability={undefined}
            heatmap={undefined}
            modelSeries={undefined}
            row={row}
            sections={gSections}
          />
        </FeatureFlagAdapterProvider>
      );
      const text = container.textContent ?? "";
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("Infinity");
      unmount();
    }
  });

  it("displays each headline KPI value matching formatKpiTileValue computed from the fixture", () => {
    renderGoldenStatsRow();

    for (const { section, dataKey } of HEADLINE_KPIS) {
      const sectionData = gSections[section];
      const kpi = sectionData?.kpis.find((k) => k.key === dataKey);
      if (!kpi) {
        throw new Error(
          `KPI ${dataKey} not found in golden fixture section ${section}`
        );
      }
      // FEA-3431: headline tiles render whole-dollar for Currency (the `kpi:cost`
      // spend headline), so the oracle must use formatKpiTileValue, not the
      // compact formatKpiValue, to match what the component now displays.
      const expected = formatKpiTileValue(kpi.value, kpi.format);
      const card = screen.getByText(kpi.label).closest('[data-slot="card"]');
      expect(card).toBeTruthy();
      const titleEl = card!.querySelector('[data-slot="card-title"]');
      expect(titleEl).toBeTruthy();
      expect(titleEl!.textContent).toContain(expected);
    }
  });

  it("feeds kpi:merged sparkline from prTrend points' values.merged (undeclared total key)", () => {
    const prTrendPoints =
      gSections[InsightsSection.Delivery]?.charts.prTrend.points;
    expect(prTrendPoints).toBeDefined();
    const mergedValues = prTrendPoints!.map(
      (pt) => (pt.values as Record<string, number>).merged ?? 0
    );
    expect(mergedValues.some((v) => v > 0)).toBe(true);

    const withDelta: InsightsSectionData = {
      ...gSections,
      [InsightsSection.Delivery]: {
        ...gSections[InsightsSection.Delivery]!,
        kpis: gSections[InsightsSection.Delivery]!.kpis.map((k) =>
          k.key === "merged" ? { ...k, deltaPct: 5 } : k
        ),
      },
    };

    renderGoldenStatsRow(withDelta);

    const mergedKpi = withDelta[InsightsSection.Delivery]!.kpis.find(
      (k) => k.key === "merged"
    );
    const mergedCard = screen
      .getByText(mergedKpi!.label)
      .closest('[data-slot="card"]');
    expect(mergedCard).toBeTruthy();

    const sparklineSvgs = mergedCard!.querySelectorAll("svg");
    expect(sparklineSvgs.length).toBeGreaterThan(0);
  });

  it("renders the delta placeholder for fixture KPIs with deltaPct === null", () => {
    renderGoldenStatsRow();

    for (const { section, dataKey } of HEADLINE_KPIS) {
      const kpi = gSections[section]?.kpis.find((k) => k.key === dataKey);
      if (!kpi) {
        continue;
      }
      if (kpi.deltaPct !== null) {
        continue;
      }

      const card = screen.getByText(kpi.label).closest('[data-slot="card"]');
      expect(card).toBeTruthy();
      const placeholder = card!.querySelector(
        '[data-testid="kpi-delta-placeholder"]'
      );
      expect(placeholder).toBeTruthy();

      const deltaArea = placeholder!.textContent ?? "";
      expect(deltaArea).not.toMatch(PERCENT_REGEX);
    }
  });

  it("renders deltaPct: 0 as a real 0% delta, not the placeholder", () => {
    const syntheticSections: InsightsSectionData = {
      ...gSections,
      [InsightsSection.Utilization]: {
        ...gSections[InsightsSection.Utilization]!,
        kpis: gSections[InsightsSection.Utilization]!.kpis.map((k) =>
          k.key === "sessions" ? { ...k, deltaPct: 0 } : k
        ),
      },
    };

    renderGoldenStatsRow(syntheticSections);

    const sessionsLabel = syntheticSections[
      InsightsSection.Utilization
    ]!.kpis.find((k) => k.key === "sessions")!.label;
    const card = screen.getByText(sessionsLabel).closest('[data-slot="card"]');
    expect(card).toBeTruthy();
    expect(
      card!.querySelector('[data-testid="kpi-delta-placeholder"]')
    ).toBeNull();
    // A real 0% renders as the shared "0%" (no misleading sign), via the same
    // formatDeltaPct SSOT the tile uses — never suppressed to the placeholder.
    expect(card!.textContent).toContain("0%");
  });

  it("caps a mega-percentage delta to >999% instead of a division artifact (FEA-3959)", () => {
    // A ceiling delta reaches the card as MAX_DELTA_PCT; the card must render
    // the comparison-glyph ">999%" affordance, never the typo-looking "+999%+".
    //
    // ISS-5003: this build's `pctDelta` no longer mints a clamp — an
    // over-ceiling magnitude returns null now — so the value is injected
    // directly here, which is exactly the case that still matters: a ±999 from a
    // version-skewed producer (an older desktop build, a cached payload) must
    // keep rendering sanely rather than showing an unlabelled figure.
    const syntheticSections: InsightsSectionData = {
      ...gSections,
      [InsightsSection.Utilization]: {
        ...gSections[InsightsSection.Utilization]!,
        kpis: gSections[InsightsSection.Utilization]!.kpis.map((k) =>
          k.key === "sessions" ? { ...k, deltaPct: MAX_DELTA_PCT } : k
        ),
      },
    };

    renderGoldenStatsRow(syntheticSections);

    const sessionsLabel = syntheticSections[
      InsightsSection.Utilization
    ]!.kpis.find((k) => k.key === "sessions")!.label;
    const card = screen.getByText(sessionsLabel).closest('[data-slot="card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain(`>${MAX_DELTA_PCT}%`);
    expect(card!.textContent).not.toContain(`+${MAX_DELTA_PCT}%+`);
    expect(card!.textContent).not.toContain("5400");
  });

  it("gives every KPI card the same explicit 'no trend yet' affordance, never a bare missing-data em-dash (FEA-3960)", () => {
    // The fixture's five headline KPIs all have deltaPct === null, so every card
    // must carry the identical intentional placeholder chip (labeled + testid),
    // not a mix of pills and bare dashes that reads as half-finished.
    renderGoldenStatsRow();

    const placeholders = screen.getAllByTestId("kpi-delta-placeholder");
    // Every headline card without a numeric delta shows the affordance.
    expect(placeholders.length).toBe(HEADLINE_KPIS.length);
    for (const placeholder of placeholders) {
      expect(placeholder).toHaveTextContent(NO_COMPARISON_CHIP_LABEL);
      // The chip is explicit, not a bare "—" that reads as missing data.
      expect(placeholder.textContent).not.toMatch(PERCENT_REGEX);
    }
  });

  it("renders a negative deltaPct with its sign and direction styling", () => {
    const syntheticSections: InsightsSectionData = {
      ...gSections,
      [InsightsSection.Delivery]: {
        ...gSections[InsightsSection.Delivery]!,
        kpis: gSections[InsightsSection.Delivery]!.kpis.map((k) =>
          k.key === "merged" ? { ...k, deltaPct: -12 } : k
        ),
      },
    };

    renderGoldenStatsRow(syntheticSections);

    const mergedLabel = syntheticSections[InsightsSection.Delivery]!.kpis.find(
      (k) => k.key === "merged"
    )!.label;
    const card = screen.getByText(mergedLabel).closest('[data-slot="card"]');
    expect(card).toBeTruthy();
    expect(
      card!.querySelector('[data-testid="kpi-delta-placeholder"]')
    ).toBeNull();
    expect(card!.textContent).toContain("-12%");

    const deltaChip = card!.querySelector(".text-destructive");
    if (!deltaChip) {
      const chipSpan = Array.from(card!.querySelectorAll("span")).find((el) =>
        el.textContent?.includes("-12%")
      );
      expect(chipSpan).toBeTruthy();
      expect(chipSpan!.className).toContain("destructive");
    }
  });
});

const sections: InsightsSectionData = {
  [InsightsSection.Delivery]: {
    kpis: [
      {
        // FEA-3818: the Cost KPI is always emitted by the insights service, so
        // the dashboard cost card (now the shared CostMetricCard) always renders
        // its info control — mirror that here so tab-order/label assertions match
        // production.
        key: "cost",
        label: "Cost",
        value: 9061,
        format: KpiFormat.Currency,
        sub: "estimated cost in range, including subscription-covered usage",
        deltaPct: null,
      },
      {
        key: "merged",
        label: "Captured PRs",
        value: 12,
        format: KpiFormat.Number,
        sub: "PRs found in local sessions",
        deltaPct: null,
      },
      {
        key: "pr-size",
        label: "Median PR size",
        value: 128,
        format: KpiFormat.Number,
        sub: "Median changed lines per merged PR",
        deltaPct: null,
      },
      {
        key: "kloc",
        label: "KLOC merged",
        value: 4.2,
        format: KpiFormat.Number,
        sub: "Thousands of lines merged",
        deltaPct: null,
      },
    ],
    charts: {
      prTrend: emptySeries,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  },
  [InsightsSection.Utilization]: {
    kpis: [],
    charts: {
      eventActivity: emptySeries,
      reviewQueue: [],
    },
  },
  [InsightsSection.Agents]: {
    kpis: [],
    charts: {
      modelUsageOverTime: emptySeries,
      modelBreakdown: [],
    },
  },
};

const agentPipelineRow = DASHBOARD_ROWS.find(
  (row) => row.tour === "agent-pipeline"
);
const sampleAgentPipeline = {
  nodes: [
    {
      subagentType: "planner",
      total: 12,
      completed: 11,
      errors: 1,
      sessions: 8,
      successRate: 92,
      avgDuration: 120,
      trend: [],
    },
    {
      subagentType: "reviewer",
      total: 9,
      completed: 9,
      errors: 0,
      sessions: 7,
      successRate: 100,
      avgDuration: 90,
      trend: [],
    },
  ],
  edges: [{ source: "planner", target: "reviewer", weight: 5 }],
};

function renderAgentPipelineRow(props: {
  agentPipeline?: typeof sampleAgentPipeline;
  // ISS-5061 re-gate: defaults to the gate OPEN so the FEA-3537 rendering tests
  // below keep testing rendering. The gate itself is covered explicitly.
  agentCollaborationNetwork?: boolean;
}) {
  if (!agentPipelineRow) {
    throw new Error("agent-pipeline row fixture is missing");
  }
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        agentPipeline={props.agentPipeline}
        autonomySeries={undefined}
        gates={{
          agentCollaborationNetwork: props.agentCollaborationNetwork ?? true,
        }}
        heatmap={undefined}
        modelSeries={undefined}
        row={agentPipelineRow}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("DashboardRowContent — agent-pipeline row (FEA-3537)", () => {
  it("shows an empty state when there is no data", () => {
    renderAgentPipelineRow({});

    expect(
      screen.getByText("No agent collaboration data for this period yet.")
    ).toBeInTheDocument();
    // FEA-4016: the empty branch still draws the "Agent Collaboration Network"
    // header. The card is flagged `contentHasOwnTitle`, so without a header here
    // the collapsed grid card would be anonymous and the expanded modal would
    // have no visible title at all. The header must hold on BOTH branches.
    expect(
      screen.getByRole("heading", { name: "Agent Collaboration Network" })
    ).toBeInTheDocument();
  });

  it("renders the agent collaboration graph when there is data", () => {
    renderAgentPipelineRow({ agentPipeline: sampleAgentPipeline });

    expect(screen.getByText("Agent Collaboration Network")).toBeInTheDocument();
    expect(
      screen.queryByText("No agent collaboration data for this period yet.")
    ).not.toBeInTheDocument();
  });

  // ISS-5061 re-gate (reverses ISS-5280 for this one flag). The render boundary
  // is the second half of the gate: `dashboardRowsFor` drops the row from the
  // order, and this stops a caller that maps `DASHBOARD_ROWS` directly from
  // drawing the card anyway. Driven WITH data present, so the absence can only
  // come from the gate and never from the empty branch.
  it("renders NOTHING when the gate is closed, even with data", () => {
    const { container } = renderAgentPipelineRow({
      agentCollaborationNetwork: false,
      agentPipeline: sampleAgentPipeline,
    });

    expect(container).toBeEmptyDOMElement();
    // Specifically NOT the graph's own empty state: that would claim there is
    // no data when the feature is merely off.
    expect(
      screen.queryByText("No agent collaboration data for this period yet.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Agent Collaboration Network" })
    ).not.toBeInTheDocument();
  });

  it("renders the row when the gate is open", () => {
    renderAgentPipelineRow({
      agentCollaborationNetwork: true,
      agentPipeline: sampleAgentPipeline,
    });

    expect(
      screen.getByRole("heading", { name: "Agent Collaboration Network" })
    ).toBeInTheDocument();
  });
});

const frustrationRow = DASHBOARD_ROWS.find((row) => row.tour === "frustration");
const sampleFrustrationSeries = {
  series: [{ key: "frustration", label: "Frustration" }],
  points: [
    { date: "2026-06-08", values: { frustration: 100 } },
    { date: "2026-06-09", values: { frustration: 25 } },
  ],
};

function renderFrustrationRow(props: {
  frustrationSeries?: typeof sampleFrustrationSeries;
}) {
  if (!frustrationRow) {
    throw new Error("frustration row fixture is missing");
  }
  // The frustration chart is the shared @repo/app component consumed by BOTH the
  // web shell and the desktop renderer, so this row render proves the same
  // surface renders on both (web+desktop parity, FEA-4022).
  return render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DashboardRowContent
        autonomySeries={undefined}
        frustrationSeries={props.frustrationSeries}
        gates={{ agentCollaborationNetwork: true }}
        heatmap={undefined}
        modelSeries={undefined}
        row={frustrationRow}
        sections={sections}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("DashboardRowContent — frustration row (FEA-4022)", () => {
  it("is a registered dashboard row", () => {
    expect(frustrationRow).toBeDefined();
  });

  it("renders the Frustration Over Time card when the series is present", () => {
    renderFrustrationRow({ frustrationSeries: sampleFrustrationSeries });

    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
  });

  it("still renders the titled card (with a loading skeleton) when the series is absent", () => {
    renderFrustrationRow({ frustrationSeries: undefined });

    // The card title is always present; the chart body degrades to a skeleton
    // rather than a broken/empty render while the section is still resolving.
    expect(screen.getByText("Frustration Over Time")).toBeInTheDocument();
  });
});
