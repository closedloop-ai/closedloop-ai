/**
 * @file approved-branches-summary-cards-canonical-row.test.tsx
 * @description ISS-9957/ISS-9958 — the Branches summary row: AI spend gives its
 * slot to Total LOC pushed, LOC per $ is last, and LOC per $ is never retired by
 * the hide gate. ISS-10636 retired the gate that used to select this row, so
 * every case renders with no cost flag seeded — the only state left.
 *
 * Every label expected ON screen below is a LITERAL, deliberately not read from
 * `BRANCH_METRIC_DICTIONARY`. A fixture that sourced its expectations from the
 * dictionary it polices would still pass if a card were dropped from the row or
 * a label deleted from the dictionary, because both sides would move together.
 */
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

const CANONICAL_ROW = [
  "Active branches",
  "Median PR size",
  "Total LOC pushed",
  "Merge rate",
  "LOC per $",
];

const SPEND_CARD_LABEL = BRANCH_METRIC_DICTIONARY[BranchMetricId.AiSpend].label;
const PUSHED_CARD_LABEL = "Total LOC pushed";
const RATIO_CARD_LABEL = "LOC per $";

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

const UNAVAILABLE = {
  current: { state: BranchMetricAvailability.Unavailable, value: null },
} as const;

/** Reachable: the kernel answers N/A when coverage is whole and cost is zero. */
const NOT_APPLICABLE = {
  current: { state: BranchMetricAvailability.NotApplicable, value: null },
} as const;

function metricsWithCanonicalFields() {
  return makeBranchListMetrics({
    activeBranches: complete(12),
    medianPrSize: complete(148),
    mergeRatePct: complete(85),
    totalLocPushed: complete(1000),
    pushedLocPerDollar: complete(4),
    aiSpendUsd: complete(250),
  });
}

function renderRow({
  enabledFlags,
  metrics,
}: {
  enabledFlags: string[];
  metrics: ReturnType<typeof makeBranchListMetrics>;
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={metrics}
      />
    </FeatureFlagAdapterProvider>
  );
}

/** Each rendered card element, in DOM order. */
function renderedCards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-slot='card']")];
}

/** The index of the card carrying `label`, or -1. */
function cardIndexFor(cards: HTMLElement[], label: string): number {
  return cards.findIndex((card) => card.textContent?.includes(label));
}

describe("ISS-9957 the canonical Branches row", () => {
  it("renders the five cards in their fixed order with LOC per $ last", () => {
    const { container } = renderRow({
      enabledFlags: [],
      metrics: metricsWithCanonicalFields(),
    });

    const cards = renderedCards(container);
    expect(cards).toHaveLength(CANONICAL_ROW.length);
    const positions = CANONICAL_ROW.map((label) => cardIndexFor(cards, label));
    // Every label found, and found in this order — so a reshuffle fails here
    // rather than only a removal.
    expect(positions).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops the AI spend card and puts Total LOC pushed in its slot", () => {
    renderRow({
      enabledFlags: [],
      metrics: metricsWithCanonicalFields(),
    });

    expect(screen.queryByText(SPEND_CARD_LABEL)).toBeNull();
    // The positive half of that absence: the slot is occupied, not empty.
    expect(screen.getByText(PUSHED_CARD_LABEL)).toBeInTheDocument();
    expect(screen.getByText("1,000 LOC")).toBeInTheDocument();
  });
});

