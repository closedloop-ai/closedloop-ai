import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { phaseAttributionSegment } from "@repo/lib/branches/__tests__/branch-phase-attribution-fixture";
import { calculateBranchDetailMetrics } from "@repo/lib/branches/branch-detail-outcomes";
import { compactBranchDetailPayload } from "@repo/lib/branches/branch-detail-payload";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail as detail } from "../../__tests__/branch-fixtures";
import {
  BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE,
  BRANCH_COST_BREAKDOWN_NO_PRICED_COST,
  BranchCostToMerge,
} from "../branch-cost-to-merge";

/**
 * ISS-8551: the card renders the sentence the PRODUCER attached to the partial
 * figure, so the legend is located through that constant rather than through a
 * component-owned one the card no longer declares.
 */
const PARTIAL_LEGEND = BranchMetricDisclosure.CostIncomplete;
/**
 * The sentence the kernel attaches when the rows' own cost evidence is whole and
 * merely disagrees with the canonical total — no unpriced activity was excluded,
 * so `CostIncomplete` would name a cause that arm does not have (tamsinb
 * review, PR #7912).
 */
const DISAGREEING_ROWS_LEGEND = BranchMetricDisclosure.DefaultIncomplete;

const PERCENT_RE = /(\d+)%/;
const STARRED_TOTAL_RE = /\$24\.00\*/;

