import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "../branch-analytics-fixtures";
import { BranchesSummaryCards } from "../branches-summary-cards";

/**
 * ISS-9730 wired end to end on the row a reader actually sees.
 *
 * `BranchesSummaryCards` is mounted here exactly as
 * `apps/app/.../branches/page.tsx` and `apps/desktop/.../branches-view.tsx` both
 * mount it, so the component under test reaches
 * `ApprovedBranchesSummaryCards` the same way production does. The primitive's
 * own suite proves the hide; this suite proves the PostHog key reaches it.
 * Wiring only the legacy `BranchKpiCard` path passed the primitive's tests while
 * changing nothing on either live surface (chatgpt-codex-connector, #6829) —
 * ISS-9961 has since deleted that unreachable path, so the mount this file
 * performs and the one production performs are now the only one there is.
 *
 * Every case runs the SAME fixture in both gate positions, so a test cannot pass
 * merely because the gate was unavailable.
 */
const LOC_PER_DOLLAR = "LOC per $";
const MEDIAN_PR_SIZE = "Median PR size";
const MERGE_RATE = "Merge rate";
const ACTIVE_BRANCHES = "Active branches";
const UNAVAILABLE_CAPTION = "Unavailable";

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

function absent(
  state:
    | typeof BranchMetricAvailability.NoData
    | typeof BranchMetricAvailability.NotApplicable
    | typeof BranchMetricAvailability.Unavailable
) {
  return { current: { state, value: null } } as const;
}

/**
 * One not-computable card in a row whose siblings resolved.
 *
 * The not-computable one is Median PR size, NOT the ratio: ISS-9958 marks LOC
 * per $ `neverHidden`, so a fixture that made the ratio absent would prove
 * nothing about the gate — it would stay on screen either way. The ratio's
 * exemption is its own case below.
 */
function oneUnavailableRow() {
  return makeBranchListMetrics({
    activeBranches: complete(7),
    canonicalLocPerDollar: complete(4),
    medianPrSize: absent(BranchMetricAvailability.Unavailable),
    mergeRatePct: complete(80),
    totalLocPushed: complete(1000),
  });
}

