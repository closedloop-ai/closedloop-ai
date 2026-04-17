"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type {
  DocumentDetail,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { PreviewDeploymentInfo } from "@repo/api/src/types/external-link-utils";
import { Label } from "@repo/design-system/components/ui/label";
import Link from "next/link";
import { useState } from "react";
import { AttachmentsSection } from "@/components/document-editor/attachments-section";
import { CollapsibleSection } from "@/components/document-editor/collapsible-section";
import { CommentsSection } from "@/components/document-editor/comments-section";
import { DocumentVersionInfo } from "@/components/document-editor/document-version-info";
import { EvaluationSection } from "@/components/document-editor/evaluation-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/document-editor/metadata-panel";
import { RatingSection } from "@/components/document-editor/rating-section";
import { getUserDisplayName } from "@/lib/user-utils";
import { PerformanceSection } from "./performance-section";
import { PreviewDeploymentSection } from "./preview-deployment-section";
import { PullRequestFeedbackSection } from "./pull-request-feedback-section";
import { PullRequestSection } from "./pull-request-section";
import { SourceDocumentSection } from "./source-document-section";

export type PlanMetadataPanelProps = {
  plan: DocumentDetail;
  generationStatus: GenerationStatus | null;
  pullRequest: PullRequestInfo | null;
  previewDeployment: PreviewDeploymentInfo | null;
  onPreviewRefresh: () => void;
  isPreviewRefreshing: boolean;
  judgeItems: JudgeFeedbackItem[] | null;
  codeJudgeItems: JudgeFeedbackItem[] | null;
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
  variant = "sidebar",
}: PlanMetadataPanelProps) {
  const [isRatingOpen, setIsRatingOpen] = useState(false);

  const projectId = plan.projectId ?? plan.project?.id;

  const detailsContent = (
    <div className="space-y-6">
      <SourceDocumentSection documentId={plan.id} projectId={projectId} />

      <GenerationSection generationStatus={generationStatus} />

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

      <AttachmentsSection documentId={plan.id} />

      <EvaluationSection
        documentId={plan.id}
        judgeItems={judgeItems}
        title="Agent Evaluation"
      />

      <EvaluationSection
        documentId={plan.id}
        emptyMessage="Code judge feedback is not available yet"
        judgeItems={codeJudgeItems}
        title="Code Evaluation"
      />

      <FeatureFlagged flag="the-one-flag">
        <PerformanceSection documentId={plan.id} />
      </FeatureFlagged>

      <CollapsibleSection
        onOpenChange={setIsRatingOpen}
        open={isRatingOpen}
        title="Rating"
      >
        <RatingSection
          currentPlanVersion={plan.version.version}
          documentId={plan.id}
        />
      </CollapsibleSection>

      <FeatureFlagged flag="the-one-flag">
        <CommentsSection documentId={plan.id} />
      </FeatureFlagged>

      <DocumentVersionInfo
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
}: {
  generationStatus: GenerationStatus | null;
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