describe("BranchCostToMerge", () => {
  it.each([false, true])(
    "preserves rendered costs after payload compaction (honesty flag: %s)",
    (enabled) => {
      const phaseAttribution = attribution(60_000, 30_000, 10_000);
      phaseAttribution.segments = [
        phaseAttributionSegment({
          sessionId: "s1",
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: 0,
          endMs: 60_000,
          estimatedCostUsd: 6,
        }),
      ];
      const raw = detail({
        canonicalMetrics: metricBundle({
          phaseCostUsd: phaseCosts(6, 3, 1),
          totalCostUsd: complete(10),
        }),
        phaseAttribution,
      });
      const wrap = (node: ReactNode) => (enabled ? withHonestFlag(node) : node);
      const { container, rerender } = render(
        wrap(<BranchCostToMerge detail={raw} />)
      );
      const before = container.innerHTML;
      expect(screen.getByText("$10.00")).toBeInTheDocument();
      rerender(
        wrap(<BranchCostToMerge detail={compactBranchDetailPayload(raw)} />)
      );
      expect(container.innerHTML).toBe(before);
    }
  );

  it("renders the exact Build, Review, and Rework lifetime-cost contract", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(6, 3, 1),
            totalCostUsd: complete(10),
          }),
          phaseAttribution: attribution(60_000, 30_000, 10_000),
        })}
      />
    );

    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Rework")).toBeInTheDocument();
    expect(screen.getByText("1m 0s · $6.00 · 60%")).toBeInTheDocument();
    expect(screen.getByText("30.0s · $3.00 · 30%")).toBeInTheDocument();
    expect(screen.getByText("10.0s · $1.00 · 10%")).toBeInTheDocument();
    expect(
      screen.queryByText(ACTIVITY_PHASE_LABEL.other)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(ACTIVITY_PHASE_LABEL.unattributed)
    ).not.toBeInTheDocument();
  });

  it("keeps all three approved rows when a phase has zero cost", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(2, 0, 1),
            totalCostUsd: complete(3),
          }),
          phaseAttribution: attribution(20_000, 0, 10_000),
        })}
      />
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("0ms · $0.00 · 0%")).toBeInTheDocument();
  });

  it("marks incomplete phase values and explains the qualifying-cost subtotal", () => {
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: {
              [BranchVisibleLifecyclePhase.Build]: partial(2),
              [BranchVisibleLifecyclePhase.Review]: partial(1),
              [BranchVisibleLifecyclePhase.Rework]: partial(0),
            },
            totalCostUsd: partial(3),
          }),
          phaseAttribution: attribution(20_000, 10_000, 0),
        })}
      />
    );

    expect(screen.getByText("$3.00*")).toBeInTheDocument();
    // No percentage: rows flagged incomplete are not a decomposition of the
    // header, so their share of it is withheld rather than misstated.
    expect(screen.getByText("20.0s · $2.00*")).toBeInTheDocument();
    expect(screen.getByText(PARTIAL_LEGEND)).toBeInTheDocument();
  });

  it("uses largest-remainder percentages so the rows reconcile to 100", () => {
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(1, 1, 1),
            totalCostUsd: complete(3),
          }),
          phaseAttribution: attribution(1, 1, 1),
        })}
      />
    );
    const percents = Array.from(
      container.querySelectorAll(".bq-costbd-val")
    ).map((node) => {
      const match = node.textContent?.match(PERCENT_RE);
      return match ? Number(match[1]) : Number.NaN;
    });

    expect(percents).toHaveLength(3);
    expect(percents.reduce((sum, percent) => sum + percent, 0)).toBe(100);
  });

  it("renders honest unavailable and zero-cost states", () => {
    const { rerender } = render(
      <BranchCostToMerge
        detail={detail({ canonicalMetrics: metricBundle() })}
      />
    );
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).toBeInTheDocument();

    rerender(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(0, 0, 0),
            totalCostUsd: complete(0),
          }),
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_NO_PRICED_COST)
    ).toBeInTheDocument();
  });

  it("ISS-6956: a complete zero total prints the em dash, never $0.00", () => {
    // The headline state: coverage is COMPLETE, so there is no marker and no
    // legend, and the card's whole claim is the sentence. `$0.00` beside it
    // asserted a measurement the sentence denies.
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(0, 0, 0),
            totalCostUsd: complete(0),
          }),
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_NO_PRICED_COST)
    ).toBeInTheDocument();
    // No marker to explain, so the legend stays away rather than appearing
    // beside a figure that carries no asterisk.
    expect(screen.queryByText(PARTIAL_LEGEND)).not.toBeInTheDocument();
  });

  it("ISS-6956: withholds the zero figure on the honest arm too", () => {
    // The flag is the one input that resolves differently per shell — PostHog in
    // the browser, DesktopFeatureFlagProvider in Electron — so a fix that landed
    // on only one arm would reach only one of them.
    renderHonestCost(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(0, 0, 0),
            totalCostUsd: complete(0),
          }),
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_NO_PRICED_COST)
    ).toBeInTheDocument();
  });

  it("ISS-6956: explains the header marker when the phase rows are unavailable", () => {
    // The rows guard returns ABOVE the unpriced arm, so this is the one path
    // that can carry the header's asterisk with no legend under it.
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({ totalCostUsd: partial(0) }),
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );

    expect(screen.getByText("—*")).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).toBeInTheDocument();
    expect(screen.getByText(PARTIAL_LEGEND)).toBeInTheDocument();
  });

  it("withholds impossible total and phase values instead of clamping to zero", () => {
    const { rerender } = renderHonestCost(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(6, 3, 1),
            totalCostUsd: complete(Number.NaN),
          }),
          phaseAttribution: attribution(60_000, 30_000, 10_000),
        })}
      />
    );

    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();

    rerender(
      withHonestFlag(
        <BranchCostToMerge
          detail={detail({
            canonicalMetrics: metricBundle({
              phaseCostUsd: phaseCosts(-1, 3, 1),
              totalCostUsd: complete(3),
            }),
            phaseAttribution: attribution(60_000, 30_000, 10_000),
          })}
        />
      )
    );

    expect(screen.getByText("$3.00")).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).toBeInTheDocument();
    expect(screen.queryByText("-$1.00")).not.toBeInTheDocument();
  });

  it("withholds phase rows when their duration evidence is impossible", () => {
    renderHonestCost(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(6, 3, 1),
            totalCostUsd: complete(10),
          }),
          phaseAttribution: attribution(-1, 30_000, 10_000),
        })}
      />
    );

    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE)
    ).toBeInTheDocument();
    expect(screen.queryByText("-1ms")).not.toBeInTheDocument();
  });

  it("ISS-6949: shows the branch's attributed cost with the phase rows starred", () => {
    // Derived through the real kernel, not hand-typed: the point is that the
    // header stops being the rollup residue.
    const metrics = kernelMetrics({ attributedCostUsd: 24, rollupCostUsd: 8 });
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metrics,
          phaseAttribution: attribution(20_000, 0, 0),
        })}
      />
    );

    expect(screen.getByText("$24.00")).toBeInTheDocument();
    expect(screen.queryByText("$8.00")).not.toBeInTheDocument();
    expect(
      screen.queryByText(BRANCH_COST_BREAKDOWN_NO_PRICED_COST)
    ).not.toBeInTheDocument();
    // Coverage is Complete and every segment event is priced here, so the only
    // shortfall is the $8 rollup disagreeing with the $24 total.
    expect(screen.getByText(DISAGREEING_ROWS_LEGEND)).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL_LEGEND)).not.toBeInTheDocument();
    // Rows that do not account for the header carry no share of it.
    expect(document.querySelector(".bq-cost-bar")).toBeNull();
  });

  it("ISS-8551: prints the sentence the PRODUCER attached, not one of the card's own", () => {
    // The whole point of the change, and the only case that can prove it. Every
    // other legend assertion in this file would pass just as well against a card
    // that hardcoded `CostIncomplete`, because that is what the kernel happens
    // to attach. Here the producer attaches a DIFFERENT canonical sentence, so
    // a card choosing its own would print the wrong shortfall — and the
    // `queryByText` on the sentence it used to hardcode is what catches that.
    const metrics = kernelMetrics({ attributedCostUsd: 24, rollupCostUsd: 24 });
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: {
            ...metrics,
            phaseCostUsd: {
              [BranchVisibleLifecyclePhase.Build]: complete(24),
              [BranchVisibleLifecyclePhase.Review]: complete(0),
              [BranchVisibleLifecyclePhase.Rework]: complete(0),
            },
            totalCostUsd: {
              state: BranchMetricAvailability.Partial,
              value: 24,
              disclosure: BranchMetricDisclosure.DefaultIncomplete,
            },
          },
          phaseAttribution: attribution(20_000, 0, 0),
        })}
      />
    );

    expect(
      screen.getByText(BranchMetricDisclosure.DefaultIncomplete)
    ).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL_LEGEND)).not.toBeInTheDocument();
  });

  it("ISS-6956: an unpriced total prints no figure, and keeps its coverage marker", () => {
    // EXPECTATION CHANGED by ISS-6956. This asserted `$0.00*` — a measurement
    // sitting directly above a sentence denying any measurement happened.
    //
    // What ISS-6949 put here is NOT reverted: at zero the body returns before
    // the rows, so the marker is still this card's only coverage signal, and it
    // survives the swap onto the em dash. Its legend is returned alongside now,
    // so the asterisk it explains is no longer the one thing left unexplained.
    const metrics = kernelMetrics({
      attributedCostUsd: 0,
      rollupCostUsd: 0,
      coverageComplete: false,
    });
    render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metrics,
          phaseAttribution: attribution(0, 0, 0),
        })}
      />
    );

    expect(screen.getByText("—*")).toBeInTheDocument();
    expect(screen.queryByText("$0.00*")).not.toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_COST_BREAKDOWN_NO_PRICED_COST)
    ).toBeInTheDocument();
    expect(screen.getByText(PARTIAL_LEGEND)).toBeInTheDocument();
  });

  it("ISS-6949: renders the attributed header even when the rows over-attribute", () => {
    const metrics = kernelMetrics({ attributedCostUsd: 8, rollupCostUsd: 24 });
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metrics,
          phaseAttribution: attribution(20_000, 0, 0),
        })}
      />
    );
    const rowText = Array.from(
      container.querySelectorAll(".bq-costbd-val")
    ).map((node) => node.textContent ?? "");

    expect(screen.getByText("$8.00")).toBeInTheDocument();
    expect(screen.getByText(STARRED_TOTAL_RE)).toBeInTheDocument();
    // The rows do not decompose the header, so there is no honest share to
    // report: the percentages and the composition bar are withheld rather than
    // rendering values that sum past 100.
    expect(rowText.every((text) => !PERCENT_RE.test(text))).toBe(true);
    expect(container.querySelector(".bq-cost-bar")).toBeNull();
  });

  it("ISS-6949: keeps shares within 100 when the rows reconcile only at displayed cents", () => {
    // whitlockk review: the kernel reconciles rows against the header through
    // `roundDisplayedCost`, so a $1.004 column under a $0.995 attributed total
    // both render "$1.00" and legitimately count as accounting for it. Dividing
    // by the raw header there reported 101% on a row and overfilled the bar.
    const metrics = kernelMetrics({
      attributedCostUsd: 0.995,
      rollupCostUsd: 1.004,
    });
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metrics,
          phaseAttribution: attribution(20_000, 0, 0),
        })}
      />
    );
    const percents = Array.from(
      container.querySelectorAll(".bq-costbd-val")
    ).map((node) => {
      const match = node.textContent?.match(PERCENT_RE);
      return match ? Number(match[1]) : Number.NaN;
    });
    const widths = Array.from(
      container.querySelectorAll<HTMLElement>(".bq-cost-seg")
    ).map((node) => Number.parseFloat(node.style.width));

    expect(screen.getAllByText("$1.00").length).toBeGreaterThan(0);
    expect(percents).toEqual([100, 0, 0]);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 6);
    expect(widths.every((width) => width <= 100)).toBe(true);
  });

  it("ISS-6949: withholds shares when a zero column sits under a nonzero header", () => {
    // Both figures round to "$0.00", so the rows reconcile — but every row would
    // read 0% of a header the card is presenting as cost.
    const metrics = kernelMetrics({
      attributedCostUsd: 0.004,
      rollupCostUsd: 0,
    });
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metrics,
          phaseAttribution: attribution(20_000, 0, 0),
        })}
      />
    );
    const rowText = Array.from(
      container.querySelectorAll(".bq-costbd-val")
    ).map((node) => node.textContent ?? "");

    expect(rowText.every((text) => !PERCENT_RE.test(text))).toBe(true);
    expect(container.querySelector(".bq-cost-bar")).toBeNull();
  });

  it("marks the segmented bar decorative because rows carry the values", () => {
    const { container } = render(
      <BranchCostToMerge
        detail={detail({
          canonicalMetrics: metricBundle({
            phaseCostUsd: phaseCosts(1, 1, 0),
            totalCostUsd: complete(2),
          }),
          phaseAttribution: attribution(1, 1, 0),
        })}
      />
    );
    expect(container.querySelector(".bq-cost-bar")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });
});

