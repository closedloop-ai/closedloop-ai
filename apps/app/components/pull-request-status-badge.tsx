"use client";

import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import {
  prReviewDecisionColors,
  prStatusColors,
  StatusBadge,
} from "./status-badge";

export function PullRequestStatusBadge({
  pullRequest,
}: {
  pullRequest: PullRequestInfo | null | undefined;
}) {
  if (!pullRequest) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      <StatusBadge
        className="text-xs"
        colorMap={prStatusColors}
        status={pullRequest.state}
      />
      {pullRequest.reviewDecision && (
        <StatusBadge
          className="text-xs"
          colorMap={prReviewDecisionColors}
          status={pullRequest.reviewDecision}
        />
      )}
    </div>
  );
}
