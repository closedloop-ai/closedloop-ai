"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type {
  ArtifactDetail,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { PreviewDeploymentInfo } from "@repo/api/src/types/external-link-utils";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { Label } from "@repo/design-system/components/ui/label";
import Link from "next/link";
import { useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { AttachmentsSection } from "@/components/artifact-editor/attachments-section";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import { EvaluationSection } from "@/components/artifact-editor/evaluation-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { RatingSection } from "@/components/artifact-editor/rating-section";
import { getUserDisplayName } from "@/lib/user-utils";
import { PerformanceSection } from "./performance-section";
import { PreviewDeploymentSection } from "./preview-deployment-section";
import { PullRequestFeedbackSection } from "./pull-request-feedback-section";
import { PullRequestSection } from "./pull-request-section";
import { SourceArtifactSection } from "./source-artifact-section";

export type PlanMetadataPanelProps = {
  plan: ArtifactDetail;
  generationStatus: GenerationStatus | null;
  pullRequest: PullRequestInfo | null;
  previewDeployment: PreviewDeploymentInfo | null;
  onPreviewRefresh: () => void;
  isPreviewRefreshing: boolean;
  judgeItems: JudgeFeedbackItem[] | null;
  codeJudgeItems: JudgeFeedbackItem[] | null;
  additionalRepos?: AdditionalRepoRef[] | null;
  /**
   * When "detailsOnly", render content without sidebar wrapper.
   */
  variant?: "detailsOnly" | "sidebar";
};

export function PlanMetadataPanel({
  plan,
  generationStatus,
  pullRequest,
  previewDeployment,
  onPreviewRefresh,
  isPreviewRefreshing,
  judgeItems,
  codeJudgeItems,
  additionalRepos,
  variant = "sidebar",
}: PlanMetadataPanelProps) {
  const [isRatingOpen, setIsRatingOpen] = useState(false);

  const projectId = plan.projectId ?? plan.project?.id;

  const detailsContent = (
    <div className="space-y-6">
      <SourceArtifactSection artifactId={plan.id} projectId={projectId} />

      <GenerationSection
        additionalRepos={additionalRepos}
        generationStatus={generationStatus}
      />

      {pullRequest ? <PullRequestSection pullRequest={pullRequest} /> : null}

      {pullRequest ? (
        <PullRequestFeedbackSection pullRequestId={pullRequest.id} />
      ) : null}

      {previewDeployment ? (
        <PreviewDeploymentSection
          isRefreshing={isPreviewRefreshing}
          onRefresh={onPreviewRefresh}
          previewDeployment={previewDeployment}
        />
      ) : null}

      <AttachmentsSection artifactId={plan.id} />

      <EvaluationSection
        artifactId={plan.id}
        judgeItems={judgeItems}
        title="Agent Evaluation"
      />

      <EvaluationSection
        artifactId={plan.id}
        emptyMessage="Code judge feedback is not available yet"
        judgeItems={codeJudgeItems}
        title="Code Evaluation"
      />

      <FeatureFlagged flag="the-one-flag">
        <PerformanceSection artifactId={plan.id} />
      </FeatureFlagged>

      <CollapsibleSection
        onOpenChange={setIsRatingOpen}
        open={isRatingOpen}
        title="Rating"
      >
        <RatingSection
          artifactId={plan.id}
          currentPlanVersion={plan.version.version}
        />
      </CollapsibleSection>

      <FeatureFlagged flag="the-one-flag">
        <CommentsSection artifactId={plan.id} />
      </FeatureFlagged>

      <ArtifactVersionInfo
        createdAt={plan.version.createdAt}
        updatedAt={plan.updatedAt}
      />
    </div>
  );

  if (variant === "detailsOnly") {
    return detailsContent;
  }

  return (
    <MetadataPanel title="Implementation Plan Details">
      {detailsContent}
    </MetadataPanel>
  );
}

/** Renders loop generation info in the metadata sidebar. */
function GenerationSection({
  generationStatus,
  additionalRepos,
}: {
  generationStatus: GenerationStatus | null;
  additionalRepos?: AdditionalRepoRef[] | null;
}) {
  if (generationStatus?.source === "loop" && generationStatus.loopId) {
    return (
      <MetadataSection separator>
        <Label className="text-muted-foreground text-xs">Loop</Label>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Status:</span>
            <LoopStatusBadge status={generationStatus.status} />
          </div>
          {generationStatus.initiatedBy ? (
            <p className="text-muted-foreground text-sm">
              Initiated by {getUserDisplayName(generationStatus.initiatedBy)}
            </p>
          ) : null}
          <Link
            className="flex items-center gap-1 text-primary text-sm hover:underline"
            href={`/loops/${generationStatus.loopId}`}
          >
            View loop details
          </Link>
          {additionalRepos && additionalRepos.length > 0 ? (
            <div className="space-y-1">
              <span className="text-muted-foreground text-xs">
                Additional Repositories
              </span>
              <ul className="space-y-0.5">
                {additionalRepos.map((repo) => (
                  <li
                    className="text-muted-foreground text-xs"
                    key={`${repo.fullName}:${repo.branch}`}
                  >
                    <span className="font-medium">{repo.fullName}</span>
                    <span className="opacity-70"> ({repo.branch})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </MetadataSection>
    );
  }

  return null;
}

/** Small inline badge for loop status display in the metadata sidebar. */
function LoopStatusBadge({ status }: { status: GenerationStatus["status"] }) {
  if (status === "NONE") {
    return null;
  }
  if (status === "SUCCESS") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-green-700 text-xs dark:bg-green-900/30 dark:text-green-300">
        Completed
      </span>
    );
  }
  if (status === "FAILURE") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-red-700 text-xs dark:bg-red-900/30 dark:text-red-300">
        Failed
      </span>
    );
  }
  if (status === "RUNNING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 text-xs dark:bg-blue-900/30 dark:text-blue-300">
        Running
      </span>
    );
  }
  // PENDING or QUEUED
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">
      Queued
    </span>
  );
}
