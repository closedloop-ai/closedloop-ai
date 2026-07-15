"use client";

import type {
  BranchAnalytics,
  BranchKpi,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import { BranchKpiState } from "@repo/api/src/types/branch";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatCost, formatNumber } from "@repo/app/shared/lib/format-utils";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  leadTimeWaterfallSegments,
  locPerDollar,
} from "../lib/branch-derivations";
import {
  type PreferredBranchLoc,
  resolveNetLoc,
} from "../lib/live-overlays/use-preferred-branch-loc";

/**
 * Headline stat cards (Epic D / D6): Value per $ and Lead time. Both read SINGLE
 * computations — Value per $ via A3's `locPerDollar`, Lead time via the D5
 * `leadTimeWaterfallSegments.totalMs`.
 *
 * Value per $ uses the net LOC resolved by `usePreferredBranchLoc` (passed in as
 * `loc`): the connected PR's live totals are authoritative and preferred over
 * enrichment-derived counts. When `loc` is absent it falls back to the
 * enrichment columns on `detail` (legacy/pure-render path). When neither is
 * available, Value per $ shows "—" rather than 0.
 *
 * 30-day baselines/deltas come from `BranchAnalytics` (`BranchKpi.baseline30d` +
 * `deltaPct`). On the desktop detail surface analytics is not wired in v1 (and
 * REST analytics is deferred), so `analytics` is usually undefined → the cards
 * render their primary value with the baseline explicitly labeled unavailable
 * and NO delta chip and NO "Sample" badge (no fabricated comparison).
 */
export type BranchHeadlineCardsProps = {
  detail: BranchPageDetail;
  analytics?: BranchAnalytics;
  /** PR-preferred LOC from `usePreferredBranchLoc`; omit to use `detail` columns. */
  loc?: PreferredBranchLoc;
};

const DELTA_LABEL = "vs. prior 30 days";

export function BranchHeadlineCards({
  detail,
  analytics,
  loc,
}: BranchHeadlineCardsProps) {
  const netLoc = resolveNetLoc(loc, detail);
  const valuePerDollar = locPerDollar({
    netLoc,
    totalCostUsd: detail.estimatedCostUsd,
  });
  const lead = leadTimeWaterfallSegments(detail);

  const locLabel = loc?.source === "github" ? "net LOC (from PR)" : "net LOC";
  const valueDetail =
    netLoc == null
      ? "Net LOC unavailable"
      : `${formatNumber(netLoc)} ${locLabel} · ${detail.estimatedCostUsd == null ? "—" : formatCost(detail.estimatedCostUsd)}`;

  return (
    <div className="bq-statcards">
      <BaselineMetricCard
        baseline={analytics?.locPerDollar}
        detailCaption={valueDetail}
        info={{
          what: "Net lines of code delivered per dollar spent.",
          how: "Net LOC ÷ estimated cost. Prefers the connected PR's live LOC.",
        }}
        label="Value per $"
        value={
          valuePerDollar == null
            ? "—"
            : `${formatNumber(valuePerDollar, true)} LOC/$`
        }
      />
      <BaselineMetricCard
        baseline={analytics?.leadTimeForChangeMs}
        detailCaption="First session → merge"
        info={{
          what: "Wall-clock from the first contributing session to merge.",
          how: "Anchored on the first session, not branch creation.",
        }}
        label="Lead time for change"
        value={
          lead.mergeUnknown ? "In progress" : formatDurationMs(lead.totalMs)
        }
      />
    </div>
  );
}

/**
 * A `MetricCard` that renders a 30-day delta chip ONLY when the KPI carries a
 * real baseline; otherwise it labels the baseline unavailable (no fabricated
 * delta, no Sample badge).
 */
function BaselineMetricCard({
  label,
  value,
  detailCaption,
  info,
  baseline,
}: {
  label: string;
  value: string;
  detailCaption: string;
  info: { what: string; how: string };
  baseline: BranchKpi | undefined;
}) {
  const hasBaseline =
    baseline != null &&
    baseline.state === BranchKpiState.Available &&
    baseline.baseline30d != null &&
    baseline.deltaPct != null;

  return (
    <MetricCard
      delta={hasBaseline ? (baseline?.deltaPct ?? undefined) : undefined}
      deltaLabel={hasBaseline ? DELTA_LABEL : undefined}
      detail={
        hasBaseline ? detailCaption : `${detailCaption} · baseline unavailable`
      }
      info={info}
      label={label}
      value={value}
    />
  );
}