function withHonestFlag(children: ReactNode) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function renderHonestCost(children: ReactNode) {
  return render(withHonestFlag(children));
}

function kernelMetrics(input: {
  attributedCostUsd: number | null;
  rollupCostUsd: number;
  coverageComplete?: boolean;
}) {
  const complete = input.coverageComplete ?? true;
  return calculateBranchDetailMetrics({
    attributedCostUsd: input.attributedCostUsd,
    selectedCycle: null,
    selectedPrAdditions: 100,
    selectedPrDeletions: 0,
    selectedPrLocComplete: true,
    phaseAttribution: {
      segments: [
        phaseAttributionSegment({
          sessionId: "s1",
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: 0,
          endMs: 1,
          estimatedCostUsd: input.rollupCostUsd,
        }),
      ],
      rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
        phase,
        estimatedCostUsd:
          phase === BranchVisibleLifecyclePhase.Build ? input.rollupCostUsd : 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 1,
      })),
      coverage: complete
        ? {
            completeness: BranchPhaseAttributionCompleteness.Complete,
            subtotalUsd: input.rollupCostUsd,
          }
        : {
            completeness: BranchPhaseAttributionCompleteness.Partial,
            reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
            subtotalUsd: input.rollupCostUsd,
          },
    },
  });
}

function metricBundle(
  overrides: Partial<{
    phaseCostUsd: Record<
      BranchVisibleLifecyclePhase,
      BranchMetricResult<number>
    >;
    totalCostUsd: BranchMetricResult<number>;
  }> = {}
) {
  const unavailable = unavailableMetric();
  return {
    abandonmentTimeMs: unavailable,
    idleTimeMs: unavailable,
    leadTimeMs: unavailable,
    locPerDollar: unavailable,
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: unavailable,
      [BranchVisibleLifecyclePhase.Review]: unavailable,
      [BranchVisibleLifecyclePhase.Rework]: unavailable,
    },
    totalCostUsd: unavailable,
    ...overrides,
  };
}

function phaseCosts(build: number, review: number, rework: number) {
  return {
    [BranchVisibleLifecyclePhase.Build]: complete(build),
    [BranchVisibleLifecyclePhase.Review]: complete(review),
    [BranchVisibleLifecyclePhase.Rework]: complete(rework),
  };
}

function attribution(
  buildDurationMs: number,
  reviewDurationMs: number,
  reworkDurationMs: number
): BranchPhaseAttributionResult {
  const durations = {
    [BranchVisibleLifecyclePhase.Build]: buildDurationMs,
    [BranchVisibleLifecyclePhase.Review]: reviewDurationMs,
    [BranchVisibleLifecyclePhase.Rework]: reworkDurationMs,
  };
  return {
    segments: [],
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: durations[phase],
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    },
  };
}

function complete(value: number): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Complete, value };
}

function partial(value: number): BranchMetricResult<number> {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure: BranchMetricDisclosure.CostIncomplete,
  };
}

function unavailableMetric(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}
