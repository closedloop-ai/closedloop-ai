"use client";

import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import { Label } from "@repo/design-system/components/ui/label";
import { GitPullRequestIcon } from "lucide-react";
import Link from "next/link";
import { MetadataSection } from "@/components/artifact-editor/metadata-panel";
import {
  prReviewDecisionColors,
  prStatusColors,
  StatusBadge,
} from "@/components/status-badge";

type PullRequestSectionProps = {
  pullRequest: PullRequestInfo;
};

export function PullRequestSection({ pullRequest }: PullRequestSectionProps) {
  const href = pullRequest.externalLinkId
    ? `/build/${pullRequest.externalLinkId}`
    : pullRequest.htmlUrl;
  const isExternal = !pullRequest.externalLinkId;

  return (
    <MetadataSection separator>
      <Label className="text-muted-foreground text-xs">Pull Request</Label>
      {isExternal ? (
        <a
          className="flex items-center gap-1 text-primary text-sm hover:underline"
          href={href}
          rel="noopener noreferrer"
          target="_blank"
        >
          <GitPullRequestIcon className="h-3 w-3" />#{pullRequest.number}:{" "}
          {pullRequest.title}
        </a>
      ) : (
        <Link
          className="flex items-center gap-1 text-primary text-sm hover:underline"
          href={href}
        >
          <GitPullRequestIcon className="h-3 w-3" />#{pullRequest.number}:{" "}
          {pullRequest.title}
        </Link>
      )}
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <StatusBadge
          className="px-2 py-0.5 text-xs uppercase"
          colorMap={prStatusColors}
          status={pullRequest.state}
        />
        {pullRequest.reviewDecision && (
          <StatusBadge
            className="px-2 py-0.5 text-xs uppercase"
            colorMap={prReviewDecisionColors}
            status={pullRequest.reviewDecision}
          />
        )}
        <span>
          {pullRequest.headBranch} → {pullRequest.baseBranch}
        </span>
      </div>
    </MetadataSection>
  );
}
