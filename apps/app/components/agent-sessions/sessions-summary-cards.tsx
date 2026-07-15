"use client";

import {
  type AgentSessionQueryFilters,
  useAgentSessionUsage,
} from "@repo/app/agents/hooks/use-agent-sessions";
import {
  SUMMARY_CARD_CLASS,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { formatCost, formatNumber } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";

const SKELETON_KEYS = ["sessions", "cost", "prs", "pr-size", "kloc"] as const;

// No period-over-period comparison endpoint exists yet, so cards omit the delta
// chip rather than render a permanent "unknown" trend.

export function SessionsSummaryCards({
  filters,
}: {
  filters: AgentSessionQueryFilters;
}) {
  const usageQuery = useAgentSessionUsage(filters);

  if (usageQuery.isLoading) {
    return (
      <SummaryCardRow>
        {SKELETON_KEYS.map((key) => (
          <Skeleton
            className={`h-[124px] rounded-xl ${SUMMARY_CARD_CLASS}`}
            key={key}
          />
        ))}
      </SummaryCardRow>
    );
  }

  const usage = usageQuery.data;
  // FEA-3156: the sessions-usage endpoint now returns the three delivery metrics
  // for the matched-session set. A metric is only "unavailable" (placeholder +
  // SAMPLE badge) when the value is genuinely absent — no merged PRs in range
  // (medianPrSize / mergedKlocPerDollar are null) or the surface doesn't compute
  // them (undefined). When merged PRs exist, real numbers render with no badge.
  const mergedPrCount = usage?.mergedPrCount;
  const medianPrSize = usage?.medianPrSize;
  const mergedKlocPerDollar = usage?.mergedKlocPerDollar;
  const hasMergedPrCount = mergedPrCount != null;
  const hasMedianPrSize = medianPrSize != null;
  const hasKlocPerDollar = mergedKlocPerDollar != null;

  return (
    <SummaryCardRow>
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="matched by the current filters"
        info={{
          what: "Agent sessions matching the current filters and time range.",
          how: "Count of session records in the active filter set.",
        }}
        label="Sessions"
        value={formatNumber(usage?.totalSessions ?? 0)}
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        // FEA-3156: the Cost card shows METERED API spend (apiEstimatedCost),
        // the SAME basis the "KLOC (Merged) / $" card divides by — so the two
        // cards never sit on different cost bases (the mixed-basis trap). The
        // raw estimated total (subscription-covered "would-have-cost" included)
        // is surfaced in the detail line, not the headline, so it can't be
        // mistaken for real metered spend.
        detail={`metered API spend · ${formatCost(usage?.totalEstimatedCost ?? 0)} incl. subscription`}
        info={{
          what: "Metered API token spend for the matched sessions — real billed dollars, excluding subscription-covered usage.",
          how: "Sum of per-session API-billed cost (tokens × model rate); subscription/seat-covered sessions are excluded, matching the KLOC-per-dollar denominator.",
        }}
        label="Cost"
        value={formatCost(usage?.apiEstimatedCost ?? 0)}
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="merged in range"
        info={{
          what: "Pull requests merged from the matched sessions.",
          how: "Count of merged PRs linked to sessions in range.",
        }}
        label="PRs Shipped"
        placeholder={!hasMergedPrCount}
        value={hasMergedPrCount ? formatNumber(mergedPrCount) : "—"}
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="lines changed"
        info={{
          what: "Median lines changed per merged PR.",
          how: "Median of additions + deletions across merged PRs.",
        }}
        label="Median PR size"
        placeholder={!hasMedianPrSize}
        value={hasMedianPrSize ? formatNumber(medianPrSize) : "—"}
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="merged KLOC per dollar"
        info={{
          what: "Merged thousand-lines-of-code per dollar — output efficiency.",
          how: "Merged KLOC divided by token cost across matched sessions.",
        }}
        label="KLOC (Merged) / $"
        placeholder={!hasKlocPerDollar}
        value={hasKlocPerDollar ? formatNumber(mergedKlocPerDollar, true) : "—"}
      />
    </SummaryCardRow>
  );
}