function renderRow({
  enabled,
  metrics,
  ...props
}: {
  enabled: boolean;
  metrics: ReturnType<typeof makeBranchListMetrics> | undefined;
} & Partial<ComponentProps<typeof BranchesSummaryCards>>) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled
          ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <BranchesSummaryCards
        analytics={
          metrics
            ? makeBranchAnalytics({ canonicalMetrics: metrics })
            : undefined
        }
        isError={false}
        isPending={false}
        {...props}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("BranchesSummaryCards approved row, metric-card-hide-unavailable", () => {
  it("keeps the not-computable card and its caption while the gate is off", () => {
    renderRow({ enabled: false, metrics: oneUnavailableRow() });
    expect(screen.getByText(MEDIAN_PR_SIZE)).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_CAPTION)).toBeInTheDocument();
  });

  it("removes that card from the live approved row when the gate is on", () => {
    renderRow({ enabled: true, metrics: oneUnavailableRow() });
    // The card is GONE — label and caption both — while every sibling that
    // resolved is untouched. Asserting only the caption would stay green for a
    // card that still rendered its frame under a different word.
    expect(screen.queryByText(MEDIAN_PR_SIZE)).not.toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE_CAPTION)).not.toBeInTheDocument();
    for (const label of [ACTIVE_BRANCHES, LOC_PER_DOLLAR, MERGE_RATE]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  // ISS-9958's exemption, driven through the same live mount: the ratio is the
  // one card the gate may never retire, so an absent ratio in an otherwise
  // resolved row keeps its frame and states its own absence.
  it("keeps the ratio card on screen when the gate is on and the ratio is absent", () => {
    renderRow({
      enabled: true,
      metrics: makeBranchListMetrics({
        activeBranches: complete(7),
        canonicalLocPerDollar: absent(BranchMetricAvailability.Unavailable),
        medianPrSize: complete(148),
        mergeRatePct: complete(80),
        totalLocPushed: complete(1000),
      }),
    });

    expect(screen.getByText(LOC_PER_DOLLAR)).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_CAPTION)).toBeInTheDocument();
  });

  it("still renders every card while the read is pending", () => {
    renderRow({ enabled: true, isPending: true, metrics: undefined });
    expect(screen.getByText(LOC_PER_DOLLAR)).toBeInTheDocument();
    expect(screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL).length).toBe(5);
  });

  it("still renders every card when the read FAILED", () => {
    renderRow({ enabled: true, isError: true, metrics: undefined });
    // An error is not an absence: hiding it deletes the reader's only signal.
    expect(screen.getByText(LOC_PER_DOLLAR)).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBe(5);
  });

  /**
   * ISS-9970 retired this row's standalone AI-spend card, and with it the
   * `$0.00` this case used to assert. The CLAIM it pinned — a computed zero is a
   * fact about the population and the gate must not eat it as an absence — is
   * unchanged and now rides on the surviving cost-derived card, so it is
   * asserted there rather than dropped.
   */
  it("renders a real zero ratio, which is a fact about the population", () => {
    renderRow({
      enabled: true,
      metrics: makeBranchListMetrics({
        activeBranches: complete(7),
        aiSpendUsd: complete(0),
        canonicalLocPerDollar: complete(0),
        medianPrSize: complete(148),
        mergeRatePct: complete(80),
      }),
    });
    expect(screen.getByText(LOC_PER_DOLLAR)).toBeInTheDocument();
    expect(screen.getByText("0 LOC/$")).toBeInTheDocument();
  });

  // The ratio is `neverHidden` (ISS-9958), so this case states the N/A claim on
  // the card whose exemption does NOT do the work — its own exemption case is
  // above, and pinning both here is what keeps them distinguishable.
  it("keeps an N/A card, because not-applicable is an answer and not an absence", () => {
    renderRow({
      enabled: true,
      metrics: makeBranchListMetrics({
        activeBranches: complete(7),
        aiSpendUsd: complete(120),
        canonicalLocPerDollar: absent(BranchMetricAvailability.NotApplicable),
        medianPrSize: complete(148),
        mergeRatePct: complete(80),
      }),
    });
    expect(screen.getByText(LOC_PER_DOLLAR)).toBeInTheDocument();
    // The value slot and its caption both read "N/A" on this state.
    expect(screen.getAllByText("N/A").length).toBe(2);
  });

  it("hides a no_data card too, which is the same claim as unavailable", () => {
    renderRow({
      enabled: true,
      metrics: makeBranchListMetrics({
        activeBranches: complete(7),
        canonicalLocPerDollar: complete(4),
        medianPrSize: absent(BranchMetricAvailability.NoData),
        mergeRatePct: complete(80),
        totalLocPushed: complete(1000),
      }),
    });
    expect(screen.queryByText(MEDIAN_PR_SIZE)).not.toBeInTheDocument();
  });

  it("keeps the whole row when EVERY card would go, rather than emptying it", () => {
    // ISS-9730 acceptance 3 — what a row with zero cards looks like is an
    // undecided design question (ISS-9749), so the gate must not produce one.
    // The default fixture leaves every card unavailable, i.e. a corpus with
    // nothing computable at all.
    renderRow({ enabled: true, metrics: makeBranchListMetrics() });
    for (const label of [
      ACTIVE_BRANCHES,
      LOC_PER_DOLLAR,
      MEDIAN_PR_SIZE,
      MERGE_RATE,
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("keeps a card whose absence is blamed on the reader's own filter", () => {
    renderRow({
      approvedComparisonSuppressedByFilter: true,
      enabled: true,
      metrics: oneUnavailableRow(),
    });
    // Hiding this deletes the only signal that a facet, not the data, caused
    // the absence — a trade ISS-9730's four-state table does not cover.
    expect(screen.getByText(MEDIAN_PR_SIZE)).toBeInTheDocument();
    expect(
      screen.getByText("Not available with filters applied")
    ).toBeInTheDocument();
  });
});
