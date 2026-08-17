"use client";

import type {
  BranchAnalytics,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { formatBranchLeadTimeMs } from "@repo/app/branches/lib/format-branch-lead-time-ms";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import {
  formatCost,
  formatLocPerDollar,
  formatNumber,
} from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { PreferredBranchLoc } from "../lib/preferred-branch-loc";

export type BranchHeadlineCardsProps = {
  detail: BranchPageDetail;
  /** Retained for compatibility while callers migrate to canonical detail metrics. */
  analytics?: BranchAnalytics;
  /** Retained because Branch LOC is resolved once at the page boundary. */
  loc?: PreferredBranchLoc;
};

/** The exact three approved Branch outcome cards, in their fixed hierarchy. */
export function BranchHeadlineCards({ detail }: BranchHeadlineCardsProps) {
  const metrics = detail.canonicalMetrics;
  const locPerDollar = metricPresentation(
    metrics?.locPerDollar,
    formatLocPerDollar
  );
  const leadTime = metricPresentation(
    metrics?.leadTimeMs,
    formatBranchLeadTimeMs
  );
  const abandonment = metricPresentation(
    metrics?.abandonmentTimeMs,
    formatDurationMs
  );
  const locDetail = supportingDetail(locPerDollar, locEvidenceDetail(detail));

  return (
    <div className="bq-statcards">
      <MetricCard
        detail={locDetail}
        info={{
          what: "Gross lines changed in the selected pull request per dollar spent on this branch.",
          how: "Selected pull request additions plus deletions divided by lifetime Build, Review, and Rework cost.",
        }}
        label="LOC per $"
        unitLabel="LOC/$"
        value={locPerDollar.value}
        valueUnavailable={locPerDollar.unavailable}
        valueUnavailableLabel={locPerDollar.unavailableLabel}
      />
      <MetricCard
        detail={supportingDetail(leadTime, "First code pushed → merge")}
        info={{
          what: "Wall-clock time from the selected pull request cycle's first qualifying code push until merge.",
          how: "Merged cycles only. Open, draft, and closed-unmerged cycles are not applicable.",
        }}
        label="Lead time for change"
        value={leadTime.value}
        valueUnavailable={leadTime.unavailable}
        valueUnavailableLabel={leadTime.unavailableLabel}
      />
      <MetricCard
        detail={supportingDetail(
          abandonment,
          "First code pushed → close without merge"
        )}
        info={{
          what: "Wall-clock time spent on the selected pull request cycle before it closed without merging.",
          how: "Closed-unmerged cycles only. Merged, open, and draft cycles are not applicable.",
        }}
        label="Abandonment Duration"
        value={abandonment.value}
        valueUnavailable={abandonment.unavailable}
        valueUnavailableLabel={abandonment.unavailableLabel}
      />
    </div>
  );
}

function locEvidenceDetail(detail: BranchPageDetail): string | null {
  const selected = detail.selectedPullRequest;
  const totalCost = detail.canonicalMetrics?.totalCostUsd;
  if (
    !selected ||
    selected.additions === null ||
    selected.deletions === null ||
    !totalCost ||
    totalCost.value === null ||
    (totalCost.state !== BranchMetricAvailability.Complete &&
      totalCost.state !== BranchMetricAvailability.Partial)
  ) {
    return null;
  }
  const lines = selected.additions + selected.deletions;
  return `${formatNumber(lines)} lines changed · ${formatCost(totalCost.value)}${
    totalCost.state === BranchMetricAvailability.Partial ? "*" : ""
  }`;
}

function supportingDetail(
  presentation: ReturnType<typeof metricPresentation>,
  caption: string | null
): string | null {
  if (presentation.unavailable) {
    return presentation.detail;
  }
  if (presentation.detail && caption) {
    return `${caption} · ${presentation.detail}`;
  }
  return presentation.detail ?? caption;
}

function metricPresentation(
  result: BranchMetricResult<number> | undefined,
  format: (value: number) => string
): {
  detail: string | null;
  unavailable: boolean;
  unavailableLabel: string;
  value: string | null;
} {
  if (!result || result.state === BranchMetricAvailability.Unavailable) {
    return {
      detail: "Evidence is unavailable.",
      unavailable: true,
      unavailableLabel: "Unavailable",
      value: null,
    };
  }
  if (result.state === BranchMetricAvailability.NotApplicable) {
    return {
      detail: "Not applicable to the selected pull request's latest cycle.",
      unavailable: true,
      unavailableLabel: "N/A",
      value: null,
    };
  }
  if (result.state === BranchMetricAvailability.NoData) {
    return {
      detail: "No qualifying data.",
      unavailable: true,
      unavailableLabel: "No data",
      value: null,
    };
  }
  if (result.value === null) {
    return {
      detail: "Evidence is unavailable.",
      unavailable: true,
      unavailableLabel: "Unavailable",
      value: null,
    };
  }
  const formatted = format(result.value);
  if (result.state === BranchMetricAvailability.Partial) {
    return {
      detail: `${result.disclosure} Values marked * use incomplete evidence.`,
      unavailable: false,
      unavailableLabel: "No data",
      value: `${formatted}*`,
    };
  }
  return {
    detail: null,
    unavailable: false,
    unavailableLabel: "No data",
    value: formatted,
  };
}
