"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchVisibleLifecyclePhase,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import { largestRemainderPercents } from "@repo/app/shared/lib/percent-shares";
import { getActivityPhaseDisplay } from "../lib/activity-taxonomy-display";

export type BranchCostToMergeProps = {
  detail: BranchPageDetail;
  /** @deprecated PR selection never suppresses Branch-lifetime phase costs. */
  suppressSplits?: boolean;
};

const VISIBLE_PHASES: readonly VisiblePhase[] = [
  BranchVisibleLifecyclePhase.Build,
  BranchVisibleLifecyclePhase.Review,
  BranchVisibleLifecyclePhase.Rework,
];

type CostRow = {
  costUsd: number;
  durationMs: number;
  key: VisiblePhase;
  label: string;
  partial: boolean;
};

/** Canonical Build / Review / Rework lifetime-cost presentation. */
export function BranchCostToMerge({ detail }: BranchCostToMergeProps) {
  const metrics = detail.canonicalMetrics;
  const total = metricValue(metrics?.totalCostUsd);
  const rows = metrics ? phaseRows(detail, metrics.phaseCostUsd) : null;

  return (
    <section className="bq-costbd">
      <div className="bq-sec-head">
        <span className="bq-sec-title">Cost breakdown</span>
        <span className="bq-sec-count">
          {total
            ? `${formatCost(total.value)}${total.partial ? "*" : ""}`
            : "—"}
        </span>
      </div>
      <CostBreakdownBody rows={rows} total={total} />
    </section>
  );
}

function CostBreakdownBody({
  rows,
  total,
}: {
  rows: CostRow[] | null;
  total: MetricValue | null;
}) {
  if (!(rows && total)) {
    return (
      <p className="bq-costbd-foot">
        Build, Review, and Rework cost evidence is unavailable.
      </p>
    );
  }
  if (total.value <= 0) {
    return <p className="bq-costbd-foot">No priced spend recorded yet.</p>;
  }
  const percents = largestRemainderPercents(
    rows.map((row) => row.costUsd),
    total.value
  );

  return (
    <>
      <div aria-hidden="true" className="bq-cost-bar">
        {rows.map((row) => (
          <span
            className="bq-cost-seg"
            key={row.key}
            style={{
              width: `${(row.costUsd / total.value) * 100}%`,
              background: getActivityPhaseDisplay(row.key).color,
            }}
          />
        ))}
      </div>
      <div className="bq-costbd-rows">
        {rows.map((row, index) => (
          <div className="bq-costbd-row" key={row.key}>
            <span
              className="bq-cost-sw"
              style={{ background: getActivityPhaseDisplay(row.key).color }}
            />
            <span className="bq-costbd-name">{row.label}</span>
            <span className="bq-costbd-val font-mono">
              {formatDurationMs(row.durationMs)} · {formatCost(row.costUsd)}
              {row.partial ? "*" : ""} · {percents[index]}%
            </span>
          </div>
        ))}
      </div>
      {rows.some((row) => row.partial) || total.partial ? (
        <p className="bq-costbd-foot">
          * Calculated from available qualifying Session costs.
        </p>
      ) : null}
    </>
  );
}

function phaseRows(
  detail: BranchPageDetail,
  phaseCosts: Record<VisiblePhase, BranchMetricResult<number>>
): CostRow[] | null {
  const durations = new Map(
    (detail.phaseAttribution?.rollups ?? []).map((rollup) => [
      rollup.phase,
      rollup.durationMs,
    ])
  );
  const rows: CostRow[] = [];
  for (const phase of VISIBLE_PHASES) {
    const value = metricValue(phaseCosts[phase]);
    if (!value) {
      return null;
    }
    rows.push({
      costUsd: value.value,
      durationMs: durations.get(phase) ?? 0,
      key: phase,
      label: getActivityPhaseDisplay(phase).label,
      partial: value.partial,
    });
  }
  return rows;
}

type MetricValue = { partial: boolean; value: number };

function metricValue(
  result: BranchMetricResult<number> | undefined
): MetricValue | null {
  if (
    !result ||
    (result.state !== BranchMetricAvailability.Complete &&
      result.state !== BranchMetricAvailability.Partial) ||
    result.value === null
  ) {
    return null;
  }
  return {
    partial: result.state === BranchMetricAvailability.Partial,
    value: Math.max(0, result.value),
  };
}
