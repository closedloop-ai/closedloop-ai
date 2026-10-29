"use client";

import type { DocumentCostCoverage } from "@repo/api/src/types/document-costs";
import type { DocumentsCosts } from "@repo/app/documents/hooks/use-documents-costs";
import {
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS,
  DocumentsSummaryUnavailableReason,
} from "@repo/app/documents/lib/documents-summary-cards";
import {
  formatCostPreciseOrDash,
  formatNumber,
} from "@repo/app/shared/lib/format-utils";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ArtifactBarMetric } from "./artifact-bar";

/** The two cost cards' metric keys (`DOCUMENTS_PROTOTYPE_METRICS`). */
export const ArtifactCostCardKey = {
  Total: "total-cost",
  Median: "median-cost",
} as const;
export type ArtifactCostCardKey =
  (typeof ArtifactCostCardKey)[keyof typeof ArtifactCostCardKey];

export type ArtifactCostCard = Pick<
  ArtifactBarMetric,
  "detail" | "loading" | "muted" | "unitLabel" | "value"
>;

/** Where the cost cards' read stands; the cards render one state per phase. */
export const ArtifactCostReadPhase = {
  Loading: "loading",
  Failed: "failed",
  Settled: "settled",
} as const;
export type ArtifactCostReadPhase =
  (typeof ArtifactCostReadPhase)[keyof typeof ArtifactCostReadPhase];

/**
 * ISS-12599 card states (Marisol Ashgrove, 2026-10-16). A full-population figure
 * renders as is, `$0.00` included. Partial coverage renders the measured
 * subset: the total with its coverage caption (decision 1), the median with an
 * asterisk whose tooltip names its denominator (decision 2). All-unknown keeps
 * the existing dash (decision 3).
 */
export function artifactCostCards(
  phase: ArtifactCostReadPhase,
  costs: DocumentsCosts | undefined
): Record<ArtifactCostCardKey, ArtifactCostCard> {
  if (phase === ArtifactCostReadPhase.Loading) {
    const loading = { loading: true, value: formatCostPreciseOrDash(null) };
    return {
      [ArtifactCostCardKey.Total]: loading,
      [ArtifactCostCardKey.Median]: loading,
    };
  }
  if (phase === ArtifactCostReadPhase.Failed) {
    const failed = {
      detail:
        DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS[
          DocumentsSummaryUnavailableReason.ReadFailed
        ],
      muted: true,
      value: formatCostPreciseOrDash(null),
    };
    return {
      [ArtifactCostCardKey.Total]: failed,
      [ArtifactCostCardKey.Median]: failed,
    };
  }
  return {
    [ArtifactCostCardKey.Total]: totalCostCard(costs),
    [ArtifactCostCardKey.Median]: medianCostCard(costs),
  };
}

/**
 * ISS-12599 decision 4 and approved copy (3): the cost-event window, appended
 * to the cost cards' existing info text. `lookbackDays` is undefined for all
 * time.
 */
export function artifactCostWindowLine(
  lookbackDays: number | undefined
): string {
  return lookbackDays === undefined
    ? "Spend for documents from all sessions"
    : `Spend from sessions in the last ${formatNumber(lookbackDays)} days`;
}

/** ISS-12599 approved copy (1), the partial Est. Total coverage caption. */
export function artifactCostCoverageCaption(
  coverage: DocumentCostCoverage
): string {
  return `Known for ${formatNumber(coverage.measuredDocumentCount)} of ${formatNumber(coverage.documentCount)} in this view`;
}

/** ISS-12599 approved copy (2), the measured-subset median asterisk tooltip. */
export function artifactCostMedianSubsetTooltip(
  coverage: DocumentCostCoverage
): string {
  return `Median for ${formatNumber(coverage.measuredDocumentCount)} of ${formatNumber(coverage.documentCount)} in this view with known cost`;
}

function totalCostCard(costs: DocumentsCosts | undefined): ArtifactCostCard {
  if (costs?.totalEstimatedCost !== undefined) {
    return { value: formatCostPreciseOrDash(costs.totalEstimatedCost) };
  }
  if (costs?.measuredSubsetTotalEstimatedCost !== undefined && costs.coverage) {
    return {
      detail: artifactCostCoverageCaption(costs.coverage),
      value: formatCostPreciseOrDash(costs.measuredSubsetTotalEstimatedCost),
    };
  }
  return { value: formatCostPreciseOrDash(null) };
}

function medianCostCard(costs: DocumentsCosts | undefined): ArtifactCostCard {
  if (costs?.medianEstimatedCost !== undefined) {
    return { value: formatCostPreciseOrDash(costs.medianEstimatedCost) };
  }
  if (
    costs?.measuredSubsetMedianEstimatedCost !== undefined &&
    costs.coverage
  ) {
    return {
      unitLabel: (
        <MeasuredSubsetMarker
          tooltip={artifactCostMedianSubsetTooltip(costs.coverage)}
        />
      ),
      value: formatCostPreciseOrDash(costs.measuredSubsetMedianEstimatedCost),
    };
  }
  return { value: formatCostPreciseOrDash(null) };
}

/**
 * The asterisk beside a measured-subset median, drawn in the value's type
 * and pulled against it like the Branches partial `*`. A button, after
 * `KpiDeltaPlaceholder`, so the tooltip opens on keyboard focus as well as
 * hover; the tooltip sentence is its accessible name.
 */
function MeasuredSubsetMarker({ tooltip }: { tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`-ml-2.5 inline-flex h-6 min-w-6 cursor-default items-baseline justify-center rounded-sm font-semibold text-2xl text-foreground leading-6 ${CHIP_FOCUS_RING_CLASS}`}
          data-testid="measured-subset-marker"
          type="button"
        >
          <span aria-hidden="true">*</span>
          <span className="sr-only">{tooltip}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
