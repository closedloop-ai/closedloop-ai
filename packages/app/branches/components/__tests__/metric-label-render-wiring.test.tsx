/**
 * ISS-10667 render-wiring proof for the Branches surfaces.
 *
 * A reviewer found the ISS-10667 suite was a false green: every component that
 * grew a `useFeatureFlagEnabledOptional(ONE_LABEL_PER_METRIC_FLAG_KEY)` read
 * could have that read deleted with the whole suite staying green, because
 * nothing rendered the REAL component through the REAL flag adapter and
 * asserted both arms. This file does that for the Branches LOC-per-dollar
 * card, on both the settled row and the honest-loading shell, and for the
 * Branch detail headline card — driving the flag through the real
 * `FeatureFlagAdapterProvider` and scoping every assertion to the one card the
 * label lives on, so deleting the flag read fails the ON case.
 */
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { ONE_LABEL_PER_METRIC_FLAG_KEY } from "@repo/api/src/types/one-label-per-metric-flag";
import { PUSHED_LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../../lib/branches-summary-honest-loading-flag";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";

/** The dictionary word `ONE_LABEL_PER_METRIC_FLAG_KEY` retires on this surface. */
const LEGACY_LOC_LABEL = "LOC per $";

/** A `BranchListMetricValue` (the summary-row bundle's shape). */
function completeListValue(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

/** A bare `BranchMetricResult<number>` (the detail bundle's shape). */
function completeResult(value: number) {
  return { state: BranchMetricAvailability.Complete, value } as const;
}

function ratioCard(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error(`ratio card "${label}" is missing`);
  }
  return card;
}

function renderSettledRow(enabledFlags: readonly string[]) {
  // ISS-10636 retired the gate that used to pick the shipped four-card row, so
  // BOTH arms render the canonical strip and its ratio card reads
  // `canonicalLocPerDollar`. What the gate still decides is the WORD over that
  // one figure, which is what the two cases below distinguish.
  const metrics = makeBranchListMetrics({
    activeBranches: completeListValue(3),
    aiSpendUsd: completeListValue(100),
    canonicalLocPerDollar: completeListValue(4.25),
    medianPrSize: completeListValue(120),
    mergeRatePct: completeListValue(50),
  });
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

function renderLoadingShell(enabledFlags: readonly string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending
        metrics={undefined}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("ApprovedBranchesSummaryCards LOC-per-dollar label (ISS-10667)", () => {
  it("settled card: names the ratio with the canonical pushed-basis word when the gate is on", () => {
    renderSettledRow([ONE_LABEL_PER_METRIC_FLAG_KEY]);

    expect(ratioCard(PUSHED_LOC_PER_DOLLAR_LABEL)).toHaveTextContent(
      "4.25 LOC/$"
    );
    expect(screen.queryByText(LEGACY_LOC_LABEL)).not.toBeInTheDocument();
  });

  it("settled card: keeps the shipped dictionary word when the gate is off", () => {
    renderSettledRow([]);

    expect(ratioCard(LEGACY_LOC_LABEL)).toHaveTextContent("4.25 LOC/$");
    expect(
      screen.queryByText(PUSHED_LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
  });

  it("honest-loading shell: names the still-loading ratio slot with the canonical word when the gate is on", () => {
    renderLoadingShell([
      BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
      ONE_LABEL_PER_METRIC_FLAG_KEY,
    ]);

    expect(screen.getByText(PUSHED_LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LEGACY_LOC_LABEL)).not.toBeInTheDocument();
  });

  it("honest-loading shell: keeps the shipped dictionary word when only the loading gate is on", () => {
    renderLoadingShell([BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY]);

    expect(screen.getByText(LEGACY_LOC_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByText(PUSHED_LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
  });
});

const unavailable = {
  state: BranchMetricAvailability.Unavailable,
  value: null,
} as const;

function renderHeadlineCards(enabledFlags: readonly string[]) {
  const detail = makeBranchDetail({
    canonicalMetrics: {
      abandonmentTimeMs: unavailable,
      idleTimeMs: unavailable,
      leadTimeMs: unavailable,
      locPerDollar: completeResult(6),
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: unavailable,
        [BranchVisibleLifecyclePhase.Review]: unavailable,
        [BranchVisibleLifecyclePhase.Rework]: unavailable,
      },
      totalCostUsd: unavailable,
    },
  });
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <BranchHeadlineCards detail={detail} />
    </FeatureFlagAdapterProvider>
  );
}

describe("BranchHeadlineCards LOC-per-dollar label (ISS-10667)", () => {
  it("names the Branch-detail ratio with the canonical pushed-basis word when the gate is on", () => {
    renderHeadlineCards([ONE_LABEL_PER_METRIC_FLAG_KEY]);

    expect(ratioCard(PUSHED_LOC_PER_DOLLAR_LABEL)).toHaveTextContent("6.00");
    expect(screen.queryByText(LEGACY_LOC_LABEL)).not.toBeInTheDocument();
  });

  it("keeps the shipped dictionary word when the gate is off", () => {
    renderHeadlineCards([]);

    expect(ratioCard(LEGACY_LOC_LABEL)).toHaveTextContent("6.00");
    expect(
      screen.queryByText(PUSHED_LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
  });
});
