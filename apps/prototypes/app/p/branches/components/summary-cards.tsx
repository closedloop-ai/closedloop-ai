"use client";

import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { CSSProperties } from "react";
import {
  type BranchMetricBundle,
  MetricAvailability,
  MetricDisclosure,
  type MetricPresentationState,
  type MetricResult,
  type MetricValue,
  MetricPresentationState as PresentationState,
} from "./branch-list-metric-types";

const WRAP_CLASS =
  "grid grid-cols-2 gap-4 md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))] max-md:[&>*:last-child:nth-child(odd)]:col-span-2";
const WRAP_STYLE = { "--summary-card-min": "12rem" } as CSSProperties;
const CARD_CLASS =
  "w-full [&_[data-slot=card-title]>span:first-child]:whitespace-nowrap";

const MetricId = {
  ActiveBranches: "activeBranches",
  LocPerDollar: "locPerDollar",
  MedianPrSize: "medianPrSize",
  AiSpend: "aiSpendUsd",
  MergeRate: "mergeRatePct",
} as const;
type MetricId = (typeof MetricId)[keyof typeof MetricId];

type CardSpec = {
  id: MetricId;
  label: string;
  polarity: MetricPolarity;
  info: { what: string; how: string };
};

const CARDS: readonly CardSpec[] = [
  {
    id: MetricId.ActiveBranches,
    label: "Active branches",
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Branches still in progress (not merged, closed, or canceled).",
      how: "Based on the Branch status stored in ClosedLoop.",
    },
  },
  {
    id: MetricId.LocPerDollar,
    label: "LOC per $",
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Gross qualifying lines changed per dollar in the selected period.",
      how: "Total additions and deletions divided by qualifying Build, Review, and Rework cost for the same Branches.",
    },
  },
  {
    id: MetricId.MedianPrSize,
    label: "Median PR size",
    polarity: MetricPolarity.LowerIsBetter,
    info: {
      what: "Median gross lines changed per distinct merged pull request.",
      how: "Uses additions and deletions and assigns each pull request by mergedAt.",
    },
  },
  {
    id: MetricId.AiSpend,
    label: "AI spend",
    polarity: MetricPolarity.LowerIsBetter,
    info: {
      what: "Subscription-equivalent plus API-associated AI cost in the selected period.",
      how: "Includes qualifying Build, Review, and Rework Session costs after global shared-Session attribution.",
    },
  },
  {
    id: MetricId.MergeRate,
    label: "Merge rate",
    polarity: MetricPolarity.HigherIsBetter,
    info: {
      what: "Share of decided pull requests in the selected outcome window that merged.",
      how: "Merged outcomes use mergedAt; closed-unmerged outcomes use closedAt. Open and draft pull requests are excluded.",
    },
  },
];

export function BranchesSummaryCards({
  metrics,
  presentationState,
}: {
  metrics: BranchMetricBundle;
  presentationState: MetricPresentationState;
}) {
  return (
    <div className={WRAP_CLASS} style={WRAP_STYLE}>
      {CARDS.map((card) => (
        <BranchMetricCard
          card={card}
          key={card.id}
          metrics={metrics}
          presentationState={presentationState}
        />
      ))}
    </div>
  );
}

function BranchMetricCard({
  card,
  metrics,
  presentationState,
}: {
  card: CardSpec;
  metrics: BranchMetricBundle;
  presentationState: MetricPresentationState;
}) {
  if (presentationState === PresentationState.Loading) {
    return (
      <MetricCard
        className={CARD_CLASS}
        detail="Loading"
        info={card.info}
        label={card.label}
        loading
        value={null}
      />
    );
  }
  if (presentationState === PresentationState.Error) {
    return (
      <MetricCard
        className={CARD_CLASS}
        detail="Unavailable"
        info={card.info}
        label={card.label}
        muted
        value="—"
      />
    );
  }

  const metric = metrics[card.id];
  const current = forcePresentationState(
    metric.current,
    presentationState,
    card.id
  );
  if (current.value === null) {
    return (
      <MetricCard
        className={CARD_CLASS}
        detail={availabilityLabel(current.state)}
        info={card.info}
        label={card.label}
        muted={current.state === MetricAvailability.Unavailable}
        value={unavailableValue(current.state)}
        valueUnavailable={current.state === MetricAvailability.NoData}
        valueUnavailableLabel="No data"
      />
    );
  }

  const value = `${formatMetric(card.id, current.value)}${
    current.state === MetricAvailability.Partial ? "*" : ""
  }`;
  const delta = comparisonDelta(metric, presentationState);
  let detail: string = metrics.label;
  if (current.state === MetricAvailability.Partial) {
    detail = current.disclosure;
  } else if (delta === undefined && metric.comparison) {
    detail = `${metrics.label} comparison unavailable`;
  }
  if (delta === undefined) {
    return (
      <MetricCard
        className={CARD_CLASS}
        detail={detail}
        info={card.info}
        label={card.label}
        value={value}
      />
    );
  }
  return (
    <MetricCard
      className={CARD_CLASS}
      delta={delta}
      deltaLabel={metrics.label}
      deltaPolarity={card.polarity}
      info={card.info}
      label={card.label}
      value={value}
    />
  );
}

function forcePresentationState(
  result: MetricResult,
  presentationState: MetricPresentationState,
  id: MetricId
): MetricResult {
  if (presentationState === PresentationState.Complete) {
    return result;
  }
  if (presentationState === PresentationState.Partial) {
    return result.value === null
      ? result
      : {
          state: MetricAvailability.Partial,
          value: result.value,
          disclosure: partialDisclosure(id),
        };
  }
  if (presentationState === PresentationState.NotApplicable) {
    return { state: MetricAvailability.NotApplicable, value: null };
  }
  if (presentationState === PresentationState.NoData) {
    return { state: MetricAvailability.NoData, value: null };
  }
  return { state: MetricAvailability.Unavailable, value: null };
}

function partialDisclosure(id: MetricId): MetricDisclosure {
  if (id === MetricId.LocPerDollar) {
    return MetricDisclosure.LocIncomplete;
  }
  if (id === MetricId.AiSpend) {
    return MetricDisclosure.CostIncomplete;
  }
  if (id === MetricId.MedianPrSize) {
    return MetricDisclosure.PrIncomplete;
  }
  return MetricDisclosure.DefaultIncomplete;
}

function unavailableValue(state: MetricAvailability): string | null {
  if (state === MetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === MetricAvailability.Unavailable) {
    return "—";
  }
  return null;
}

function comparisonDelta(
  metric: MetricValue,
  presentationState: MetricPresentationState
): number | undefined {
  if (presentationState !== PresentationState.Complete) {
    return undefined;
  }
  const delta = metric.comparison?.deltaPct;
  return delta?.state === MetricAvailability.Complete
    ? roundComparisonDelta(delta.value)
    : undefined;
}

function roundComparisonDelta(value: number): number {
  return Math.round(value * 10) / 10;
}

function availabilityLabel(state: MetricAvailability): string {
  if (state === MetricAvailability.NotApplicable) {
    return "N/A";
  }
  if (state === MetricAvailability.NoData) {
    return "No data";
  }
  return "Unavailable";
}

function formatMetric(id: MetricId, value: number): string {
  if (id === MetricId.AiSpend) {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });
  }
  if (id === MetricId.MergeRate) {
    return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (id === MetricId.LocPerDollar) {
    return `${formatNumber(value)} LOC/$`;
  }
  if (id === MetricId.MedianPrSize) {
    return `${Math.round(value).toLocaleString("en-US")} LOC`;
  }
  return formatNumber(value);
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
