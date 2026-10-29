/**
 * @file approved-branches-summary-cards-comparison-slot.test.tsx
 * @description ISS-9960, as reversed by the operator ruling of 2026-09-16: the
 * Branches summary cards' comparison slot behaves identically to the Sessions
 * listing metrics cards. A card publishes its comparison whenever there is one
 * to speak about, and renders no slot only on genuine absence — the `All time`
 * range, which the producer ships with no `comparison` at all.
 *
 * What this replaces: the slot used to be RETIRED behind
 * `total-estimated-cost-metrics` whenever a delta could not be drawn, on the
 * evidence that "No comparison" was the steady state of every tile in every
 * window. `buildBranchMetricComparison` had refused a delta the moment either
 * window was Partial and on real data every non-count Branches metric is
 * Partial, so the producer's refusal — not an uncomputable comparison — is what
 * emptied the slot. ISS-10540 removes that refusal (ISS-10208 measured it; its
 * #7447 closed unmerged). The fixtures below supply `deltaPct` directly, so
 * they pin what the slot does in the RESIDUAL case where a side produced no
 * number; what is no longer true is the premise that the case is universal.
 * The gate is therefore gone from this card, and the cases that pinned the retirement are
 * inverted here rather than kept as controls over a rule that no longer exists.
 *
 * ISS-10636 retired that gate, so every case here now renders with NO flag
 * seeded — the state every real reader is in, and the only state left.
 *
 * Every expected string below is a LITERAL, deliberately NOT imported from
 * `branch-list-comparison-copy`. A fixture that read its expectation from the
 * copy module the component renders would still pass if the chip and its
 * sentences were deleted together.
 */
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/** The shared "No comparison" affordance's marker. */
const DELTA_PLACEHOLDER = "kpi-delta-placeholder";
/** The marker a REAL delta renders under. */
const DELTA_CHIP = "metric-delta-chip";
const NO_COMPARISON_COPY = "No comparison";
const ACTIVE_BRANCHES_LABEL = "Active branches";
/** The window label a live delta's chip carries beside the percentage. */
const WINDOW_CAPTION = "MoM";
/**
 * The scope caption under every Active branches figure (product ruling,
 * 2026-09-22: the approved prototype's phrase, on every card in every range).
 */
const SCOPE_CAPTION = "in progress";

const PRIOR_WINDOW = {
  startAt: "2026-06-06T00:00:00.000Z",
  endAt: "2026-07-06T00:00:00.000Z",
} as const;

/**
 * One numeric card in a finite (month-over-month) window, carrying whatever
 * `deltaPct` the producer managed. Active branches is the row's count card, so
 * its value renders as a bare number this suite can pin exactly.
 */
function metricsWithDelta(
  deltaPct:
    | { state: typeof BranchMetricAvailability.Complete; value: number }
    | { state: typeof BranchMetricAvailability.Unavailable; value: null }
    | undefined
) {
  return makeBranchListMetrics({
    label: BranchMetricComparisonLabel.MonthOverMonth,
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value: 12 },
      comparison: {
        label: BranchMetricComparisonLabel.MonthOverMonth,
        priorWindow: PRIOR_WINDOW,
        // Cast at the fixture, not in the component: `deltaPct` is required by
        // the in-process type, and the case below is precisely the payload a
        // version-skewed producer can put on the wire that the type forbids
        // in-process (AGENTS.md → Handling Bad or Nonsensical Data: the
        // type-forbidden carve-out stops at every trust boundary).
        deltaPct,
      } as BranchListMetricValue["comparison"],
    },
  });
}

/**
 * An `All time` bundle. The producer ships NO `comparison` on any metric in this
 * range — `metricValue` returns a bare `{ current }` for that label
 * (`packages/lib/branches/branch-list-metrics.ts`) — so these cards have no
 * comparison window to speak about. This is the genuine absence.
 */
function allTimeMetrics() {
  return makeBranchListMetrics({
    period: BranchMetricPeriod.All,
    label: BranchMetricComparisonLabel.AllTime,
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value: 12 },
    },
  });
}

const NO_COMPUTABLE_DELTA = {
  state: BranchMetricAvailability.Unavailable,
  value: null,
} as const;

const REAL_DELTA = {
  state: BranchMetricAvailability.Complete,
  value: 12.5,
} as const;

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

/** The one card in this row carrying a numeric value. */
function activeBranchesCard(): HTMLElement {
  const card = screen
    .getByText(ACTIVE_BRANCHES_LABEL)
    .closest("[data-slot='card']");
  if (!card) {
    throw new Error("Active branches card did not render");
  }
  return card as HTMLElement;
}

describe("ISS-9960 the Branches comparison slot", () => {
  it("still speaks about a measured window whose delta the producer could not state", () => {
    renderRow({
      enabledFlags: [],
      metrics: metricsWithDelta(NO_COMPUTABLE_DELTA),
    });

    const placeholder = within(activeBranchesCard()).getByTestId(
      DELTA_PLACEHOLDER
    );
    expect(placeholder.textContent).toContain(NO_COMPARISON_COPY);
  });

  it("renders a real delta, with its window label in the chip, beside the figure", () => {
    renderRow({
      enabledFlags: [],
      metrics: metricsWithDelta(REAL_DELTA),
    });

    const card = activeBranchesCard();
    expect(within(card).getByTestId(DELTA_CHIP)).toBeInTheDocument();
    expect(card.textContent).toContain(WINDOW_CAPTION);
    expect(within(card).queryByTestId(DELTA_PLACEHOLDER)).toBeNull();
  });

  /**
   * The cross-repo boundary (whitlockk review). `comparison` is a wire payload, and
   * a producer on either side of a version skew can send the object without
   * `deltaPct`. With the slot no longer gated, every Branches card runs this
   * path on every render, so an unchained read there is a crashed row rather
   * than a missing chip. The card must take the no-comparison path it already
   * takes for an absent `comparison`.
   */
  it("takes the no-comparison path for a comparison carrying no deltaPct", () => {
    renderRow({
      enabledFlags: [],
      metrics: metricsWithDelta(undefined),
    });

    const card = activeBranchesCard();
    expect(within(card).getByTestId(DELTA_PLACEHOLDER).textContent).toContain(
      NO_COMPARISON_COPY
    );
    // The positive control on the same locator: the figure the skewed payload
    // sits under still renders, so the assertion above is about the slot and
    // not about a row that failed to mount.
    expect(within(card).getByText("12")).toBeInTheDocument();
    expect(within(card).queryByTestId(DELTA_CHIP)).toBeNull();
  });

  /**
   * The genuine absence, and the only one. `All time` never carries a
   * comparison, so there is no slot — and the scope caption under the figure
   * is the same phrase every other range shows, so nothing on the card claims
   * a window that is not being compared.
   */
  it("renders no slot, and keeps the scope caption, for an all-time range", () => {
    renderRow({
      enabledFlags: [],
      metrics: allTimeMetrics(),
    });

    const card = activeBranchesCard();
    // The positive anchor: the figure resolves, so the absence below is a real
    // difference rather than a locator that was never going to match.
    expect(within(card).getByText("12")).toBeInTheDocument();
    expect(card.textContent).toContain(SCOPE_CAPTION);
    expect(within(card).queryByTestId(DELTA_PLACEHOLDER)).toBeNull();
  });
});
