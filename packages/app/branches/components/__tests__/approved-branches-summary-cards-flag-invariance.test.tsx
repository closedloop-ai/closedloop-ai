/**
 * @file approved-branches-summary-cards-flag-invariance.test.tsx
 * @description ISS-9972 — no feature flag may change what a dollar figure
 * means.
 *
 * Two flags used to decide which arithmetic this strip performed:
 * `branches-cost-coverage-agreement` swapped the AI-spend tile between
 * `aiSpendUsd` and a `reconciledAiSpendUsd` companion, and
 * `branches-population-matched-loc-per-dollar` swapped the LOC/$ denominator
 * between the cost-known subset and a population-matched alternate. Both are
 * DELETED — the keys, the alternate derivations, and the wire companions — so
 * the basis is single-valued.
 *
 * This suite pins that outcome from the render side, which is where a
 * reintroduced selection branch would be observable: every flag this component
 * can read is turned ON, then OFF, and the LOC/$ card must state the SAME
 * number and unit both times. The claim is deliberately the READING, not the
 * whole card text. What may never differ is the figure itself, and a
 * flag-selected alternate denominator is exactly what would make it differ.
 * (`metric-partial-disclosure`, a disclosure gate this list used to carry, was
 * retired by ISS-10540.)
 */
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY,
  METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
  METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
  METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../../lib/branches-summary-honest-loading-flag";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/** Every flag this strip's render path can read. */
const EVERY_FLAG: readonly string[] = [
  BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY,
  BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
  METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
  METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
  METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
];

/**
 * A LOC/$ reading with the incomplete-cost disclosure a basis swap would move.
 *
 * Fed as `canonicalLocPerDollar`, the field the surviving card selects since
 * ISS-10636 retired the row that read the phase-attributed ratio.
 */
const PARTIAL_LOC_PER_DOLLAR = {
  current: {
    state: BranchMetricAvailability.Partial,
    value: 1234.5,
    coverage: { included: 4, total: 6 },
    disclosure: BranchMetricDisclosure.CostIncomplete,
  },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: { state: BranchMetricAvailability.Unavailable, value: null },
  },
} as const;

const CARD_SLOT = "[data-slot='card']";
const RATIO_READING = /[\d,]+(?:\.\d+)?\s*LOC\/\$/g;
const SPEND_FIGURE = /\$20\.39/;
const AI_SPEND_LABEL = BRANCH_METRIC_DICTIONARY[BranchMetricId.AiSpend].label;

function locPerDollarReadingsWith(
  enabledFlags: readonly string[]
): readonly string[] {
  const { container } = render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [...enabledFlags],
      })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          canonicalLocPerDollar: PARTIAL_LOC_PER_DOLLAR,
        })}
      />
    </FeatureFlagAdapterProvider>
  );
  const card = [...container.querySelectorAll(CARD_SLOT)].find((node) =>
    node.textContent?.includes("LOC/$")
  );
  if (!card) {
    throw new Error("LOC per $ card did not render");
  }
  return [...(card.textContent ?? "").matchAll(RATIO_READING)].map(
    ([reading]) => reading
  );
}

afterEach(() => {
  cleanup();
});

describe("ISS-9972 the Branches cost basis does not vary with flag state", () => {
  it("states the same LOC per $ reading with every flag on and with none on", () => {
    const allOn = locPerDollarReadingsWith(EVERY_FLAG);
    cleanup();
    const allOff = locPerDollarReadingsWith([]);

    expect(allOn).toEqual(["1,234.5 LOC/$"]);
    expect(allOff).toEqual(allOn);
  });

  it("renders no standalone AI spend dollar card in either flag state", () => {
    for (const enabledFlags of [EVERY_FLAG, []]) {
      cleanup();
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [...enabledFlags],
          })}
        >
          <ApprovedBranchesSummaryCards
            cardClassName="card"
            isError={false}
            isPending={false}
            metrics={makeBranchListMetrics({
              aiSpendUsd: {
                current: {
                  state: BranchMetricAvailability.Complete,
                  value: 20.39,
                },
              },
              canonicalLocPerDollar: PARTIAL_LOC_PER_DOLLAR,
            })}
          />
        </FeatureFlagAdapterProvider>
      );

      expect(screen.queryByText(SPEND_FIGURE)).toBeNull();
      expect(screen.queryByText(AI_SPEND_LABEL, { exact: false })).toBeNull();
    }
  });
});
