"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type {
  BranchMetricDisclosure,
  BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchVisibleLifecyclePhase,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import { largestRemainderPercents } from "@repo/app/shared/lib/percent-shares";
import { getActivityPhaseDisplay } from "../lib/activity-taxonomy-display";
import {
  type DisplayableBranchMetricValue,
  displayableBranchMetricValue,
  isDisplayableBranchMetricNumber,
  shippedClampedBranchMetricValue,
} from "../lib/branch-metric-value";
import { formatBranchDurationMs } from "../lib/format-branch-duration-ms";

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
  disclosure?: BranchMetricDisclosure;
  durationMs: number;
  key: VisiblePhase;
  label: string;
  partial: boolean;
};

/** Canonical Build / Review / Rework lifetime-cost presentation. */
export function BranchCostToMerge({ detail }: BranchCostToMergeProps) {
  // ISS-6958 is "one duration treatment for the SCREEN", and this section shares
  // the screen with the headline cards and the outcome waterfall. Left on the
  // minutes-only formatter it put "185m 0s" beside their "3h 5m" for durations
  // of the same order, which is the flag introducing the inconsistency it was
  // taken out to remove. Durations only: every dollar figure here, and the
  // no-priced-cost sentence beneath them, belong to ISS-6956 and are untouched.
  const honest = useFeatureFlagEnabledOptional(
    BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY
  );
  const metrics = detail.canonicalMetrics;
  const total = honest
    ? displayableBranchMetricValue(metrics?.totalCostUsd)
    : shippedClampedBranchMetricValue(metrics?.totalCostUsd);
  let rows: CostRow[] | null = null;
  if (metrics) {
    rows = honest
      ? honestPhaseRows(detail, metrics.phaseCostUsd)
      : shippedPhaseRows(detail, metrics.phaseCostUsd);
  }

  return (
    <section className="bq-costbd">
      <div className="bq-sec-head">
        <span className="bq-sec-title">Cost breakdown</span>
        <span className="bq-sec-count">{costHeaderLabel(total)}</span>
      </div>
      <CostBreakdownBody
        formatDuration={honest ? formatBranchDurationMs : formatDurationMs}
        rows={rows}
        total={total}
      />
    </section>
  );
}

