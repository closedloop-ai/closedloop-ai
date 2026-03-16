"use client";

import type {
  ArtifactDetail,
  ArtifactStatus,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { PreviewDeploymentInfo } from "@repo/api/src/types/external-link-utils";
import { Label } from "@repo/design-system/components/ui/label";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { TargetRepositoryFields } from "@/components/artifact-editor/target-repository-fields";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import {
  getUserDisplayName,
  transformApiUserToSelectUser,
} from "@/lib/user-utils";
import { PerformanceSection } from "./performance-section";
import { PreviewDeploymentSection } from "./preview-deployment-section";
import { PullRequestFeedbackSection } from "./pull-request-feedback-section";
import { PullRequestSection } from "./pull-request-section";
import { SourceArtifactSection } from "./source-artifact-section";

export type PlanMetadataPanelProps = {
  plan: ArtifactDetail;
  status: ArtifactStatus;
  approver: User | null;
  assignee: User | null;
  teamMembers: User[];
  generationStatus: GenerationStatus | null;
  pullRequest: PullRequestInfo | null;
  previewDeployment: PreviewDeploymentInfo | null;
  onPreviewRefresh: () => void;
  isPreviewRefreshing: boolean;
  judgeItems: JudgeFeedbackItem[] | null;
  codeJudgeItems: JudgeFeedbackItem[] | null;
  onStatusChange: (status: ArtifactStatus) => void;
  onApproverSelect: (user: User | null) => void;
  onAssigneeChange: (user: User | null) => void;
  targetRepo: string;
  targetBranch: string;
  onTargetRepoChange: (targetRepo: string) => void;
  onTargetRepoBlur: (overrideValue?: string) => void;
  onTargetBranchChange: (targetBranch: string) => void;
  onTargetBranchBlur: (overrideValue?: string) => void;
  /**
   * When "detailsOnly", render content without sidebar wrapper and without StatusMetadataSection.
   */
  variant?: "detailsOnly" | "sidebar";
};

export function PlanMetadataPanel({
  plan,
  status,
  approver,
  assignee,
  teamMembers,
  generationStatus,
  pullRequest,
  previewDeployment,
  onPreviewRefresh,
  isPreviewRefreshing,
  judgeItems,
  codeJudgeItems,
  onStatusChange,
  onApproverSelect,
  onAssigneeChange,
  targetRepo = "Inherited from project",
  targetBranch = "main",
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
  variant = "sidebar",
}: PlanMetadataPanelProps) {
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

  const {
    dialogOpen,
    dialogTrace,
    selectedSessionId,
    handleViewFullTrace,
    setDialogOpen,
  } = useExecutionLogDialog();

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isExecutionLogOpen, setIsExecutionLogOpen] = useState(false);
  const [isRatingOpen, setIsRatingOpen] = useState(false);

  const projectId = plan.projectId ?? plan.project?.id;

  const detailsContent = (
    <div className="space-y-6">
      <CollapsibleSection
        onOpenChange={setIsPropertiesOpen}
        open={isPropertiesOpen}
        title="Properties"
      >
        {variant === "sidebar" ? (
          <StatusMetadataSection
            approver={approver}
            assignee={assignee}
            onApproverSelect={onApproverSelect}
            onAssigneeChange={onAssigneeChange}
            onStatusChange={onStatusChange}
            orgUsers={transformedOrgUsers}
            status={status}
            teamMembers={teamMembers}
          />
        ) : null}

        <TargetRepositoryFields
          onTargetBranchBlur={onTargetBranchBlur}
          onTargetBranchChange={onTargetBranchChange}
          onTargetRepoBlur={onTargetRepoBlur}
          onTargetRepoChange={onTargetRepoChange}
          targetBranch={targetBranch}
          targetRepo={targetRepo}
          title="Target Repository"
        />

        <SourceArtifactSection artifactId={plan.id} projectId={projectId} />

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

        <ArtifactVersionInfo
          createdAt={plan.version.createdAt}
          updatedAt={plan.updatedAt}
          version={plan.version.version}
        />
      </CollapsibleSection>

      <CollapsibleSection
        onOpenChange={setIsExecutionLogOpen}
        open={isExecutionLogOpen}
        title="Execution Log"
      >
        <ExecutionLogSummary
          artifactId={plan.id}
          onViewFullTrace={handleViewFullTrace}
        />
      </CollapsibleSection>

      <EvaluationSection artifactId={plan.id} judgeItems={judgeItems} />

      <EvaluationSection
        artifactId={plan.id}
        emptyMessage="Code judge feedback is not available yet"
        judgeItems={codeJudgeItems}
        title="Code Evaluation"
      />

      <PerformanceSection artifactId={plan.id} />

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

      <CommentsSection artifactId={plan.id} />

      <AttachmentsSection artifactId={plan.id} />

      <CustomFieldsSection
        entityId={plan.id}
        entityType={CustomFieldEntityType.Artifact}
        values={plan.customFields}
      />
    </div>
  );

  if (variant === "detailsOnly") {
    return (
      <>
        {detailsContent}
        <ExecutionLogDialog
          initialSessionId={selectedSessionId}
          onOpenChange={setDialogOpen}
          open={dialogOpen}
          trace={dialogTrace}
        />
      </>
    );
  }

  return (
    <>
      <MetadataPanel title="Implementation Plan Details">
        {detailsContent}
      </MetadataPanel>
      <ExecutionLogDialog
        initialSessionId={selectedSessionId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        trace={dialogTrace}
      />
    </>
  );
}

/** Renders loop or GitHub Actions generation info in the metadata sidebar. */
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

  if (generationStatus?.htmlUrl) {
    return (
      <MetadataSection separator>
        <Label className="text-muted-foreground text-xs">Generation</Label>
        <a
          className="flex items-center gap-1 text-primary text-sm hover:underline"
          href={generationStatus.htmlUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          View GitHub Workflow
          <ExternalLinkIcon className="h-3 w-3" />
        </a>
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
