"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import {
  type PhaseSegment,
  partitionBuildVsRework,
  reconcilePhaseSegments,
} from "../lib/branch-derivations";

/**
 * Cost-to-merge breakdown (Epic D / D4) — restyled to the design handoff's
 * `BQCostBreakdown`: a section head with the total, a segmented spend bar, and
 * per-phase rows. Segments come from the D3 SSOT (`partitionBuildVsRework`),
 * residualized to the branch total via `reconcilePhaseSegments`. v1 has no
 * per-session phase signal, so spend attributes to a single Build phase; the
 * extra phases (Subagents / Auto-review / Human-review / Rework) appear as the
 * data lands. A multi-PR branch can't attribute spend per phase, so the split is
 * replaced with a note.
 */
export type BranchCostToMergeProps = {
  detail: BranchPageDetail;
  suppressSplits?: boolean;
};

const PHASE_COLOR: Record<PhaseSegment["key"], string> = {
  build: "#4F7DF0",
  subagents: "#8B7CF0",
  autoReview: "#D98A3D",
  humanReview: "#8B5CF6",
  rework: "#C0492B",
};

const PHASE_LABEL: Record<PhaseSegment["key"], string> = {
  build: "Build",
  subagents: "Delegated subagents",
  autoReview: "Automated review (CI)",
  humanReview: "Human review",
  rework: "Rework from review",
};

export function BranchCostToMerge({
  detail,
  suppressSplits = false,
}: BranchCostToMergeProps) {
  const { build, rework } = partitionBuildVsRework(detail);
  const total = detail.estimatedCostUsd;

  const rawSegments: PhaseSegment[] = [
    {
      key: "build",
      label: PHASE_LABEL.build,
      costUsd: build.costUsd ?? 0,
      firstRow: null,
    },
  ];
  if ((rework.costUsd ?? 0) > 0) {
    rawSegments.push({
      key: "rework",
      label: PHASE_LABEL.rework,
      costUsd: rework.costUsd ?? 0,
      firstRow: null,
    });
  }
  const segments = reconcilePhaseSegments(total, rawSegments).filter(
    (segment) => segment.costUsd > 0
  );
  const segmentTotal = segments.reduce((sum, s) => sum + s.costUsd, 0);

  return (
    <section className="bq-costbd">
      <div className="bq-sec-head">
        <span className="bq-sec-title">
          {detail.mergedAt ? "Cost to merge" : "Cost to date"}
        </span>
        <span className="bq-sec-count">
          {total == null ? "—" : formatCost(total)}
        </span>
      </div>

      <CostBreakdownBody
        segments={segments}
        segmentTotal={segmentTotal}
        suppressSplits={suppressSplits}
      />
    </section>
  );
}

/**
 * The breakdown body below the section head: a multi-PR note, an empty state, or
 * the segmented spend bar + per-phase rows. Split out (with early returns) so the
 * three cases stay flat rather than a nested ternary.
 */
function CostBreakdownBody({
  segments,
  segmentTotal,
  suppressSplits,
}: {
  segments: PhaseSegment[];
  segmentTotal: number;
  suppressSplits: boolean;
}) {
  if (suppressSplits) {
    return (
      <p className="bq-costbd-foot">
        More than one linked pull request — spend can't be attributed per phase.
      </p>
    );
  }

  if (segmentTotal <= 0) {
    return <p className="bq-costbd-foot">No priced spend recorded yet.</p>;
  }

  return (
    <>
      <div className="bq-cost-bar">
        {segments.map((segment) => (
          <span
            className="bq-cost-seg"
            key={segment.key}
            style={{
              width: `${(segment.costUsd / segmentTotal) * 100}%`,
              background: PHASE_COLOR[segment.key],
            }}
            title={`${segment.label} · ${formatCost(segment.costUsd)}`}
          />
        ))}
      </div>
      <div className="bq-costbd-rows">
        {segments.map((segment) => (
          <div className="bq-costbd-row" key={segment.key}>
            <span
              className="bq-cost-sw"
              style={{ background: PHASE_COLOR[segment.key] }}
            />
            <span className="bq-costbd-name">{segment.label}</span>
            <span className="bq-costbd-val font-mono">
              {formatCost(segment.costUsd)} ·{" "}
              {Math.round((segment.costUsd / segmentTotal) * 100)}%
            </span>
          </div>
        ))}
      </div>
      <p className="bq-costbd-foot">
        Per-phase split (subagents, review, rework) fills in as phase capture
        lands.
      </p>
    </>
  );
}
