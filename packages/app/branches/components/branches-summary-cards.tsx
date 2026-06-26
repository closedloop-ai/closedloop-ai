"use client";

import type { BranchAnalytics, BranchKpi } from "@repo/api/src/types/branch";
import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  SUMMARY_CARD_CLASS,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { formatCost, formatNumber } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  CheckCheckIcon,
  CircleDollarSignIcon,
  CoinsIcon,
  FileDiffIcon,
  GitBranchIcon,
  type LucideIcon,
} from "lucide-react";
import {
  type BranchQueryFilters,
  useBranchAnalytics,
} from "../hooks/use-branches";
import { ConnectGitHubIndicator } from "./connect-github-indicator";

/**
 * Branches summary KPI cards (FEA-1948 / B6; FEA-2051). Reconciled to flow
 * through the `BranchesDataSource` port (`useBranchAnalytics`) instead of the
 * cloud `useDeliveryInsights` hook. The row surfaces ONLY locally-computable
 * KPIs (AI spend, Value per $, Active branches, Merge rate, Median PR size — no
 * GitHub needed) so the page is useful without a GitHub connection. GitHub-gated
 * KPIs (active/merged PR counts, time-to-merge) are intentionally NOT shown
 * (FEA-2051) rather than rendered as empty connect-GitHub placeholders — no
 * hardcoded "86", no Sample badges. `BranchKpiCard` keeps a defensive
 * connect-GitHub affordance for any KPI a future REST source reports as gated.
 * The cards light up unchanged when the authenticated REST source lands (the
 * port's HTTP impl serves the same shape).
 */

const DELTA_LABEL = "vs. prior 30 days";

type CardSpec = {
  key: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  info: { what: string; how: string };
  select: (analytics: BranchAnalytics) => BranchKpi;
  format: (value: number) => string;
};

const CARDS: CardSpec[] = [
  {
    key: "spend",
    label: "AI spend",
    detail: "estimated cost in range",
    icon: CircleDollarSignIcon,
    info: {
      what: "Total estimated AI cost across your branches.",
      how: "Summed from local session token usage — no GitHub needed.",
    },
    select: (analytics) => analytics.totalSpendUsd,
    format: (value) => formatCost(value),
  },
  {
    key: "value-per-dollar",
    label: "Value per $",
    detail: "net LOC per dollar",
    icon: CoinsIcon,
    info: {
      what: "Net lines of code delivered per dollar spent.",
      how: "Net LOC ÷ estimated cost (needs LOC enrichment).",
    },
    select: (analytics) => analytics.locPerDollar,
    // The "Value per $" label + "net LOC per dollar" detail already convey the
    // unit, so the numeric display stays clean (e.g. "5.98", not "5.98 LOC/$").
    format: (value) => formatNumber(value, true),
  },
  {
    key: "active-branches",
    label: "Active branches",
    detail: "in progress",
    icon: GitBranchIcon,
    info: {
      what: "Branches still in progress (not merged or closed).",
      how: "Count by local branch status — no GitHub needed.",
    },
    select: (analytics) => analytics.activeBranchCount,
    format: (value) => value.toLocaleString(),
  },
  {
    key: "merge-rate",
    label: "Merge rate",
    detail: "of opened PRs",
    icon: CheckCheckIcon,
    info: {
      what: "Share of opened PRs that get merged.",
      how: "Merged ÷ opened over the local corpus.",
    },
    select: (analytics) => analytics.mergeRate,
    format: (value) => `${Math.round(value)}%`,
  },
  {
    key: "pr-size",
    label: "Median PR size",
    detail: "lines changed",
    icon: FileDiffIcon,
    info: {
      what: "Median lines changed per merged PR.",
      how: "Median of additions + deletions across merged PRs.",
    },
    select: (analytics) => analytics.medianPrSize,
    format: (value) => Math.round(value).toLocaleString(),
  },
];

export function BranchesSummaryCards({
  className,
  cardClassName = SUMMARY_CARD_CLASS,
  filters,
  showDelta = true,
}: {
  /** Layout for the card container (desktop passes its dashboard grid). */
  className?: string;
  /** Per-card styling. Defaults to the fixed-width row card. */
  cardClassName?: string;
  /** Time-window (and future facet) filters so the KPIs reflect the window. */
  filters?: BranchQueryFilters;
  /**
   * Whether to show the "vs. prior 30 days" delta. The baseline is fixed at 30
   * days, so the delta is only meaningful when the window itself is 30 days —
   * callers pass `false` for any other window to avoid an apples-to-oranges %.
   */
  showDelta?: boolean;
}) {
  const { data } = useBranchAnalytics(filters);

  return (
    <SummaryCardRow className={className}>
      {CARDS.map((card) => (
        <BranchKpiCard
          card={card}
          cardClassName={cardClassName}
          key={card.key}
          kpi={data ? card.select(data) : null}
          showDelta={showDelta}
        />
      ))}
    </SummaryCardRow>
  );
}

function BranchKpiCard({
  card,
  cardClassName,
  kpi,
  showDelta,
}: {
  card: CardSpec;
  cardClassName: string;
  kpi: BranchKpi | null;
  showDelta: boolean;
}) {
  // No analytics yet (loading or an unreachable REST source) — neutral dash.
  if (!kpi) {
    return (
      <MetricCard
        className={cardClassName}
        detail={card.detail}
        icon={card.icon}
        info={card.info}
        label={card.label}
        placeholder
        value="—"
      />
    );
  }

  if (kpi.state === BranchKpiState.Available && kpi.value != null) {
    const delta = showDelta ? (kpi.deltaPct ?? undefined) : undefined;
    return (
      <MetricCard
        className={cardClassName}
        delta={delta}
        deltaLabel={delta == null ? undefined : DELTA_LABEL}
        detail={card.detail}
        icon={card.icon}
        info={card.info}
        label={card.label}
        value={card.format(kpi.value)}
      />
    );
  }

  // Gated (needs GitHub) → the connect-GitHub affordance, never a fake number.
  if (kpi.state === BranchKpiState.Gated) {
    return (
      <MetricCard
        className={cardClassName}
        detail={<ConnectGitHubIndicator compact />}
        icon={card.icon}
        info={card.info}
        label={card.label}
        value="—"
      />
    );
  }

  // Unavailable — no data on the local corpus yet (e.g. no LOC enrichment).
  return (
    <MetricCard
      className={cardClassName}
      detail={card.detail}
      icon={card.icon}
      info={card.info}
      label={card.label}
      value="—"
    />
  );
}
