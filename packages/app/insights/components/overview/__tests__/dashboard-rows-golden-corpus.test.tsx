import { MAX_DELTA_PCT } from "@closedloop-ai/loops-api/insights";
import type { KpiStat } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { TOTAL_ESTIMATED_COST_COPY } from "@repo/api/src/types/total-estimated-cost-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import goldenAggregates from "../../../__tests__/fixtures/golden-render-aggregates.json";
import { formatKpiTileValue } from "../../../lib/format";
import { getTile } from "../../../lib/tile-catalog";
import { NO_COMPARISON_CHIP_LABEL } from "../../kpi-delta-placeholder";
import type { InsightsSectionData } from "../../tile-content";
import { DashboardRowContent } from "../dashboard-rows";
import { DASHBOARD_ROWS } from "../dashboard-tiles";
import {
  type GoldenSectionsFixture,
  sectionsFromGoldenFixture,
} from "./golden-sections.test-helpers";

const PERCENT_REGEX = /[+-]?\d+%/;

// ISS-4754: the fixture -> InsightsSectionData adapter moved to a shared helper
// so the Layer-5 cloud contract test can use the same one. It takes the fixture
// as a parameter now; this suite still passes the Layer-4 desktop aggregates.
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
  const gSections = sectionsFromGoldenFixture(
    goldenAggregates as unknown as GoldenSectionsFixture
  );
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

  /**
   * The label a headline tile actually renders: the catalog's title on every
   * surface (ISS-12638), whatever the producer's `kpi.label` says — spelled as
   * literals so the catalog is not its own oracle. The cost tile is the one
   * canonical dollar phrase (ISS-9971), so this screen and the Sessions strip
   * cannot name the same figure two ways.
   */
  const CATALOG_KPI_TITLES: Record<string, string> = {
    // The flag-off volume title is the retired KLOC spelling, which the
    // vocabulary gate keeps out of new literals: read it from the catalog.
    kloc: getTile("kpi:kloc")?.title ?? "",
    merged: "Merged PRs",
    "pr-size": "Median PR size",
    sessions: "Sessions",
  };
  function renderedKpiLabel(dataKey: string): string {
    if (dataKey === "cost") {
      return TOTAL_ESTIMATED_COST_COPY.label;
    }
    const title = CATALOG_KPI_TITLES[dataKey];
    if (title === undefined) {
      throw new Error(`No catalog title recorded for headline KPI ${dataKey}`);
    }
    return title;
  }

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
      const card = screen
        .getByText(renderedKpiLabel(dataKey))
        .closest('[data-slot="card"]');
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

    const mergedCard = screen
      .getByText(renderedKpiLabel("merged"))
      .closest('[data-slot="card"]');
    expect(mergedCard).toBeTruthy();

    // The sparkline is the only mark in this card drawn as a `polyline`; the
    // fallback delta glyph is a lucide icon made of `path`s. Asserting the mark
    // rather than MetricCard's private 26x11 box survives a primitive resize
    // and still fails when the `kpi:merged` series arm is dropped.
    const sparklineMark = mergedCard!.querySelector("svg polyline");
    expect(sparklineMark).toBeTruthy();
    expect(sparklineMark!.getAttribute("points")).toBeTruthy();
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

      const card = screen
        .getByText(renderedKpiLabel(dataKey))
        .closest('[data-slot="card"]');
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

    const card = screen
      .getByText(renderedKpiLabel("sessions"))
      .closest('[data-slot="card"]');
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

    const card = screen
      .getByText(renderedKpiLabel("sessions"))
      .closest('[data-slot="card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain(`>${MAX_DELTA_PCT}%`);
    expect(card!.textContent).not.toContain(`+${MAX_DELTA_PCT}%+`);
    expect(card!.textContent).not.toContain("5400");
  });

  it("gives every KPI card the same explicit 'no trend yet' affordance, never a bare missing-data em-dash (FEA-3960)", () => {
    // All five headline KPIs are overridden to deltaPct === null (the fixture
    // gives some a trend since the ISS-12552 anchor move), so every card must
    // carry the identical intentional placeholder chip (labeled + testid), not a
    // mix of pills and bare dashes that reads as half-finished.
    const withoutHeadlineDeltas = (section: string, kpis: KpiStat[]) =>
      kpis.map((k) =>
        HEADLINE_KPIS.some((h) => h.section === section && h.dataKey === k.key)
          ? { ...k, deltaPct: null }
          : k
      );
    const syntheticSections: InsightsSectionData = {
      ...gSections,
      [InsightsSection.Delivery]: {
        ...gSections[InsightsSection.Delivery]!,
        kpis: withoutHeadlineDeltas(
          InsightsSection.Delivery,
          gSections[InsightsSection.Delivery]!.kpis
        ),
      },
      [InsightsSection.Utilization]: {
        ...gSections[InsightsSection.Utilization]!,
        kpis: withoutHeadlineDeltas(
          InsightsSection.Utilization,
          gSections[InsightsSection.Utilization]!.kpis
        ),
      },
    };
    renderGoldenStatsRow(syntheticSections);

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

    const card = screen
      .getByText(renderedKpiLabel("merged"))
      .closest('[data-slot="card"]');
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
