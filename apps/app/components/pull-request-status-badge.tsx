"use client";

import {
  ChecksStatus,
  type PullRequestInfo,
} from "@repo/api/src/types/document";
import type { LucideIcon } from "lucide-react";
import { CheckCircle2Icon, ClockIcon, XCircleIcon } from "lucide-react";
import {
  prReviewDecisionColors,
  prStatusColors,
  StatusBadge,
} from "./status-badge";

const CI_STATUS_ICONS: Partial<
  Record<ChecksStatus, { icon: LucideIcon; className: string; testId: string }>
> = {
  [ChecksStatus.Passing]: {
    icon: CheckCircle2Icon,
    className: "h-4 w-4 text-green-500",
    testId: "ci-status-passing",
  },
  [ChecksStatus.Failing]: {
    icon: XCircleIcon,
    className: "h-4 w-4 text-red-500",
    testId: "ci-status-failing",
  },
  [ChecksStatus.Pending]: {
    icon: ClockIcon,
    className: "h-4 w-4 text-yellow-500",
    testId: "ci-status-pending",
  },
};

export function PullRequestStatusBadge({
  pullRequest,
}: {
  pullRequest: PullRequestInfo | null | undefined;
}) {
  if (!pullRequest) {
    return null;
  }

  const ciIcon = pullRequest.checksStatus
    ? CI_STATUS_ICONS[pullRequest.checksStatus]
    : null;

  return (
    <div className="flex items-center gap-1.5">
      <StatusBadge
        className="text-xs uppercase"
        colorMap={prStatusColors}
        status={pullRequest.state}
      />
      {ciIcon && (
        <ciIcon.icon className={ciIcon.className} data-testid={ciIcon.testId} />
      )}
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
