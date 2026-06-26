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
import {
  CircleDollarSignIcon,
  GitPullRequestArrowIcon,
  LayersIcon,
  RulerIcon,
  ZapIcon,
} from "lucide-react";

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

  return (
    <SummaryCardRow>
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="matched by the current filters"
        icon={LayersIcon}
        info={{
          what: "Agent sessions matching the current filters and time range.",
          how: "Count of session records in the active filter set.",
        }}
        label="Sessions"
        value={formatNumber(usage?.totalSessions ?? 0)}
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="estimated spend"
        icon={CircleDollarSignIcon}
        info={{
          what: "Estimated token spend for the matched sessions.",
          how: "Sum of per-session cost (tokens × model rate).",
        }}
        label="Cost"
        value={formatCost(usage?.totalEstimatedCost ?? 0)}
      />
      {/* No backing endpoint yet — rendered blank and flagged as a placeholder
          (dimmed + badge) rather than fabricating a value. */}
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="merged in range"
        icon={GitPullRequestArrowIcon}
        info={{
          what: "Pull requests merged from the matched sessions.",
          how: "Count of merged PRs linked to sessions in range.",
        }}
        label="PRs Shipped"
        placeholder
        value="—"
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="lines changed"
        icon={RulerIcon}
        info={{
          what: "Median lines changed per merged PR.",
          how: "Median of additions + deletions across merged PRs.",
        }}
        label="Median PR size"
        placeholder
        value="—"
      />
      <MetricCard
        className={SUMMARY_CARD_CLASS}
        detail="merged KLOC per dollar"
        icon={ZapIcon}
        info={{
          what: "Merged thousand-lines-of-code per dollar — output efficiency.",
          how: "Merged KLOC divided by token cost across matched sessions.",
        }}
        label="KLOC (Merged) / $"
        placeholder
        value="—"
      />
    </SummaryCardRow>
  );
}
