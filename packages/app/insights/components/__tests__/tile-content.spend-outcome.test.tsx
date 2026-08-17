/**
 * ISS-4463 (#4282 review): what the spend-by-outcome tiles must SAY on screen.
 *
 * Two claims are under test, both raised on the PR:
 *  - a MEASURED zero (the producer emitted every bucket for a period with no
 *    spend) must not render the same "no data" state as an ABSENT chart field,
 *    because "you spent nothing" and "we have nothing to show you" are different
 *    facts (wongk);
 *  - outcome is a SEMANTIC dimension, so the charts must be handed a fixed
 *    key→colour map and the share tile must print the share, rather than leaning
 *    on the generic index palette and an undenominated ring.
 */

import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import type { CategoryDatum } from "@repo/design-system/components/ui/category-bar-chart";
import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SPEND_OUTCOME_ZERO_MESSAGE } from "../../lib/spend-outcome-palette";
import { getTile, type TileDescriptor } from "../../lib/tile-catalog";
import { InsightsChartContent } from "../tile-content";

vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: ({
    colorByKey,
  }: {
    data: CategoryDatum[];
    colorByKey?: Readonly<Record<string, string>>;
  }) => (
    <div data-testid="mock-category-bar-chart">
      <span data-testid="bar-color-errored">
        {colorByKey?.[SpendOutcome.Errored] ?? "none"}
      </span>
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/donut-chart", () => ({
  DonutChart: ({
    colorByKey,
    showSharePercent,
  }: {
    colorByKey?: Readonly<Record<string, string>>;
    showSharePercent?: boolean;
  }) => (
    <div data-testid="mock-donut-chart">
      <span data-testid="donut-share">{String(showSharePercent)}</span>
      <span data-testid="donut-color-errored">
        {colorByKey?.[SpendOutcome.Errored] ?? "none"}
      </span>
    </div>
  ),
}));

const barTile = getTile("chart:spendByOutcome") as TileDescriptor;
const donutTile = getTile("chart:spendByOutcome:donut") as TileDescriptor;

/** The producer's own emission for a period in which nothing was spent. */
const MEASURED_ZERO: CategoryBucket[] = [
  { key: SpendOutcome.Clean, label: "Ended clean", value: 0 },
  { key: SpendOutcome.Errored, label: "Ended with error", value: 0 },
  { key: SpendOutcome.Running, label: "Still running", value: 0 },
  { key: SpendOutcome.Unknown, label: "Not recorded", value: 0 },
];

const SPENT: CategoryBucket[] = [
  { key: SpendOutcome.Clean, label: "Ended clean", value: 6 },
  { key: SpendOutcome.Errored, label: "Ended with error", value: 3 },
  { key: SpendOutcome.Running, label: "Still running", value: 1 },
  { key: SpendOutcome.Unknown, label: "Not recorded", value: 0 },
];

const EMPTY_SERIES = { series: [], points: [] };

function renderTile(tile: TileDescriptor, spendByOutcome?: CategoryBucket[]) {
  return render(
    <InsightsChartContent
      sections={{
        [InsightsSection.Agents]: {
          kpis: [],
          charts: {
            modelUsageOverTime: EMPTY_SERIES,
            modelBreakdown: [],
            ...(spendByOutcome ? { spendByOutcome } : {}),
          },
        },
      }}
      tile={tile}
    />
  );
}

describe("spend-by-outcome tile content", () => {
  it("names a measured zero instead of reusing the absent-data empty state", () => {
    renderTile(barTile, MEASURED_ZERO);

    expect(screen.getByText(SPEND_OUTCOME_ZERO_MESSAGE)).toBeInTheDocument();
  });

  it("keeps the generic empty state when the chart field is absent entirely", () => {
    // A peer that does not compute this chart omits the field. That is NOT a
    // measured zero, and must not claim the user spent nothing.
    renderTile(barTile, undefined);

    expect(
      screen.queryByText(SPEND_OUTCOME_ZERO_MESSAGE)
    ).not.toBeInTheDocument();
  });

  it("colours the failure bucket semantically rather than by palette position", () => {
    renderTile(barTile, SPENT);

    // Third in emission order, so the index palette would have painted it
    // --chart-3 (green) — colour carrying the opposite of its meaning.
    expect(screen.getByTestId("bar-color-errored")).toHaveTextContent(
      "var(--destructive)"
    );
  });

  it("prints the share on the share tile, and colours it semantically too", () => {
    renderTile(donutTile, SPENT);

    expect(screen.getByTestId("donut-share")).toHaveTextContent("true");
    expect(screen.getByTestId("donut-color-errored")).toHaveTextContent(
      "var(--destructive)"
    );
  });
});
