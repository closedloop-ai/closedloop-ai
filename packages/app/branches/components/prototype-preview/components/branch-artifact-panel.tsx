"use client";

import type { BranchDetail } from "../mock";
import { BranchFilesChangedPanel } from "./branch-files-changed-panel";
import {
  BranchChecksReviewPanel,
  BranchCostToMerge,
  BranchDeliveredPanel,
  BranchHeadlineCards,
  BranchLeadTimeWaterfall,
} from "./detail-panels";

/** Branch-specific viewer content hosted by the generic Artifact tab. */
export function BranchArtifactPanel({ detail }: { detail: BranchDetail }) {
  return (
    <section
      aria-label="Branch viewer canvas"
      className="min-h-0 flex-1 overflow-auto"
    >
      <div className="relative mx-auto min-h-full w-full max-w-6xl px-5 py-6 sm:px-7">
        <BranchHeadlineCards detail={detail} />
        <BranchDeliveredPanel detail={detail} />
        <BranchFilesChangedPanel detail={detail} />
        <BranchChecksReviewPanel detail={detail} />
        <BranchCostToMerge detail={detail} />
        <BranchLeadTimeWaterfall detail={detail} />
      </div>
    </section>
  );
}
