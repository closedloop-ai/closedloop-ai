"use client";

import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricId,
  type BranchMetricResult,
  BranchMetricUnit,
} from "@repo/api/src/types/branch-metrics";
// Cross-slice on purpose (ISS-5714): `KpiDeltaPlaceholder` is the ONE
// "no comparison" affordance in this app, already rendered in this exact
// `MetricCard` slot by Insights and by the Sessions summary row (FEA-3960).
// Re-declaring a branches-local variant is how the slot drifted into a bare
// "Unavailable" under a real number in the first place.
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { ReactNode } from "react";
import { describeMissingBranchComparison } from "../lib/branch-list-comparison-copy";

type CardSpec = {
  id: BranchMetricId;
  select: (bundle: BranchListMetricBundle) => BranchListMetricValue;
  polarity: MetricPolarity;
  info: { what: string; how: string };
};

const CARDS: readonly CardSpec[] = [
  {
    id: BranchMetricId.ActiveBranches,
    select: (bundle) => bundle.activeBranches,
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Branches still in progress (not merged, closed, or canceled).",
      how: "Based on the Branch status already stored in ClosedLoop; no live GitHub request is made for this metric.",
    },
  },
  {
    id: BranchMetricId.ListLocPerDollar,
    select: (bundle) => bundle.locPerDollar,
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Gross qualifying lines changed per dollar in the selected period.",
      how: "Total qualifying additions + deletions divided by qualifying Build + Review + Rework cost for the same filtered Branches. * Only includes Branches with known line counts and qualifying cost.",
    },
  },
  {
    id: BranchMetricId.MedianPrSize,
    select: (bundle) => bundle.medianPrSize,
    polarity: MetricPolarity.LowerIsBetter,
    info: {
      what: "Median gross lines changed per distinct merged pull request.",
      how: "Uses additions + deletions and assigns each merged pull request to the selected period by mergedAt.",
    },
  },
  {
    id: BranchMetricId.AiSpend,
    select: (bundle) => bundle.aiSpendUsd,
    polarity: MetricPolarity.LowerIsBetter,
    info: {
      what: "Subscription-equivalent plus API-associated AI cost in the selected period.",
      how: "* Calculated from available qualifying Session costs. Activity with unavailable cost is excluded.",
    },
  },
  {
    id: BranchMetricId.MergeRate,
    select: (bundle) => bundle.mergeRatePct,
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Share of decided pull requests in the selected outcome window that merged.",
      how: "Merged outcomes use mergedAt; closed-unmerged outcomes use closedAt. Open and draft pull requests are excluded.",
    },
  },
];

/** Five canonical PRD-601 cards in their fixed order. */
export function ApprovedBranchesSummaryCards({
  metrics,
  isPending,
  isError,
  className,
  cardClassName,
  wrapBelow = false,
  comparisonSuppressedByFilter = false,
}: {
  metrics: BranchListMetricBundle | undefined;
  isPending: boolean;
  isError: boolean;
  className?: string;
  cardClassName: string;
  wrapBelow?: boolean;
  /**
   * ISS-5714 (review thread): did the local filtered-metrics fallback REPLACE
   * the producer's comparisons? Not "is a facet active" — an exact cohort
   * response is the filtered cohort's own metrics, and captioning a gap in those
   * as a filter problem blames the user's facet for a missing data window. See
   * `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter`, the only
   * defensible source for this flag.
   */
  comparisonSuppressedByFilter?: boolean;
}) {
  return (
    <SummaryCardRow className={className} wrapBelow={wrapBelow}>
      {CARDS.map((card) => (
        <CanonicalMetricCard
          card={card}
          cardClassName={cardClassName}
          comparisonSuppressedByFilter={comparisonSuppressedByFilter}
          isError={isError}
          isPending={isPending}
          key={card.id}
          metrics={metrics}
        />
      ))}
    </SummaryCardRow>
  );
}

function CanonicalMetricCard({
  card,
  cardClassName,
  metrics,
  isPending,
  isError,
  comparisonSuppressedByFilter,
}: {
  card: CardSpec;
  cardClassName: string;
  metrics: BranchListMetricBundle | undefined;
  isPending: boolean;
  isError: boolean;
  comparisonSuppressedByFilter: boolean;
}) {
  // ISS-5842 (ISS-4779 closed-by-default): opt in to the unified delta pill
  // only when this surface's own gate is on — PostHog on web, Labs on desktop.
  const deltaTreatment = useMetricDeltaTreatment();
  const definition = BRANCH_METRIC_DICTIONARY[card.id];
  if (isPending || isError || !metrics) {
    return (
      <MetricCard
        className={cardClassName}
        detail={isPending ? "Loading" : "Unavailable"}
        info={card.info}
        label={definition.label}
        muted
        value="—"
      />
    );
  }
  const metric = card.select(metrics);
  const current = metric.current;
  if (!hasNumericValue(current)) {
    return (
      <MetricCard
        className={cardClassName}
        detail={availabilityDetail(current.state, comparisonSuppressedByFilter)}
        info={metricInfo(card, metrics.label)}
        label={definition.label}
        muted={current.state === BranchMetricAvailability.Unavailable}
        value={unavailableValue(current.state)}
      />
    );
  }
  const delta = comparisonDelta(metric);
  const detail = metricDetail(current, metrics.label);
  const value = `${formatMetric(current.value, definition.unit)}${
    current.state === BranchMetricAvailability.Partial ? "*" : ""
  }`;
  const placeholder = comparisonPlaceholder(
    metric,
    comparisonSuppressedByFilter
  );
  if (delta === undefined) {
    return (
      <MetricCard
        className={cardClassName}
        deltaPlaceholder={placeholder}
        // A chip reading "No comparison" directly above a caption reading
        // "MoM" is the same contradiction one line down that this card just
        // stopped printing. When the chip is showing, the only caption worth
        // keeping is a Partial value's own disclosure — the bare window label
        // means nothing to a reader once the window is not being compared.
        detail={placeholder ? partialDisclosure(current) : detail}
        info={metricInfo(card, metrics.label)}
        label={definition.label}
        value={value}
      />
    );
  }
  return (
    <MetricCard
      className={cardClassName}
      delta={delta}
      deltaLabel={metrics.label}
      deltaPolarity={card.polarity}
      deltaTreatment={deltaTreatment}
      detail={detail}
      info={metricInfo(card, metrics.label)}
      label={definition.label}
      value={value}
    />
  );
}

