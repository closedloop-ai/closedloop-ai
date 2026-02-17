"use client";

import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import { Label } from "@repo/design-system/components/ui/label";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { MetadataSection } from "@/components/artifact-editor/metadata-panel";
import { prStatusColors, StatusBadge } from "@/components/status-badge";

type PullRequestSectionProps = {
  pullRequest: PullRequestInfo;
};

export function PullRequestSection({ pullRequest }: PullRequestSectionProps) {
  return (
    <MetadataSection separator>
      <Label className="text-muted-foreground text-xs">Pull Request</Label>
      <a
        className="flex items-center gap-1 text-primary text-sm hover:underline"
        href={pullRequest.htmlUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <GitPullRequestIcon className="h-3 w-3" />#{pullRequest.number}:{" "}
        {pullRequest.title}
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <StatusBadge
          className="px-2 py-0.5 text-xs uppercase"
          colorMap={prStatusColors}
          status={pullRequest.state}
        />
        <span>
          {pullRequest.headBranch} → {pullRequest.baseBranch}
        </span>
      </div>
    </MetadataSection>
  );
}
