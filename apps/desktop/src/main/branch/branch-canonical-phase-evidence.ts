import {
  type BranchPhaseAttributionCompletenessReason,
  BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import type { BranchActivitySegmentRow } from "../database/branch-analytics-phase-evidence.js";
import type { BranchLifecycleEventRow } from "../database/branch-reads.js";

/** Assemble one bounded phase-evidence snapshot for canonical metrics. */
export function buildPhaseEvidence(
  activitySegmentEvidence: {
    rows: readonly BranchActivitySegmentRow[];
    capped: boolean;
  },
  lifecycleEvidence: {
    rows: readonly BranchLifecycleEventRow[];
    capped: boolean;
  }
): {
  activitySegmentRows: readonly BranchActivitySegmentRow[];
  lifecycleEventRows: readonly BranchLifecycleEventRow[];
  coverageReasons: readonly BranchPhaseAttributionCompletenessReason[];
} {
  const capped = activitySegmentEvidence.capped || lifecycleEvidence.capped;
  return {
    activitySegmentRows: activitySegmentEvidence.rows,
    lifecycleEventRows: lifecycleEvidence.rows,
    coverageReasons: capped ? [PhaseCompletenessReason.CoverageCapped] : [],
  };
}