function unavailableValue(state: BranchMetricAvailability): string | null {
  if (state === BranchMetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === BranchMetricAvailability.Unavailable) {
    return "—";
  }
  return null;
}

function hasNumericValue(
  result: BranchMetricResult<number>
): result is Extract<BranchMetricResult<number>, { value: number }> {
  return (
    result.state === BranchMetricAvailability.Complete ||
    result.state === BranchMetricAvailability.Partial
  );
}

function comparisonDelta(metric: BranchListMetricValue): number | undefined {
  const result = metric.comparison?.deltaPct;
  return result && hasNumericValue(result) ? result.value : undefined;
}

function availabilityDetail(
  state: BranchMetricAvailability,
  comparisonSuppressedByFilter: boolean
): string {
  if (state === BranchMetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === BranchMetricAvailability.NoData) {
    return "No data";
  }
  if (comparisonSuppressedByFilter) {
    return "Not available with filters applied";
  }
  return "Unavailable";
}

function metricDetail(
  result: Extract<BranchMetricResult<number>, { value: number }>,
  label: BranchMetricComparisonLabel
): string {
  if (result.state === BranchMetricAvailability.Partial) {
    return result.disclosure;
  }
  return label === BranchMetricComparisonLabel.AllTime ? "all time" : label;
}

function metricInfo(
  card: CardSpec,
  label: BranchMetricComparisonLabel
): CardSpec["info"] {
  if (
    card.id !== BranchMetricId.ActiveBranches ||
    label === BranchMetricComparisonLabel.AllTime
  ) {
    return card.info;
  }
  return {
    ...card.info,
    how: `${card.info.how} Comparisons use Branch status at each period boundary.`,
  };
}

/**
 * What stands in for a delta chip this card cannot draw — and it says WHAT it
 * cannot draw.
 *
 * ISS-5714: this slot used to be the bare word `Unavailable`, rendered in the
 * footer directly beneath the value. `MEDIAN PR SIZE` then read `148 LOC*` with
 * `Unavailable` under it — a figure and a denial of that figure in one tile,
 * with nothing on screen telling the reader which to believe. The figure was
 * real; only the period-over-period COMPARISON was missing. So the slot now
 * names the missing thing instead of leaving an unscoped denial under a number.
 *
 * It reuses the shared `KpiDeltaPlaceholder` the Insights tiles and the Sessions
 * summary row already render in this same slot (FEA-3960), rather than a fourth
 * hand-rolled string: one "No comparison" affordance with the reason in a
 * tooltip and an `sr-only` sentence, and the sentences themselves live in
 * `branch-list-comparison-copy.ts` beside the branch-detail set.
 *
 * `undefined` when there is no comparison window at all — nothing was promised,
 * so nothing is owed an explanation, and the footer keeps its chip-free layout.
 */
function comparisonPlaceholder(
  metric: BranchListMetricValue,
  comparisonSuppressedByFilter: boolean
): ReactNode | undefined {
  const comparison = metric.comparison;
  if (!comparison) {
    return;
  }
  return (
    <KpiDeltaPlaceholder
      reason={describeMissingBranchComparison({
        state: comparison.deltaPct.state,
        label: comparison.label,
        comparisonSuppressedByFilter,
      })}
    />
  );
}

/**
 * A Partial value's own disclosure, or nothing. The `*` on the value promises a
 * footnote, so it is the one caption that still has to survive when the delta
 * slot is explaining itself.
 */
function partialDisclosure(
  result: Extract<BranchMetricResult<number>, { value: number }>
): string | undefined {
  return result.state === BranchMetricAvailability.Partial
    ? result.disclosure
    : undefined;
}

function formatMetric(value: number, unit: BranchMetricUnit): string {
  if (unit === BranchMetricUnit.Usd) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (unit === BranchMetricUnit.Percentage) {
    return `${round(value, 1)}%`;
  }
  if (unit === BranchMetricUnit.LinesPerDollar) {
    return `${round(value, 2)} LOC/$`;
  }
  if (unit === BranchMetricUnit.Lines) {
    return `${Math.round(value).toLocaleString()} LOC`;
  }
  return Math.round(value).toLocaleString();
}

function round(value: number, digits: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value);
}