describe("ISS-9958 LOC per $ is never retired by the hide gate", () => {
  it("renders the ratio card even when its value is not computable", () => {
    const { container } = renderRow({
      enabledFlags: [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY],
      metrics: makeBranchListMetrics({
        activeBranches: complete(12),
        medianPrSize: complete(148),
        mergeRatePct: complete(85),
        totalLocPushed: complete(1000),
        // The one not-computable card in the row. With the hide gate open and
        // four computable siblings, the shared policy WOULD retire it; the
        // row's `neverHidden` rule is the only thing keeping it on screen.
        pushedLocPerDollar: UNAVAILABLE,
      }),
    });

    expect(screen.getByText(RATIO_CARD_LABEL)).toBeInTheDocument();
    expect(renderedCards(container)).toHaveLength(CANONICAL_ROW.length);
  });

  /**
   * The exempt card computes the word for its own absent slot, but the word
   * only matters if it REACHES the card. A not-applicable ratio must not print
   * "No data" under a caption reading "N/A" — two different absences in one
   * tile. This fails if the label is computed and then dropped on the way to
   * `MetricCard`, which is exactly how it shipped before review.
   */
  it("labels a not-applicable ratio N/A rather than No data", () => {
    renderRow({
      enabledFlags: [],
      metrics: makeBranchListMetrics({
        activeBranches: complete(12),
        medianPrSize: complete(148),
        mergeRatePct: complete(85),
        totalLocPushed: complete(1000),
        pushedLocPerDollar: NOT_APPLICABLE,
      }),
    });

    const card = screen
      .getByText(RATIO_CARD_LABEL)
      .closest("[data-slot='card']");
    expect(card?.textContent).toContain("N/A");
    expect(card?.textContent).not.toContain("No data");
  });

  /**
   * The sibling that proves the gate is actually biting in this configuration.
   * Without it the case above would pass on a row where nothing is ever hidden,
   * and would say nothing about `neverHidden`.
   */
  it("still retires a non-exempt card in the same configuration", () => {
    const { container } = renderRow({
      enabledFlags: [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY],
      metrics: makeBranchListMetrics({
        activeBranches: complete(12),
        medianPrSize: complete(148),
        mergeRatePct: complete(85),
        totalLocPushed: UNAVAILABLE,
        pushedLocPerDollar: complete(4),
      }),
    });

    expect(screen.queryByText(PUSHED_CARD_LABEL)).toBeNull();
    expect(renderedCards(container)).toHaveLength(CANONICAL_ROW.length - 1);
  });
});

/**
 * ISS-9956 / ISS-9970 — the card labelled "LOC per $" reads the CANONICAL
 * ratio whenever the producer sends it.
 *
 * The bundle carried `canonicalLocPerDollar` and the filtered rebind handled it
 * long before anything rendered it, so the producers were correct while the
 * shipped tile still divided the phase-attributed cost. ISS-9970 made that one
 * dollar basis unconditional, so the read is no longer gated; these cases pin
 * the RENDERED selection, which is the half a bundle-level test cannot prove.
 * ISS-10636 retired the gate that chose between two rows, so the row above is
 * the only one — its order is pinned by the cases above, and the CARD by the
 * ISS-10021 suite in
 * `approved-branches-summary-cards-canonical-loc-per-dollar.test.tsx`.
 *
 * Distinctive values throughout: the canonical and shipped ratios differ, so an
 * assertion cannot pass by reading the wrong field and matching by luck.
 */
describe("ISS-9956 LOC per $ reads the canonical total-estimated-cost ratio", () => {
  const CANONICAL_RATIO = 731;
  const SHIPPED_RATIO = 912;

  it("renders the canonical ratio, not the shipped one", () => {
    renderRow({
      enabledFlags: [],
      metrics: makeBranchListMetrics({
        canonicalLocPerDollar: complete(CANONICAL_RATIO),
        locPerDollar: complete(SHIPPED_RATIO),
      }),
    });

    expect(screen.getByText(`${CANONICAL_RATIO} LOC/$`)).toBeInTheDocument();
    // The negative half, on a locator proven to resolve by the line above: the
    // superseded figure is gone, not merely unqueried.
    expect(screen.queryByText(`${SHIPPED_RATIO} LOC/$`)).toBeNull();
  });

  /**
   * The version-skew contract `canonicalLocPerDollar` states for itself: a
   * producer predating it omits the field and the consumer keeps the pushed
   * ratio rather than rendering an empty tile. This is the counterfactual for
   * the case above — same component, same fixture shape, one field absent.
   */
  it("falls back to the shipped ratio when the producer omits the canonical field", () => {
    renderRow({
      enabledFlags: [],
      metrics: makeBranchListMetrics({
        pushedLocPerDollar: complete(SHIPPED_RATIO),
      }),
    });

    expect(screen.getByText(`${SHIPPED_RATIO} LOC/$`)).toBeInTheDocument();
  });
});
