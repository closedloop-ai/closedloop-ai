import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/**
 * ISS-10363: a Branches card whose producer sent a series draws it, even though
 * no producer supplies the SEPARATE comparison operand (ISS-10208).
 *
 * ISS-10544 moved the decision off a flag read inside the card and onto a HOST
 * capability, because the two shells now answer it differently. These cases are
 * about the shared row honouring whatever it is told, so they mount the real
 * strip and vary only the capability; which answer each shell gives — and that
 * both shells give one at all — is
 * `apps/app/__tests__/branch-metric-sparkline-host-parity.test.tsx`.
 *
 * Every case still mounts through the real adapter: deleting the `sparkline`
 * prop beneath the capability, or the capability's own forwarding, has to redden
 * this file.
 */

const SERIES = [10, 14, 9, 22, 30, 26];

const SIZE_VALUE_TEXT = /148 LOC/;

/**
 * The card WITH a comparable delta — the form `CanonicalMetricCard` renders
 * through its other return, where the mark rides inside the chip and replaces
 * the directional glyph (marisolashgrove review, PR #7525).
 *
 * It is the majority web render, not an edge: ISS-10540 removed
 * `buildBranchMetricComparison`'s Partial refusal, so on real data most cards
 * now DO carry a delta. Until this fixture existed every case in this file and
 * every arm of the host-parity suite pinned `deltaPct` to `Unavailable`, so all
 * of them landed in the `delta === undefined` return and deleting the OTHER
 * `sparkline={…}` line left both suites green.
 */
const SIZE_WITH_COMPARISON = {
  current: { state: BranchMetricAvailability.Complete, value: 148 },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: { state: BranchMetricAvailability.Complete, value: -12 },
  },
  series: SERIES,
} as const;

/** The card ISS-10208 leaves without a delta: a real value, no comparison. */
const SIZE_WITHOUT_COMPARISON = {
  current: { state: BranchMetricAvailability.Complete, value: 148 },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: { state: BranchMetricAvailability.Unavailable, value: null },
  },
  series: SERIES,
} as const;

function renderStrip({
  comparable = false,
  series,
  trendSparkline,
}: {
  /**
   * Which of `CanonicalMetricCard`'s two returns the card takes. `false` keeps
   * the historical fixture (no comparable delta, standalone mark); `true`
   * supplies one, which is the in-chip form.
   */
  comparable?: boolean;
  // Explicit rather than defaulted: `undefined` IS one of the cases under test
  // — the producer that sent no series — and a default would silently swap it
  // for the populated one and pass on the wrong render.
  series: readonly number[] | undefined;
  /** `undefined` is the fourth case: a mount that never answered at all. */
  trendSparkline: boolean | undefined;
}) {
  return render(
    // No flag is enabled in ANY case here. After ISS-10544 the shared row has no
    // read of its own to satisfy, so an adapter that opened one would assert
    // against a gate this component no longer consults.
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          medianPrSize: {
            ...(comparable ? SIZE_WITH_COMPARISON : SIZE_WITHOUT_COMPARISON),
            series,
          },
        })}
        trendSparkline={trendSparkline}
      />
    </FeatureFlagAdapterProvider>
  );
}

/** The median-PR-size card, found by its own figure, never by position. */
function sizeCard(): Element | null | undefined {
  return screen.getByText(SIZE_VALUE_TEXT).closest("[data-slot='card']");
}

describe("Branches metric card sparkline (ISS-10363 / ISS-10544)", () => {
  it("draws the series on a card with no comparison when its host serves one", () => {
    renderStrip({ series: SERIES, trendSparkline: true });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(1);
  });

  it("keeps the shipped card untouched when its host serves none", () => {
    renderStrip({ series: SERIES, trendSparkline: false });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(0);
  });

  it("draws nothing when the producer sent no series", () => {
    // The host serves the mark and the figure is real; the absence here is the
    // series itself, which is the one honest reason to draw no mark.
    renderStrip({ series: undefined, trendSparkline: true });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(0);
  });

  it("draws nothing for a mount that never answered the capability", () => {
    // The row's default, asserted rather than assumed: a fixture that has not
    // claimed the capability renders the shipped card, which is what keeps the
    // default fail-closed.
    renderStrip({ series: SERIES, trendSparkline: undefined });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(0);
  });

  // The OTHER return of `CanonicalMetricCard`, which had no coverage at either
  // layer until this PR's review. Deleting `sparkline={trendSparkline ?
  // metric.series : undefined}` from the delta arm kept both suites green,
  // because every other case in the repo pins `deltaPct` to `Unavailable`.
  it("draws the series inside the chip on a card that HAS a comparable delta", () => {
    renderStrip({ comparable: true, series: SERIES, trendSparkline: true });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(1);
  });

  it("keeps the comparable card untouched when its host serves no mark", () => {
    // The negative for the case above, on the same return: without it the
    // assertion is satisfied by a card that draws a polyline unconditionally.
    renderStrip({ comparable: true, series: SERIES, trendSparkline: false });
    expect(sizeCard()?.querySelectorAll("svg polyline")).toHaveLength(0);
  });
});