function CostBreakdownBody({
  formatDuration,
  rows,
  total,
}: {
  formatDuration: (ms: number) => string;
  rows: CostRow[] | null;
  total: DisplayableBranchMetricValue | null;
}) {
  if (!(rows && total)) {
    return (
      <>
        <p className="bq-costbd-foot">
          {BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE}
        </p>
        <PartialCostLegend disclosures={partialDisclosures([], total)} />
      </>
    );
  }
  if (!isPricedBranchCost(total)) {
    // ISS-6949 made the header marker this card's only disclosure at zero,
    // because the rows and their legend are below this return.
    return (
      <>
        <p className="bq-costbd-foot">{BRANCH_COST_BREAKDOWN_NO_PRICED_COST}</p>
        <PartialCostLegend disclosures={partialDisclosures([], total)} />
      </>
    );
  }
  // ISS-6949: the header is the branch's canonical attributed cost, so when the
  // phase rows do not account for it there is no honest share to report — a
  // percentage against a denominator the rows do not decompose misstates every
  // row, and the bar would under- or over-fill its track. `packages/app`'s
  // self-reconcile rule allows exactly two outcomes here, "say it changed, or
  // mark unavailable"; the share is marked unavailable by omission, and the
  // rows keep their durations, dollars and the disclosure footnote.
  const shares = costShares(rows, !rows.some((row) => row.partial));

  return (
    <>
      {shares ? (
        <div aria-hidden="true" className="bq-cost-bar">
          {rows.map((row, index) => (
            <span
              className="bq-cost-seg"
              key={row.key}
              style={{
                width: `${shares.widths[index]}%`,
                background: getActivityPhaseDisplay(row.key).color,
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="bq-costbd-rows">
        {rows.map((row, index) => (
          <div className="bq-costbd-row" key={row.key}>
            <span
              className="bq-cost-sw"
              style={{ background: getActivityPhaseDisplay(row.key).color }}
            />
            <span className="bq-costbd-name">{row.label}</span>
            <span className="bq-costbd-val font-mono">
              {formatDuration(row.durationMs)} · {formatCost(row.costUsd)}
              {row.partial ? "*" : ""}
              {shares ? ` · ${shares.percents[index]}%` : ""}
            </span>
          </div>
        ))}
      </div>
      <PartialCostLegend disclosures={partialDisclosures(rows, total)} />
    </>
  );
}

function honestPhaseRows(
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
    const value = displayableBranchMetricValue(phaseCosts[phase]);
    if (!value) {
      return null;
    }
    const durationMs = durations.get(phase) ?? 0;
    if (!isDisplayableBranchMetricNumber(durationMs)) {
      return null;
    }
    rows.push({
      costUsd: value.value,
      ...(value.disclosure ? { disclosure: value.disclosure } : {}),
      durationMs,
      key: phase,
      label: getActivityPhaseDisplay(phase).label,
      partial: value.partial,
    });
  }
  return rows;
}

function shippedPhaseRows(
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
    const value = shippedClampedBranchMetricValue(phaseCosts[phase]);
    if (!value) {
      return null;
    }
    rows.push({
      costUsd: value.value,
      ...(value.disclosure ? { disclosure: value.disclosure } : {}),
      durationMs: durations.get(phase) ?? 0,
      key: phase,
      label: getActivityPhaseDisplay(phase).label,
      partial: value.partial,
    });
  }
  return rows;
}

/**
 * Per-row share of the phase column, or `null` when there is no honest one.
 *
 * whitlockk review: the kernel reconciles the rows against the header at DISPLAY
 * precision (`roundDisplayedCost`), because the two figures come off pipelines
 * that round differently — so a rollup of `1.004` under an attributed `0.995`
 * both render `$1.00` and legitimately reconcile. Dividing by the RAW header
 * there puts 101% on a row and overfills the bar track. The shares divide the
 * sum the rows actually decompose instead, which that reconciliation guarantees
 * is the header to the cent the reader can see.
 *
 * A zero column under a nonzero header is the same "no honest share" case: every
 * row would read 0% of a total the card is displaying as spent.
 */
function costShares(
  rows: readonly CostRow[],
  rowsAccountForTotal: boolean
): { percents: number[]; widths: number[] } | null {
  const columnTotalUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
  if (!(rowsAccountForTotal && columnTotalUsd > 0)) {
    return null;
  }
  return {
    percents: largestRemainderPercents(
      rows.map((row) => row.costUsd),
      columnTotalUsd
    ),
    widths: rows.map((row) => (row.costUsd / columnTotalUsd) * 100),
  };
}

export const BRANCH_COST_BREAKDOWN_EVIDENCE_UNAVAILABLE =
  "Build, Review, and Rework cost evidence is unavailable.";

export const BRANCH_COST_BREAKDOWN_NO_PRICED_COST =
  "No priced cost recorded yet.";

/**
 * ISS-6956: whether this branch has a priced cost to PRINT.
 *
 * Declared once because the header and the body used to decide it separately —
 * the header on `total` being truthy, the body on `total.value <= 0` — so a zero
 * satisfied both and the card printed `$0.00` directly above a sentence saying
 * no cost was recorded.
 *
 * A measured $0.00 is NOT separable here, and not by any consumer: the kernel
 * folds "no attributed cost" and "a priced zero" into one settled zero
 * (`resolveDetailPhaseTotal`, `packages/lib/branches/branch-detail-cost-reconciliation.ts`),
 * which its own `it.each` pins deliberately. ISS-6950 owns that distinction.
 */
function isPricedBranchCost(
  total: DisplayableBranchMetricValue | null
): boolean {
  return total !== null && total.value > 0;
}

/**
 * ISS-6956 fix decision: no dollar value is reported when the dollar value is
 * not known, so an unpriced branch takes the same em dash an absent metric
 * already took on this row.
 *
 * The partial marker survives that swap rather than going with the figure: it is
 * a claim about COVERAGE, which is still true — and still the reader's only
 * signal — when the covered cost sums to nothing.
 */
function costHeaderLabel(total: DisplayableBranchMetricValue | null): string {
  if (total === null) {
    return "—";
  }
  const marker = total.partial ? "*" : "";
  return isPricedBranchCost(total)
    ? `${formatCost(total.value)}${marker}`
    : `—${marker}`;
}

/**
 * The distinct sentences the partial figures on this card arrived with.
 *
 * ISS-8551: the card used to render a sentence of its OWN choosing for every
 * partial figure, which is how it came to state a narrower shortfall than the
 * producer had declared. It states the producer's instead, so the words track
 * whichever shortfall the figure actually has rather than the one the component
 * happened to hardcode. Deduplicated because the rows and the header can all be
 * partial for the same reason, and one cause is one footnote.
 */
function partialDisclosures(
  rows: readonly CostRow[],
  total: DisplayableBranchMetricValue | null
): string[] {
  const seen = new Set<string>();
  for (const source of [...rows, total]) {
    if (source?.partial && source.disclosure) {
      seen.add(source.disclosure);
    }
  }
  return [...seen];
}

/**
 * The header marker and this legend are one unit. Every body arm returns
 * through here because the card has three of them and the two early ones sit
 * above the rows, so an arm that forgot the legend would leave the reader an
 * asterisk with nothing explaining it.
 */
function PartialCostLegend({ disclosures }: { disclosures: string[] }) {
  return disclosures.map((disclosure) => (
    <p className="bq-costbd-foot" key={disclosure}>
      {disclosure}
    </p>
  ));
}
