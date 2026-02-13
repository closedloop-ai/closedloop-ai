"use client";

import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import { prStatusColors, StatusBadge } from "./status-badge";

export function PullRequestStatusBadge({
  pullRequest,
}: {
  pullRequest: PullRequestInfo | null | undefined;
}) {
  if (!pullRequest) {
    return null;
  }

  return (
    <StatusBadge
      className="text-xs"
      colorMap={prStatusColors}
      status={pullRequest.state}
    />
  );
}
